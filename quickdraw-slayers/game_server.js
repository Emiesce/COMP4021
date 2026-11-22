const express = require("express");

// Additional packages for handling authentication
const argon2 = require("argon2");
const session = require("express-session");

// Socket.IO for the real-time lobby and game
const { createServer } = require("http");
const { Server } = require("socket.io");

const store = require("./server/store");
const leaderboard = require("./server/leaderboard");
const { createLimiter } = require("./server/ratelimit");

const PORT = process.env.PORT || 8000;
const SESSION_MS = 15 * 60 * 1000;      // a sign-in lasts 15 minutes after the last activity

// Create the data folder / users.json if they are missing
store.init();

// Create the Express app and the HTTP server that Socket.IO shares with it
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Use the 'public' folder to serve static files
app.use(express.static("public"));

// Use the json middleware to parse JSON data
app.use(express.json());

// Use the session middleware to maintain sessions
const gameSession = session({
    secret: "quickdraw",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: SESSION_MS }
});
app.use(gameSession);

// Limits for account details.
// Username: letters, numbers and underscores only (so no spaces), 1-16 characters, unique ignoring case.
// Name: anything you like (spaces, symbols, emoji), just not empty and at most 20 characters.
const MIN_USERNAME = 1;
const MAX_USERNAME = 16;
const MAX_NAME = 20;
const MAX_PASSWORD = 128;

// Sign-in limits: 5 wrong passwords for one username, or 30 from one address, within a minute
// lock that username/address for 30 seconds.
const userLimiter = createLimiter({ max: 5, windowMs: 60000, lockMs: 30000 });
const ipLimiter = createLimiter({ max: 30, windowMs: 60000, lockMs: 30000 });

// This helper function checks whether the text only contains word characters
function containWordCharsOnly(text) {
    return /^\w+$/.test(text);
}

// Find the stored username that matches `username` ignoring upper/lower case (or null)
const findUsername = (users, username) =>
    Object.keys(users).find(key => key.toLowerCase() === username.toLowerCase()) || null;

// Remove control characters and surrounding spaces from a name
const cleanName = (name) => name.replace(/[\u0000-\u001f\u007f]/g, "").trim();

// A new account must read How to Play once. Accounts without the flag (older ones) are treated as done.
const needsGuide = (users, username) => Object.hasOwn(users, username) && users[username].seenGuide === false;

// Handle the /register endpoint: creates the account (the player then reads How to Play and signs in)
app.post("/register", async (req, res) => {
    const { username, name, password } = req.body || {};

    // Validation (the browser checks too, but the server never trusts it)
    if (typeof username !== "string" || typeof name !== "string" || typeof password !== "string") {
        res.json({ error: "Username/name/password cannot be empty." });
        return;
    }
    const cleanedName = cleanName(name);
    if (!username || !cleanedName || !password) {
        res.json({ error: "Username/name/password cannot be empty." });
        return;
    }
    if (!containWordCharsOnly(username)) {
        res.json({ error: "Username can only contain letters, numbers and underscores (no spaces)." });
        return;
    }
    if (username.length < MIN_USERNAME || username.length > MAX_USERNAME) {
        res.json({ error: `Username must be ${MIN_USERNAME}-${MAX_USERNAME} characters.` });
        return;
    }
    if ([...cleanedName].length > MAX_NAME) {
        res.json({ error: `Name can be at most ${MAX_NAME} characters.` });
        return;
    }
    if (password.length > MAX_PASSWORD) {
        res.json({ error: `Password can be at most ${MAX_PASSWORD} characters.` });
        return;
    }
    if (findUsername(store.loadUsers(), username)) {
        res.json({ error: "Username has already been used." });
        return;
    }

    const hash = await argon2.hash(password);

    // Hashing is slow, so read the accounts again right before saving: if two players register at the
    // same moment, neither account may overwrite the other, and the same username can only win once.
    const users = store.loadUsers();
    if (findUsername(users, username)) {
        res.json({ error: "Username has already been used." });
        return;
    }
    // seenGuide: false means the player must go through How to Play first
    users[username] = { name: cleanedName, password: hash, seenGuide: false };
    store.saveUsers(users);

    // The player is NOT signed in. This browser session is only allowed to mark the guide as done
    // for this new account (so they read it once now and then sign in normally).
    req.session.guideUser = username;
    res.json({ success: true, username, name: cleanedName, needsGuide: true });
});

