// Historical high scores, saved on the server in data/leaderboard.json
const fs = require("fs");
const FILE = "data/leaderboard.json";

function load() {
    try { return JSON.parse(fs.readFileSync(FILE)); } catch (e) { return []; }
}
function add(entry) {
    const list = load();
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    fs.writeFileSync(FILE, JSON.stringify(list.slice(0, 50), null, 1));
}
function top(n = 5) { return load().slice(0, n); }

module.exports = { load, add, top };
