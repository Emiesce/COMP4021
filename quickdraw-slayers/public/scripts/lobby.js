// Browser side of the lobby / room / game-over screens (Lab 6's HandGame pattern).
// Owns the single Socket.IO connection; Game (game.js) borrows it.
const Lobby = (function() {
    let socket = null;
    let me = null;          // {username, name, avatar} filled from the first room:update
    const views = ["#lobby-view", "#room-view", "#game-view", "#over-view"];
    const show = (id) => { views.forEach(v => $(v).toggle(v === id)); };

    const connect = function() {
        if (socket) return;
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
            if (room.status === "over") return;           // stay on the game-over page
            $("#lobby-error").text("");
            show("#room-view");
            $("#room-name").text(room.name);
            const $slots = $("#room-slots").empty();
            for (let i = 0; i < 2; i++) {
                const p = room.players[i];
                const $s = $("<div class='slot'>").appendTo($slots);
                if (p) $s.addClass("filled").toggleClass("ready", p.ready)
                    .append($("<div>").html(Avatar.getCode(p.avatar)), $("<div>").text(p.name), $("<div>").text(p.ready ? "READY" : "not ready"));
                else $s.text("Empty slot");
            }
            $("#room-message").text(room.players.length < 2 ? "Waiting for another Slayer…" : "Both Slayers present. Click Ready!");
            if (room.status !== "countdown") $("#countdown").text("");
        });

        socket.on("room:countdown", (d) => { show("#room-view"); $("#countdown").text(d.seconds); });
        socket.on("room:countdown_cancel", () => $("#countdown").text(""));
        socket.on("room:left", () => show("#lobby-view"));

        socket.on("game:start", () => { show("#game-view"); Game.start(socket); });
        socket.on("game:over", (data) => { Game.stop(); showOver(data); });
        socket.on("room:rematch", (d) => $("#rematch-message").text(`Rematch votes: ${d.count}/${d.needed}`));
    };

    const disconnect = function() {
        if (socket) { socket.disconnect(); socket = null; }
        Game.stop();
    };

    const showOver = function(d) {
        show("#over-view");
        $("#over-title").text(d.result === "victory" ? "VICTORY!" : "DEFEAT");
        $("#over-reason").text(`${d.reason}  Duration: ${d.duration}s`);
        $("#rematch-message").text("");
        const $stats = $("#over-stats").empty();
        d.stats.forEach(s => {
            $("<div class='stat-card'>").toggleClass("top", s.rank === 1).append(
                $("<h3>").text(`#${s.rank} ${s.name}${s.cheat ? " (cheated)" : ""}`),
                $("<div>").text("Damage dealt: " + s.damageDealt),
                $("<div>").text("Attacks blocked: " + s.damageBlocked),
                $("<div>").text("Cards played: " + s.cardsPlayed),
                $("<div>").text("Survival time: " + s.survivalTime + "s"),
                $("<b>").text("Score: " + s.score)).appendTo($stats);
        });
        const $b = $("#over-board").empty().append("<b>Top runs</b>");
        d.leaderboard.forEach((e, i) => $b.append($("<div>").text(`${i + 1}. ${e.players.join(" & ")} - ${e.score} (${e.result})`)));
    };

    $(function() {
        $("#quick-button").on("click", () => socket.emit("room:quick"));
        $("#create-button").on("click", () => socket.emit("room:create", {}));
        $("#ready-button").on("click", () => socket.emit("lobby:ready"));
        $("#leave-button").on("click", () => socket.emit("room:leave"));
        $("#rematch-button").on("click", () => { socket.emit("game:rematch"); $("#rematch-message").text("Waiting for your partner…"); });
        $("#home-button").on("click", () => socket.emit("room:leave"));
    });

    return { connect, disconnect };
})();
