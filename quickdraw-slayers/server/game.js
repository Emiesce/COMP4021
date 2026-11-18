// One game (one fight) for ONE room. The server owns the whole game state:
// browsers only send intentions ("play the card in slot 2"); the server checks
// them, updates the state and broadcasts the result to that room only.
//
// This starter is a working vertical slice:
//   one training dummy (instead of 3 floors), attack cards only, 4-card hands,
//   Energy +1 every 2.5 s, 4:00 master timer, stats, saved leaderboard, cheat flag.
// TODO (group): enemy attack timers, hazards, block/heal/buff cards, floors,
// reward overlay, dead-player rules (see the announcement).
//
// Server -> client events (this room only):
//   game:state  {timeLeft, enemy:{name,hp,maxHp}, players:[{name,avatar,hp,maxHp,energy,maxEnergy,energyProgress,cheat,alive}]}  20x/s
//   game:hand   [{id,name,cost,type,damage}]     private to the card owner
//   game:event  {type:"card_played",by,card,damage,target} | {type:"cheat",by,on}
//   game:rejected "reason"                       only to the player whose play failed
//   game:over   {result,reason,duration,stats,leaderboard}
const Cards = require("./cards");
const Leaderboard = require("./leaderboard");

const TICK_MS = 50;
const MASTER_SECONDS = 240;
const ENERGY_REGEN_MS = 2500;
const HAND_SIZE = 4;
const PLAYER_HP = 60;
const START_ENERGY = 3;
const MAX_ENERGY = 3;            // TODO: 3 / 4 / 5 on floors 1 / 2 / 3
const ENEMY = { name: "Training Dummy", hp: 120 };

function create(io, room, onOver) {
    const state = {
        timeLeft: MASTER_SECONDS,
        over: false,
        enemy: { name: ENEMY.name, hp: ENEMY.hp, maxHp: ENEMY.hp },
        players: room.players.map(p => ({
            socketId: p.socketId, username: p.username, name: p.name, avatar: p.avatar,
            hp: PLAYER_HP, maxHp: PLAYER_HP,
            energy: START_ENERGY, maxEnergy: MAX_ENERGY, energyTimer: 0,
            deck: Cards.createDeck(), hand: [], cheat: false,
            stats: { damageDealt: 0, damageBlocked: 0, cardsPlayed: 0, survivalTime: 0 }
        }))
    };
    let timer = null, last = 0, startedAt = 0;

    const find = (socketId) => state.players.findIndex(p => p.socketId === socketId);
    const toRoom = (event, data) => io.to(room.id).emit(event, data);
    const sendHand = (p) => io.to(p.socketId).emit("game:hand", p.hand.map(id => Cards.CARDS[id]));

    const snapshot = () => ({
        timeLeft: Math.max(0, state.timeLeft),
        enemy: state.enemy,
        players: state.players.map(p => ({
            name: p.name, avatar: p.avatar, hp: p.hp, maxHp: p.maxHp,
            energy: p.energy, maxEnergy: p.maxEnergy,
            energyProgress: p.energy >= p.maxEnergy ? 1 : p.energyTimer / ENERGY_REGEN_MS,
            cheat: p.cheat, alive: p.hp > 0
        }))
    });

    const finish = (result, reason) => {
        if (state.over) return;
        state.over = true;
        if (timer) clearInterval(timer);
        timer = null;

        const stats = state.players.map(p => ({
            name: p.name, avatar: p.avatar, cheat: p.cheat,
            damageDealt: p.stats.damageDealt,
            damageBlocked: p.stats.damageBlocked,
            cardsPlayed: p.stats.cardsPlayed,
            survivalTime: Math.round(p.stats.survivalTime),
            score: p.stats.damageDealt + p.stats.damageBlocked + p.stats.cardsPlayed
        }));
        stats.sort((a, b) => b.score - a.score);
        stats.forEach((s, i) => { s.rank = i + 1; });

        const duration = Math.round((Date.now() - startedAt) / 1000);
        Leaderboard.add({
            players: stats.map(s => s.name),
            score: stats.reduce((sum, s) => sum + s.score, 0),
            result, duration, date: new Date().toISOString()
        });

        toRoom("game:over", { result, reason, duration, stats, leaderboard: Leaderboard.top(5) });
        if (onOver) onOver();
    };

    const tick = () => {
        const now = Date.now();
        const dt = now - last;
        last = now;

        state.timeLeft -= dt / 1000;
        for (const p of state.players) {
            if (p.hp <= 0) continue;
            p.stats.survivalTime += dt / 1000;
            if (p.cheat) {
                p.energy = p.maxEnergy; p.energyTimer = 0;
            } else if (p.energy < p.maxEnergy) {
                p.energyTimer += dt;
                if (p.energyTimer >= ENERGY_REGEN_MS) { p.energy++; p.energyTimer -= ENERGY_REGEN_MS; }
            } else {
                p.energyTimer = 0;
            }
        }

        toRoom("game:state", snapshot());
        if (state.timeLeft <= 0) finish("defeat", "Time ran out.");
    };

    return {
        start() {
            for (const p of state.players) {
                for (let i = 0; i < HAND_SIZE; i++) p.hand.push(p.deck.draw());
                sendHand(p);
            }
            startedAt = last = Date.now();
            toRoom("game:state", snapshot());
            timer = setInterval(tick, TICK_MS);
        },

        play(socketId, slot) {
            if (state.over) return;
            const i = find(socketId);
            if (i === -1) return;
            const p = state.players[i];
            const reject = (why) => io.to(socketId).emit("game:rejected", why);

            if (p.hp <= 0) return reject("You are down.");
            if (!Number.isInteger(slot) || slot < 0 || slot >= HAND_SIZE || !p.hand[slot]) return reject("No card there.");
            const card = Cards.CARDS[p.hand[slot]];
            if (!p.cheat && p.energy < card.cost) return reject("Not enough Energy.");

            if (!p.cheat) p.energy -= card.cost;
            const damage = card.damage * (p.cheat ? 3 : 1);
            state.enemy.hp = Math.max(0, state.enemy.hp - damage);
            p.stats.damageDealt += damage;
            p.stats.cardsPlayed++;

            p.hand[slot] = p.deck.draw();
            sendHand(p);
            toRoom("game:event", { type: "card_played", by: i, card: { id: card.id, name: card.name }, damage, target: "enemy" });
            if (state.enemy.hp <= 0) finish("victory", "The enemy was defeated!");
        },

        setCheat(socketId, on) {
            if (state.over) return;
            const i = find(socketId);
            if (i === -1) return;
            state.players[i].cheat = !!on;
            toRoom("game:event", { type: "cheat", by: i, on: !!on });
        },

        playerLeft() {
            if (state.over) return;
            finish("defeat", "Your partner left the game.");
        },

        stop() {
            state.over = true;
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}

module.exports = { create };
