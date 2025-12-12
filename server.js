const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ----- GAME CONFIG -----
const TEAM_IDS = ['red', 'blue'];
const COMMAND_COOLDOWN_MS = 5000; // 5 seconds
const TICK_MS = 300;              // how often cubes consume a command from queue

// ----- GAME STATE -----
const teams = {};
TEAM_IDS.forEach((id, idx) => {
  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
  teams[id] = {
    id,
    name: id.toUpperCase(),
    color: colors[idx] || '#ffffff',
    cube: { x: 2 + idx * 2, y: 1 }, // starts at (2,1) and (4,1), both open in the maze
    commandQueue: []                // queue of 'up' | 'down' | 'left' | 'right'
  };
});

// players[socketId] = { teamId, lastCommandTime }
const players = {};

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

  // --- Outer border ---
  for (let x = 0; x < w; x++) {
    walls.push({ x, y: 0 });       // top
    walls.push({ x, y: h - 1 });   // bottom
  }
  for (let y = 1; y < h - 1; y++) {
    walls.push({ x: 0, y });       // left
    walls.push({ x: w - 1, y });   // right
  }

  // --- Interior "maze" rows (with gaps) ---

  // Row y = 3, walls everywhere except at x = 3 and x = 16
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
  // Simple load balancing: choose team with fewest players
  const counts = {};
  TEAM_IDS.forEach(id => counts[id] = 0);
  Object.values(players).forEach(p => counts[p.teamId]++);
  return TEAM_IDS.reduce((best, id) =>
    counts[id] < counts[best] ? id : best, TEAM_IDS[0]);
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
  if (isWall(newX, newY)) {
    return; // ignore this move
  }

  cube.x = newX;
  cube.y = newY;
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

  // Send initial state
  socket.emit('init', {
    teamId,
    teams,
    map: MAP
  });

  // Receive commands
  socket.on('command', cmd => {
    const player = players[socket.id];
    if (!player) return;

    if (!['up', 'down', 'left', 'right'].includes(cmd)) return;

    const now = Date.now();
    const timeSinceLast = now - (player.lastCommandTime || 0);

    // Cooldown: 1 command every 5 seconds
    if (timeSinceLast < COMMAND_COOLDOWN_MS) {
      const remaining = COMMAND_COOLDOWN_MS - timeSinceLast;
      socket.emit('rate_limited', {
        cooldownMs: remaining
      });
      return;
    }

    // Accept command
    player.lastCommandTime = now;
    teams[player.teamId].commandQueue.push(cmd);

    // Optional echo to team as "chat"
    io.to(player.teamId).emit('command_echo', {
      from: socket.id,
      cmd
    });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    console.log('player disconnected', socket.id);
  });
});

// ----- GAME LOOP -----
// Each TICK, each team's cube consumes exactly ONE command
setInterval(() => {
  // 1. For each team, pop next command in queue and move cube
  Object.values(teams).forEach(team => {
    const cmd = team.commandQueue.shift(); // first-in, first-out
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
    winner
  });

  // 4. If someone won, reset after a short delay
  if (winner) {
    console.log('Winner:', winner);
    setTimeout(() => {
      TEAM_IDS.forEach((id, idx) => {
        teams[id].cube = { x: 2 + idx * 2, y: 2 };
        teams[id].commandQueue = [];
      });
      io.emit('reset', { teams, map: MAP });
    }, 3000);
  }
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
