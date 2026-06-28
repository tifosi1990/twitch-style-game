# Twitch Style Game

A local multiplayer maze race inspired by "Twitch Plays" style controls. One shared screen shows the maze, while players join from phones or other devices and send movement commands for their assigned team.

## Requirements

- Node.js 18 or newer
- npm
- All players should be on the same local network if using phones/controllers

## Install

From this folder:

```bash
cd C:\Users\angel\OneDrive\Programming\twitchstylegame\twitch-style-game
npm install
```

Dependencies are:

- `express`
- `socket.io`
- `socket.io-client`

## Run

```bash
npm start
```

By default the server listens on:

```text
http://localhost:3000
```

## Open The Game Screen

On the computer connected to the display/projector, open:

```text
http://localhost:3000/screen.html
```

This page shows the maze, player counts, and the admin buttons:

- `Start Race`
- `Next Map`

## Open Player Controllers

On the same computer, open:

```text
http://localhost:3000/controller.html
```

For phones or other devices on the same Wi-Fi, use the host computer's local IP address instead of `localhost`.

Example:

```text
http://192.168.1.50:3000/controller.html
```

To find your local IP on Windows:

```powershell
ipconfig
```

Look for the IPv4 address under your active Wi-Fi or Ethernet adapter.

## How To Play

1. Start the server with `npm start`.
2. Open `screen.html` on the main display.
3. Players open `controller.html` on their devices.
4. Each player is automatically assigned to either the red or blue team.
5. Click `Start Race` on the screen page.
6. Players press arrow buttons to queue movement commands.
7. The first team cube to reach the green goal wins.

## Game Rules

- Each team has one cube.
- Commands are rate-limited per player.
- The server consumes one queued command per team every game tick.
- Walls block movement.
- Boulders can be pushed if the space behind them is free.
- Ledges can only be crossed by moving downward.
- After a winner is found, the race resets after a short delay.

## Maps

Maps live in:

```text
maps/
```

The server loads all `.txt` maps and cycles through them with `Next Map`.

Map characters:

```text
# = wall
R = red team start
B = blue team start
G = goal
O = boulder
V = ledge
space = empty floor
```

Each map should include exactly one `R`, one `B`, and one `G`.

Important: keep map rows the same width and avoid trailing spaces or tabs. Ragged rows can make collision and rendering behave unexpectedly.

## Useful Commands

Start the server:

```bash
npm start
```

Check server syntax:

```bash
node --check server.js
```

Use a different port:

```powershell
$env:PORT=4000; npm start
```

Then open:

```text
http://localhost:4000/screen.html
```

## Troubleshooting

If phones cannot connect:

- Make sure the phone and host computer are on the same Wi-Fi.
- Use the computer's local IPv4 address, not `localhost`.
- Allow Node.js through Windows Firewall if prompted.
- Check that the server terminal says `Server listening on 3000`.

If movement does not work:

- Make sure the race has been started from `screen.html`.
- Check the controller log for cooldown or race-not-started messages.
- Confirm the player is assigned to a team.

If a map behaves strangely:

- Check that all rows are the same length.
- Remove trailing spaces and tabs.
- Confirm the map has one red start, one blue start, and one goal.

