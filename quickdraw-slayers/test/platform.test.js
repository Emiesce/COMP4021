// Automated platform test: accounts, guide, sign-in limits, rooms, rejoin, sign-out, isolation.
//
//   npm test
//
// It starts its own server on port 8123 with a temporary data folder (so your real data/users.json is
// never touched), drives it with simulated browsers (HTTP + Socket.IO) and prints PASS / FAIL lines.
// Needs Node 18+ and the socket.io-client dev dependency (installed by npm install).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { io } = require("socket.io-client");

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const GRACE_MS = 1500;
const DATA_DIR = path.join(os.tmpdir(), "quickdraw-test-" + Date.now());   // does not exist yet on purpose
const ROOT = path.join(__dirname, "..");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (ok, message) => { if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + message); };

// ---------- helpers ----------

const post = async (url, body, cookie) => {
    const res = await fetch(BASE + url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get("set-cookie");
    return { json: await res.json(), cookie: setCookie ? setCookie.split(";")[0] : null };
};
const get = async (url, cookie) => {
    const res = await fetch(BASE + url, { headers: cookie ? { cookie } : {} });
    return { json: await res.json(), cookie: res.headers.get("set-cookie") };
};

// Register + finish the guide + sign in. Returns { username, cookie } for a ready-to-use account.
const makeUser = async (username, name = username) => {
    const reg = await post("/register", { username, name, password: "pw" });
    if (reg.json.error) throw new Error("register failed: " + reg.json.error);
    await post("/guide-complete", undefined, reg.cookie);
    const login = await post("/signin", { username, password: "pw" });
    return { username, name, cookie: login.cookie };
};

// A simulated browser tab: connects with the account's cookie and records every event it receives
const connect = (account) => new Promise((resolve) => {
    const socket = io(BASE, { extraHeaders: { cookie: account.cookie }, transports: ["websocket"], reconnection: false });
    const tab = { socket, events: [], notices: [], disconnectReason: null, lastRoom: null, gameStart: null, refused: null };
    socket.onAny((event, data) => {
        tab.events.push(event);
        if (event === "room:notice") tab.notices.push(data.type);
        if (event === "room:update") tab.lastRoom = data;
        if (event === "game:start") tab.gameStart = data;
    });
    socket.on("disconnect", (reason) => { tab.disconnectReason = reason; });
    socket.on("connect", () => resolve(tab));
    socket.on("connect_error", (err) => { tab.refused = err.message; resolve(tab); });
});
const count = (tab, event) => tab.events.filter(e => e === event).length;
const waitFor = async (condition, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (condition()) return true; await sleep(50); }
    return condition();
};
// Simulate a browser refresh: the connection drops without the player pressing anything
const dropConnection = (tab) => tab.socket.io.engine.close();

// ---------- tests ----------

