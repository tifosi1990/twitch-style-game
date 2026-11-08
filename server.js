const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const fs = require('fs');
const path = require('path')
const os = require('os');
const QRCode = require('qrcode');

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

app.use(express.static(path.join(__dirname, 'public')));

// ----- JOIN QR CODE -----
// Players scan a QR code on the game screen that points at this computer's
// controller page. Set JOIN_URL to override the auto-detected address.
const PORT = process.env.PORT || 3000;

// Adapters that are never the Wi-Fi/Ethernet network phones are on.
const VIRTUAL_ADAPTER = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|vpn/i;

function isPrivateIPv4(ip) {
  return /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function detectLanAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (!VIRTUAL_ADAPTER.test(name)) score += 4;
      if (/wi-?fi|wlan|wireless/i.test(name)) score += 2;
      if (isPrivateIPv4(a.address)) score += 1;
      candidates.push({ address: a.address, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return candidates.length ? candidates[0].address : 'localhost';
}

const JOIN_URL = process.env.JOIN_URL ||
  `http://${detectLanAddress()}:${PORT}/controller.html`;

app.get('/join-info', (req, res) => {
  res.json({ url: JOIN_URL });
});

app.get('/join-qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(JOIN_URL, { type: 'svg', margin: 2 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).send('Could not create QR code');
  }
});



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

  const ice = [];
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
      if (char === 'I') ice.push({ x, y });
    });
  });

  return {
    width,
    height,
    walls,
    ledges,
    hole,
    boulders,
    ice,
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


function isIce(x, y) {
  if (!MAP.ice) return false;
  return MAP.ice.some(t => t.x === x && t.y === y);
}


function blocksSlide(x, y, movingCube) {
  if (!inBounds(x, y)) return true;
  if (isWall(x, y)) return true;
  if (isLedge(x, y)) return true;     // ledge is an obstacle for sliding
  if (isBoulder(x, y)) return true;   // boulder is an obstacle for sliding
  if (isCubeAt(x, y, movingCube)) return true; // optional but recommended
  return false;
}

function slideIfOnIce(cube, dx, dy) {
  // Only slide if you are currently on ice
  if (!isIce(cube.x, cube.y)) return;

  // Slide until next step would be blocked.
  while (isIce(cube.x, cube.y)) {
    const nx = cube.x + dx;
    const ny = cube.y + dy;

    // stop before obstacle
    if (blocksSlide(nx, ny, cube)) return;

    // next tile is free:
    // - if it's ice, keep going
    // - if it's not ice, step onto it and stop (classic “slide off”)
    cube.x = nx;
    cube.y = ny;

    if (!isIce(cube.x, cube.y)) return;
  }
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
    slideIfOnIce(cube, dx, dy);
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
    slideIfOnIce(cube, 0, 1); 
    return;
  }

  if (isCubeAt(newX, newY, cube)) {
    console.log('RETURN: cube collision');
    return;
  }

  console.log('NORMAL MOVE');
  cube.x = newX;
  cube.y = newY;
  slideIfOnIce(cube, dx, dy); 
  return;
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
  // The game screen connects as a spectator: it gets the game state but is
  // not a player, so it is not counted or put on a team.
  const isScreen = socket.handshake.query.role === 'screen';
  console.log(isScreen ? 'screen connected' : 'player connected', socket.id);

  let teamId = null;
  if (!isScreen) {
    teamId = assignTeam();
    players[socket.id] = {
      teamId,
      lastCommandTime: 0
    };
    socket.join(teamId);
  }

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
    console.log(isScreen ? 'screen disconnected' : 'player disconnected', socket.id);
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

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log(`Game screen:  http://localhost:${PORT}/screen.html`);
  console.log(`Players join: ${JOIN_URL}`);
});
