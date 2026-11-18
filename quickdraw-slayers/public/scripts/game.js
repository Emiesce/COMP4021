// Canvas client. It only DRAWS what the server sends and SENDS the player's intentions.
const Game = (function() {
    let socket = null, ctx = null, raf = null;
    let state = null, hand = [], flash = "", flashUntil = 0, notice = "", myCheat = false;
    const floaters = [];            // floating damage numbers
    const sounds = { card: new Audio("sounds/card.mp3"), bgm: new Audio("sounds/bgm.mp3"), over: new Audio("sounds/over.mp3") };
    sounds.bgm.loop = true; sounds.bgm.volume = 0.3;
    const CARD = { w: 140, h: 190, y: 330 };
    const cardBox = (i) => BoundingBox(ctx, CARD.y, 150 + i * 165, CARD.y + CARD.h, 150 + i * 165 + CARD.w);

    const play = (slot) => { if (socket) socket.emit("game:play", slot); };

    const onKey = (e) => {
        if (e.key >= "1" && e.key <= "4") play(Number(e.key) - 1);
        else if (e.key === "c" || e.key === "C") { myCheat = !myCheat; socket.emit("game:cheat", myCheat); }
    };
    const onClick = (e) => {
        const r = ctx.canvas.getBoundingClientRect();
        const x = (e.clientX - r.left) * ctx.canvas.width / r.width, y = (e.clientY - r.top) * ctx.canvas.height / r.height;
        for (let i = 0; i < hand.length; i++) if (cardBox(i).isPointInBox(x, y)) play(i);
    };

    const bar = (x, y, w, h, frac, color) => {
        ctx.fillStyle = "#444"; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
    };

    const draw = () => {
        ctx.clearRect(0, 0, 960, 540);
        if (state) {
            ctx.fillStyle = "#fff"; ctx.font = "20px sans-serif"; ctx.textAlign = "center";
            const t = Math.ceil(state.timeLeft);
            ctx.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`, 480, 28);
            // Enemy
            ctx.fillStyle = "#a33"; ctx.fillRect(420, 70, 120, 140);
            ctx.fillStyle = "#fff"; ctx.fillText(state.enemy.name, 480, 58);
            bar(380, 220, 200, 14, state.enemy.hp / state.enemy.maxHp, "#e44");
            // Players
            state.players.forEach((p, i) => {
                const x = 60 + i * 640;
                ctx.textAlign = "left"; ctx.fillStyle = p.alive ? "#fff" : "#888";
                ctx.fillText(p.name + (p.cheat ? "  [CHEAT]" : ""), x, 100);
                bar(x, 110, 200, 14, p.hp / p.maxHp, "#4c4");
                bar(x, 130, 200, 10, p.energyProgress >= 1 ? 1 : p.energy / p.maxEnergy, "#58f");
                ctx.fillStyle = "#9bf"; ctx.font = "14px sans-serif"; ctx.fillText(`Energy ${p.energy}/${p.maxEnergy}`, x, 158);
                ctx.font = "20px sans-serif";
            });
            if (state.players.some(p => p.cheat)) {
                ctx.fillStyle = "#f55"; ctx.textAlign = "left"; ctx.fillText("CHEAT MODE ACTIVE", 12, 28);
            }
        }
        // Hand
        hand.forEach((c, i) => {
            const x = 150 + i * 165;
            ctx.fillStyle = "#eee"; ctx.fillRect(x, CARD.y, CARD.w, CARD.h);
            ctx.fillStyle = "#222"; ctx.textAlign = "center"; ctx.font = "18px sans-serif";
            ctx.fillText(`${i + 1}. ${c.name}`, x + CARD.w / 2, CARD.y + 40);
            ctx.fillText(`Cost ${c.cost}`, x + CARD.w / 2, CARD.y + 90);
            ctx.fillText(`Dmg ${c.damage}`, x + CARD.w / 2, CARD.y + 130);
        });
        // Floating damage numbers
        for (let i = floaters.length - 1; i >= 0; i--) {
            const f = floaters[i]; f.y -= 0.8; f.life--;
            if (f.life <= 0) { floaters.splice(i, 1); continue; }
            ctx.globalAlpha = f.life / 60; ctx.fillStyle = "#ff0"; ctx.font = "bold 28px sans-serif";
            ctx.fillText(f.text, f.x, f.y); ctx.globalAlpha = 1;
        }
        if (Date.now() < flashUntil) { ctx.fillStyle = "#f88"; ctx.font = "18px sans-serif"; ctx.textAlign = "center"; ctx.fillText(flash, 480, 310); }
        if (notice) { ctx.fillStyle = "#f55"; ctx.textAlign = "right"; ctx.font = "16px sans-serif"; ctx.fillText(notice, 948, 28); }
        raf = requestAnimationFrame(draw);
    };

    const start = function(sock) {
        socket = sock; state = null; hand = []; myCheat = false; notice = "";
        ctx = $("#game-canvas").get(0).getContext("2d");
        socket.on("game:state", (s) => { state = s; });
        socket.on("game:hand", (h) => { hand = h; });
        socket.on("game:rejected", (why) => { flash = why; flashUntil = Date.now() + 1200; });
        socket.on("game:event", (ev) => {
            if (ev.type === "card_played") {
                floaters.push({ x: 480 + (Math.random() * 60 - 30), y: 150, text: "-" + ev.damage, life: 60 });
                const a = sounds.card.cloneNode(); a.play().catch(() => {});
            } else if (ev.type === "cheat") {
                notice = ev.on ? "A Slayer is using CHEAT MODE" : "";
            }
        });
        $(document).on("keydown.game", onKey);
        $("#game-canvas").on("click.game", onClick);
        sounds.bgm.currentTime = 0; sounds.bgm.play().catch(() => {});
        if (!raf) draw();
    };

    const stop = function() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        $(document).off(".game"); $("#game-canvas").off(".game");
        if (socket) socket.off("game:state").off("game:hand").off("game:rejected").off("game:event");
        sounds.bgm.pause();
        if (state) sounds.over.play().catch(() => {});
    };

    return { start, stop };
})();
