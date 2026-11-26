# Multiplayer protocol

The lobby owns accounts and rooms. Combat is owned by `server/game.js`, which is authoritative for
hands, Energy, HP, cooldowns, damage, rewards, the master timer, and results, for solo (one Slayer) and co-op (two Slayers) alike. A browser never reports a result.

## 1. Who does what

| Part | File | Status |
|---|---|---|
| Accounts, sessions, sign-in | `game_server.js`, `server/store.js` | done |
| Lobby, rooms, ready, countdown, rejoin | `server/lobby.js` | done |
| **Game logic for a room (server-authoritative)** | `server/game.js` | done |
| Leaderboard (ranking, saving) | `server/leaderboard.js` | done |
| Result screen | `public/scripts/gameover.js` | done |
| Game rendering and input | `public/scripts/game.js` | draws server snapshots/effects (solo and co-op) |
| Shared combat definitions | `public/scripts/game_data.js` | done |

## 2. Lifecycle of a room

1. Players create or join a room, both press Ready, a 3-2-1 countdown runs.
2. `lobby.js` emits `game:start`, then calls `Game.create(io, room, onOver)` and `game.start()`.
3. While `room.status === "playing"` the game runs. Clients send actions, the server answers with state.
4. The game ends in one of two ways:
   - **Normal end** (win, defeat, time out): call `onOver(result)` once (shape in section 4).
   - **A player leaves for good**: `lobby.js` calls `game.playerLeft(player)`. The game aborts without a result.
5. `lobby.js` saves a normal result, emits `game:over`, and puts the room back to `lobby` status.

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

Two-player enemies use `1 + 0.8 * (playerCount - 1)` health and
`1 + 0.25 * (playerCount - 1)` damage. With two players this is 1.8x HP and 1.25x damage. Attacks rotate
between connected, living Slayers; if one Slayer is temporarily away, the other is the target. A downed
Slayer returns with half HP on the next floor (a "Rest" or "Train" reward chosen while down does not change that),
while both Slayers down is a defeat.

On screen, each server seat is always the same character on every client: seat 0 (the player who created the room) is
the straw-hat Grade Farmer on the left, seat 1 is the Deadline Fighter on the right. Each client still keeps its own
Slayer's hand and HUD first, and labels the characters "YOU · name" and the partner's name.

## 4. The result object (what you pass to `onOver`)

```js
onOver({
    won: true,              // true only when all 3 floors were cleared
    floors: 3,              // floors cleared, 0 to 3
    durationMs: 187000,     // how long the run lasted
    cheated: false,         // true if cheat mode was switched on at any point (the run is then not ranked)
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
and emits `game:over { entry, rank, total, unranked }` to the room. `rank` is null if the run did not make the top 100.
`unranked` is `"cheat"` (cheat mode was used) or `"idle"` (nobody played a card) when the run is shown to the players but
deliberately **not** saved on the leaderboard; otherwise it is null.
Call `onOver` only once per game (a second call for the same room is ignored).

## 5. Ranking rule

1. A win beats a loss.
2. More floors cleared beats fewer.
3. Wins: shorter total time first, then more total damage.
4. Losses: more total damage first, then shorter time.

## 6. Messages

Server to clients:

| Event | Payload | When |
|---|---|---|
| `game:start` | `{ you, players, seed }` | already sent by the lobby |
| `game:state` | full snapshot (below), 10 per second and on actions | during play |
| `game:effect` | `{ type: "hit"\|"block"\|"heal"\|"floor", ... }` | animation and sound cues |
| `game:cheat` | `{ on, by }` | cheat toggled |
| `game:over` | `{ entry, rank, total }` | already sent by the lobby |

A snapshot is the whole truth, so a player who reconnects can be caught up with one message:

```js
{ t: 183000, floor: 2, status: "active", timeLeft: 57000, rewardEndsIn: 0,
  enemy: { id, hp, maxHp, nextAttackIn, vulnerableRemaining, weaknessAttacks },
  players: [{ username, hp, shield, energy, energyMax, hand: [cardIds], cooldowns: [...], rewardChoice, away, awayEndsIn }],
  scaling: { playerCount: 2, health: 1.8, damage: 1.25 },
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
While a player is away, their Energy recovery pauses and attacks target the connected partner while possible. The
master timer and enemy cadence continue. `awayEndsIn` (ms) is how long their seat is still held; the client shows it in a
"Bob lost connection… 7s" banner. On rejoin, send a fresh `game:state` to that socket only.
If the grace period ends, `lobby.js` calls `playerLeft`, and the room ends without a saved result.

## 8. Solo

A solo run is the same game with one Slayer: `lobby:solo` makes a one-player room and `server/game.js` runs it exactly
like a co-op room (scaling 1x HP and 1x damage). The browser cannot send a score: there is no `game:report` event, so a
leaderboard entry can only come from `onOver(result)`.

## 9. Testing

`npm test` runs leaderboard tests plus the platform integration harness. The platform test covers room-scoped state,
invalid intents, independent actions, cooldowns, scaled health and actual attack damage, team cheat, and rejoin snapshots.
