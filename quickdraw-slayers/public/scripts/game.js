// Game page client. Blank for now: the lobby calls Game.start(socket) when the game starts.
// TODO (group): draw on #game-canvas, listen for the server's game events, send the player's actions.
const Game = (function() {
    const start = function(socket) {};
    const stop = function() {};
    return { start, stop };
})();
