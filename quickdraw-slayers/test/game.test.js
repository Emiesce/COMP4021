// Fast-forward test of server/game.js (two players, no sockets): a downed Slayer's reward choice must not
// change how they come back, a cheat run is flagged, and the partner-away countdown is in the snapshot.
//
//   node test/game.test.js      (also runs as part of npm test)
//
// Time runs 25x faster (Date.now and setInterval are patched) so a whole run takes a few seconds.
const SPEED = 25;
const realNow = Date.now.bind(Date);
const START = realNow();
Date.now = () => START + (realNow() - START) * SPEED;
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => realSetInterval(fn, Math.max(1, ms / SPEED));

const Game = require("../server/game");

let failures = 0;
const check = (ok, message) => { if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + message); };

// One run: "a" never plays and picks `aChoice` on every reward screen, "b" plays every card as fast as possible.
function runOnce(aChoice, useCheatEarly) {
    return new Promise((resolve) => {
        const room = { id: "r1", players: [
            { socketId: "sa", username: "a", name: "A", away: false, awayUntil: 0 },
            { socketId: "sb", username: "b", name: "B", away: false, awayUntil: 0 }] };
        let snapshot = null, result = null, downedOnFloor = 0, revived = null;
        const io = { to: () => ({ emit: (event, payload) => { if (event === "game:state") snapshot = payload; } }), sockets: { sockets: new Map() } };
        const game = Game.create(io, room, (r) => { result = r; });
        game.start();
        if (useCheatEarly) { game.setCheat("sb", { on: true }); game.setCheat("sb", { on: false }); }
        const loop = realSetInterval(() => {
            if (!snapshot) return;
            const a = snapshot.players[0];
            if (snapshot.status === "active") for (let slot = 0; slot < 4; slot++) game.play("sb", { slot });
            if (snapshot.status === "reward") { game.chooseReward("sa", { choice: aChoice }); game.chooseReward("sb", { choice: "heal" }); }
            if (a.hp <= 0 && !downedOnFloor) downedOnFloor = snapshot.floor;
            if (downedOnFloor && revived === null && snapshot.floor > downedOnFloor && a.hp > 0) revived = { hp: a.hp, maxHp: a.maxHp };
            if (result) { clearInterval(loop); game.stop(); resolve({ result, downedOnFloor, revived }); }
        }, 5);
    });
}

(async () => {
    for (const choice of ["heal", "buff"]) {
        let outcome = null;
        for (let attempt = 0; attempt < 4 && !(outcome && outcome.revived); attempt++) outcome = await runOnce(choice, false);
        check(outcome && outcome.revived !== null, `a downed Slayer comes back on a later floor (reward: ${choice})`);
        if (outcome && outcome.revived) {
            check(outcome.revived.hp === Math.ceil(outcome.revived.maxHp / 2),
                `a downed Slayer who picked "${choice}" returns with exactly half HP (${outcome.revived.hp}/${outcome.revived.maxHp})`);
        }
    }

    const cheated = await runOnce("heal", true);
    check(cheated.result.cheated === true, "a run where cheat mode was switched on is flagged cheated");

    // A solo run is run by the server too: idle until the Slayer falls, one player in the result
    const soloRoom = { id: "r3", players: [{ socketId: "sa", username: "solo", name: "Solo", away: false, awayUntil: 0 }] };
    const soloResult = await new Promise((resolve) => {
        const keepAlive = realSetInterval(() => {}, 50);     // the game's own timer is unref'd, so keep Node running
        const game = Game.create({ to: () => ({ emit() {} }), sockets: { sockets: new Map() } }, soloRoom, (r) => { clearInterval(keepAlive); resolve(r); });
        game.start();
    });
    check(soloResult.players.length === 1 && soloResult.won === false && soloResult.reason === "Your Slayer fell.",
        "an idle solo run ends in defeat with one player in the result");
    check(soloResult.cheated === false && soloResult.players[0].cards === 0, "an idle solo run is not flagged cheated and played no cards");

    // snapshot shows how long the away partner's seat is held
    const room = { id: "r2", players: [
        { socketId: "sa", username: "a", name: "A", away: true, awayUntil: Date.now() + 8000 },
        { socketId: "sb", username: "b", name: "B", away: false, awayUntil: 0 }] };
    const g = Game.create({ to: () => ({ emit() {} }), sockets: { sockets: new Map() } }, room, () => {});
    g.start();
    const snap = g.snapshot();
    g.stop();
    check(snap.players[0].away === true && snap.players[0].awayEndsIn > 0 && snap.players[0].awayEndsIn <= 8000, "the snapshot tells the partner how long the away seat is held");
    check(snap.players[1].awayEndsIn === 0, "a connected player has no away countdown");

    console.log(failures === 0 ? "\nAll game checks passed." : `\n${failures} game check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
})();
