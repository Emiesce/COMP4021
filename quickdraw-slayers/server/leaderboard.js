// The saved leaderboard (data/leaderboard.json): one entry per finished run, best runs first.
//
//   record(result)  -> { entry, rank, total, unranked }   store one finished run (sanitised) and say where it ranks.
//                      Runs that used cheat mode, or where nobody played a card, are NOT saved: rank is null and
//                      `unranked` says why ("cheat" or "idle").
//   top(n)          -> [entry with .rank]       the best n runs
//
// `result` is the object the game hands over when a run ends (the contract is in docs/multiplayer-protocol.md):
//   { won, floors, durationMs, cheated, players: [{ username, name, damage, blocked, cards, survivalMs }] }
//
// Ranking, best first:
//   1. a win beats any loss
//   2. more floors cleared
//   3. wins:   faster total time, then more total damage
//      losses: more total damage, then faster total time
// Only the best MAX_ENTRIES runs are kept, so the file can never grow without limit.
//
// Nothing the game sends is trusted: names are cleaned and every number is clamped, so a bad message can
// never put garbage or a huge value into the file. Writes are atomic (store.writeJson).
const path = require("path");
const crypto = require("crypto");
const store = require("./store");

const FILE = path.join(store.DATA_DIR, "leaderboard.json");
const MAX_ENTRIES = 100;
const MAX_PLAYERS = 2;
const MAX_FLOORS = 3;
const MAX_TIME_MS = 10 * 60 * 1000;         // a run is 4 minutes; anything above 10 minutes is clamped
const MAX_STAT = 1000000;

const clampInt = (value, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0;
};
const cleanText = (value, max, fallback) => {
    const t = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
    return t || fallback;
};

const totalDamage = (entry) => entry.players.reduce((sum, p) => sum + p.damage, 0);

// Negative when `a` ranks above `b`
function compare(a, b) {
    if (a.won !== b.won) return a.won ? -1 : 1;
    if (a.floors !== b.floors) return b.floors - a.floors;
    const damage = totalDamage(b) - totalDamage(a);
    if (a.won) return (a.durationMs - b.durationMs) || damage || a.at.localeCompare(b.at);
    return damage || (a.durationMs - b.durationMs) || a.at.localeCompare(b.at);
}

// Turn whatever the game sent into a safe entry, or null when there is nothing worth saving
function sanitize(result, now) {
    if (!result || typeof result !== "object" || !Array.isArray(result.players)) return null;
    const players = result.players.slice(0, MAX_PLAYERS)
        .filter(p => p && typeof p === "object")
        .map(p => ({
            username: cleanText(p.username, 16, ""),
            name: cleanText(p.name, 20, "Slayer"),
            damage: clampInt(p.damage, MAX_STAT),
            blocked: clampInt(p.blocked, MAX_STAT),
            cards: clampInt(p.cards, MAX_STAT),
            survivalMs: clampInt(p.survivalMs, MAX_TIME_MS)
        }));
    if (players.length === 0) return null;
    return {
        id: crypto.randomBytes(6).toString("hex"),
        at: (now || new Date()).toISOString(),
        mode: players.length > 1 ? "coop" : "solo",
        won: result.won === true,
        floors: clampInt(result.floors, MAX_FLOORS),
        durationMs: clampInt(result.durationMs, MAX_TIME_MS),
        players
    };
}

function load() {
    const list = store.readJson(FILE, []);
    if (!Array.isArray(list)) throw new Error(`${FILE} must contain a JSON array`);
    return list;
}

// Why a finished run must not appear on the leaderboard (or null when it may)
function unrankedReason(result, entry) {
    if (result && result.cheated === true) return "cheat";           // cheat mode was switched on at some point
    if (entry.players.every(p => p.cards === 0)) return "idle";      // nobody played a single card
    return null;
}

function record(result, now) {
    const entry = sanitize(result, now);
    if (!entry) return null;
    const entries = load();
    const unranked = unrankedReason(result, entry);
    if (unranked) return { entry, rank: null, total: entries.length, unranked };
    entries.push(entry);
    entries.sort(compare);
    const kept = entries.slice(0, MAX_ENTRIES);
    store.writeJson(FILE, kept);
    const index = kept.findIndex(e => e.id === entry.id);
    return { entry, rank: index === -1 ? null : index + 1, total: kept.length, unranked: null };
}

function top(n) {
    const count = Math.max(1, Math.min(MAX_ENTRIES, Number(n) || 10));
    return load().slice(0, count).map((entry, index) => ({ ...entry, rank: index + 1, damage: totalDamage(entry) }));
}

module.exports = { record, top, compare, sanitize, unrankedReason, MAX_ENTRIES };
