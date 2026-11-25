// Lobby, rooms and pairing (the Lab 6 join / ready / start flow, but PER ROOM).
//
// Rule for the whole project: there is NO global "players" object.
// Everything lives inside a room object, and every message is sent with
// io.to(room.id).emit(...) so two pairs playing at once never see each other.
//
// Connections
//   - One live connection per account: a newer connection (another tab, a refresh) replaces the older
//     one. The older one gets "session:replaced" and is disconnected; the seat in a room moves over.
//   - A refresh or a dropped connection does not kick a player out at once: their seat is kept for
//     GRACE_MS (10 s). If they reconnect in time they are back in the same room (and game).
//   - Signing out, or leaving with the Leave button, removes the player immediately.
//
// Socket.IO events (client -> server):
//   room:create {name?}   create a room and sit in it
//   room:join   roomId    join an open room
//   room:leave            leave the room
//   lobby:ready bool?     set (or toggle) your ready flag
//   lobby:solo            start a one-player run
//   game:report result    TEMPORARY, solo only: the browser reports its own solo result (see below)
//   rooms:request         ask for the open-room list again
// Socket.IO events (server -> client):
//   rooms:list [{id,name,count,max}]
//   room:update {id,name,status,players:[{username,name,ready,away}]}
//   room:notice {type,username,name}   type: joined | left | away | back | ready | unready | countdown_cancelled
//   room:countdown {seconds} / room:countdown_cancel
//   room:left / room:error "message"
//   session:replaced                   this account connected somewhere else
//   game:start {roomId, players}       the game begins
//   game:over {entry, rank, total}     the run was saved: the final result and where it ranks on the leaderboard
const Game = require("./game");
const leaderboard = require("./leaderboard");

const MAX_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const GRACE_MS = Number(process.env.GRACE_MS) || 10000;     // how long a dropped player's seat is kept
const SWEEP_MS = 30000;                                      // how often stale rooms are cleaned up
const MAX_EVENTS_PER_SECOND = 60;                            // per socket; more than this is ignored

