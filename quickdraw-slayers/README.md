# QuickDraw Slayers

A real-time card battle for one or two players (COMP4021 group project). You are a Slayer fighting exam monsters on three floors of the HKUST Jockey Club Atrium. Play cards, block the enemy's telegraphed attacks and clear all three floors before the 4:00 master timer runs out. Play **solo** or **co-op** over the network with a partner. There are no turns: every card takes effect the moment it is played.

## Run it

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder: `npm install`
3. `node game_server.js` (or `npm start`)
4. Open [http://localhost:8000](http://localhost:8000). For co-op, open it a second time in another browser, or in a private window (a different login session).

Register an account, read the How to Play guide (new players must finish it once), then sign in. The server uses port 8000 unless the `PORT` environment variable is set.

## How to play

The full guide, with screenshots and GIFs recorded from the game, is in the game itself: register, or press the yellow **?** button after you sign in.

| Action | Control |
|---|---|
| Play a card | click it, or press `1` `2` `3` `4` |
| Cheat mode on/off (whole team) | `C` |
| Sound on/off | the button at the top right (lobby and game) |

- **Goal:** beat the boss on each of the 3 floors before the 4:00 timer ends. All Slayers falling, or the timer reaching 0:00, is Defeat.
- **Hand and Energy:** you hold 4 cards; a played card is replaced from a pool of 10 cards (attacks, blocks, utilities). Energy holds 4 / 5 / 6 on floors 1 / 2 / 3, starts full on each floor and refills **1 every 1.8 s**.
- **Enemies:** three bosses (Campus Typhoon, Feral Firebird, Thesis Dragon), one per floor, in a random order. Each has an attack timer bar; when it empties it hits one Slayer (with a partner, the attacks take turns). Bosses get stronger on each floor, and in co-op have 80% more HP and deal 25% more damage.
- **Shield:** block cards give Shield (max 60) which absorbs damage before HP.
- **Combos:** Group Project or Bell Curve followed by any attack within about 2 s gives +25%. Bell Curve makes the enemy take 45% more damage for 8 s. Group Project makes its next 2 attacks 35% weaker. Extension gives 2 Energy to every Slayer.
- **Between floors:** a 5 s reward screen (main timer paused): *Draw a card*, *Train* (+12% damage, +10 max HP) or *Rest* (+40 HP).
- **Downed Slayers:** a Slayer at 0 HP spectates; if the partner clears the floor they return on the next floor with half HP.
- **Cheat mode (`C`):** applies to the **whole team**: unlimited Energy, no damage taken, triple damage. A "CHEAT MODE ACTIVE" label shows at the top left and the partner sees who switched it. Runs that used cheat mode are not ranked.

## Game over and the leaderboard

The result screen shows Victory or Defeat, floors cleared, run time and, for each Slayer, damage dealt, damage blocked, cards played and survival time, plus the run's leaderboard rank. **Play again** starts a new run (a rematch with the same partner in co-op) and **Home** returns to the lobby.
The **Hall of Slayers** in the lobby shows the top 10 runs of all players; **solo and co-op runs share one board** (one name is a solo run, two names a team run). Runs are ranked best first by:
1. a win beats any loss;
2. more floors cleared;
3. wins: the faster time, then more total damage. Losses: more total damage, then the faster time.

Runs that used cheat mode, or where nobody played a card, are not saved. The best 100 runs are kept in `data/leaderboard.json`.

## How it works

- **Server-authoritative game:** `server/game.js` runs every battle, solo and co-op, on the server (hands, Energy, HP, cooldowns, damage, rewards, timers, results). Browsers only send intents (play a slot, pick a reward, toggle cheat) and draw the snapshots they receive over Socket.IO, so a browser cannot report a score or change a result.
- **Accounts and sessions:** register / sign in with argon2-hashed passwords, a server-side session (15 minutes, kept alive while a page is open), input validation on client and server, and a limiter for repeated failed sign-ins. Socket.IO shares the same session, so only signed-in users can connect.
- **Lobby:** live room list, create / join a room, ready buttons, a 3-2-1 countdown, a 10 second grace period if a player's connection drops (the game waits and shows a banner) and automatic return to the room or game after a page refresh.
- The shared game numbers (`public/scripts/game_data.js`) are used by both the server and the browser. The message list is in `docs/multiplayer-protocol.md`.

## Files

- **game_server.js** - Express app: register, sign in, validate, guide-complete, sign out, `/leaderboard`, sign-in limits, Socket.IO setup (shares the login session)
- **server/store.js** - JSON data files in `data/` (created if missing, atomic writes)
- **server/ratelimit.js** - "too many failed attempts" limiter
- **server/lobby.js** - rooms, pairing, ready, countdown, rejoin and grace period, starting and finishing games
- **server/game.js** - the authoritative battle for one room (solo or co-op)
- **server/leaderboard.js** - ranking rules, cleaning of results, saving the best runs
- **public/index.html, style.css** - all pages: sign-in / register, How to Play, lobby, room, battle, game over
- **public/scripts/game_room.js** - accounts and sessions in the browser; **howto.js** - How to Play guide; **lobby.js** - lobby, rooms, Hall of Slayers, music; **game.js** - battle canvas, sprites, effects, sound; **game_data.js** - shared card, enemy and balance data; **gameover.js** - result screen
- **public/images/** - backgrounds, sprites, card art; **images/howto/** - the GIFs and screenshots used by How to Play, recorded from the game
- **public/sounds/** - `lobby_theme.mp3` (lobby music), `boss_music_1.mp3` (battle music) and the short effect sounds `attack.wav`, `block.wav`, `hit.wav`, `reward.wav`, `victory.wav`, `defeat.wav`, `error.wav` (generated by us)
- **test/** - `leaderboard.test.js`, `game.test.js`, `platform.test.js`
- **docs/multiplayer-protocol.md** - Socket.IO events and the result format
- **data/** - `users.json` (accounts) and `leaderboard.json` (best runs); both are created automatically if missing

## Tests

`npm test` runs three suites and prints PASS / FAIL lines: the ranking rules and file handling, the battle rules (fast-forwarded: rewards, downed players, cheat, defeat results), and the platform (accounts, sessions, rooms, rejoin, solo and co-op runs through a real server on port 8123 with a temporary data folder).

## Starting fresh

To clear all accounts and scores, stop the server and delete `data/users.json` and `data/leaderboard.json` (or set them to `{}` and `[]`).

## Credits

Account and session infrastructure adapted from COMP4021 Labs 5 (accounts) and 6 (Socket.IO lobby). Game design, rules, balance and the battle code are our own. Libraries: Express, express-session, argon2, Socket.IO, jQuery 3.7.1 (loaded from the jQuery CDN, with a copy in `public/scripts/` that is used automatically if the CDN cannot be reached).
