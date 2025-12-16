const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');
const path = require('path')

// ----- CONFIG -----
const TEAM_IDS = ['red', 'blue'];
const COMMAND_COOLDOWN_MS = 1000; // 1 command every 5 seconds
const TICK_MS = 300;              // how often cubes consume commands


const MAP_DIR = path.join(__dirname, 'maps');
const MAP_FILES = fs.readdirSync(MAP_DIR)
  .filter(f => f.endsWith('.txt'))
  .sort();

if (MAP_FILES.length === 0) {
  throw new Error('No map files found in /maps folder');
}



let mapIndex = 0;
let MAP = loadMapFromFile(path.join(MAP_DIR, MAP_FILES[mapIndex]));
validateMap(MAP);

app.use(express.static('public'));



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

function validateMap(map) {
  TEAM_IDS.forEach(id => {
    if (!map.starts[id]) {
      throw new Error(`Map '${MAP_FILES[mapIndex]}' missing start for team '${id}'`);
    }
  });
  if (!map.hole) {
    throw new Error(`Map '${MAP_FILES[mapIndex]}' missing goal 'G'`);
  }
}

function loadNextMap() {
  mapIndex = (mapIndex + 1) % MAP_FILES.length;

  MAP = loadMapFromFile(path.join(MAP_DIR, MAP_FILES[mapIndex]));
  validateMap(MAP);

  // stop race + reset to new start positions
  raceStarted = false;
  resetTeamsToStart();

  // tell everyone the new map + reset teams
  io.emit('map_changed', {
    map: MAP,
    teams,
    raceStarted,
    teamCounts: getTeamCounts(),
    mapName: MAP_FILES[mapIndex]
  });
}

// ----- MAP & MAZE -----
function loadMapFromFile(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const lines = text.split('\n').map(l => l.replace(/\r/g, ''));

  const height = lines.length;
  const width = lines[0].length;

  const walls = [];
  const ledges = [];
  const starts = {};
  const boulders = [];
  let hole = null;

  lines.forEach((line, y) => {
    [...line].forEach((char, x) => {
      if (char === '#') walls.push({ x, y });
      if (char === 'V') ledges.push({ x, y });
      if (char === 'R') starts.red = { x, y };
      if (char === 'B') starts.blue = { x, y };
      if (char === 'O') boulders.push({ x, y });
      if (char === 'G') hole = { x, y };
    });
  });

  return {
    width,
    height,
    walls,
    ledges,
    hole,
    boulders,
    starts
  };
}

let boulders = MAP.boulders ? MAP.boulders.map(b => ({ ...b })) : [];


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


function boulderIndexAt(x, y) {
  return boulders.findIndex(b => b.x === x && b.y === y);
}

function isBoulder(x, y) {
  return boulderIndexAt(x, y) !== -1;
}

function isCubeAt(x, y, ignoreCube = null) {
  return Object.values(teams).some(t => {
    if (ignoreCube && t.cube === ignoreCube) return false;
    return t.cube.x === x && t.cube.y === y;
  });
}


function inBounds(x, y) {
  return x >= 0 && x < MAP.width && y >= 0 && y < MAP.height;
}

function applyMove(cube, cmd) {
  console.log('applyMove START', cube.x, cube.y, cmd);

  if (!cmd) {
    console.log('RETURN: no cmd');
    return;
  }

  let dx = 0, dy = 0;
  if (cmd === 'up') dy = -1;
  if (cmd === 'down') dy = 1;
  if (cmd === 'left') dx = -1;
  if (cmd === 'right') dx = 1;

  if (dx === 0 && dy === 0) {
    console.log('RETURN: dx dy zero');
    return;
  }

  const newX = cube.x + dx;
  const newY = cube.y + dy;

  console.log('TARGET', newX, newY);

  if (!inBounds(newX, newY)) {
    console.log('RETURN: out of bounds');
    return;
  }

  const bi = boulderIndexAt(newX, newY);
  if (bi !== -1) {
    console.log('HIT BOULDER');

    const pushX = newX + dx;
    const pushY = newY + dy;

    if (!inBounds(pushX, pushY)) {
      console.log('RETURN: boulder push OOB');
      return;
    }
    if (isWall(pushX, pushY)) {
      console.log('RETURN: boulder push wall');
      return;
    }
    if (isLedge(pushX, pushY)) {
      console.log('RETURN: boulder push ledge');
      return;
    }
    if (isBoulder(pushX, pushY)) {
      console.log('RETURN: boulder push boulder');
      return;
    }
    if (isCubeAt(pushX, pushY, cube)) {
      console.log('RETURN: boulder push cube');
      return;
    }

    console.log('PUSH BOULDER');
    boulders[bi] = { x: pushX, y: pushY };
    cube.x = newX;
    cube.y = newY;
    return;
  }

  if (isWall(newX, newY)) {
    console.log('RETURN: wall');
    return;
  }

  if (isLedge(newX, newY)) {
    console.log('HIT LEDGE');

    if (cmd !== 'down') {
      console.log('RETURN: ledge wrong direction');
      return;
    }

    const landingX = newX;
    const landingY = newY + 1;

    if (!inBounds(landingX, landingY)) {
      console.log('RETURN: ledge OOB');
      return;
    }
    if (isWall(landingX, landingY)) {
      console.log('RETURN: ledge wall');
      return;
    }
    if (isLedge(landingX, landingY)) {
      console.log('RETURN: ledge onto ledge');
      return;
    }
    if (isBoulder(landingX, landingY)) {
      console.log('RETURN: ledge onto boulder');
      return;
    }
    if (isCubeAt(landingX, landingY, cube)) {
      console.log('RETURN: ledge onto cube');
      return;
    }

    console.log('LEDGE JUMP');
    cube.x = landingX;
    cube.y = landingY;
    return;
  }

  if (isCubeAt(newX, newY, cube)) {
    console.log('RETURN: cube collision');
    return;
  }

  console.log('NORMAL MOVE');
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
  //reset boulders to start
  boulders = MAP.boulders ? MAP.boulders.map(b => ({ ...b })) : [];

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
    boulders,
    map: MAP,
    mapName: MAP_FILES[mapIndex],
    raceStarted,
    teamCounts: getTeamCounts()
  });

  // Player commands
  socket.on('command', cmd => {
    console.log('COMMAND RECEIVED:', cmd);
    console.log('CMD from', socket.id, cmd);
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
    if (raceStarted) return;

    console.log('Race started by', socket.id);

    raceStarted = true;

    // ✅ HARD RESET STATE
    TEAM_IDS.forEach(id => {
      teams[id].cube = { ...MAP.starts[id] };
      teams[id].commandQueue = [];
    });
    boulders = MAP.boulders ? MAP.boulders.map(b => ({ ...b })) : [];

    io.emit('race_started', {
      raceStarted,
      teams,
      boulders,
      map: MAP,
      teamCounts: getTeamCounts()
    });
  });


  socket.on('next_map', () => {
  loadNextMap();
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
      boulders,
      winner: null,
      raceStarted,
      teamCounts
    });
    return;
  }

  // 1. Move each cube by one queued command
  Object.values(teams).forEach(team => {
    const cmd = team.commandQueue.shift();
    if (cmd) {
    console.log('APPLY MOVE:', team.id, cmd);
  }
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
    boulders,
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
        boulders,
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
