const {
    MASTER_TIME_MS,
    ENERGY_INTERVAL_MS,
    REWARD_TIME_MS,
    MAX_SHIELD,
    DECK_COPIES,
    CARD_SLOT_COOLDOWN_MS,
    STATE_RATE_MS,
    FLOOR_HEALTH,
    FLOOR_HEALTH_VARIANCE,
    PLAYER_SCALING,
    CARD_POOL,
    ENEMIES
} = require("../public/scripts/game_data");

const VALID_REWARDS = new Set(["card", "buff", "heal"]);
const FLOOR_TRANSITION_MS = 700;

const shuffle = (items) => {
    const values = [...items];
    for (let index = values.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [values[index], values[swap]] = [values[swap], values[index]];
    }
    return values;
};

function create(io, room, onOver) {
    let timer = null;
    let state = null;
    let lastTick = 0;
    let finished = false;
    const playerCount = room.players.length;
    const authoritative = playerCount > 1;

    const emitRoom = (event, payload) => io.to(room.id).emit(event, payload);
    const emitEffect = (effect) => emitRoom("game:effect", effect);
    const playerForSocket = (socketId) => state && state.players.find(player => player.socketId === socketId);

    const roomPlayer = (player) =>
        room.players.find(candidate => candidate.username === player.username);

    const buildDeck = () => shuffle(CARD_POOL.flatMap(card =>
        Array.from({ length: DECK_COPIES }, () => ({ ...card }))
    ));

    const drawCategory = (player, predicate) => {
        const index = player.deck.findIndex(predicate);
        return player.deck.splice(index >= 0 ? index : 0, 1)[0];
    };

    const makeHand = (player) => {
        player.deck = buildDeck();
        player.hand = [
            drawCategory(player, card => card.type === "ATTACK"),
            drawCategory(player, card => card.type === "BLOCK"),
            drawCategory(player, card => card.type === "UTILITY"),
            drawCategory(player, () => true)
        ];
    };

    const replaceCard = (player, slot) => {
        if (player.deck.length === 0) player.deck = buildDeck();
        player.hand[slot] = player.deck.shift();
        if (!player.hand[slot]) player.hand[slot] = { ...CARD_POOL[0] };
    };

    const makePlayer = (source, index) => {
        const player = {
            socketId: source.socketId,
            username: source.username,
            name: source.name,
            index,
            hp: 100,
            maxHp: 100,
            shield: 0,
            energy: 4,
            energyMax: 4,
            energyProgress: 0,
            damageBoost: 1,
            hand: [],
            deck: [],
            lockedUntil: [0, 0, 0, 0],
            rewardChoice: null,
            diedAt: null,
            stats: { damage: 0, blocked: 0, cards: 0 }
        };
        makeHand(player);
        return player;
    };

    const scaling = () => ({
        playerCount,
        health: 1 + Math.max(0, playerCount - 1) * PLAYER_SCALING.healthPerExtra,
        damage: 1 + Math.max(0, playerCount - 1) * PLAYER_SCALING.damagePerExtra
    });

    const spawnEnemy = () => {
        const template = state.enemyOrder[state.floor - 1];
        const scale = scaling();
        const maxHp = Math.round(
            FLOOR_HEALTH[state.floor - 1] *
            FLOOR_HEALTH_VARIANCE[state.floor - 1] *
            scale.health
        );
        state.enemy = {
            ...template,
            maxHp,
            hp: maxHp,
            attackElapsed: 0,
            attackDelay: Math.max(5400, template.attackDelay + 1200 - (state.floor - 1) * 400),
            attackNumber: 0,
            vulnerableUntil: 0,
            weaknessAttacks: 0
        };
        state.players.forEach(player => {
            player.energyMax = state.floor + 3;
            player.energy = player.energyMax;
            player.energyProgress = 0;
            if (player.hp <= 0) {
                player.hp = Math.ceil(player.maxHp / 2);
                player.diedAt = null;
            }
            else if (player.diedAt != null) {
                player.diedAt = null;
            }
        });
    };

    const snapshot = () => {
        if (!state) return null;
        const now = Date.now();
        return {
            t: state.clock,
            floor: state.floor,
            status: state.status,
            timeLeft: Math.max(0, state.timeRemaining),
            rewardEndsIn: state.status === "reward" ? Math.max(0, state.statusUntil - now) : 0,
            cheat: state.cheat,
            scaling: scaling(),
            enemy: {
                id: state.enemy.id,
                name: state.enemy.name,
                intent: state.enemy.intent,
                color: state.enemy.color,
                hp: Math.max(0, state.enemy.hp),
                maxHp: state.enemy.maxHp,
                nextAttackIn: Math.max(0, state.enemy.attackDelay - state.enemy.attackElapsed),
                attackDelay: state.enemy.attackDelay,
                vulnerableRemaining: Math.max(0, state.enemy.vulnerableUntil - state.clock),
                weaknessAttacks: state.enemy.weaknessAttacks
            },
            players: state.players.map(player => {
                const member = roomPlayer(player);
                return {
                    username: player.username,
                    name: player.name,
                    index: player.index,
                    hp: player.hp,
                    maxHp: player.maxHp,
                    shield: player.shield,
                    energy: player.energy,
                    energyMax: player.energyMax,
                    energyProgress: player.energyProgress,
                    hand: player.hand.map(card => card.id),
                    deckCount: player.deck.length,
                    cooldowns: player.lockedUntil.map(until => Math.max(0, until - now)),
                    damageBoost: player.damageBoost,
                    rewardChoice: player.rewardChoice,
                    away: Boolean(member && member.away)
                };
            })
        };
    };

    const sendState = (target) => {
        const payload = snapshot();
        if (!payload) return;
        if (target) target.emit("game:state", payload);
        else emitRoom("game:state", payload);
    };

    const finish = (won, reason) => {
        if (finished || !state) return;
        finished = true;
        state.status = "over";
        if (timer) clearInterval(timer);
        timer = null;
        sendState();
        const result = {
            won,
            reason,
            floors: state.floorsCleared,
            durationMs: Math.max(0, Math.round(state.durationMs)),
            players: state.players.map(player => ({
                username: player.username,
                name: player.name,
                damage: Math.round(player.stats.damage),
                blocked: Math.round(player.stats.blocked),
                cards: player.stats.cards,
                survivalMs: player.diedAt == null
                    ? Math.round(state.durationMs)
                    : Math.round(player.diedAt)
            }))
        };
        if (onOver) onOver(result);
    };

    const endAborted = () => {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (state) state.status = "over";
        if (onOver) onOver();
    };

    const updateEnergy = (delta) => {
        state.players.forEach(player => {
            const member = roomPlayer(player);
            if (player.hp <= 0 || (member && member.away)) return;
            if (player.energy >= player.energyMax) {
                player.energyProgress = 0;
                return;
            }
            player.energyProgress += delta;
            while (player.energyProgress >= ENERGY_INTERVAL_MS && player.energy < player.energyMax) {
                player.energyProgress -= ENERGY_INTERVAL_MS;
                player.energy++;
            }
            if (player.energy >= player.energyMax) player.energyProgress = 0;
        });
    };

    const checkDefeat = () => {
        if (state.players.every(player => player.hp <= 0)) {
            finish(false, "Both Slayers fell.");
            return true;
        }
        return false;
    };

    const availableAttackTargets = () => {
        const living = state.players.filter(player => player.hp > 0);
        const connected = living.filter(player => {
            const member = roomPlayer(player);
            return !member || !member.away;
        });
        return connected.length ? connected : living;
    };

    const damagePlayer = (target, incoming) => {
        if (state.status !== "active" || target.hp <= 0) return;
        if (state.cheat) {
            emitEffect({ type: "immune", target: target.index });
            return;
        }

        const blocked = Math.min(target.shield, incoming);
        target.shield -= blocked;
        target.stats.blocked += blocked;
        const damage = incoming - blocked;
        target.hp = Math.max(0, target.hp - damage);
        if (target.hp <= 0 && target.diedAt == null) target.diedAt = state.durationMs;
        emitEffect({
            type: blocked > 0 && damage === 0 ? "block" : "hit",
            target: target.index,
            damage,
            blocked,
            hp: target.hp
        });
        checkDefeat();
    };

    const attack = () => {
        const targets = availableAttackTargets();
        if (!targets.length) {
            checkDefeat();
            return;
        }
        const target = targets[state.enemy.attackNumber % targets.length];
        state.enemy.attackNumber++;
        let incoming = state.enemy.baseDamage + (state.floor - 1) * 7;
        if (state.enemy.weaknessAttacks > 0) {
            incoming *= 0.65;
            state.enemy.weaknessAttacks--;
        }
        incoming *= scaling().damage;
        const attackModifier = state.enemy.id === "enemy_firebird"
            ? 1.05
            : state.enemy.id === "enemy_dragon" && state.enemy.attackNumber % 2 === 0
                ? 0.85
                : state.enemy.id === "enemy_typhoon"
                    ? 0.78
                    : 1;
        incoming = Math.round(incoming * attackModifier);
        emitEffect({ type: "enemy-attack", target: target.index, enemy: state.enemy.id, damage: incoming });
        damagePlayer(target, incoming);
    };

    const beginReward = () => {
        if (finished || state.floor >= 3) return;
        state.status = "reward";
        state.statusUntil = Date.now() + REWARD_TIME_MS;
        state.players.forEach(player => { player.rewardChoice = null; });
        sendState();
    };

    const clearFloor = () => {
        if (state.status !== "active" || state.enemy.hp > 0) return;
        state.floorsCleared++;
        state.status = "transition";
        state.statusUntil = Date.now() + FLOOR_TRANSITION_MS;
        emitEffect({ type: "floor", floor: state.floor });
        sendState();
    };

    const nextFloor = () => {
        if (state.status !== "reward" || finished) return;
        state.floor++;
        state.status = "active";
        state.statusUntil = 0;
        state.players.forEach(player => { player.rewardChoice = null; });
        spawnEnemy();
        emitEffect({ type: "next-floor", floor: state.floor });
        sendState();
    };

    const advance = (now) => {
        const delta = Math.max(0, now - lastTick);
        lastTick = now;
        state.clock += state.status === "active" ? delta : 0;

        if (state.status === "active") {
            state.durationMs += delta;
            state.timeRemaining = Math.max(0, state.timeRemaining - delta);
            if (state.timeRemaining <= 0) {
                finish(false, "The master timer reached 00:00.");
                return;
            }
            updateEnergy(delta);
            state.enemy.attackElapsed += delta;
            while (state.enemy.attackElapsed >= state.enemy.attackDelay && state.status === "active") {
                state.enemy.attackElapsed -= state.enemy.attackDelay;
                attack();
            }
        } else if (state.status === "transition" && now >= state.statusUntil) {
            if (state.floor === 3) finish(true, "All three floors cleared.");
            else beginReward();
        } else if (state.status === "reward" &&
                (now >= state.statusUntil || state.players.every(player => player.rewardChoice))) {
            nextFloor();
        }
    };

    const play = (socketId, payload) => {
        if (!authoritative || !state || finished || state.status !== "active") return false;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        const player = playerForSocket(socketId);
        if (!player || player.hp <= 0) return false;
        const member = roomPlayer(player);
        if (member && member.away) return false;
        if (!Number.isInteger(payload.slot) || payload.slot < 0 || payload.slot > 3) return false;
        const slot = payload.slot;
        const now = Date.now();
        if (player.lockedUntil[slot] > now) return false;
        const card = player.hand[slot];
        if (!card || (!state.cheat && player.energy < card.cost)) return false;

        player.lockedUntil[slot] = now + CARD_SLOT_COOLDOWN_MS;
        if (!state.cheat) player.energy -= card.cost;
        player.stats.cards++;
        let amount = 0;
        let combo = false;
        if (card.action === "damage") {
            const vulnerability = state.enemy.vulnerableUntil > state.clock ? 1.45 : 1;
            combo = state.lastUtilityAt != null && state.clock - state.lastUtilityAt <= 2200;
            if (combo) state.lastUtilityAt = null;
            amount = Math.round(card.value * player.damageBoost * vulnerability *
                (state.cheat ? 3 : 1) * (combo ? 1.25 : 1));
            state.enemy.hp = Math.max(0, state.enemy.hp - amount);
            player.stats.damage += amount;
        } else if (card.action === "block") {
            amount = Math.min(MAX_SHIELD - player.shield, card.value);
            player.shield += amount;
        } else if (card.action === "heal") {
            amount = Math.min(card.value, player.maxHp - player.hp);
            player.hp += amount;
        } else if (card.action === "energy") {
            amount = card.value;
            state.players.forEach(ally => {
                ally.energy = Math.min(ally.energyMax, ally.energy + card.value);
                ally.energyProgress = ally.energy >= ally.energyMax ? 0 : ally.energyProgress;
            });
        } else if (card.action === "weaken") {
            state.enemy.weaknessAttacks = card.value;
            state.lastUtilityAt = state.clock;
        } else if (card.action === "vulnerable") {
            state.enemy.vulnerableUntil = state.clock + card.value;
            state.lastUtilityAt = state.clock;
        } else {
            player.stats.cards--;
            return false;
        }

        replaceCard(player, slot);
        emitEffect({
            type: "card",
            player: player.index,
            slot,
            cardId: card.id,
            action: card.action,
            amount,
            combo
        });
        if (state.enemy.hp <= 0) clearFloor();
        sendState();
        return true;
    };

    const chooseReward = (socketId, payload) => {
        if (!authoritative || !state || finished || state.status !== "reward") return false;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
        const choice = payload.choice;
        if (!VALID_REWARDS.has(choice)) return false;
        const player = playerForSocket(socketId);
        if (!player || player.rewardChoice) return false;

        player.rewardChoice = choice;
        if (choice === "card") {
            const rare = CARD_POOL.filter(card => card.cost >= 2);
            const replacement = rare[Math.floor(Math.random() * rare.length)];
            const weakest = player.hand.reduce(
                (best, card, index) => card.cost < player.hand[best].cost ? index : best,
                0
            );
            player.hand[weakest] = { ...replacement };
        } else if (choice === "buff") {
            player.damageBoost += 0.12;
            player.maxHp += 10;
            player.hp = Math.min(player.maxHp, player.hp + 10);
        } else if (choice === "heal") {
            player.hp = Math.min(player.maxHp, player.hp + 40);
        }
        emitEffect({ type: "reward", player: player.index, choice });
        sendState();
        return true;
    };

    const setCheat = (socketId, payload) => {
        if (!authoritative || !state || finished || !payload || typeof payload !== "object") return false;
        if (typeof payload.on !== "boolean") return false;
        const player = playerForSocket(socketId);
        if (!player || state.cheat === payload.on) return false;
        state.cheat = payload.on;
        emitRoom("game:cheat", { on: state.cheat, by: player.username });
        sendState();
        return true;
    };

    return {
        start() {
            if (!authoritative || state || finished) return;
            state = {
                status: "active",
                floor: 1,
                floorsCleared: 0,
                timeRemaining: MASTER_TIME_MS,
                clock: 0,
                durationMs: 0,
                statusUntil: 0,
                cheat: false,
                lastUtilityAt: null,
                enemyOrder: shuffle(ENEMIES.map(enemy => ({ ...enemy }))),
                players: room.players.map(makePlayer),
                enemy: null
            };
            spawnEnemy();
            lastTick = Date.now();
            sendState();
            timer = setInterval(() => {
                if (!finished && state) {
                    advance(Date.now());
                    if (!finished) sendState();
                }
            }, STATE_RATE_MS);
            timer.unref();
        },
        play,
        chooseReward,
        setCheat,
        playerLeft() {
            if (authoritative) endAborted();
            else if (!finished && onOver) {
                finished = true;
                onOver();
            }
        },
        playerRejoined(oldSocketId, newSocketId) {
            if (!authoritative || !state || finished) return;
            const player = playerForSocket(oldSocketId);
            if (!player) return;
            player.socketId = newSocketId;
            const socket = io.sockets.sockets.get(newSocketId);
            if (socket) sendState(socket);
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
            finished = true;
        },
        snapshot
    };
}

module.exports = { create, scalingForPlayerCount: (count) => ({
    playerCount: count,
    health: 1 + Math.max(0, count - 1) * PLAYER_SCALING.healthPerExtra,
    damage: 1 + Math.max(0, count - 1) * PLAYER_SCALING.damagePerExtra
}) };
