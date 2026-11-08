// Waits until the game server answers, then opens the game screen in Chrome
// (or the default browser if Chrome is not installed). Used by "Start Game.bat".
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://localhost:3000/screen.html';

const chromePaths = [
  path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function openBrowser() {
  const chrome = chromePaths.find(p => fs.existsSync(p));
  const [cmd, args] = chrome
    ? [chrome, ['--new-window', url]]
    : ['cmd', ['/c', 'start', '', url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (err) {
      // server not up yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

waitForServer().then(ok => {
  if (ok) openBrowser();
  else console.log(`Server did not start; open ${url} by hand.`);
});
