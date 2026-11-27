// Browser side of the lobby / room screens (Lab 6's HandGame pattern).
// Owns the single Socket.IO connection; Game (game.js) borrows it.
//
// Connection rules (the server enforces the other half, see server/lobby.js):
//   - a refresh or a dropped connection keeps your seat for a few seconds; Socket.IO reconnects by itself
//   - the same account in a newer tab replaces this tab ("session:replaced")
//   - signing out in any tab disconnects every tab
//   - while connected, the page asks /validate once a minute so the sign-in does not expire
// Whether sound is muted, shared by the lobby music and the game. It is kept in memory only,
// so every page load and every sign-in starts with the sound on.
const SoundSetting = { muted: false };

const Lobby = (function() {
    const HEARTBEAT_MS = 60000;
    const NOTICE_MS = 5000;

    let socket = null;
    let me = null;              // {username, name}
    let replaced = false;       // the server told us another tab took over
    let heartbeat = null;
    let noticeTimer = null;
    let runEndedBy = null;      // name of the partner who left during a game: explains why we landed back in the room
    let lastRoom = null;        // the newest room:update, kept while the game-over screen is open

    // Lobby music: a looping ambient track that plays in the lobby and the room, fades out when a game starts
    // and stays silent on the landing page. SoundSetting is shared with the game's own sound button.
    const LobbyMusic = (function() {
        const VOLUME = 0.22;
        let audio = null, fade = null, wanted = false;
        const isMuted = () => SoundSetting.muted;
        const saveMuted = (m) => { SoundSetting.muted = m; };
        const fadeTo = (target, done) => {
            clearInterval(fade);
            fade = setInterval(() => {
                const diff = target - audio.volume;
                if (Math.abs(diff) <= 0.02) { audio.volume = target; clearInterval(fade); if (done) done(); }
                else audio.volume = Math.max(0, Math.min(1, audio.volume + Math.sign(diff) * 0.02));
            }, 60);
        };
        const begin = () => {
            if (!audio) { audio = new Audio("/sounds/lobby_theme.mp3"); audio.loop = true; audio.volume = 0; }
            const attempt = audio.play();
            if (attempt && attempt.catch) attempt.catch(() => {
                // Autoplay is blocked until the player interacts with the page: try again on the first click or key
                const retry = () => { if (wanted && !isMuted()) begin(); };
                document.addEventListener("pointerdown", retry, { once: true });
                document.addEventListener("keydown", retry, { once: true });
            });
            fadeTo(VOLUME);
        };
        const label = () => $("#music-toggle").text(isMuted() ? "Sound off" : "Sound on");
        return {
            start() { wanted = true; label(); if (!isMuted() && (!audio || audio.paused)) begin(); },
            stop() { wanted = false; if (audio) fadeTo(0, () => { if (!wanted) audio.pause(); }); },
            toggle() {
                const muted = !isMuted();
                saveMuted(muted);
                label();
                if (muted) { if (audio) fadeTo(0, () => audio.pause()); }
                else if (wanted) begin();
            }
        };
    })();

    const views = ["#lobby-view", "#room-view", "#game-view"];
    const show = (id) => {
        views.forEach(v => $(v).toggle(v === id));
        if (id !== "#game-view") GameOver.hide();                                      // never leave the result screen behind
        $("#game-room-content-page").toggleClass("in-lobby", id !== "#game-view");   // lobby background only outside the game
        if (id === "#game-view") LobbyMusic.stop(); else LobbyMusic.start();
        if (id === "#lobby-view") refreshLeaderboard();
    };

    // ---- Hall of Slayers: the best runs, shown in the lobby ----
    const formatTime = (ms) => {
        const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
    };

    const renderLeaderboard = (entries) => {
        const $list = $("#leaderboard-list").empty();
        $("#leaderboard-count").text(entries.length);
        $("#leaderboard-head").prop("hidden", entries.length === 0);
        if (entries.length === 0) {
            $list.append($("<div class='rooms-empty'>").text("No runs yet. Finish a game to put your name here."));
            return;
        }
        entries.forEach(e => {
            const names = e.players.map(p => p.name).join(" & ");
            const team = e.players.length > 1;
            const result = e.won ? "Victory" : "Fell on floor " + Math.min(3, e.floors + 1);
            $("<div class='lb-row'>").toggleClass("lb-win", e.won).append(
                $("<span class='lb-rank'>").text("#" + e.rank),
                $("<span class='lb-names'>").text(names),
                $("<span class='lb-tag'>").addClass(team ? "team" : "solo").text(team ? "TEAM" : "SOLO"),
                $("<span class='lb-result'>").text(result),
                $("<span class='lb-time'>").text(formatTime(e.durationMs)),
                $("<span class='lb-damage'>").text(e.damage + " dmg")
            ).appendTo($list);
        });
    };

    const refreshLeaderboard = () => {
        if (!me) return;                                            // signed out: nothing to ask for
        fetch("/leaderboard")
            .then(r => r.json())
            .then(json => { if (json.entries) renderLeaderboard(json.entries); })
            .catch(() => {});
    };

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
        if (notice.type === "left" && $("#game-view").is(":visible") && !GameOver.isOpen()) runEndedBy = notice.name || "Your partner";
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
        SoundSetting.muted = false;                                 // every sign-in starts with the sound on
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
            $("#rooms-count").text(rooms.length);
            if (rooms.length === 0) $list.append($("<div class='rooms-empty'>").text("No open rooms yet. Create one and a partner can join you."));
            rooms.forEach(r => {
                $("<div class='room'>").append(
                    $("<span class='room-name'>").text(r.name),
                    $("<span class='room-count'>").text(`${r.count}/${r.max}`),
                    $("<button type='button'>Join</button>").on("click", () => socket.emit("room:join", r.id))).appendTo($list);
            });
        });

        // Show the waiting room for this room state
        const renderRoom = (room) => {
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
            if (runEndedBy && room.players.length < 2) {
                $("#room-message").text(`${runEndedBy} left, so the run ended. Wait for a new partner or go back to the lobby.`);
            } else {
                runEndedBy = null;
            }
            if (room.status !== "countdown") $("#countdown").text("");
        };

        socket.on("room:update", (room) => {
            lastRoom = room;
            if (room.status === "playing") return;
            if (GameOver.isOpen()) return;                          // the player is reading the result: stay on it
            renderRoom(room);
        });

        // The run has ended (the server ran it, solo or co-op) and was saved: show the result screen
        socket.on("game:over", (info) => {
            if (!GameOver.isOpen()) {
                Game.stop();
                show("#game-view");
                const solo = info.entry.players.length === 1;
                GameOver.show(info.entry, {
                    onPlayAgain: () => {
                        GameOver.hide();
                        if (solo) {                                 // a solo run: leave this room and start a fresh run
                            socket.emit("room:leave");
                            socket.emit("lobby:solo");
                        } else if (lastRoom && lastRoom.status !== "playing") renderRoom(lastRoom);
                        else show("#lobby-view");
                    },
                    onHome: () => { GameOver.hide(); socket.emit("room:leave"); }
                });
            }
            GameOver.setRank(info);
            refreshLeaderboard();
        });

        socket.on("room:countdown", (d) => { show("#room-view"); $("#countdown").text(d.seconds); });
        socket.on("room:countdown_cancel", () => $("#countdown").text(""));
        socket.on("room:left", () => {
            GameOver.hide();
            lastRoom = null;
            runEndedBy = null;
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
        LobbyMusic.stop();                                          // the landing page is silent
    };

    $(function() {
        $("#music-toggle").on("click", () => { if (!$("#game-view").is(":visible")) LobbyMusic.toggle(); });   // inside the game, game.js handles this button
        $("#solo-button").on("click", () => socket.emit("lobby:solo"));
        $("#create-button").on("click", () => socket.emit("room:create", {}));
        $("#ready-button").on("click", () => socket.emit("lobby:ready"));
        $("#leave-button").on("click", () => socket.emit("room:leave"));
    });

    return { connect, disconnect };
})();
