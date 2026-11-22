# COMP4021 Final Project

## 1. Title of the Game

QuickDraw Slayers

## 2. Game Home Page

The home page explains the game and how to play it. It includes guidelines on how the game system works, how each enemy’s fixed-duration attack timer operates, and how players coordinate defence and offence together. It also has a how-to-play section with screenshots/GIFs of each action.

The game is not turn-based. It is a real-time co-op card battle, and every card takes effect the moment a player plays it.

Players register an account (username, display name, password, confirm password) with client- and server-side validation:

- No empty fields
- Usernames limited to letters, numbers, and underscores
- Duplicate usernames rejected
- Passwords must match

Sign-in shows a clear error for wrong details, and the login session is kept across page reloads with a Sign Out button, so we have persistent browser session management.

After signing in, players enter a live Socket.IO queue/lobby where they see each other’s name and ready status in real time. If a player enters the lobby and nobody is available, show a message such as “Waiting for another Slayer…” rather than leaving them on an empty screen. When both click Ready, a countdown launches the game.

## 3. Game Play Page

We will use an HTML5 canvas rendering loop with animated character sprites, floating damage numbers, visual card feedback, and background music plus sound effects.

### Game elements

- **Players:** two cooperating avatars, each with an independent HP bar, a Shield/Block meter, and a custom hand of cards.
- **Enemies:** the game has several enemy types/variants. Each game run randomly selects three of them in a random order, one per floor, and each floor’s enemy gets progressively stronger as the players progress. Enemies telegraph upcoming attacks with a live countdown timer bar and periodically fire attacks or spawn hazards.
- **Cards:** each player can only hold 4 cards at a time. A new card is drawn to replace the one just played, from a pool of pre-determined cards that includes standard attacks, blocking, and special buffs/debuffs.
- **Projectiles/hazards:** card attacks travel from the players to the enemy, and enemy attacks and hazards travel toward the players. They are animated and interact with the characters through damage and blocking.

### How to play

There are no turns. Both players act at the same time over WebSockets. Each player has an Energy bar (max 3 on floor 1, 4 on floor 2, and 5 on floor 3) that refills 1 Energy every 2.5 seconds, and cards cost different amounts of Energy.

Players click a card or press keyboard keys 1, 2, 3, or 4 to play it immediately. Playing a card animates a projectile or shield on both screens instantly. Players coordinate combos to maximise damage and protection. For example, one player applies a debuff and the partner follows with a high-damage attack, or one player shields while the other attacks.

### Between floors

After defeating the floor 1 and floor 2 enemies, a 5-second overlay lets each player choose a new card, a buff, or a heal before the next enemy spawns. The 4-minute master timer is paused during this overlay.

### Downed players

If one player’s HP drops to 0 while the partner is alive, the fallen player spectates. If the surviving player defeats the floor’s enemy, the fallen player is revived for the next floor.

### Win condition

Defeat the enemies on all 3 floors before the master timer (4 minutes) expires.

### Lose condition

Either both players’ HP drops to 0, or the master timer reaches 00:00 before the floor 3 enemy is defeated.

## 4. Game Over Page

When a run ends, players see the appropriate Game Over screen (Victory or Defeat) and the game duration. It shows side-by-side performance metrics for Player 1 and Player 2:

- Total Damage Dealt
- Incoming Attacks Blocked
- Number of Cards Played
- Survival Time (how long the player survived)

An overall leaderboard ranks the players by contribution score (damage dealt + attacks blocked + cards played), alongside historical high scores stored on the server. Quick buttons let players Restart/Rematch with the same partner or Return to the Home Page.

## 5. Cheating (Cheat Mode)

Pressing C turns Cheat Mode on or off for the player who pressed it. A “CHEAT MODE ACTIVE” label shows at the top left while it is on, and the partner sees a notice. It gives infinite Energy, zero damage taken, and 3× damage so all 3 floors can be cleared quickly.
