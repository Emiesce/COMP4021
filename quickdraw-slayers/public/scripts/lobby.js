// Browser side of the lobby / room screens (Lab 6's HandGame pattern).
// Owns the single Socket.IO connection; Game (game.js) borrows it.
//
// Connection rules (the server enforces the other half, see server/lobby.js):
//   - a refresh or a dropped connection keeps your seat for a few seconds; Socket.IO reconnects by itself
//   - the same account in a newer tab replaces this tab ("session:replaced")
//   - signing out in any tab disconnects every tab
//   - while connected, the page asks /validate once a minute so the sign-in does not expire
const Lobby = (function() {
    const HEARTBEAT_MS = 60000;
    const NOTICE_MS = 5000;

    let socket = null;
    let me = null;              // {username, name}
    let replaced = false;       // the server told us another tab took over
    let heartbeat = null;
    let noticeTimer = null;

    const views = ["#lobby-view", "#room-view", "#game-view"];
    const show = (id) => { views.forEach(v => $(v).toggle(v === id)); };

    // A short status line that is shown in the lobby and in the room
    const setStatus = (text) => { $("#lobby-error").text(text); $("#room-notice").text(text); };

    // Messages about the other player (and the room) that appear for a few seconds
    const NOTICES = {
        joined: (n) => `${n} joined the room.`,
        left: (n) => `${n} left the room.`,
        away: (n) => `${n} lost connection. Waiting for them to come back…`,
        back: (n) => `${n} is back.`,
        ready: (n) => `${n} is ready.`,
        unready: (n) => `${n} is not ready.`,
        countdown_cancelled: () => "Countdown cancelled."
    };
    const showNotice = function(notice) {
        if (me && notice.username === me.username) return;         // only news about the other player
        const make = NOTICES[notice.type];
        if (!make) return;
        $("#room-notice").text(make(notice.name || ""));
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => $("#room-notice").text(""), NOTICE_MS);
    };

    const startHeartbeat = function() {
        stopHeartbeat();
        heartbeat = setInterval(() => {
            fetch("/validate")
                .then((res) => res.json())
                .then((json) => { if (json.error) GameRoom.sessionEnded("Your session expired. Please sign in again."); })
                .catch(() => {});                   // a network problem is handled by Socket.IO
        }, HEARTBEAT_MS);
    };
    const stopHeartbeat = function() {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
    };

    const connect = function(user) {
        if (socket) return;
        me = user;
        replaced = false;
        socket = io();
        show("#lobby-view");
        startHeartbeat();

        socket.on("connect", () => setStatus(""));

        socket.on("connect_error", (err) => {
            if (err.message === "Not signed in") GameRoom.sessionEnded("Your session expired. Please sign in again.");
            else setStatus("Connection problem: " + err.message);
        });

        socket.on("disconnect", (reason) => {
            if (reason === "io client disconnect") return;          // we disconnected on purpose (sign out)
            if (reason === "io server disconnect") {                // the server closed it: signed out or replaced
                GameRoom.sessionEnded(replaced
                    ? "This account was opened in another tab or window, so this tab was signed out."
                    : "You were signed out.");
                return;
            }
            setStatus("Connection lost. Reconnecting…");            // Socket.IO keeps trying
        });

        socket.on("session:replaced", () => { replaced = true; });
        socket.on("room:error", (msg) => { $("#lobby-error").text(msg); $("#room-message").text(msg); });
        socket.on("room:notice", showNotice);

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
            Game.stop();                                            // e.g. the game ended and we are back in the room
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
                                $("<div>").text(p.away ? "reconnecting…" : (p.ready ? "READY" : "not ready")));
                    if (mine) $("#ready-button").text(p.ready ? "Cancel Ready" : "Ready");
                }
                else $s.text("Empty slot");
            }
            $("#room-message").text(room.players.length < 2 ? "Waiting for another Slayer…" : "Both Slayers present. Click Ready!");
            if (room.status !== "countdown") $("#countdown").text("");
        });

        socket.on("room:countdown", (d) => { show("#room-view"); $("#countdown").text(d.seconds); });
        socket.on("room:countdown_cancel", () => $("#countdown").text(""));
        socket.on("room:left", () => {
            $("#ready-button").text("Ready");
            $("#countdown, #room-message, #room-notice").text("");
            show("#lobby-view");
        });

        socket.on("game:start", (info) => { show("#game-view"); Game.start(socket, info, me); });
    };

    // Called when the player signs out or the session ends
    const disconnect = function() {
        stopHeartbeat();
        clearTimeout(noticeTimer);
        if (socket) { socket.disconnect(); socket = null; }
        Game.stop();
        me = null;
        $("#countdown, #room-message, #room-notice, #lobby-error").text("");
        $("#ready-button").text("Ready");
        show("#lobby-view");
    };

    $(function() {
        $("#quick-button").on("click", () => socket.emit("room:quick"));
        $("#solo-button").on("click", () => socket.emit("lobby:solo"));
        $("#create-button").on("click", () => socket.emit("room:create", {}));
        $("#ready-button").on("click", () => socket.emit("lobby:ready"));
        $("#leave-button").on("click", () => socket.emit("room:leave"));
    });

    return { connect, disconnect };
})();
