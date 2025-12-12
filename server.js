const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ----- CONFIG -----
const TEAM_IDS = ['red', 'blue'];
const COMMAND_COOLDOWN_MS = 1000; // 1 command every 5 seconds
const TICK_MS = 300;              // how often cubes consume commands

// ----- GAME STATE -----
const teams = {};
TEAM_IDS.forEach((id, idx) => {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  teams[id] = {
    id,
    name: id.toUpperCase(),
    color: colors[idx] || '#ffffff',
    // starting positions inside maze corridor
    cube: { x: 2 + idx * 2, y: 1 },
    commandQueue: []
  };
});

// players[socketId] = { teamId, lastCommandTime }
const players = {};

let raceStarted = false;

// ----- MAP & MAZE -----
const MAP = {
  width: 20,
  height: 12,
  hole: { x: 18, y: 10 }, // goal near bottom-right
  walls: []
};

function buildMaze() {
  const w = MAP.width;
  const h = MAP.height;
  const walls = [];

  // Outer border
  for (let x = 0; x < w; x++) {
    walls.push({ x, y: 0 });       // top
    walls.push({ x, y: h - 1 });   // bottom
  }
  for (let y = 1; y < h - 1; y++) {
    walls.push({ x: 0, y });       // left
    walls.push({ x: w - 1, y });   // right
  }

  // Interior "maze" rows (each has two gaps)

  // Row y = 3, gaps at x = 3 and x = 16
  for (let x = 1; x < w - 1; x++) {
    if (x !== 3 && x !== 16) {
      walls.push({ x, y: 3 });
    }
  }

  // Row y = 5, gaps at x = 6 and x = 10
  for (let x = 1; x < w - 1; x++) {
    if (x !== 6 && x !== 10) {
      walls.push({ x, y: 5 });
    }
  }

  // Row y = 7, gaps at x = 2 and x = 13
  for (let x = 1; x < w - 1; x++) {
    if (x !== 2 && x !== 13) {
      walls.push({ x, y: 7 });
    }
  }

  // Row y = 9, gaps at x = 8 and x = 17
  for (let x = 1; x < w - 1; x++) {
    if (x !== 8 && x !== 17) {
      walls.push({ x, y: 9 });
    }
  }

  MAP.walls = walls;
}

buildMaze();

// ----- HELPERS -----
function assignTeam() {
  const counts = {};
  TEAM_IDS.forEach(id => counts[id] = 0);
  Object.values(players).forEach(p => counts[p.teamId]++);
  return TEAM_IDS.reduce(
    (best, id) => counts[id] < counts[best] ? id : best,
    TEAM_IDS[0]
  );
}

function isWall(x, y) {
  if (!MAP.walls) return false;
  return MAP.walls.some(w => w.x === x && w.y === y);
}

function applyMove(cube, cmd) {
  if (!cmd) return;

  let newX = cube.x;
  let newY = cube.y;

  if (cmd === 'up') newY -= 1;
  if (cmd === 'down') newY += 1;
  if (cmd === 'left') newX -= 1;
  if (cmd === 'right') newX += 1;

  // clamp to bounds
  newX = Math.max(0, Math.min(MAP.width - 1, newX));
  newY = Math.max(0, Math.min(MAP.height - 1, newY));

  // block walls
  if (isWall(newX, newY)) return;

  cube.x = newX;
  cube.y = newY;
}

function getTeamCounts() {
  const counts = {};
  TEAM_IDS.forEach(id => counts[id] = 0);
  Object.values(players).forEach(p => {
    if (counts[p.teamId] !== undefined) {
      counts[p.teamId]++;
    }
  });
  return counts;
}

function resetTeamsToStart() {
  TEAM_IDS.forEach((id, idx) => {
    teams[id].cube = { x: 2 + idx * 2, y: 1 };
    teams[id].commandQueue = [];
  });
}

// ----- SOCKET.IO -----
io.on('connection', socket => {
  console.log('player connected', socket.id);

  const teamId = assignTeam();
  players[socket.id] = {
    teamId,
    lastCommandTime: 0
  };
  socket.join(teamId);

  // Initial state for this client
  socket.emit('init', {
    teamId,
    teams,
    map: MAP,
    raceStarted,
    teamCounts: getTeamCounts()
  });

  // Player commands
  socket.on('command', cmd => {
    const player = players[socket.id];
    if (!player) return;
    if (!['up', 'down', 'left', 'right'].includes(cmd)) return;

    // Ignore commands before race starts
    if (!raceStarted) {
      socket.emit('race_not_started');
      return;
    }

    const now = Date.now();
    const timeSinceLast = now - (player.lastCommandTime || 0);

    // Cooldown
    if (timeSinceLast < COMMAND_COOLDOWN_MS) {
      const remaining = COMMAND_COOLDOWN_MS - timeSinceLast;
      socket.emit('rate_limited', { cooldownMs: remaining });
      return;
    }

    player.lastCommandTime = now;
    teams[player.teamId].commandQueue.push(cmd);

    io.to(player.teamId).emit('command_echo', {
      from: socket.id,
      cmd
    });
  });

  // Start race (from screen button)
  socket.on('start_race', () => {
    if (!raceStarted) {
      console.log('Race started by', socket.id);
      raceStarted = true;
      resetTeamsToStart();
      io.emit('race_started', {
        raceStarted,
        teams,
        map: MAP,
        teamCounts: getTeamCounts()
      });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    console.log('player disconnected', socket.id);
  });
});

// ----- GAME LOOP -----
setInterval(() => {
  const teamCounts = getTeamCounts();

  // Before race: just broadcast state & counts (no movement)
  if (!raceStarted) {
    io.emit('state', {
      teams,
      map: MAP,
      winner: null,
      raceStarted,
      teamCounts
    });
    return;
  }

  // 1. Move each cube by one queued command
  Object.values(teams).forEach(team => {
    const cmd = team.commandQueue.shift();
    applyMove(team.cube, cmd);
  });

  // 2. Check for winner
  let winner = null;
  Object.values(teams).forEach(team => {
    if (team.cube.x === MAP.hole.x && team.cube.y === MAP.hole.y) {
      winner = team.id;
    }
  });

  // 3. Broadcast state
  io.emit('state', {
    teams,
    map: MAP,
    winner,
    raceStarted,
    teamCounts
  });

  // 4. If winner, stop race & reset after delay
  if (winner) {
    console.log('Winner:', winner);
    raceStarted = false;

    setTimeout(() => {
      resetTeamsToStart();
      io.emit('reset', {
        teams,
        map: MAP,
        raceStarted,
        teamCounts: getTeamCounts()
      });
    }, 3000);
  }
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
