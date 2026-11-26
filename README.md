# COMP4021 Final Project

## 1. Title of the Game

QuickDraw Slayers

The game lives in the `quickdraw-slayers/` folder. To run it: `cd quickdraw-slayers`, `npm install`, `node game_server.js`, then open http://localhost:8000 (details and the file list are in `quickdraw-slayers/README.html`).

## 2. Game Home Page

The home page explains the game and how to play it. A How to Play guide of 12 pages (plus a Cards tab and an Enemies tab) covers how the game system works, how each enemy's attack timer operates, and how players coordinate defence and offence together. Its pages have GIFs and screenshots recorded from the real game for each action. New players must go through the basics before they can sign in, and the guide can be reopened at any time with the **?** button.

The game is not turn-based. It is a real-time card battle for one or two players, and every card takes effect the moment a player plays it.

Players register an account (username, display name, password, confirm password) with client- and server-side validation:

- No empty fields
- Usernames limited to letters, numbers, and underscores
- Duplicate usernames rejected
- Passwords must match

Passwords are hashed with argon2, and repeated failed sign-ins are rate limited. Sign-in shows a clear error for wrong details, and the login session is kept across page reloads (15 minutes, kept alive while a page is open) with a Sign Out button, so we have persistent browser session management.

After signing in, players reach the lobby and choose **Play Solo** (the run starts straight away) or **Create Room** / join an open room for co-op. In a room, a live Socket.IO connection shows both players' names and ready status in real time. If nobody has joined yet, the room says "Waiting for another Slayer…". When both click Ready, a 3-2-1 countdown launches the game. The lobby also shows the **Hall of Slayers** leaderboard.

## 3. Game Play Page

An HTML5 canvas rendering loop draws animated character sprites, floating damage numbers and visual card feedback, with background music (lobby and battle tracks) plus sound effects. A Sound on/off button works in both the lobby and the game.

### Game elements

- **Players:** one Slayer in solo, two cooperating Slayers in co-op, each with an independent HP bar, a Shield meter, an Energy bar and a hand of cards. The room creator is the straw-hat Slayer on the left, the second player the shield Slayer on the right, on both screens.
- **Enemies:** three bosses (Campus Typhoon, Feral Firebird, Thesis Dragon), one per floor, met in a random order each run. Each floor's enemy is stronger than the last (more HP and harder hits), and in co-op bosses have 80% more HP and deal 25% more damage. Enemies telegraph their attacks with a live countdown timer bar, and each attack hits one Slayer (the attacks take turns between Slayers in co-op).
- **Cards:** each player holds 4 cards at a time. A new card is drawn to replace the one just played, from a pool of 10 cards that includes attacks, blocks, and special buffs/debuffs.
- **Projectiles/hazards:** card attacks travel from the players to the enemy, and enemy attacks travel toward the players. They are animated and interact with the characters through damage and blocking.

### How to play

There are no turns. Both players act at the same time over WebSockets, and the battle itself runs on the server (a browser only sends what the player did and draws what the server sends back). Each player has an Energy bar (max 4 on floor 1, 5 on floor 2, and 6 on floor 3, full at the start of each floor) that refills 1 Energy every 1.8 seconds, and cards cost different amounts of Energy.

Players click a card or press keyboard keys 1, 2, 3, or 4 to play it immediately. Playing a card animates a projectile or shield on both screens instantly. Players coordinate combos to maximise damage and protection. For example, one player applies a debuff and the partner follows with a high-damage attack, or one player shields while the other attacks. Playing Group Project or Bell Curve and then attacking within about 2 seconds gives a +25% "setup combo".

### Between floors

After defeating the floor 1 and floor 2 enemies, a 5-second overlay lets each player choose a new card, a buff (+12% damage, +10 max HP), or a heal (+40 HP) before the next enemy spawns. The 4-minute master timer is paused during this overlay.

### Downed players

If one player's HP drops to 0 while the partner is alive, the fallen player spectates. If the surviving player defeats the floor's enemy, the fallen player is revived for the next floor with half HP. If a player's connection drops, the game waits 10 seconds for them to come back.

### Win condition

Defeat the enemies on all 3 floors before the master timer (4 minutes) expires.

### Lose condition

Either all Slayers' HP drops to 0, or the master timer reaches 00:00 before the floor 3 enemy is defeated.

## 4. Game Over Page

When a run ends, players see the appropriate Game Over screen (Victory or Defeat), the floors cleared and the game duration. It shows side-by-side performance metrics for each Slayer:

- Total Damage Dealt
- Incoming Attacks Blocked
- Number of Cards Played
- Survival Time (how long the player survived)

The Hall of Slayers leaderboard (shown in the lobby, and as the run's rank on this screen) ranks solo and co-op runs together, and each row is marked SOLO or TEAM. A win beats a loss, then more floors cleared, then for wins the faster time (then more damage) and for losses more total damage (then the faster time). The best 100 runs are stored on the server; runs that used cheat mode, or where nobody played a card, are not ranked. Quick buttons let players Play again (a rematch with the same partner in co-op) or return Home to the lobby.

## 5. Cheating (Cheat Mode)

Pressing C turns Cheat Mode on or off for the whole team. A "CHEAT MODE ACTIVE" label shows at the top left while it is on, and the partner sees a notice saying who changed it. It gives infinite Energy, zero damage taken, and 3x damage so all 3 floors can be cleared quickly. Runs that used cheat mode are not put on the leaderboard.

## 6. Tests

`npm test` (inside `quickdraw-slayers/`) runs automated checks for the leaderboard ranking, the battle rules (rewards, downed players, cheat mode, results) and the platform (accounts, sessions, rooms, reconnecting, solo and co-op runs).
