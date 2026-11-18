// Lobby, rooms and pairing (the Lab 6 join / ready / start flow, but PER ROOM).
//
// Rule for the whole project: there is NO global "players" object.
// Everything lives inside a room object, and every message is sent with
// io.to(room.id).emit(...) so two pairs playing at once never see each other.
//
// Socket.IO events (client -> server):
//   room:create {name?}   create a room and sit in it
//   room:join   roomId    join an open room
//   room:quick            join the first open room, or create one
//   room:leave            leave the room
//   lobby:ready bool?     set (or toggle) your ready flag
//   game:play   slot      play the card in hand slot 0-3
//   game:cheat  bool      switch your cheat mode on/off
//   game:rematch          vote for a rematch (game over page)
//   rooms:request         ask for the open-room list again
// Socket.IO events (server -> client):
//   rooms:list [{id,name,count,max}]
//   room:update {id,name,status,players:[{username,name,avatar,ready}]}
//   room:countdown {seconds} / room:countdown_cancel
//   room:rematch {count,needed}
//   room:left / room:error "message"
//   game:start {roomId, players}   (then game:state / game:hand / game:event / game:over, see game.js)
const Game = require("./game");

const MAX_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;

module.exports = function(io) {
    const rooms = new Map();      // roomId   -> room
    const userRoom = new Map();   // username -> roomId  (one room per account)
    let roomCounter = 0;

    const cleanName = (text, fallback) => {
        const t = String(text == null ? "" : text).replace(/[^\w '.-]/g, "").trim().slice(0, 20);
        return t || fallback;
    };

    const roomInfo = (room) => ({
        id: room.id, name: room.name, status: room.status,
        players: room.players.map(p => ({ username: p.username, name: p.name, avatar: p.avatar, ready: p.ready }))
    });

    const listRooms = () => [...rooms.values()]
        .filter(r => r.status === "lobby" && r.players.length < MAX_PLAYERS)
        .map(r => ({ id: r.id, name: r.name, count: r.players.length, max: MAX_PLAYERS }));

    const sendRooms = (target) => (target || io.to("lobby")).emit("rooms:list", listRooms());
    const sendRoom = (room) => io.to(room.id).emit("room:update", roomInfo(room));

    const createRoom = (user, name) => {
        roomCounter++;
        const room = {
            id: "r" + roomCounter,
            name: cleanName(name, user.name + "'s room"),
            players: [], status: "lobby", countdown: null, game: null, rematch: new Set()
        };
        rooms.set(room.id, room);
        return room;
    };

    const joinError = (socket, room) => {
        const user = socket.data.user;
        if (socket.data.roomId) return "You are already in a room.";
        if (userRoom.has(user.username)) return "You are already in a room in another tab or window.";
        if (!room) return "That room no longer exists.";
        if (room.status !== "lobby") return "A game is already running in that room.";
        if (room.players.length >= MAX_PLAYERS) return "That room is full.";
        return null;
    };

    const joinRoom = (socket, room) => {
        const user = socket.data.user;
        socket.leave("lobby");
        socket.join(room.id);
        socket.data.roomId = room.id;
        userRoom.set(user.username, room.id);
        room.players.push({ socketId: socket.id, username: user.username, name: user.name, avatar: user.avatar, ready: false });
        sendRoom(room);
        sendRooms();
    };

    const cancelCountdown = (room) => {
        if (!room.countdown) return;
        clearInterval(room.countdown);
        room.countdown = null;
        if (room.status === "countdown") room.status = "lobby";
        io.to(room.id).emit("room:countdown_cancel");
    };

    const destroyRoom = (room) => {
        cancelCountdown(room);
        if (room.game) room.game.stop();
        rooms.delete(room.id);
    };

    const leaveRoom = (socket, notify) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        const user = socket.data.user;

        const idx = room.players.findIndex(p => p.socketId === socket.id);
        if (idx !== -1) room.players.splice(idx, 1);
        userRoom.delete(user.username);
        room.rematch.delete(user.username);
        socket.leave(room.id);
        socket.data.roomId = null;

        if (room.players.length === 0) {
            destroyRoom(room);
        } else {
            cancelCountdown(room);
            if (room.status === "playing" && room.game) {
                room.game.playerLeft(socket.id);          // ends the game
            } else if (room.status !== "over") {
                room.status = "lobby";
            }
            room.players.forEach(p => { p.ready = false; });
            sendRoom(room);
        }
        sendRooms();

        if (notify) {
            socket.join("lobby");
            socket.emit("room:left");
            sendRooms(socket);
        }
    };

    const startGame = (room) => {
        room.status = "playing";
        room.rematch.clear();
        sendRooms();
        io.to(room.id).emit("game:start", {
            roomId: room.id,
            players: room.players.map(p => ({ username: p.username, name: p.name, avatar: p.avatar }))
        });
        room.game = Game.create(io, room, () => {
            room.status = "over";
            room.players.forEach(p => { p.ready = false; });
            sendRoom(room);
        });
        room.game.start();
    };

    const startCountdown = (room) => {
        cancelCountdown(room);
        room.status = "countdown";
        let seconds = COUNTDOWN_SECONDS;
        io.to(room.id).emit("room:countdown", { seconds });
        sendRoom(room);
        sendRooms();
        room.countdown = setInterval(() => {
            seconds--;
            if (seconds > 0) {
                io.to(room.id).emit("room:countdown", { seconds });
            } else {
                clearInterval(room.countdown);
                room.countdown = null;
                startGame(room);
            }
        }, 1000);
    };

    io.on("connection", (socket) => {
        const user = socket.data.user;
        console.log("Player connected:", user.username, socket.id);

        socket.data.roomId = null;
        socket.join("lobby");
        sendRooms(socket);

        socket.on("rooms:request", () => sendRooms(socket));

        socket.on("room:create", (data) => {
            const err = joinError(socket, { status: "lobby", players: [] });
            if (err) { socket.emit("room:error", err); return; }
            joinRoom(socket, createRoom(user, data && data.name));
        });

        socket.on("room:join", (roomId) => {
            const room = rooms.get(roomId);
            const err = joinError(socket, room);
            if (err) { socket.emit("room:error", err); return; }
            joinRoom(socket, room);
        });

        socket.on("room:quick", () => {
            const open = [...rooms.values()].find(r => r.status === "lobby" && r.players.length < MAX_PLAYERS);
            const err = joinError(socket, open || { status: "lobby", players: [] });
            if (err) { socket.emit("room:error", err); return; }
            joinRoom(socket, open || createRoom(user));
        });

        socket.on("room:leave", () => leaveRoom(socket, true));

        socket.on("lobby:ready", (value) => {
            const room = rooms.get(socket.data.roomId);
            if (!room || room.status === "playing" || room.status === "over") return;
            const me = room.players.find(p => p.socketId === socket.id);
            if (!me) return;
            me.ready = (typeof value === "boolean") ? value : !me.ready;
            if (!me.ready) cancelCountdown(room);
            sendRoom(room);
            if (room.players.length === MAX_PLAYERS && room.players.every(p => p.ready) && room.status === "lobby") {
                startCountdown(room);
            }
        });

        // Game messages only reach the game of the sender's own room
        socket.on("game:play", (slot) => {
            const room = rooms.get(socket.data.roomId);
            if (room && room.game && room.status === "playing") room.game.play(socket.id, slot);
        });

        socket.on("game:cheat", (on) => {
            const room = rooms.get(socket.data.roomId);
            if (room && room.game && room.status === "playing") room.game.setCheat(socket.id, on);
        });

        socket.on("game:rematch", () => {
            const room = rooms.get(socket.data.roomId);
            if (!room || room.status !== "over" || room.players.length < MAX_PLAYERS) return;
            room.rematch.add(user.username);
            io.to(room.id).emit("room:rematch", { count: room.rematch.size, needed: MAX_PLAYERS });
            if (room.rematch.size >= MAX_PLAYERS) {
                room.rematch.clear();
                startCountdown(room);
            }
        });

        socket.on("disconnect", () => {
            console.log("Player disconnected:", user.username, socket.id);
            leaveRoom(socket, false);
        });
    });
};