module.exports = function(io) {
    const rooms = new Map();        // roomId   -> room
    const userRoom = new Map();     // username -> roomId   (one room per account)
    const userSocket = new Map();   // username -> socket id of the live connection
    let roomCounter = 0;

    // ---------- small helpers ----------

    const cleanName = (text, fallback) => {
        const t = String(text == null ? "" : text).replace(/[^\w '.-]/g, "").trim().slice(0, 20);
        return t || fallback;
    };
    const isRoomId = (value) => typeof value === "string" && /^r\d{1,9}$/.test(value);

    const roomInfo = (room) => ({
        id: room.id, name: room.name, status: room.status,
        players: room.players.map(p => ({ username: p.username, name: p.name, ready: p.ready, away: p.away }))
    });

    const listRooms = () => [...rooms.values()]
        .filter(r => r.status === "lobby" && r.players.length < MAX_PLAYERS)
        .map(r => ({ id: r.id, name: r.name, count: r.players.length, max: MAX_PLAYERS }));

    const sendRooms = (target) => (target || io.to("lobby")).emit("rooms:list", listRooms());
    const sendRoom = (room) => io.to(room.id).emit("room:update", roomInfo(room));
    const notify = (room, type, player) =>
        io.to(room.id).emit("room:notice", { type, username: player ? player.username : null, name: player ? player.name : null });

    const createRoom = (user, name) => {
        roomCounter++;
        const room = {
            id: "r" + roomCounter,
            name: cleanName(name, user.name + "'s room"),
            players: [],            // [{ socketId, username, name, ready, away, awayTimer }]
            status: "lobby",        // lobby -> countdown -> playing -> (back to lobby when the game is over)
            countdown: null,
            countdownSeconds: 0,
            game: null
        };
        rooms.set(room.id, room);
        return room;
    };

    // Returns an error message if this socket may not join, otherwise null
    const joinError = (socket, room) => {
        if (socket.data.roomId) return "You are already in a room.";
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
        const player = { socketId: socket.id, username: user.username, name: user.name, ready: false, away: false, awayTimer: null };
        room.players.push(player);
        notify(room, "joined", player);
        sendRoom(room);
        sendRooms();
    };

    // ---------- countdown ----------

    const cancelCountdown = (room, announce) => {
        if (!room.countdown) return;
        clearInterval(room.countdown);
        room.countdown = null;
        if (room.status === "countdown") room.status = "lobby";
        io.to(room.id).emit("room:countdown_cancel");
        if (announce) notify(room, "countdown_cancelled", null);
    };

    // A run has ended. Save the result on the leaderboard and tell everybody in the room where they ranked.
    // `result` is { won, floors, durationMs, players: [...] } (see docs/multiplayer-protocol.md).
    // A broken leaderboard file must never break the game, so any error is only logged.
    const saveResult = (room, result) => {
        if (!result || room.resultSaved) return;
        room.resultSaved = true;
        try {
            const saved = leaderboard.record(result);
            if (saved) {
                const reason = typeof result.reason === "string"
                    ? result.reason.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100)
                    : "";
                io.to(room.id).emit("game:over", {
                    entry: reason ? { ...saved.entry, reason } : saved.entry,
                    rank: saved.rank,
                    total: saved.total
                });
            }
        } catch (err) {
            console.error("Could not save the result:", err);
        }
    };

    const startGame = (room) => {
        room.status = "playing";
        room.resultSaved = false;
        sendRooms();
        io.to(room.id).emit("game:start", gameStartInfo(room));
        // The game calls onOver(result) when the run is finished (win, defeat or time out)
        room.game = Game.create(io, room, (result) => {
            saveResult(room, result);
            // The game is over: everybody goes back to the room, not ready
            if (room.status !== "playing") return;
            room.status = "lobby";
            room.players.forEach(p => { p.ready = false; });
            sendRoom(room);
            sendRooms();
        });
        room.game.start();
    };

    const gameStartInfo = (room) => ({
        roomId: room.id,
        players: room.players.map(p => ({ username: p.username, name: p.name }))
    });

    const startCountdown = (room) => {
        cancelCountdown(room, false);
        room.status = "countdown";
        room.countdownSeconds = COUNTDOWN_SECONDS;
        io.to(room.id).emit("room:countdown", { seconds: room.countdownSeconds });
        sendRoom(room);
        sendRooms();
        room.countdown = setInterval(() => {
            room.countdownSeconds--;
            if (room.countdownSeconds > 0) {
                io.to(room.id).emit("room:countdown", { seconds: room.countdownSeconds });
            } else {
                clearInterval(room.countdown);
                room.countdown = null;
                startGame(room);
            }
        }, 1000);
    };

    // ---------- leaving, dropping and coming back ----------

    const destroyRoom = (room) => {
        cancelCountdown(room, false);
        room.players.forEach(p => { if (p.awayTimer) clearTimeout(p.awayTimer); });
        if (room.game) room.game.stop();
        rooms.delete(room.id);
    };

    // Take a player out of their room for good
    const removePlayer = (room, player) => {
        if (player.awayTimer) { clearTimeout(player.awayTimer); player.awayTimer = null; }
        const idx = room.players.indexOf(player);
        if (idx === -1) return;
        room.players.splice(idx, 1);
        if (userRoom.get(player.username) === room.id) userRoom.delete(player.username);

        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) { socket.leave(room.id); socket.data.roomId = null; }

        if (room.players.length === 0) {
            destroyRoom(room);
        } else {
            cancelCountdown(room, false);
            notify(room, "left", player);
            room.players.forEach(p => { p.ready = false; });
            if (room.status === "playing" && room.game) {
                room.game.playerLeft(player.socketId);      // the game decides when it is over
            } else {
                room.status = "lobby";
            }
            sendRoom(room);
        }
        sendRooms();
    };

    // The Leave button / sign out: the player leaves immediately
    const leaveRoom = (socket, goToLobby) => {
        const room = rooms.get(socket.data.roomId);
        if (!room) return;
        const player = room.players.find(p => p.socketId === socket.id);
        if (!player) return;
        removePlayer(room, player);
        if (goToLobby) {
            socket.join("lobby");
            socket.emit("room:left");
            sendRooms(socket);
        }
    };

    // The connection dropped (refresh, network problem): keep the seat for GRACE_MS
    const markAway = (room, player) => {
        if (player.away) return;
        player.away = true;
        cancelCountdown(room, false);
        room.players.forEach(p => { p.ready = false; });
        notify(room, "away", player);
        sendRoom(room);
        player.awayTimer = setTimeout(() => {
            player.awayTimer = null;
            if (player.away) removePlayer(room, player);
        }, GRACE_MS);
    };

    // A browser (re)connected and this account already has a seat in a room: move the seat to the new socket
    const rejoin = (socket, room, player) => {
        const oldSocketId = player.socketId;
        const wasAway = player.away;
        if (player.awayTimer) { clearTimeout(player.awayTimer); player.awayTimer = null; }
        player.away = false;
        player.socketId = socket.id;
        socket.data.roomId = room.id;
        socket.join(room.id);

        socket.emit("room:update", roomInfo(room));
        if (room.status === "countdown") socket.emit("room:countdown", { seconds: room.countdownSeconds });
        if (room.status === "playing") {
            socket.emit("game:start", gameStartInfo(room));
            if (room.game) room.game.playerRejoined(oldSocketId, socket.id);
        }
        if (wasAway) { notify(room, "back", player); sendRoom(room); }
    };

    // ---------- connections ----------

    io.on("connection", (socket) => {
        const user = socket.data.user;
        console.log("Player connected:", user.username, socket.id);
        socket.data.roomId = null;
        socket.data.replaced = false;
        socket.join("session:" + socket.request.sessionID);      // lets /signout disconnect every tab

        // One live connection per account: this one replaces the older one
        const oldId = userSocket.get(user.username);
        const old = oldId && oldId !== socket.id ? io.sockets.sockets.get(oldId) : null;
        if (old) {
            old.data.replaced = true;
            old.emit("session:replaced");
            old.disconnect(true);
        }
        userSocket.set(user.username, socket.id);

        // Already seated in a room (refresh / second tab)? Take the seat back, otherwise start in the lobby
        const room = rooms.get(userRoom.get(user.username));
        const player = room && room.players.find(p => p.username === user.username);
        if (room && player) {
            rejoin(socket, room, player);
        } else {
            socket.join("lobby");
            sendRooms(socket);
        }

        // Ignore a socket that floods the server with messages
        let windowStart = Date.now(), count = 0;
        socket.use((packet, next) => {
            const now = Date.now();
            if (now - windowStart >= 1000) { windowStart = now; count = 0; }
            count++;
            if (count > MAX_EVENTS_PER_SECOND) { next(new Error("Too many messages")); return; }
            next();
        });

        // Every handler is wrapped so that one bad message can never crash the server
        const on = (event, handler) => socket.on(event, (...args) => {
            try {
                handler(...args);
            } catch (err) {
                console.error(`Error handling '${event}' from ${user.username}:`, err);
                socket.emit("room:error", "Something went wrong.");
            }
        });

        on("rooms:request", () => sendRooms(socket));

        on("lobby:solo", () => {
            if (socket.data.roomId) {
                socket.emit("room:error", "Leave your room before starting a solo run.");
                return;
            }
            const room = createRoom(user, `${user.name}'s solo run`);
            joinRoom(socket, room);
            room.players[0].ready = true;
            startGame(room);
        });

        on("room:create", (data) => {
            const err = joinError(socket, { status: "lobby", players: [] });
            if (err) { socket.emit("room:error", err); return; }
            const name = data && typeof data === "object" && typeof data.name === "string" ? data.name : "";
            joinRoom(socket, createRoom(user, name));
        });

        on("room:join", (roomId) => {
            const room = isRoomId(roomId) ? rooms.get(roomId) : null;
            const err = joinError(socket, room);
            if (err) { socket.emit("room:error", err); return; }
            joinRoom(socket, room);
        });

        // TEMPORARY: until the server runs the solo game itself, the browser tells us how a solo run ended.
        // Only accepted once per run, only for a room with one player in a running game. A two-player result
        // is never taken from a browser: server/game.js hands it to onOver(result) instead.
        on("game:report", (result) => {
            const room = rooms.get(socket.data.roomId);
            if (!room || room.status !== "playing" || room.players.length !== 1) return;
            if (!result || typeof result !== "object") return;
            const player = room.players[0];
            const reported = Array.isArray(result.players) && result.players[0] ? result.players[0] : {};
            // The name on the leaderboard is the account's, whatever the browser says
            saveResult(room, { ...result, players: [{ ...reported, username: player.username, name: player.name }] });
        });

        on("room:leave", () => leaveRoom(socket, true));

        on("lobby:ready", (value) => {
            if (value !== undefined && typeof value !== "boolean") return;
            const room = rooms.get(socket.data.roomId);
            if (!room || room.status === "playing") return;
            const me = room.players.find(p => p.socketId === socket.id);
            if (!me) return;
            me.ready = (typeof value === "boolean") ? value : !me.ready;
            notify(room, me.ready ? "ready" : "unready", me);
            if (!me.ready) cancelCountdown(room, true);
            sendRoom(room);
            if (room.players.length === MAX_PLAYERS && room.players.every(p => p.ready && !p.away) && room.status === "lobby") {
                startCountdown(room);
            }
        });

        on("game:play", (payload) => {
            const room = rooms.get(socket.data.roomId);
            if (room && room.status === "playing" && room.game) room.game.play(socket.id, payload);
        });

        on("game:reward", (payload) => {
            const room = rooms.get(socket.data.roomId);
            if (room && room.status === "playing" && room.game) room.game.chooseReward(socket.id, payload);
        });

        on("game:cheat", (payload) => {
            const room = rooms.get(socket.data.roomId);
            if (room && room.status === "playing" && room.game) room.game.setCheat(socket.id, payload);
        });

        socket.on("disconnect", (reason) => {
            console.log("Player disconnected:", user.username, socket.id, `(${reason})`);
            if (userSocket.get(user.username) === socket.id) userSocket.delete(user.username);
            if (socket.data.replaced) return;           // a newer connection already took over this account

            const room = rooms.get(socket.data.roomId);
            const player = room && room.players.find(p => p.socketId === socket.id);
            if (!player) return;

            // The player (or the server, on sign out) closed the connection on purpose: leave at once.
            // Anything else (refresh, network drop) keeps the seat for a short grace period.
            if (reason === "client namespace disconnect" || reason === "server namespace disconnect") {
                removePlayer(room, player);
            } else {
                markAway(room, player);
            }
        });
    });

    // ---------- stale rooms ----------
    // Safety net: remove empty rooms, players whose connection no longer exists (and are not in their grace
    // period), and bookkeeping entries that point at nothing.
    const sweep = () => {
        for (const room of [...rooms.values()]) {
            for (const player of [...room.players]) {
                if (!player.away && !io.sockets.sockets.has(player.socketId)) removePlayer(room, player);
            }
            if (rooms.has(room.id) && room.players.length === 0) destroyRoom(room);
        }
        for (const [username, roomId] of [...userRoom]) {
            if (!rooms.has(roomId)) userRoom.delete(username);
        }
        for (const [username, socketId] of [...userSocket]) {
            if (!io.sockets.sockets.has(socketId)) userSocket.delete(username);
        }
        sendRooms();
    };
    setInterval(sweep, SWEEP_MS).unref();
};
