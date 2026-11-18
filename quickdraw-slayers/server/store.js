// Data files (accounts). Everything that reads or writes data/ goes through here.
//   - init() creates the data folder and users.json if they are missing or empty
//   - writes are atomic: the new content goes to a temporary file which is then renamed over the
//     real file, so a crash in the middle of a write can never leave a half-written users.json
// The folder can be changed with the DATA_DIR environment variable (the tests use this).
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "data";
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Read a JSON file. A missing or empty file gives `fallback`; a corrupt file throws, so that
// accounts are never silently wiped.
function readJson(file, fallback) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") return fallback;
        throw err;
    }
    if (text.trim() === "") return fallback;
    return JSON.parse(text);
}

// Write a JSON file safely (temporary file + rename)
function writeJson(file, data) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, " "));
    fs.renameSync(temp, file);
}

// Create the data folder and an empty users.json when needed (called once at startup)
function init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (readJson(USERS_FILE, null) === null) writeJson(USERS_FILE, {});
}

function loadUsers() {
    const users = readJson(USERS_FILE, {});
    if (users === null || typeof users !== "object" || Array.isArray(users)) {
        throw new Error(`${USERS_FILE} must contain a JSON object`);
    }
    return users;
}

function saveUsers(users) {
    writeJson(USERS_FILE, users);
}

module.exports = { init, readJson, writeJson, loadUsers, saveUsers };
