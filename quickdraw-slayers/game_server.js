const express = require("express");

// Additional packages for handling authentication
const argon2 = require("argon2");
const fs = require("fs");
const session = require("express-session");

// Socket.IO for the real-time lobby and game
const { createServer } = require("http");
const { Server } = require("socket.io");

// Create the Express app
const app = express();

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
    cookie: { maxAge: 300000 }
});
app.use(gameSession);

// This helper function checks whether the text only contains word characters
function containWordCharsOnly(text) {
    return /^\w+$/.test(text);
}

// Limits for account details.
// Username: letters, numbers and underscores only (so no spaces), 1-16 characters, unique ignoring case.
// Name: anything you like (spaces, symbols, emoji), just not empty and at most 20 characters.
const MIN_USERNAME = 1;
const MAX_USERNAME = 16;
const MAX_NAME = 20;
const MAX_PASSWORD = 128;

// Find the stored username that matches `username` ignoring upper/lower case (or null)
const findUsername = (users, username) =>
    Object.keys(users).find(key => key.toLowerCase() === username.toLowerCase()) || null;

// Remove control characters and surrounding spaces from a name
const cleanName = (name) => name.replace(/[\u0000-\u001f\u007f]/g, "").trim();

// Read / write the accounts file
const loadUsers = () => JSON.parse(fs.readFileSync("data/users.json"));
const saveUsers = (users) => fs.writeFileSync("data/users.json", JSON.stringify(users, null, " "));

// A new account must read How to Play once. Accounts without the flag (older ones) are treated as done.
const needsGuide = (users, username) => Object.hasOwn(users, username) && users[username].seenGuide === false;

// Handle the /register endpoint: creates the account (the player then reads How to Play and signs in)
app.post("/register", async (req, res) => {
    const { username, name, password } = req.body;
    const users = loadUsers();

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
    if (findUsername(users, username)) {
        res.json({ error: "Username has already been used." });
        return;
    }

    // Save the account; seenGuide: false means the player must go through How to Play first
    const hash = await argon2.hash(password);
    users[username] = { name: cleanedName, password: hash, seenGuide: false };
    saveUsers(users);

    // The player is NOT signed in. This browser session is only allowed to mark the guide as done
    // for this new account (so they read it once now and then sign in normally).
    req.session.guideUser = username;
    res.json({ success: true, username, name: cleanedName, needsGuide: true });
});

// Handle the /signin endpoint
app.post("/signin", async (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();

    // Same message for an unknown user and a wrong password
    const key = (typeof username === "string" && typeof password === "string") ? findUsername(users, username) : null;
    if (!key) {
        res.json({ error: "Incorrect username/password." });
        return;
    }
    const user = users[key];
    const verified = await argon2.verify(user.password, password);
    if (!verified) {
        res.json({ error: "Incorrect username/password." });
        return;
    }

    req.session.user = { username: key, name: user.name };
    res.json({ user: req.session.user, needsGuide: needsGuide(users, key) });
});

// Handle the /validate endpoint: is this browser still signed in?
app.get("/validate", (req, res) => {
    const user = req.session.user;
    if (!user) {
        res.json({ error: "You have not signed in." });
        return;
    }

    // The account may have been removed from users.json since the session was created
    const users = loadUsers();
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
    const users = loadUsers();
    if (!Object.hasOwn(users, username)) {
        res.json({ error: "Account not found." });
        return;
    }
    users[username].seenGuide = true;
    saveUsers(users);
    delete req.session.guideUser;
    res.json({ success: true });
});

// Handle the /signout endpoint
app.get("/signout", (req, res) => {
    if (req.session.user) {
        delete req.session.user;
    }
    res.json({ success: true });
});

// Socket.IO shares the login session: only signed-in users may connect
const httpServer = createServer(app);
const io = new Server(httpServer);
io.engine.use(gameSession);
io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) { next(new Error("Not signed in")); return; }
    // Players who have not finished the How to Play guide cannot enter the lobby
    const users = loadUsers();
    if (!Object.hasOwn(users, user.username)) { next(new Error("Not signed in")); return; }
    if (needsGuide(users, user.username)) { next(new Error("Please finish the How to Play guide first.")); return; }
    socket.data.user = user;
    next();
});

// All lobby / room / game logic lives in server/
require("./server/lobby")(io);

// Use a web server to listen at port 8000
httpServer.listen(8000, () => {
    console.log("The game server has started...");
});