// Handle the /signin endpoint
app.post("/signin", async (req, res) => {
    const { username, password } = req.body || {};
    const userKey = "u:" + (typeof username === "string" ? username.toLowerCase() : "?");
    const ipKey = "ip:" + req.ip;

    // Too many wrong passwords recently?
    const blocked = [userLimiter.check(userKey), ipLimiter.check(ipKey)].find(c => c.blocked);
    if (blocked) {
        res.json({ error: `Too many failed attempts. Try again in ${blocked.retryAfter} seconds.` });
        return;
    }

    const users = store.loadUsers();

    // Same message for an unknown user and a wrong password
    const key = (typeof username === "string" && typeof password === "string") ? findUsername(users, username) : null;
    const verified = key ? await argon2.verify(users[key].password, password) : false;
    if (!verified) {
        userLimiter.fail(userKey);
        ipLimiter.fail(ipKey);
        res.json({ error: "Incorrect username/password." });
        return;
    }

    userLimiter.reset(userKey);
    req.session.user = { username: key, name: users[key].name };
    res.json({ user: req.session.user, needsGuide: needsGuide(users, key) });
});

// Handle the /validate endpoint: is this browser still signed in?
// The lobby also calls it every minute while a player is connected, which keeps the session alive.
app.get("/validate", (req, res) => {
    const user = req.session.user;
    if (!user) {
        res.json({ error: "You have not signed in." });
        return;
    }

    // The account may have been removed from users.json since the session was created
    const users = store.loadUsers();
    if (!Object.hasOwn(users, user.username)) {
        delete req.session.user;
        res.json({ error: "You have not signed in." });
        return;
    }

    res.json({ user, needsGuide: needsGuide(users, user.username) });
});

// Handle the /guide-complete endpoint: the player reached the end of How to Play.
// Allowed for a signed-in player, or for the account this browser has just registered.
app.post("/guide-complete", (req, res) => {
    const username = req.session.user ? req.session.user.username : req.session.guideUser;
    if (!username) {
        res.json({ error: "You have not signed in." });
        return;
    }
    const users = store.loadUsers();
    if (!Object.hasOwn(users, username)) {
        res.json({ error: "Account not found." });
        return;
    }
    users[username].seenGuide = true;
    store.saveUsers(users);
    delete req.session.guideUser;
    res.json({ success: true });
});

// Handle the /leaderboard endpoint: the best runs, for the lobby's Hall of Slayers
app.get("/leaderboard", (req, res) => {
    if (!req.session.user) {
        res.json({ error: "You have not signed in." });
        return;
    }
    try {
        res.json({ entries: leaderboard.top(10) });
    } catch (err) {
        console.error("Could not read the leaderboard:", err);
        res.json({ error: "The leaderboard could not be read." });
    }
});

// Handle the /signout endpoint
app.get("/signout", (req, res) => {
    if (req.session.user) {
        delete req.session.user;
    }
    // Every open tab of this browser session is disconnected from the lobby/game straight away
    io.in("session:" + req.sessionID).disconnectSockets(true);
    res.json({ success: true });
});

// Anything unexpected (corrupt data file, bad JSON from a client...) becomes a JSON error
app.use((err, req, res, next) => {
    console.error("Request error:", err.message);
    if (res.headersSent) { next(err); return; }
    res.status(err.status || 500).json({ error: "Server error." });
});

// Socket.IO shares the login session: only signed-in users may connect
io.engine.use(gameSession);
io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) { next(new Error("Not signed in")); return; }
    try {
        const users = store.loadUsers();
        if (!Object.hasOwn(users, user.username)) { next(new Error("Not signed in")); return; }
        // Players who have not finished the How to Play guide cannot enter the lobby
        if (needsGuide(users, user.username)) { next(new Error("Please finish the How to Play guide first.")); return; }
    } catch (err) {
        next(new Error("Server error"));
        return;
    }
    socket.data.user = user;
    next();
});

// All lobby / room / game logic lives in server/
require("./server/lobby")(io);

// Use a web server to listen at the port
httpServer.listen(PORT, () => {
    console.log("The game server has started...");
});
