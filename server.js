const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');
const MAP = loadMapFromFile('maps/map1.txt')


app.use(express.static('public'));

// ----- CONFIG -----
const TEAM_IDS = ['red', 'blue'];
const COMMAND_COOLDOWN_MS = 1000; // 1 command every 5 seconds
const TICK_MS = 300;              // how often cubes consume commands

// ----- GAME STATE -----
const teams = {};
TEAM_IDS.forEach((id, idx) => {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];

  if (!MAP.starts[id]) {
    throw new Error(`Map is missing start position for team '${id.toUpperCase()}'`);
  }

  teams[id] = {
    id,
    name: id.toUpperCase(),
    color: colors[idx] || '#ffffff',
    cube: { ...MAP.starts[id] },   // ← START POSITION FROM MAP
    commandQueue: []
  };
});
// players[socketId] = { teamId, lastCommandTime }
const players = {};

let raceStarted = false;

// ----- MAP & MAZE -----
function loadMapFromFile(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const lines = text.split('\n').map(l => l.replace(/\r/g, ''));

  const height = lines.length;
  const width = lines[0].length;

  const walls = [];
  const ledges = [];
  const starts = {};
  let hole = null;

  lines.forEach((line, y) => {
    [...line].forEach((char, x) => {
      if (char === '#') walls.push({ x, y });
      if (char === 'V') ledges.push({ x, y });
      if (char === 'R') starts.red = { x, y };
      if (char === 'B') starts.blue = { x, y };
      if (char === 'G') hole = { x, y };
    });
  });

  return {
    width,
    height,
    walls,
    hole,
    starts
  };
}



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

function isLedge(x, y) {
  if (!MAP.ledges) return false;
  return MAP.ledges.some(l => l.x === x && l.y === y);
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

  if (isLedge(newX, newY)) {
    // Only allow entering a ledge from above while moving down
    if (cmd !== 'down') return;

    // Jump over it: land one more cell down
    const landingX = newX;
    const landingY = Math.min(MAP.height - 1, newY + 1);

    // landing must be valid (not wall, not ledge)
    if (isWall(landingX, landingY)) return;
    if (isLedge(landingX, landingY)) return;

    cube.x = landingX;
    cube.y = landingY;
    return;
  }


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
  TEAM_IDS.forEach(id => {
    teams[id].cube = { ...MAP.starts[id] };
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
