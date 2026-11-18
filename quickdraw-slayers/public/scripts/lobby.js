// Browser side of the lobby / room screens (Lab 6's HandGame pattern).
// Owns the single Socket.IO connection; Game (game.js) borrows it.
const Lobby = (function() {
    let socket = null;
    let me = null;          // {username, name} filled from the first room:update
    const views = ["#lobby-view", "#room-view", "#game-view"];
    const show = (id) => { views.forEach(v => $(v).toggle(v === id)); };

    const connect = function(user) {
        if (socket) return;
        me = user;
        socket = io();
        show("#lobby-view");

        socket.on("connect_error", (err) => $("#lobby-error").text("Connection problem: " + err.message));
        socket.on("room:error", (msg) => { $("#lobby-error").text(msg); $("#room-message").text(msg); });

        socket.on("rooms:list", (rooms) => {
            const $list = $("#rooms-list").empty();
            if (rooms.length === 0) $list.text("No open rooms. Create one or press Quick Match.");
            rooms.forEach(r => {
                $("<div class='room'>").append($("<span>").text(`${r.name} (${r.count}/${r.max})`),
                    $("<button>Join</button>").on("click", () => socket.emit("room:join", r.id))).appendTo($list);
            });
        });

        socket.on("room:update", (room) => {
            if (room.status === "playing") return;
            $("#lobby-error").text("");
            show("#room-view");
            $("#room-name").text(room.name);
            const $slots = $("#room-slots").empty();
            for (let i = 0; i < 2; i++) {
                const p = room.players[i];
                const $s = $("<div class='slot'>").appendTo($slots);
                if (p) {
                    const mine = me && p.username === me.username;
                    $s.addClass("filled").toggleClass("ready", p.ready)
                        .append($("<div class='initial'>").text(p.name.charAt(0).toUpperCase()),
                                $("<div>").text(p.name + (mine ? " (you)" : "")),
                                $("<div>").text(p.ready ? "READY" : "not ready"));
                    if (mine) $("#ready-button").text(p.ready ? "Cancel Ready" : "Ready");
                }
                else $s.text("Empty slot");
            }
            $("#room-message").text(room.players.length < 2 ? "Waiting for another Slayer…" : "Both Slayers present. Click Ready!");
            if (room.status !== "countdown") $("#countdown").text("");
        });

        socket.on("room:countdown", (d) => { show("#room-view"); $("#countdown").text(d.seconds); });
        socket.on("room:countdown_cancel", () => $("#countdown").text(""));
        socket.on("room:left", () => { $("#ready-button").text("Ready"); $("#countdown, #room-message").text(""); show("#lobby-view"); });

        socket.on("game:start", () => { show("#game-view"); Game.start(socket); });
    };

    const disconnect = function() {
        if (socket) { socket.disconnect(); socket = null; }
        Game.stop();
        me = null;
        $("#countdown, #room-message, #lobby-error").text("");
        $("#ready-button").text("Ready");
        show("#lobby-view");
    };

    $(function() {
        $("#quick-button").on("click", () => socket.emit("room:quick"));
        $("#create-button").on("click", () => socket.emit("room:create", {}));
        $("#ready-button").on("click", () => socket.emit("lobby:ready"));
        $("#leave-button").on("click", () => socket.emit("room:leave"));
    });

    return { connect, disconnect };
})();
