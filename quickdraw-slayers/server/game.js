// Game logic for ONE room. Intentionally empty for now: when both players are ready and the
// countdown ends, the lobby calls create() and start(), and the browsers show a blank page.
//
// TODO (group): the server-authoritative game goes here (state, timers, cards, enemies, game over).
// Every message must be sent to this room only: io.to(room.id).emit(...)
function create(io, room, onOver) {
    return {
        start() {},
        playerLeft(socketId) {},
        stop() {}
    };
}

module.exports = { create };
