// The Victory / Defeat screen, with each player's stats and the leaderboard rank.
// It is a separate module so the solo game and the two-player game show exactly the same screen:
//
//   GameOver.show(result, { onPlayAgain, onHome })   draw the screen over the battlefield
//   GameOver.setRank({ rank, total })                fill in the leaderboard line once the server has saved the run
//   GameOver.hide()                                  close it (also called when the game stops)
//   GameOver.isOpen()                                true while it is on screen
//
// result = {
//   won: true | false,
//   reason: "text under the title" (optional),
//   floors: 0-3 floors cleared,
//   durationMs: how long the run lasted,
//   players: [{ name, damage, blocked, cards, survivalMs }]     one or two players
// }
const GameOver = (function() {
    let open = false;

    const formatTime = function(ms) {
        const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
    };

    const el = function(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    // The per-player table. With two players the better value in each row is highlighted.
    const buildTable = function(players) {
        const table = el("table", "go-table");
        const head = table.createTHead().insertRow();
        head.append(el("th", "", ""));
        players.forEach(p => head.append(el("th", "", p.name || "Slayer")));
        const rows = [
            ["Damage dealt", "damage", (v) => String(v)],
            ["Damage blocked", "blocked", (v) => String(v)],
            ["Cards played", "cards", (v) => String(v)],
            ["Survival time", "survivalMs", formatTime]
        ];
        const body = table.createTBody();
        rows.forEach(([label, key, format]) => {
            const row = body.insertRow();
            row.append(el("th", "", label));
            const best = Math.max(...players.map(p => Number(p[key]) || 0));
            players.forEach(p => {
                const value = Number(p[key]) || 0;
                const cell = el("td", players.length > 1 && value === best && best > 0 ? "go-best" : "", format(value));
                row.append(cell);
            });
        });
        return table;
    };

    const show = function(result, actions) {
        const players = (result && Array.isArray(result.players) && result.players.length) ? result.players : [{ name: "Slayer" }];
        const won = !!(result && result.won);
        const overlay = document.getElementById("game-overlay");
        const card = document.getElementById("game-overlay-card");
        card.replaceChildren();

        const summary = el("div", "go-summary");
        [[`${Number(result && result.floors) || 0} / 3`, "Floors cleared"],
         [formatTime(result && result.durationMs), "Run time"],
         [players.length > 1 ? "Co-op" : "Solo", "Mode"]].forEach(([value, label]) => {
            const item = el("div");
            item.append(el("strong", "", value), document.createTextNode(label));
            summary.append(item);
        });

        const rank = el("div", "go-rank", "Saving your score…");
        rank.id = "go-rank";

        const buttons = el("div", "go-buttons");
        const again = el("button", "result-button", "Play again");
        again.type = "button";
        again.addEventListener("click", () => { if (actions && actions.onPlayAgain) actions.onPlayAgain(); });
        const home = el("button", "result-button go-home", "Home");
        home.type = "button";
        home.addEventListener("click", () => { if (actions && actions.onHome) actions.onHome(); });
        buttons.append(again, home);

        card.append(
            el("div", "overlay-kicker", won ? "DUNGEON CLEARED" : "RUN ENDED"),
            el("h2", won ? "go-win" : "go-lose", won ? "VICTORY!" : "DEFEAT"),
            el("div", "overlay-copy", (result && result.reason) || ""),
            summary,
            buildTable(players),
            rank,
            buttons
        );
        overlay.hidden = false;
        open = true;
    };

    const setRank = function(info) {
        const node = document.getElementById("go-rank");
        if (!node || !info) return;
        const notRanked = {
            cheat: "Cheat mode was used, so this run is not ranked.",
            idle: "No cards were played, so this run is not ranked."
        };
        node.textContent = info.unranked && notRanked[info.unranked]
            ? notRanked[info.unranked]
            : info.rank
                ? `Leaderboard rank: #${info.rank} of ${info.total}`
                : `Not in the top ${info.total} runs`;
        node.classList.add("saved");
    };

    const hide = function() {
        open = false;
        const overlay = document.getElementById("game-overlay");
        if (overlay) overlay.hidden = true;
    };

    return { show, setRank, hide, isOpen: () => open };
})();
