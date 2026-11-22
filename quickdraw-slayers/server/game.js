// Lifecycle boundary for ONE room. Multiplayer combat remains unimplemented; when both
// players are ready, the clients run the local gameplay prototype.
//
// The lobby calls these methods; the game calls onOver() when it has finished:
//   start()                             the countdown ended
//   playerLeft(socketId)                a player left for good (or did not come back in time)
//   playerRejoined(oldId, newId)        a player's browser reconnected (refresh / new tab); their socket id changed
//   stop()                              the room is being removed: clear every timer here
//
// Future multiplayer state, timers, cards, enemies and game-over events belong here. Every
// server message must be scoped with io.to(room.id).emit(...), never a global player list.
function create(io, room, onOver) {
    return {
        start() {},
        // For now a player leaving simply ends the "game" and sends the remaining player back to the room
        playerLeft(socketId) { if (onOver) onOver(); },
        playerRejoined(oldSocketId, newSocketId) {},
        stop() {}
    };
}

module.exports = { create };
