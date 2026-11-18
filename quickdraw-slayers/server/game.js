// Game logic for ONE room. Intentionally empty for now: when both players are ready and the
// countdown ends, the lobby calls create() and start(), and the browsers show a blank page.
//
// The lobby calls these methods; the game calls onOver() when it has finished:
//   start()                             the countdown ended
//   playerLeft(socketId)                a player left for good (or did not come back in time)
//   playerRejoined(oldId, newId)        a player's browser reconnected (refresh / new tab); their socket id changed
//   stop()                              the room is being removed: clear every timer here
//
// TODO (group): the server-authoritative game goes here (state, timers, cards, enemies, game over).
// Every message must be sent to this room only: io.to(room.id).emit(...)
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