async function run() {
    // 1. Data files are created at startup
    check(fs.existsSync(path.join(DATA_DIR, "users.json")), "data folder and users.json were created at startup");

    // 2. Registration rules
    const reg = (username, name, password = "pw") => post("/register", { username, name, password }).then(r => r.json);
    check((await reg("", "X")).error, "empty username rejected");
    check((await reg("a b", "X")).error, "username with a space rejected");
    check((await reg("a".repeat(17), "X")).error, "17-character username rejected");
    check((await reg("ab", "n".repeat(21))).error, "21-character name rejected");
    check((await reg("ok1", "   ")).error, "blank name rejected");
    check((await reg("a", "One char")).success, "1-character username accepted");
    check((await reg("Mixed_Case", "★ Any name 🐉")).success, "symbols and emoji in name accepted");
    check((await reg("mixed_case", "X")).error === "Username has already been used.", "duplicate username rejected ignoring case");

    // 3. Two players registering at the same moment must both be saved
    const names = Array.from({ length: 10 }, (_, i) => "burst" + i);
    await Promise.all(names.map(n => reg(n, n)));
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "users.json")));
    check(names.every(n => saved[n]), "10 simultaneous registrations were all saved");
    const same = await Promise.all(Array.from({ length: 6 }, () => reg("samename", "S")));
    check(same.filter(r => r.success).length === 1, "same username registered at once: exactly one wins");
    check(fs.readdirSync(DATA_DIR).every(f => !f.endsWith(".tmp")), "no temporary files left behind");

    // 4. The guide gates the lobby
    const fresh = await post("/register", { username: "guided", name: "Guided", password: "pw" });
    check(!fresh.json.user && (await get("/validate", fresh.cookie)).json.error, "register does not sign the player in");
    const login1 = await post("/signin", { username: "guided", password: "pw" });
    check(login1.json.needsGuide === true, "first sign-in says the guide is needed");
    check((await connect(login1)).refused === "Please finish the How to Play guide first.", "lobby refused before the guide is finished");
    check((await post("/guide-complete")).json.error, "guide-complete without any session is refused");
    await post("/guide-complete", undefined, login1.cookie);
    const t = await connect(login1);
    check(t.refused === null && t.socket.connected, "lobby allowed after the guide");
    t.socket.close();

    // 5. Sign-in rate limit
    const victim = await makeUser("victim");
    for (let i = 0; i < 5; i++) await post("/signin", { username: "victim", password: "wrong" });
    const locked = await post("/signin", { username: "victim", password: "pw" });
    check(/Too many failed attempts/.test(locked.json.error || ""), "5 wrong passwords lock the username (even the right password is refused)");
    check((await post("/signin", { username: "a", password: "pw" })).json.user, "another username can still sign in");

    // 6. Solo gameplay starts without pairing or a countdown
    const solo = await connect(await makeUser("solo", "Solo"));
    solo.socket.emit("lobby:solo");
    check(await waitFor(() => count(solo, "game:start") === 1), "solo run starts immediately");
    check(solo.gameStart && solo.gameStart.players.length === 1 && solo.gameStart.players[0].username === "solo", "solo run only contains the local player");
    solo.socket.close();
    await sleep(200);

    // 7. Pairing, notices, countdown
    const [alice, bob] = [await makeUser("alice", "Alice"), await makeUser("bob", "Bob")];
    const A = await connect(alice), B = await connect(bob);
    A.socket.emit("room:quick"); await sleep(200);
    check(A.lastRoom && A.lastRoom.players.length === 1, "first player waits alone in a new room");
    B.socket.emit("room:quick");
    check(await waitFor(() => A.lastRoom && A.lastRoom.players.length === 2), "second Quick Match lands in the same room");
    check(A.notices.includes("joined"), "partner gets a 'joined' notice");
    A.socket.emit("lobby:ready");
    check(await waitFor(() => B.notices.includes("ready")), "partner gets a 'ready' notice");
    A.socket.emit("lobby:ready");
    check(await waitFor(() => B.notices.includes("unready")), "partner gets an 'unready' notice");
    A.socket.emit("lobby:ready"); B.socket.emit("lobby:ready");
    check(await waitFor(() => count(A, "room:countdown") >= 3 && count(B, "game:start") === 1, 6000), "both ready: 3-2-1 countdown, then game:start");

    // 8. Refresh keeps the seat (rejoin within the grace period)
    dropConnection(B); 
    check(await waitFor(() => A.notices.includes("away")), "partner sees 'away' when a connection drops");
    const B2 = await connect(bob);
    check(await waitFor(() => A.notices.includes("back")), "partner sees 'back' after the reconnect");
    check(B2.events.includes("game:start") && B2.lastRoom && B2.lastRoom.players.length === 2, "reconnected player is put back into the running game");
    // Not coming back: the seat is released after the grace period
    dropConnection(B2);
    check(await waitFor(() => A.notices.includes("left"), GRACE_MS + 3000), "seat released after the grace period ('left' notice)");
    check(A.lastRoom.status === "lobby" && A.lastRoom.players.length === 1, "remaining player is back in a waiting room");

    // 9. Second tab replaces the first, and takes over the seat
    const A2 = await connect(alice);
    check(await waitFor(() => A.disconnectReason === "io server disconnect") && A.events.includes("session:replaced"), "older tab is told it was replaced and disconnected");
    check(A2.lastRoom && A2.lastRoom.players.length === 1, "new tab takes over the seat in the room");

    // 10. Signing out disconnects every tab at once and frees the seat (no grace period)
    const C = await connect(bob); C.socket.emit("room:quick");
    await waitFor(() => A2.lastRoom && A2.lastRoom.players.length === 2);
    await get("/signout", bob.cookie);
    check(await waitFor(() => C.disconnectReason === "io server disconnect"), "sign out disconnects the player's socket");
    check(await waitFor(() => A2.notices.filter(n => n === "left").length >= 1 && A2.lastRoom.players.length === 1, 1000), "seat freed immediately on sign out");
    check((await get("/validate", bob.cookie)).json.error, "session is gone after sign out");

    // 11. Rooms are isolated
    const [p1, p2, p3, p4] = await Promise.all(["iso1", "iso2", "iso3", "iso4"].map(n => makeUser(n)));
    const [T1, T2, T3, T4] = [await connect(p1), await connect(p2), await connect(p3), await connect(p4)];
    T1.socket.emit("room:create", { name: "Room One" }); await sleep(100);
    T2.socket.emit("room:join", T1.lastRoom.id);
    T3.socket.emit("room:create", { name: "Room Two" }); await sleep(100);
    T4.socket.emit("room:join", T3.lastRoom.id);
    await sleep(200);
    [T1, T2, T3, T4].forEach(x => x.socket.emit("lobby:ready"));
    check(await waitFor(() => [T1, T2, T3, T4].every(x => count(x, "game:start") === 1), 6000), "two rooms start games at the same time");
    check(T1.lastRoom.id !== T3.lastRoom.id && T1.lastRoom.players.every(p => ["iso1", "iso2"].includes(p.username)), "each room only knows its own players");
    check(T1.notices.every(n => n !== "left") && T3.notices.every(n => n !== "left"), "nothing leaked between rooms");

    // 12. Bad messages never crash the server or break later messages
    const E = await makeUser("evil"), ET = await connect(E);
    for (const payload of [null, 42, "x", {}, [], { name: {} }, { name: 123 }]) ET.socket.emit("room:create", payload), ET.socket.emit("room:leave");
    for (const payload of [null, 42, {}, [], "r1;drop", "../etc", "r99999999999999"]) ET.socket.emit("room:join", payload);
    for (const payload of ["yes", 1, {}, []]) ET.socket.emit("lobby:ready", payload);
    await sleep(400);
    ET.socket.emit("room:create", { name: "Still alive" });
    check(await waitFor(() => ET.lastRoom && ET.lastRoom.name === "Still alive"), "server survives garbage messages and keeps working");

    // 13. No stale rooms
    ET.socket.emit("room:leave"); [T1, T2, T3, T4, A2].forEach(x => x.socket.close()); ET.socket.close();
    await sleep(500);
    const L = await connect(await makeUser("looker"));
    L.socket.emit("rooms:request");
    const listed = await new Promise(r => { L.socket.once("rooms:list", r); L.socket.emit("rooms:request"); });
    check(Array.isArray(listed) && listed.length === 0, "no leftover rooms after everyone left");
    L.socket.close();
}

// ---------- start the server, run, stop ----------

const server = spawn("node", ["game_server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, GRACE_MS: String(GRACE_MS) }
});
let output = "";
server.stdout.on("data", d => { output += d; });
server.stderr.on("data", d => { output += d; });

(async () => {
    try {
        if (!await waitFor(() => output.includes("The game server has started"), 10000)) throw new Error("server did not start:\n" + output);
        await run();
        check(server.exitCode === null, "server process is still running");
    } catch (err) {
        failures++;
        console.log("FAIL test crashed:", err.stack || err);
    }
    server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.\n--- server output ---\n${output}`);
    process.exit(failures === 0 ? 0 : 1);
})();
