// Unit tests for server/leaderboard.js: ranking rules, cleaning of bad input, saving and the size limit.
//
//   npm test      (also runs this file)
//
// It uses its own temporary data folder, so your real data/ is never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = path.join(os.tmpdir(), "quickdraw-lb-test-" + Date.now());
process.env.DATA_DIR = DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const lb = require("../server/leaderboard");

let failures = 0;
const check = (ok, message) => { if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + message); };
const run = (won, floors, durationMs, damage, name = "A") => ({
    won, floors, durationMs,
    players: [{ username: name.toLowerCase(), name, damage, blocked: 5, cards: 10, survivalMs: durationMs }]
});
const reset = () => fs.rmSync(path.join(DATA_DIR, "leaderboard.json"), { force: true });

// 1. Empty board and a first run
reset();
check(lb.top(10).length === 0, "a new leaderboard is empty");
const first = lb.record(run(false, 1, 90000, 200));
check(first && first.rank === 1 && first.total === 1, "the first run is rank 1 of 1");
check(fs.existsSync(path.join(DATA_DIR, "leaderboard.json")), "the result is saved to data/leaderboard.json");

// 2. Ranking rules: win > floors > time (win) / damage (loss)
reset();
lb.record(run(false, 2, 200000, 900, "LossFloor2"));
lb.record(run(true, 3, 180000, 500, "SlowWin"));
lb.record(run(true, 3, 150000, 400, "FastWin"));
lb.record(run(false, 2, 200000, 1200, "LossMoreDamage"));
lb.record(run(false, 0, 30000, 50, "EarlyLoss"));
const order = lb.top(10).map(e => e.players[0].name);
check(order.join(",") === "FastWin,SlowWin,LossMoreDamage,LossFloor2,EarlyLoss",
    "order is: fastest win, slower win, loss with more floors and damage, ..., earliest loss (got " + order.join(",") + ")");
check(lb.top(10).every((e, i) => e.rank === i + 1), "ranks are numbered 1, 2, 3, ...");
check(lb.record(run(true, 3, 100000, 100, "Best")).rank === 1, "a new best run takes rank 1");

// 3. Two players: total damage decides ties, the entry is co-op
reset();
const coop = lb.record({ won: true, floors: 3, durationMs: 200000, players: [
    { username: "a", name: "Alice", damage: 700, blocked: 90, cards: 30, survivalMs: 200000 },
    { username: "b", name: "Bob", damage: 600, blocked: 20, cards: 28, survivalMs: 150000 }] });
check(coop.entry.mode === "coop" && lb.top(1)[0].damage === 1300, "two players: mode is co-op and total damage is the sum");
const tie = lb.record({ won: true, floors: 3, durationMs: 200000, players: [{ username: "c", name: "Solo", damage: 1400, blocked: 0, cards: 1, survivalMs: 1 }] });
check(tie.rank === 1, "same time and floors: more total damage ranks higher");

// 4. Bad input is cleaned or refused
reset();
check(lb.record(null) === null && lb.record("x") === null && lb.record({}) === null && lb.record({ players: [] }) === null,
    "missing or empty results are refused");
const dirty = lb.record({ won: "yes", floors: 99, durationMs: -5, players: [
    { username: "u".repeat(50), name: "<b>Eve\n</b>" + "x".repeat(60), damage: "lots", blocked: Infinity, cards: -3, survivalMs: 1e12 },
    { username: "second", name: "Two", damage: 1 }, { username: "third", name: "Three", damage: 1 }] });
const e = dirty.entry;
check(e.won === false, "won must be exactly true (the string 'yes' is not a win)");
check(e.floors === 3 && e.durationMs === 0, "floors are clamped to 3 and a negative time to 0");
check(e.players.length === 2, "at most two players are kept");
check(e.players[0].username.length <= 16 && e.players[0].name.length <= 20 && !/\n/.test(e.players[0].name), "names are trimmed and control characters removed");
check(e.players[0].damage === 0 && e.players[0].blocked === 0 && e.players[0].cards === 0, "non-numbers, Infinity and negatives become 0");
check(e.players[0].survivalMs === 600000, "a huge time is clamped to 10 minutes");

// 5. Saved across a restart of the server (fresh module, same folder)
reset();
lb.record(run(true, 3, 120000, 800, "Saved"));
for (const key of Object.keys(require.cache)) if (key.includes(path.join("server", "leaderboard")) || key.includes(path.join("server", "store"))) delete require.cache[key];
const lb2 = require("../server/leaderboard");
check(lb2.top(10).length === 1 && lb2.top(10)[0].players[0].name === "Saved", "results survive a server restart");

// 6. Size limit: only the best MAX_ENTRIES runs are kept
reset();
for (let i = 0; i < lb2.MAX_ENTRIES + 20; i++) lb2.record(run(false, 0, 1000, i, "P" + i));
const all = lb2.top(1000);
check(all.length === lb2.MAX_ENTRIES, `the file keeps only the best ${lb2.MAX_ENTRIES} runs`);
const worst = lb2.record(run(false, 0, 1000, 0, "Worst"));
check(worst.rank === null, "a run that does not make the top list gets no rank");

// 7. A damaged file is reported, not silently replaced
fs.writeFileSync(path.join(DATA_DIR, "leaderboard.json"), "{ broken");
let threw = false;
try { lb2.top(10); } catch (err) { threw = true; }
check(threw, "a corrupt leaderboard.json throws instead of being overwritten");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll leaderboard checks passed." : `\n${failures} leaderboard check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
