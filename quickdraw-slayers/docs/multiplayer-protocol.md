# Multiplayer protocol (contract for `server/game.js`)

This file describes what the platform (sign-in, lobby, rooms, leaderboard, result screen) already does, and the
few things the server-side game has to do to plug in. Everything outside `server/game.js` should not need to change.

## 1. Who does what

| Part | File | Status |
|---|---|---|
| Accounts, sessions, sign-in | `game_server.js`, `server/store.js` | done |
| Lobby, rooms, ready, countdown, rejoin | `server/lobby.js` | done |
| **Game logic for a room (server-authoritative)** | `server/game.js` | **stub, to write** |
| Leaderboard (ranking, saving) | `server/leaderboard.js` | done |
| Result screen | `public/scripts/gameover.js` | done |
| Game rendering and input | `public/scripts/game.js` | solo works; needs to follow server state |

## 2. Lifecycle of a room

1. Players create or join a room, both press Ready, a 3-2-1 countdown runs.
2. `lobby.js` calls `Game.create(io, room, onOver)` and then `game.start()`; it also emits `game:start` to the room.
3. While `room.status === "playing"` the game runs. Clients send actions, the server answers with state.
4. The game ends in one of two ways:
   - **Normal end** (win, defeat, time out): call `onOver(result)` once (shape in section 4).
   - **A player leaves for good**: `lobby.js` calls `game.playerLeft(player)`. The stub ends the room without a result, so nothing is saved.
5. `lobby.js` saves the result, emits `game:over` to the room and puts the room back to `lobby` status.

The `game` object returned by `create` must have: `start()`, `playerLeft(player)`, `playerRejoined(player)`, `stop()`.
`stop()` must clear every timer. Never keep game state in module-level variables: there can be several rooms at once.

## 3. Rules for everything the game sends and receives

- Send only to the room: `io.to(room.id).emit(...)`. Never `io.emit` (that reaches every room).
- The browser is not trusted. The server decides damage, HP, Energy, cooldowns, hands, rewards and the timer.
  The browser sends only *intent* ("play the card in slot 2"), never results ("deal 40 damage").
- Check every payload: type, range (slot 0-3, reward is one of `card|buff|heal`), and that the player belongs to the room and
  the action is allowed right now (enough Energy, card in hand, reward screen open, game still running).
- Use the existing `on(event, handler)` wrapper in `lobby.js` for new events: it catches errors and the 60 events/s limit applies.
- Cheat mode (`C`) is a toggle that affects the whole team (see the announcement). It must be switched on the server and
  announced to the partner (`game:cheat {on, by}`), otherwise the partner would not see the notice the rubric asks for.

## 4. The result object (what you pass to `onOver`)

```js
onOver({
    won: true,              // true only when all 3 floors were cleared
    floors: 3,              // floors cleared, 0 to 3
    durationMs: 187000,     // how long the run lasted
    players: [              // 1 or 2 entries
        { username: "alice", name: "Alice",
          damage: 812,      // damage dealt to enemies
          blocked: 95,      // damage her Shield soaked up
          cards: 31,        // cards played
          survivalMs: 187000 }  // how long she stayed alive
    ]
});
```

`lobby.js` forces `username` and `name` from the account, clamps every number (see `server/leaderboard.js`), saves the run,
and emits `game:over { entry, rank, total }` to the room. `rank` is null if the run did not make the top 100.
Call `onOver` only once per game (a second call for the same room is ignored).

## 5. Ranking rule

1. A win beats a loss.
2. More floors cleared beats fewer.
3. Wins: shorter total time first, then more total damage.
4. Losses: more total damage first, then shorter time.

## 6. Recommended messages (you may rename them, but keep client and server in sync)

Server to clients:

| Event | Payload | When |
|---|---|---|
| `game:start` | `{ you, players, seed }` | already sent by the lobby |
| `game:state` | full snapshot (below), about 10 per second, or on change | during play |
| `game:effect` | `{ type: "hit"\|"block"\|"heal"\|"floor", ... }` | animation and sound cues |
| `game:cheat` | `{ on, by }` | cheat toggled |
| `game:over` | `{ entry, rank, total }` | already sent by the lobby |

A snapshot is the whole truth, so a player who reconnects can be caught up with one message:

```js
{ t: 183000, floor: 2, timeLeft: 57000,
  enemy: { id, hp, maxHp, nextAttackIn },
  players: [{ username, hp, shield, energy, energyMax, hand: [cardIds], cooldowns: [...] }],
  reward: null | { options: [...] },
  cheat: false }
```

Clients to server:

| Event | Payload | Notes |
|---|---|---|
| `game:play` | `{ slot: 0..3 }` | play the card in that hand slot |
| `game:reward` | `{ choice: "card"\|"buff"\|"heal", slot? }` | only while a reward is open |
| `game:cheat` | `{ on: boolean }` | toggle with `C` |

## 7. Disconnects and rejoin

`lobby.js` already keeps a player's seat for `GRACE_MS` after a drop and calls `playerRejoined(player)` when they come back.
While a player is away: pause that player's timers (or keep them running, but say which in the announcement), and show the
partner a "partner reconnecting" notice. On rejoin, send a fresh `game:state` to that socket only.
If the grace period ends, `lobby.js` calls `playerLeft`, and the room ends without a saved result.

## 8. The temporary `game:report` event

Solo still runs in the browser, so `public/scripts/game.js` sends `game:report` with its result and `lobby.js` accepts it
only for a one-player room that is playing. Two-player results never come from a browser. When solo also runs on the
server, delete the `game:report` handler in `lobby.js` and the one `socket.emit("game:report", ...)` line in `game.js`,
and remove the matching checks in `test/platform.test.js`.

## 9. Testing

`npm test` runs `test/leaderboard.test.js` (ranking, cleaning, saving) and `test/platform.test.js` (accounts, lobby, rooms,
rejoin, leaderboard). Add a test per rule you implement: for example, a player who sends `game:play` with `slot: 99` gets ignored,
and a play with too little Energy changes nothing.
