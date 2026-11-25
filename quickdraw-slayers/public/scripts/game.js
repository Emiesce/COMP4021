// Solo combat remains client-local; co-op combat is rendered from server-authoritative snapshots.
const Game = (function() {
    "use strict";

    const WORLD_WIDTH = 960;
    const WORLD_HEIGHT = 540;
    // The background image is 16:9, same as the canvas. Lift it so the courtyard meets the sprites,
    // and stretch the bottom edge to cover the strip that lift uncovers.
    const BACKGROUND_SHIFT = 96;
    const {
        MASTER_TIME_MS, ENERGY_INTERVAL_MS, REWARD_TIME_MS, MAX_SHIELD, DECK_COPIES,
        CARD_POOL, ENEMIES, FLOOR_HEALTH, FLOOR_HEALTH_VARIANCE
    } = QuickdrawGameData;

    const PLAYER_LAYOUT = [
        { x: 125, y: 222, scale: 0.82, sprite: "grade_farmer", fallbackName: "Grade Farmer" },
        { x: 340, y: 254, scale: 0.68, sprite: "deadline_fighter", fallbackName: "Deadline Fighter" }
    ];
    let socket = null;
    let state = null;
    let animationFrame = null;
    let canvas = null;
    let context = null;
    let assets = { backgrounds: new Image(), sprites: {}, metadata: null };
    let lastHudPaint = 0;
    let listenersBound = false;
    let networkSocket = null;
    let localUsername = null;
    let lastHandSignature = "";

    const byId = id => document.getElementById(id);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const randomItem = items => items[Math.floor(Math.random() * items.length)];
    const shuffled = items => [...items].sort(() => Math.random() - 0.5);
    const easeOut = t => 1 - Math.pow(1 - t, 3);
    const cardById = new Map(CARD_POOL.map(card => [card.id, card]));

    function formatTime(milliseconds) {
        const total = Math.max(0, Math.ceil(milliseconds / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    function safePlayerName(roomPlayers, index) {
        const value = roomPlayers && roomPlayers[index] && roomPlayers[index].name;
        return typeof value === "string" && value.trim() ? value.slice(0, 24) : PLAYER_LAYOUT[index].fallbackName;
    }

    function buildDeck() {
        return shuffled(CARD_POOL.flatMap(card =>
            Array.from({ length: DECK_COPIES }, () => ({ ...card }))
        ));
    }

    function drawCategory(player, predicate) {
        const index = player.deck.findIndex(predicate);
        return player.deck.splice(index >= 0 ? index : 0, 1)[0];
    }

    function resetHand(player) {
        player.deck = buildDeck();
        player.hand = [
            drawCategory(player, card => card.type === "ATTACK"),
            drawCategory(player, card => card.type === "BLOCK"),
            drawCategory(player, card => card.type === "UTILITY"),
            drawCategory(player, card => true)
        ];
    }

    function setAnimation(entity, name) {
        entity.animation = { name, startedAt: performance.now() };
    }

    function makePlayer(index, roomPlayers) {
        const layout = PLAYER_LAYOUT[index];
        const player = {
            index,
            name: safePlayerName(roomPlayers, index),
            sprite: layout.sprite,
            x: layout.x,
            y: layout.y,
            scale: layout.scale,
            hp: 100,
            maxHp: 100,
            shield: 0,
            energy: 3,
            energyMax: 4,
            energyProgress: 0,
            damageBoost: 1,
            cheat: false,
            hand: [],
            deck: [],
            deckCycle: 0,
            lockedSlots: new Set(),
            lastEnergyCharge: -Infinity,
            lastDeckReset: -Infinity,
            animation: { name: "idle", startedAt: performance.now() },
            rewardChoice: null
        };
        resetHand(player);
        return player;
    }

    const Audio = {
        context: null,
        master: null,
        interval: null,
        step: 0,
        muted: false,

        unlock() {
            if (!this.context) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) return;
                this.context = new AudioContext();
                this.master = this.context.createGain();
                this.master.gain.value = 0.20;  // master volume control for hit/attack sounds
                this.master.connect(this.context.destination);
            }
            if (!this.interval) this.beginMusic();
            if (this.context.state === "suspended") this.context.resume().catch(() => {});
        },

        beginMusic() {
            if (!this.game_music_1) { 
                this.game_music_1 = new window.Audio("/sounds/boss_music_1.mp3");
                this.game_music_1.loop = true;
                this.game_music_1.volume = 0.3; 
            }
            if (!this.muted) { 
                this.game_music_1.play();
            }
        },

        note(frequency, when, duration, type, volume) {
            if (!this.context || !this.master || this.muted) return;
            const oscillator = this.context.createOscillator();
            const gain = this.context.createGain();
            oscillator.type = type || "sine";
            oscillator.frequency.setValueAtTime(frequency, when);
            gain.gain.setValueAtTime(0.0001, when);
            gain.gain.exponentialRampToValueAtTime(volume, when + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
            oscillator.connect(gain);
            gain.connect(this.master);
            oscillator.start(when);
            oscillator.stop(when + duration + 0.02);
        },

        play(name) {
            if (!this.context || this.context.state !== "running" || this.muted) return;
            const now = this.context.currentTime;
            if (name === "attack") {
                this.note(520, now, 0.09, "square", 0.11);
                this.note(250, now + 0.025, 0.12, "sawtooth", 0.11);
            } else if (name === "block") {
                this.note(310, now, 0.16, "triangle", 0.11);
                this.note(620, now + 0.05, 0.2, "sine", 0.11);
            } else if (name === "hit") {
                this.note(110, now, 0.14, "sawtooth", 0.10);
            } else if (name === "reward") {
                [392, 523.25, 659.25].forEach((note, index) => this.note(note, now + index * 0.09, 0.22, "triangle", 0.10));
            } else if (name === "error") {
                this.note(120, now, 0.1, "square", 0.08);   
            } else if (name === "victory") {
                [261.63, 329.63, 392, 523.25].forEach((note, index) => this.note(note, now + index * 0.12, 0.3, "triangle", 0.10));
            }
        },

        // The mute setting is shared with the lobby music button (SoundSetting, defined in lobby.js)
        syncMuted() {
            this.muted = SoundSetting.muted;
        },

        toggle() {
            this.syncMuted();
            this.unlock();
            this.muted = !this.muted;
            if (this.game_music_1) {
                if (this.muted) this.game_music_1.pause();
                else this.game_music_1.play();
            }
            SoundSetting.muted = this.muted;
            byId("music-toggle").textContent = this.muted ? "Sound off" : "Sound on";
        },

        stop() {
            if (this.interval) clearInterval(this.interval);
            this.interval = null;
            if (this.game_music_1) {
                this.game_music_1.pause();
            }
        }
    };

    function loadImage(source) {
        return new Promise(resolve => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = source;
        });
    }

    async function loadAssets() {
        const [background, metadata] = await Promise.all([
            loadImage("/images/backgrounds/bg_battle.jpg"),
            fetch("/images/sprites/sprites.json").then(response => response.ok ? response.json() : null).catch(() => null)
        ]);
        assets.backgrounds = background;
        assets.metadata = metadata;
        if (!metadata) return;
        const keys = Object.keys(metadata);
        const images = await Promise.all(keys.map(key => loadImage(`/images/sprites/${key}_sheet.png`)));
        keys.forEach((key, index) => { assets.sprites[key] = images[index]; });
    }

    function spawnEnemy() {
        const template = state.enemyOrder[state.floor - 1];
        state.enemy = {
            ...template,
            // adjust enemy height
            x: 640,
            y: 160,
            scale: 0.74,
            maxHp: Math.round(FLOOR_HEALTH[state.floor - 1] * FLOOR_HEALTH_VARIANCE[state.floor - 1]),
            hp: 0,
            attackElapsed: 0,
            attackDelay: Math.max(5400, template.attackDelay + 1200 - (state.floor - 1) * 400),
            attackNumber: 0,
            vulnerableUntil: 0,
            weaknessAttacks: 0,
            animation: { name: "idle", startedAt: performance.now() }
        };
        state.enemy.hp = state.enemy.maxHp;
        state.projectiles = [];
        state.hazards = [];
        state.players.forEach(player => {
            player.energyMax = state.floor + 3;
            player.energy = player.energyMax;
            player.energyProgress = 0;
            setAnimation(player, "idle");
        });
        updateNames();
        feed(`${state.enemy.name} enters the battle.`);
        setAnimation(state.enemy, "charge");
    }

    function updateNames() {
        if (!state.enemy) return;
        byId("enemy-name").textContent = state.enemy.name;
        byId("enemy-variant").textContent = `VARIANT ${["I", "II", "III"][state.floor - 1]}`;
        byId("floor-number").textContent = String(state.floor);
    }

    function makeCardButton(player, card, cardIndex, entering) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `card-button${entering ? " drawing" : ""}`;
        button.dataset.player = String(player.index);
        button.dataset.slot = String(cardIndex);
        button.setAttribute("aria-label", `${card.name}, costs ${card.cost} Energy. ${card.description}`);

        const image = document.createElement("img");
        image.className = "card-art";
        image.src = card.image;
        image.alt = "";
        const cost = document.createElement("span");
        cost.className = "card-cost";
        cost.textContent = String(card.cost);
        const hotkey = document.createElement("span");
        hotkey.className = "card-hotkey";
        hotkey.textContent = String(cardIndex + 1);
        const type = document.createElement("span");
        type.className = "card-type";
        type.textContent = card.type;
        const name = document.createElement("span");
        name.className = "card-name";
        name.textContent = card.name;
        const description = document.createElement("span");
        description.className = "card-description";
        description.textContent = card.description;
        button.style.setProperty("--card-color", card.color);
        button.append(image, cost, hotkey, type, name, description);
        button.addEventListener("click", () => playCard(player.index, cardIndex, button));
        return button;
    }

    function renderHands() {
        if (!state) return;
        state.players.forEach(player => {
            const host = byId(`card-hand-${player.index}`);
            if (!host) return;
            host.replaceChildren(...player.hand.map((card, cardIndex) => makeCardButton(player, card, cardIndex)));
        });
        updateCardAvailability();
    }

    function updateCardAvailability() {
        if (!state) return;
        state.players.forEach(player => {
            const host = byId(`card-hand-${player.index}`);
            const handZone = byId(`hand-zone-${player.index}`);
            if (!host || !handZone) return;
            const buttons = host.querySelectorAll(".card-button");
            buttons.forEach((button, index) => {
                const card = player.hand[index];
                const unavailable = !card || player.hp <= 0 || state.status !== "active" ||
                    player.lockedSlots.has(index) || (!state.cheat && !player.cheat && player.energy < card.cost);
                button.classList.toggle("unaffordable", unavailable);
                button.setAttribute("aria-disabled", unavailable ? "true" : "false");
            });
            handZone.classList.toggle("inactive", player.hp <= 0 || state.status !== "active");
        });
    }

    function renderStatusStrip(host, statuses) {
        const signature = statuses.map(status => status.key).join("|");
        if (host.dataset.signature !== signature) {
            host.replaceChildren();
            statuses.forEach(status => {
                const chip = document.createElement("span");
                chip.className = `status-chip ${status.kind} applied`;
                chip.dataset.status = status.key;
                chip.textContent = status.label;
                host.append(chip);
            });
            host.dataset.signature = signature;
            return;
        }
        statuses.forEach(status => {
            const chip = host.querySelector(`[data-status="${status.key}"]`);
            if (chip) chip.textContent = status.label;
        });
    }

    function paintMeters() {
        if (!state) return;
        state.players.forEach(player => {
            byId(`player-hp-${player.index}`).style.width = `${(player.hp / player.maxHp) * 100}%`;
            byId(`player-hp-text-${player.index}`).textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
            const shield = Math.ceil(player.shield);
            byId(`player-shield-text-${player.index}`).textContent = String(shield);
            const shieldBadge = byId(`player-shield-badge-${player.index}`);
            shieldBadge.hidden = shield <= 0;
            shieldBadge.setAttribute("aria-label", `${shield} Shield`);
            byId(`player-hud-${player.index}`).classList.toggle("defeated", player.hp <= 0);
            const pipHost = byId(`player-energy-${player.index}`);
            if (pipHost.children.length !== player.energyMax) {
                pipHost.replaceChildren();
                for (let index = 0; index < player.energyMax; index++) {
                    const pip = document.createElement("i");
                    pip.className = "energy-pip";
                    pip.append(document.createElement("span"));
                    pipHost.append(pip);
                }
            }
            for (let index = 0; index < player.energyMax; index++) {
                const pip = pipHost.children[index];
                const full = index < player.energy || player.cheat;
                const charging = index === Math.floor(player.energy) && player.energy < player.energyMax;
                const fill = full || player.cheat ? 100 : (charging ? player.energyProgress / ENERGY_INTERVAL_MS * 100 : 0);
                pip.classList.toggle("full", full);
                pip.style.setProperty("--fill", `${fill}%`);
                pip.classList.toggle(
                    "just-charged",
                    index === Math.floor(player.energy) - 1 && state.clock - player.lastEnergyCharge < 700
                );
                if (charging) {
                    pip.setAttribute("aria-label", `Charging energy, ${Math.round(fill)} percent`);
                } else {
                    pip.setAttribute("aria-label", full ? "Energy ready" : "Energy empty");
                }
            }
            byId(`player-hud-${player.index}`).classList.toggle("away", !!player.away);
            if (player.index === 0) {
                const deckLength = state.authoritative ? player.deckCount : player.deck.length;
                byId("deck-count").textContent = String(deckLength);
                byId("deck-counter").setAttribute("aria-label", `${deckLength} cards remaining in the deck`);
                byId("deck-counter").classList.toggle(
                    "reshuffling",
                    state.clock - player.lastDeckReset < 650
                );
            }
        });

        const enemy = state.enemy;
        if (enemy) {
            byId("enemy-hp").style.width = `${Math.max(0, enemy.hp / enemy.maxHp) * 100}%`;
            byId("enemy-hp-text").textContent = `${Math.max(0, Math.ceil(enemy.hp))} / ${enemy.maxHp}`;
            const remaining = Math.max(0, enemy.attackDelay - enemy.attackElapsed);
            const progress = clamp(remaining / enemy.attackDelay, 0, 1);
            byId("enemy-attack-timer").style.width = `${progress * 100}%`;
            byId("enemy-countdown").textContent = `${(remaining / 1000).toFixed(1)}s`;
            byId("enemy-intent").textContent =
                enemy.weaknessAttacks > 0 ? `${enemy.intent} · WEAKENED ${enemy.weaknessAttacks}` :
                (enemy.vulnerableUntil > state.clock ? `${enemy.intent} · VULNERABLE` : enemy.intent);
            const statuses = [];
            if (enemy.vulnerableUntil > state.clock) {
                statuses.push({
                    key: "vulnerable",
                    kind: "vulnerable",
                    label: `VULNERABLE ${((enemy.vulnerableUntil - state.clock) / 1000).toFixed(1)}s`
                });
            }
            if (enemy.weaknessAttacks > 0) {
                statuses.push({
                    key: "weakened",
                    kind: "weakened",
                    label: `WEAKENED ${enemy.weaknessAttacks} ATTACK${enemy.weaknessAttacks === 1 ? "" : "S"}`
                });
            }
            renderStatusStrip(byId("enemy-statuses"), statuses);
        }

        const clock = byId("master-clock-value");
        clock.textContent = formatTime(state.timeRemaining);
        byId("master-clock").classList.toggle("danger", state.timeRemaining <= 30000 && state.status === "active");
        byId("cheat-badge").classList.toggle("visible", state.cheat || state.players[0].cheat);
        updateCardAvailability();
    }

    function feed(message) {
        const host = byId("battle-feed");
        if (!host || !message) return;
        const item = document.createElement("div");
        item.className = "feed-message";
        item.textContent = message;
        host.prepend(item);
        while (host.children.length > 3) host.lastElementChild.remove();
        setTimeout(() => item.remove(), 3600);
    }

    let calloutTimer = null;
    function callout(message) {
        const element = byId("combo-callout");
        clearTimeout(calloutTimer);
        element.textContent = message;
        element.classList.remove("show");
        void element.offsetWidth;
        element.classList.add("show");
        calloutTimer = setTimeout(() => element.classList.remove("show"), 1400);
    }

    function hudPulse(playerIndex, className) {
        const element = byId(`player-hud-${playerIndex}`);
        if (!element) return;
        element.classList.remove(className);
        void element.offsetWidth;
        element.classList.add(className);
        setTimeout(() => element.classList.remove(className), 380);
    }

    function addFloating(x, y, text, color, size) {
        state.floating.push({
            x, y, text: String(text), color, size: size || 18,
            age: 0, duration: 950
        });
    }

    function burst(x, y, color, count) {
        for (let index = 0; index < count; index++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 55 + Math.random() * 130;
            state.particles.push({
                x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                size: 2 + Math.random() * 4, color, age: 0, duration: 520 + Math.random() * 480
            });
        }
    }

    function addProjectile(from, to, options) {
        state.projectiles.push({
            from: { ...from }, to: { ...to }, age: 0, duration: options.duration || 560,
            color: options.color || "#ffcf66", kind: options.kind || "attack",
            size: options.size || 10, onHit: options.onHit || null
        });
    }

    function enemyTarget(player) {
        return {
            x: player.x + 60 * player.scale / 0.7,
            y: player.y + 72 * player.scale / 0.7
        };
    }

    function dealEnemyDamage(playerIndex, incoming, source) {
        if (!state || state.status !== "active") return;
        const player = state.players[playerIndex];
        if (player.hp <= 0) return;
        if (player.cheat) {
            const target = enemyTarget(player);
            addFloating(target.x, target.y - 25, "IMMUNE", "#8ff4ff", 14);
            burst(target.x, target.y, "#8ff4ff", 10);
            return;
        }

        const blocked = Math.min(player.shield, incoming);
        player.shield -= blocked;
        state.stats.blocked += blocked;                  // damage the Shield soaked up (shown on the game-over screen)
        const damage = incoming - blocked;
        player.hp = Math.max(0, player.hp - damage);
        const target = enemyTarget(player);
        if (blocked > 0) {
            addFloating(target.x - 8, target.y - 36, `BLOCK ${Math.ceil(blocked)}`, "#7bdfff", 14);
            hudPulse(player.index, "blocked");
        }
        if (damage > 0) {
            addFloating(target.x + 18, target.y - 32, `-${Math.ceil(damage)}`, "#ff7388", 22);
            hudPulse(player.index, "hit");
            setAnimation(player, "hurt");
            burst(target.x, target.y, "#ff5976", 13);
            Audio.play("hit");
        } else {
            Audio.play("block");
        }
        if (player.hp <= 0) {
            setAnimation(player, "defeated");
            feed(`${player.name} is down.`);
            finishGame(false, "Your Slayer fell.");
        }
    }

    function dealCardDamage(playerIndex, rawDamage) {
        if (!state || state.status !== "active" || !state.enemy) return;
        const player = state.players[playerIndex];
        const vulnerability = state.enemy.vulnerableUntil > state.clock ? 1.45 : 1;
        const cheat = player.cheat ? 3 : 1;
        let damage = rawDamage * player.damageBoost * vulnerability * cheat;

        const recentUtility = state.lastUtility;
        if (recentUtility && state.clock - recentUtility.time <= 2200) {
            damage *= 1.25;
            state.lastUtility = null;
            callout(`SETUP COMBO! +25%`);
        }
        damage = Math.round(damage);
        state.enemy.hp = Math.max(0, state.enemy.hp - damage);
        setAnimation(state.enemy, "hurt");
        addFloating(state.enemy.x + 118, state.enemy.y + 78, `-${damage}`, vulnerability > 1 ? "#ffe27a" : "#ff7c9b", damage > 50 ? 28 : 20);
        burst(state.enemy.x + 118, state.enemy.y + 105, vulnerability > 1 ? "#ffdc72" : "#ff688d", 18);
        Audio.play("attack");
        state.stats.damage += damage;
        if (state.enemy.hp <= 0) clearFloor();
    }

    function burnCard(button, color) {
        if (!button) return;
        button.style.setProperty("--burn-color", color);
        for (let index = 0; index < 12; index++) {
            const ember = document.createElement("i");
            ember.className = "card-ember";
            ember.style.setProperty("--x", `${20 + Math.random() * 60}%`);
            ember.style.setProperty("--y", `${20 + Math.random() * 50}%`);
            ember.style.setProperty("--dx", `${-24 + Math.random() * 48}px`);
            ember.style.setProperty("--dy", `${-36 - Math.random() * 52}px`);
            ember.style.setProperty("--delay", `${Math.random() * 120}ms`);
            button.append(ember);
        }
    }

    function cardResolved(playerIndex, cardIndex, button) {
        const player = state.players[playerIndex];
        const run = state;
        const deckCycle = player.deckCycle;
        player.lockedSlots.add(cardIndex);
        button && button.classList.add("played");
        button && button.setAttribute("aria-busy", "true");
        state.stats.cards++;
        setTimeout(() => {
            if (state !== run || player.deckCycle !== deckCycle || !player.lockedSlots.has(cardIndex)) return;
            const drawnCard = player.deck.shift();
            const resetDeck = !drawnCard || player.deck.length === 0;
            if (!resetDeck) player.hand[cardIndex] = drawnCard;
            else {
                resetHand(player);
                player.deckCycle++;
                player.lockedSlots.clear();
                player.lastDeckReset = state.clock;
                callout("DECK RENEWED");
                feed("The deck is reshuffled and a fresh hand is dealt.");
            }
            player.lockedSlots.delete(cardIndex);
            const host = byId(`card-hand-${playerIndex}`);
            if (resetDeck) {
                host.replaceChildren(...player.hand.map((card, index) => makeCardButton(player, card, index, true)));
            } else {
                const replacement = makeCardButton(player, player.hand[cardIndex], cardIndex, true);
                const current = host.children[cardIndex];
                if (current) host.replaceChild(replacement, current);
            }
            updateCardAvailability();
            paintMeters();
        }, 650);
    }

    function playCard(playerIndex, cardIndex, button) {
        Audio.unlock();
        if (!state || state.status !== "active") return;
        const player = state.players[playerIndex];
        if (!player) return;
        const card = player.hand[cardIndex];
        if (!card || player.hp <= 0 || player.lockedSlots.has(cardIndex)) return;
        if (!state.cheat && !player.cheat && player.energy < card.cost) {
            button && button.classList.add("invalid");
            setTimeout(() => button && button.classList.remove("invalid"), 280);
            feed(`${player.name} needs ${card.cost} Energy for ${card.name}.`);
            Audio.play("error");
            return;
        }
        if (state.authoritative) {
            if (socket && socket.connected) {
                player.lockedSlots.add(cardIndex);
                burnCard(button, card.color);
                updateCardAvailability();
                socket.emit("game:play", { slot: cardIndex });
            }
            return;
        }
        if (!player.cheat) {
            player.energy -= card.cost;
            player.energyProgress = 0;
        }
        setAnimation(player, card.action === "block" ? "block" : "attack");
        burnCard(button, card.color);

        const from = enemyTarget(player);
        const target = { x: state.enemy.x + 125, y: state.enemy.y + 105 };
        if (card.action === "damage") {
            addProjectile(from, target, {
                color: card.color,
                duration: card.cost >= 3 ? 700 : 520,
                size: card.cost >= 3 ? 16 : 11,
                onHit: () => dealCardDamage(playerIndex, card.value)
            });
            feed(`${player.name} fires ${card.name}.`);
        } else if (card.action === "block") {
            player.shield = Math.min(MAX_SHIELD, player.shield + card.value);
            state.effects.push({ kind: "shield", playerIndex, age: 0, duration: 640, color: card.color });
            addFloating(from.x, from.y - 42, `+${card.value} SHIELD`, "#75dfff", 16);
            Audio.play("block");
            state.stats.blocks += card.value;
            feed(`${player.name} raises ${card.name}.`);
            setTimeout(() => {
                if (state && state.players[playerIndex] === player && player.hp > 0) setAnimation(player, "idle");
            }, 520);
        } else if (card.action === "heal") {
            const healed = Math.min(card.value, player.maxHp - player.hp);
            player.hp += healed;
            state.effects.push({ kind: "heal", playerIndex, age: 0, duration: 720, color: card.color });
            addFloating(from.x, from.y - 45, `+${healed} HP`, "#83efad", 18);
            Audio.play("reward");
            feed(`${player.name} recovers with ${card.name}.`);
        } else if (card.action === "energy") {
            player.energy = Math.min(player.energyMax, player.energy + card.value);
            player.lastEnergyCharge = state.clock;
            state.effects.push({ kind: "energy", playerIndex, age: 0, duration: 720, color: card.color });
            addFloating(from.x, from.y - 42, `+${card.value} ENERGY`, "#ffe179", 15);
            feed(`${player.name} takes an ${card.name}.`);
            Audio.play("reward");
        } else if (card.action === "weaken") {
            addProjectile(from, target, {
                color: card.color, kind: "debuff", duration: 600,
                onHit: () => {
                    state.enemy.weaknessAttacks = card.value;
                    state.lastUtility = { time: state.clock, player: playerIndex, card: card.id };
                    callout("ENEMY WEAKENED");
                    feed(`${card.name} lowers the next ${card.value} attacks.`);
                }
            });
        } else if (card.action === "vulnerable") {
            addProjectile(from, target, {
                color: card.color, kind: "mark", duration: 620,
                onHit: () => {
                    state.enemy.vulnerableUntil = state.clock + card.value;
                    state.lastUtility = { time: state.clock, player: playerIndex, card: card.id };
                    callout("TARGET MARKED +45%");
                    feed(`${player.name} bends the curve in your favor.`);
                }
            });
        }

        cardResolved(playerIndex, cardIndex, button);
        paintMeters();
    }

    function fireEnemyAttack() {
        if (!state || state.status !== "active") return;
        const living = state.players.map(player => player.index).filter(index => state.players[index].hp > 0);
        if (!living.length) return;
        const enemy = state.enemy;
        const attackNumber = ++enemy.attackNumber;
        let baseDamage = enemy.baseDamage + (state.floor - 1) * 7;
        if (enemy.weaknessAttacks > 0) {
            baseDamage *= 0.65;
            enemy.weaknessAttacks--;
        }
        setAnimation(enemy, "attack");
        Audio.play("attack");
        feed(`${enemy.name} launches ${enemy.intent}!`);

        if (enemy.id === "enemy_typhoon") {
            addProjectile(
                { x: enemy.x + 60, y: enemy.y + 100 },
                enemyTarget(state.players[0]),
                {
                    color: enemy.color, kind: "wind", duration: 950, size: 15,
                    onHit: () => dealEnemyDamage(0, Math.round(baseDamage * 0.78))
                }
            );
        } else if (enemy.id === "enemy_firebird") {
            addProjectile(
                { x: enemy.x + 55, y: enemy.y + 100 },
                enemyTarget(state.players[0]),
                {
                    color: "#ff734d", kind: "fire", duration: 850, size: 18,
                    onHit: () => {
                        dealEnemyDamage(0, Math.round(baseDamage * 1.05));
                        state.hazards.push({
                            ...enemyTarget(state.players[0]), color: "#ff754c", age: 0, duration: 900
                        });
                    }
                }
            );
        } else {
            addProjectile(
                { x: enemy.x + 52, y: enemy.y + 108 },
                enemyTarget(state.players[0]),
                {
                    color: "#bb80ff", kind: "breath", duration: 900, size: 19,
                    onHit: () => dealEnemyDamage(0, Math.round(baseDamage * (attackNumber % 2 === 0 ? 0.85 : 1)))
                }
            );
        }
    }

    function clearFloor() {
        if (!state || state.status !== "active") return;
        state.stats.floors++;
        setAnimation(state.enemy, "defeated");
        state.projectiles = [];
        state.hazards = [];
        state.status = "transition";
        Audio.play("reward");
        callout(`FLOOR ${state.floor} CLEARED`);

        if (state.floor === 3) {
            setTimeout(() => finishGame(true, "All three floors cleared."), 800);
        } else {
            setTimeout(showRewards, 650);
        }
    }

    function showRewards() {
        if (!state || state.status !== "transition") return;
        state.status = "reward";
        state.rewardEndsAt = state.clock + REWARD_TIME_MS;
        state.players.forEach(player => { player.rewardChoice = null; });
        const overlay = byId("game-overlay");
        const card = byId("game-overlay-card");
        card.replaceChildren();

        const kicker = document.createElement("div");
        kicker.className = "overlay-kicker";
        kicker.textContent = `FLOOR ${state.floor} CLEARED`;
        const title = document.createElement("h2");
        title.textContent = "Choose your advantage";
        const copy = document.createElement("div");
        copy.className = "overlay-copy";
        copy.textContent = "The master timer is paused. Choose one advantage before the next floor.";
        const clock = document.createElement("div");
        clock.className = "reward-clock";
        clock.id = "reward-clock";
        clock.textContent = "5";
        const columns = document.createElement("div");
        columns.className = "reward-columns";

        state.players.forEach(player => {
            const column = document.createElement("section");
            column.className = "reward-player";
            column.id = `reward-player-${player.index}`;
            const heading = document.createElement("h3");
            heading.textContent = player.name;
            const options = document.createElement("div");
            options.className = "reward-options";
            [
                ["card", "Draw a card", "Replace one card with a rare strike."],
                ["buff", "Train", "+12% damage and +10 max HP."],
                ["heal", "Rest", "Recover 40 HP now."]
            ].forEach(([id, label, description]) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "reward-button";
                button.dataset.player = String(player.index);
                button.dataset.reward = id;
                const strong = document.createElement("strong");
                strong.textContent = label;
                const small = document.createElement("small");
                small.textContent = description;
                button.append(strong, small);
                button.addEventListener("click", () => chooseReward(player.index, id));
                options.append(button);
            });
            column.append(heading, options);
            columns.append(column);
        });
        card.append(kicker, title, copy, clock, columns);
        overlay.hidden = false;
        renderHands();
    }

    function chooseReward(playerIndex, choice) {
        if (!state || state.status !== "reward") return;
        const player = state.players[playerIndex];
        if (player.rewardChoice) return;
        player.rewardChoice = choice;
        if (state.authoritative) {
            if (socket && socket.connected) socket.emit("game:reward", { choice });
            document.querySelectorAll(`#reward-player-${playerIndex} .reward-button`).forEach(button => {
                button.disabled = true;
                button.classList.toggle("chosen", button.dataset.reward === choice);
            });
            byId(`reward-player-${playerIndex}`).classList.add("complete");
            Audio.play("reward");
            return;
        }
        if (choice === "card") {
            player.rewardReviveBonus = false;
            const rare = randomItem(CARD_POOL.filter(card => card.cost >= 2));
            const weakest = player.hand.reduce((best, card, index) => card.cost < player.hand[best].cost ? index : best, 0);
            player.hand[weakest] = { ...rare };
            feed(`${player.name} adds ${rare.name}.`);
        } else if (choice === "buff") {
            player.rewardReviveBonus = false;
            player.damageBoost += 0.12;
            player.maxHp += 10;
            player.hp = Math.min(player.maxHp, player.hp + 10);
            feed(`${player.name} gains 12% damage.`);
        } else if (choice === "heal") {
            player.rewardReviveBonus = false;
            player.hp = Math.min(player.maxHp, player.hp + 40);
            feed(`${player.name} recovers 40 HP.`);
        }
        document.querySelectorAll(`#reward-player-${playerIndex} .reward-button`).forEach(button => {
            button.disabled = true;
            button.classList.toggle("chosen", button.dataset.reward === choice);
        });
        byId(`reward-player-${playerIndex}`).classList.add("complete");
        Audio.play("reward");
        renderHands();
        paintMeters();
    }

    function nextFloor() {
        if (!state) return;
        byId("game-overlay").hidden = true;
        state.floor++;
        state.status = "active";
        state.rewardEndsAt = 0;
        state.players.forEach(player => {
            player.rewardReviveBonus = false;
            player.rewardChoice = null;
        });
        spawnEnemy();
        renderHands();
        paintMeters();
        Audio.play("reward");
    }

    function finishGame(won, reason) {
        if (!state || state.status === "over") return;
        state.status = "over";
        state.projectiles = [];
        state.hazards = [];
        const lived = MASTER_TIME_MS - state.timeRemaining;
        const result = {
            won,
            reason,
            floors: state.stats.floors,
            durationMs: lived,
            players: state.players.map(p => ({
                name: p.name,
                damage: Math.round(state.stats.damage),
                blocked: Math.round(state.stats.blocked),
                cards: state.stats.cards,
                survivalMs: lived
            }))
        };
        GameOver.show(result, {
            // Solo: leave this room and start a fresh run straight away
            onPlayAgain: () => {
                stop();
                if (socket && socket.connected) { socket.emit("room:leave"); socket.emit("lobby:solo"); }
            },
            onHome: () => {
                stop();
                if (socket && socket.connected) socket.emit("room:leave");
            }
        });
        // TEMPORARY: the solo game still runs in the browser, so it reports its own result for the leaderboard.
        // Once the server runs the game, delete this line: server/game.js passes the result to onOver(result).
        if (socket && socket.connected) socket.emit("game:report", result);
        if (won) Audio.play("victory");
        renderHands();
    }

    function drawCover(image) {
        if (!image) {
            const gradient = context.createLinearGradient(0, 0, 0, WORLD_HEIGHT);
            gradient.addColorStop(0, "#22203a");
            gradient.addColorStop(1, "#40304f");
            context.fillStyle = gradient;
            context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
            return;
        }
        const scale = Math.max(WORLD_WIDTH / image.width, WORLD_HEIGHT / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const x = (WORLD_WIDTH - width) / 2;
        const y = (WORLD_HEIGHT - height) / 2 - BACKGROUND_SHIFT;
        context.drawImage(image, x, y, width, height);
        const bottom = y + height;
        if (bottom < WORLD_HEIGHT) {
            const slice = Math.max(1, Math.round(image.height * 0.012));
            context.drawImage(
                image,
                0, image.height - slice, image.width, slice,
                x, bottom - 1, width, WORLD_HEIGHT - bottom + 1
            );
        }
    }

    function drawBackdrop(now) {
        drawCover(assets.backgrounds);
        context.fillStyle = "rgba(16, 12, 29, 0.28)";
        context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        context.save();
        context.globalAlpha = 0.12;
        for (let index = 0; index < 24; index++) {
            const x = (index * 83 + now * (0.004 + (index % 3) * 0.002)) % (WORLD_WIDTH + 40) - 20;
            const y = 50 + ((index * 47) % 340) + Math.sin(now / 900 + index) * 12;
            context.fillStyle = index % 2 ? "#ffe8b3" : "#bfa5ff";
            context.beginPath();
            context.arc(x, y, 1.5 + index % 3, 0, Math.PI * 2);
            context.fill();
        }
        context.restore();
        const ground = context.createLinearGradient(0, 385, 0, WORLD_HEIGHT);
        ground.addColorStop(0, "rgba(12, 11, 25, 0)");
        ground.addColorStop(1, "rgba(12, 10, 22, 0.58)");
        context.fillStyle = ground;
        context.fillRect(0, 365, WORLD_WIDTH, WORLD_HEIGHT - 365);
    }

    function spriteFrame(key, animation, now) {
        const metadata = assets.metadata && assets.metadata[key];
        const sprite = assets.sprites[key];
        if (!metadata || !sprite) return null;
        let sequence = metadata.sequences[animation.name];
        if (!sequence) sequence = metadata.sequences.idle;
        const elapsed = now - animation.startedAt;
        let frame = Math.floor(elapsed / sequence.timing);
        if (sequence.loop) frame %= sequence.count;
        else frame = Math.min(frame, sequence.count - 1);
        return { sprite, frame, sequence };
    }

    function drawGroundShadow(entity, width, height) {
        const centerX = entity.x + width * 0.53;    // adjust where the shadow sits (horizontal)
        const centerY = entity.y + height * 0.98;   // vertical
        const radiusX = width * 0.42;
        const radiusY = width * 0.12;
        context.save();
        context.globalAlpha = entity.hp <= 0 ? 0.35 : 1;
        const gradient = context.createRadialGradient(centerX, centerY, radiusY * 0.15, centerX, centerY, radiusX);
        gradient.addColorStop(0, "rgba(126, 126, 126, 0.72)");  // adjust shadow color here
        gradient.addColorStop(0.45, "rgba(167, 165, 165, 0.4)");
        gradient.addColorStop(1, "rgba(235, 235, 235, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        context.fill();
        context.restore();
    }

    function drawEntity(entity, key, now, width) {
        const metadata = assets.metadata && assets.metadata[key];
        const sequence = metadata && metadata.sequences[entity.animation.name];
        if (sequence && !sequence.loop && entity.animation.name !== "defeated" &&
            now - entity.animation.startedAt >= sequence.timing * sequence.count) {
            setAnimation(entity, "idle");
        }
        const resolved = spriteFrame(key, entity.animation, now);
        if (resolved) {
            const sequence = resolved.sequence;
            const height = width * (sequence.height / sequence.width);
            const sourceX = sequence.x + resolved.frame * sequence.width;
            const bob = entity.animation.name === "idle" ? Math.sin(now / 230 + entity.x) * 2.2 : 0;
            drawGroundShadow(entity, width, height);
            context.save();
            if (entity.hp <= 0) context.globalAlpha = 0.55;
            context.shadowColor = "rgba(0, 0, 0, 0.55)";
            context.shadowBlur = 14;
            context.shadowOffsetY = 8;
            context.drawImage(resolved.sprite, sourceX, sequence.y, sequence.width, sequence.height,
                entity.x, entity.y + bob, width, height);
            context.restore();
            return;
        }

        drawGroundShadow(entity, width, width);
        context.save();
        context.fillStyle = key.indexOf("enemy") === 0 ? "#b85d77" : "#775ca7";
        context.beginPath();
        context.ellipse(entity.x + width / 2, entity.y + width / 2, width * 0.32, width * 0.42, 0, 0, Math.PI * 2);
        context.fill();
        context.restore();
    }

    function drawEffects(now) {
        state.projectiles.forEach(projectile => {
            const progress = clamp(projectile.age / projectile.duration, 0, 1);
            const eased = easeOut(progress);
            const x = projectile.from.x + (projectile.to.x - projectile.from.x) * eased;
            const y = projectile.from.y + (projectile.to.y - projectile.from.y) * eased
                - Math.sin(progress * Math.PI) * (projectile.kind === "attack" ? 45 : 24);
            const direction = Math.atan2(projectile.to.y - projectile.from.y, projectile.to.x - projectile.from.x);
            context.save();
            context.translate(x, y);
            context.rotate(direction);
            context.shadowColor = projectile.color;
            context.shadowBlur = 20;
            context.fillStyle = projectile.color;
            if (projectile.kind === "wind") {
                context.strokeStyle = projectile.color;
                context.lineWidth = 5;
                context.beginPath();
                context.arc(0, 0, projectile.size, -1.4, 1.8);
                context.stroke();
            } else if (["debuff", "mark"].includes(projectile.kind)) {
                context.strokeStyle = projectile.color;
                context.lineWidth = 4;
                for (let index = 0; index < 3; index++) {
                    context.beginPath();
                    context.arc(0, 0, 7 + index * 5, now / 400 + index, now / 400 + index + Math.PI);
                    context.stroke();
                }
            } else {
                context.beginPath();
                context.moveTo(projectile.size * 1.5, 0);
                context.lineTo(-projectile.size, -projectile.size * 0.65);
                context.lineTo(-projectile.size * 0.6, 0);
                context.lineTo(-projectile.size, projectile.size * 0.65);
                context.closePath();
                context.fill();
                context.globalAlpha = 0.35;
                context.fillRect(-projectile.size * 2.5, -2, projectile.size * 2, 4);
            }
            context.restore();
        });

        state.hazards.forEach(hazard => {
            const progress = hazard.age / hazard.duration;
            context.save();
            context.globalAlpha = (1 - progress) * 0.7;
            context.strokeStyle = hazard.color;
            context.lineWidth = 3;
            context.beginPath();
            context.ellipse(hazard.x, hazard.y, 12 + progress * 34, 7 + progress * 19, 0, 0, Math.PI * 2);
            context.stroke();
            context.restore();
        });

        state.effects.forEach(effect => {
            const progress = effect.age / effect.duration;
            const target = enemyTarget(state.players[effect.playerIndex]);
            context.save();
            context.globalAlpha = 1 - progress;
            context.strokeStyle = effect.color;
            context.lineWidth = effect.kind === "shield" ? 7 : 4;
            context.shadowColor = effect.color;
            context.shadowBlur = 16;
            if (effect.kind === "shield") {
                context.beginPath();
                context.arc(target.x, target.y, 48 + progress * 32, Math.PI * 0.55, Math.PI * 1.45);
                context.stroke();
            } else {
                context.beginPath();
                context.arc(target.x, target.y, 25 + progress * 55, 0, Math.PI * 2);
                context.stroke();
            }
            context.restore();
        });
    }

    function drawParticles() {
        state.particles.forEach(particle => {
            context.save();
            context.globalAlpha = 1 - particle.age / particle.duration;
            context.fillStyle = particle.color;
            context.beginPath();
            context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
            context.fill();
            context.restore();
        });
        state.floating.forEach(number => {
            const progress = number.age / number.duration;
            context.save();
            context.globalAlpha = 1 - progress;
            context.fillStyle = number.color;
            context.font = `900 ${number.size}px Helvetica, sans-serif`;
            context.textAlign = "center";
            context.shadowColor = "rgba(0,0,0,0.8)";
            context.shadowBlur = 5;
            context.fillText(number.text, number.x, number.y - progress * 46);
            context.restore();
        });
    }

    function displayPlayerForServerIndex(serverIndex) {
        if (!state) return null;
        return state.players.find(player => player.serverIndex === serverIndex) || null;
    }

    function showNetworkReward() {
        if (!state || state.status !== "reward" || typeof GameOver === "undefined" || GameOver.isOpen()) return;
        const overlay = byId("game-overlay");
        const card = byId("game-overlay-card");
        const player = state.players[0];
        const partner = state.players[1];
        card.replaceChildren();

        const kicker = document.createElement("div");
        kicker.className = "overlay-kicker";
        kicker.textContent = `FLOOR ${state.floor} CLEARED`;
        const title = document.createElement("h2");
        title.textContent = "Choose your advantage";
        const copy = document.createElement("div");
        copy.className = "overlay-copy";
        copy.textContent = partner
            ? `${partner.name} ${partner.rewardChoice ? "has chosen." : "is choosing too."} The next floor begins when both Slayers are ready.`
            : "Choose one advantage before the next floor.";
        const clock = document.createElement("div");
        clock.className = "reward-clock";
        clock.id = "reward-clock";
        clock.textContent = String(Math.max(0, Math.ceil(state.rewardRemaining / 1000)));
        const columns = document.createElement("div");
        columns.className = "reward-columns";
        const column = document.createElement("section");
        column.className = "reward-player";
        column.id = `reward-player-${player.index}`;
        const heading = document.createElement("h3");
        heading.textContent = player.name;
        const options = document.createElement("div");
        options.className = "reward-options";
        [
            ["card", "Draw a card", "Replace one card with a rare strike."],
            ["buff", "Train", "+12% damage and +10 max HP."],
            ["heal", "Rest", "Recover 40 HP now."]
        ].forEach(([id, label, description]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "reward-button";
            button.dataset.player = String(player.index);
            button.dataset.reward = id;
            const strong = document.createElement("strong");
            strong.textContent = label;
            const small = document.createElement("small");
            small.textContent = description;
            button.append(strong, small);
            button.addEventListener("click", () => chooseReward(player.index, id));
            options.append(button);
        });
        column.append(heading, options);
        columns.append(column);
        card.append(kicker, title, copy, clock, columns);
        overlay.hidden = false;
        if (player.rewardChoice) {
            column.classList.add("complete");
            options.querySelectorAll(".reward-button").forEach(button => {
                button.disabled = true;
                button.classList.toggle("chosen", button.dataset.reward === player.rewardChoice);
            });
        }
    }

    function applyServerState(snapshot) {
        if (!state || !state.authoritative || !snapshot || !Array.isArray(snapshot.players)) return;
        const previous = new Map(state.players.map(player => [player.username, player]));
        const serverLocal = snapshot.players.find(player => player.username === localUsername);
        const ordered = serverLocal
            ? [serverLocal, ...snapshot.players.filter(player => player.username !== localUsername)]
            : [...snapshot.players];
        const previousStatus = state.status;
        const previousFloor = state.floor;

        state.status = snapshot.status;
        state.floor = snapshot.floor;
        state.clock = snapshot.t;
        state.timeRemaining = snapshot.timeLeft;
        state.rewardRemaining = snapshot.rewardEndsIn;
        state.cheat = snapshot.cheat === true;
        state.scaling = snapshot.scaling;
        state.players = ordered.map((player, index) => {
            const old = previous.get(player.username);
            const layout = PLAYER_LAYOUT[index] || PLAYER_LAYOUT[0];
            const lockedSlots = new Set(
                (player.cooldowns || []).map((remaining, slot) => remaining > 0 ? slot : -1).filter(slot => slot >= 0)
            );
            const next = {
                ...old,
                index,
                serverIndex: player.index,
                username: player.username,
                name: player.name,
                sprite: layout.sprite,
                x: layout.x,
                y: layout.y,
                scale: layout.scale,
                hp: player.hp,
                maxHp: player.maxHp,
                shield: player.shield,
                energy: player.energy,
                energyMax: player.energyMax,
                energyProgress: player.energyProgress,
                deckCount: player.deckCount,
                deck: [],
                hand: (player.hand || []).map(id => cardById.get(id)).filter(Boolean).map(card => ({ ...card })),
                lockedSlots,
                rewardChoice: player.rewardChoice,
                away: player.away,
                damageBoost: player.damageBoost,
                cheat: snapshot.cheat === true,
                lastEnergyCharge: old && old.lastEnergyCharge != null ? old.lastEnergyCharge : -Infinity,
                lastDeckReset: old && old.lastDeckReset != null ? old.lastDeckReset : -Infinity,
                animation: old && old.animation ? old.animation : { name: "idle", startedAt: performance.now() }
            };
            if (old && old.hp > 0 && next.hp <= 0) setAnimation(next, "defeated");
            if (old && old.hp <= 0 && next.hp > 0) setAnimation(next, "idle");
            return next;
        });

        const enemy = snapshot.enemy;
        const oldEnemy = state.enemy && state.enemy.id === enemy.id ? state.enemy : null;
        state.enemy = {
            ...ENEMIES.find(candidate => candidate.id === enemy.id),
            ...enemy,
            x: 640,
            y: 160,
            scale: 0.74,
            attackElapsed: Math.max(0, enemy.attackDelay - enemy.nextAttackIn),
            vulnerableUntil: state.clock + enemy.vulnerableRemaining,
            animation: oldEnemy && oldEnemy.animation
                ? oldEnemy.animation
                : { name: "idle", startedAt: performance.now() }
        };

        const handSignature = state.players.map(player =>
            `${player.username}:${player.hand.map(card => card.id).join(",")}`
        ).join("|");
        if (handSignature !== lastHandSignature) {
            lastHandSignature = handSignature;
            renderHands();
        }
        byId("player-hud-1").hidden = state.players.length < 2;
        byId("mode-label").textContent = "CO-OP · 2 PLAYERS";
        updateNames();
        paintMeters();

        if (state.status === "reward") {
            const rewardSignature = `${state.floor}:${state.players.map(player => player.rewardChoice || "-").join(",")}`;
            if (previousStatus !== "reward" || previousFloor !== state.floor ||
                state.rewardSignature !== rewardSignature) {
                state.rewardSignature = rewardSignature;
                showNetworkReward();
            }
        } else if (!GameOver.isOpen()) {
            byId("game-overlay").hidden = true;
        }
    }

    function handleNetworkEffect(effect) {
        if (!state || !state.authoritative || !effect) return;
        const player = displayPlayerForServerIndex(effect.player != null ? effect.player : effect.target);
        const target = player ? enemyTarget(player) : null;
        const card = effect.cardId ? cardById.get(effect.cardId) : null;
        if (effect.type === "card" && player && card) {
            setAnimation(player, card.action === "block" ? "block" : "attack");
            const button = player.index === 0
                ? byId("card-hand-0").querySelector(`[data-slot="${effect.slot}"]`)
                : null;
            burnCard(button, card.color);
            if (card.action === "damage" || card.action === "weaken" || card.action === "vulnerable") {
                addProjectile(target, { x: state.enemy.x + 125, y: state.enemy.y + 105 }, {
                    color: card.color,
                    kind: card.action === "damage" ? "attack" : card.action === "weaken" ? "debuff" : "mark",
                    duration: card.cost >= 3 ? 700 : 520
                });
                if (card.action === "damage") {
                    addFloating(state.enemy.x + 118, state.enemy.y + 78, `-${effect.amount}`, "#ff7c9b", 20);
                }
            } else if (["block", "heal", "energy"].includes(card.action)) {
                state.effects.push({ kind: card.action === "block" ? "shield" : card.action, playerIndex: player.index, age: 0, duration: 720, color: card.color });
                const label = card.action === "block" ? `+${effect.amount} SHIELD`
                    : card.action === "heal" ? `+${effect.amount} HP`
                    : `+${effect.amount} ENERGY`;
                addFloating(target.x, target.y - 42, label, card.color, 16);
            }
            feed(`${player.name} plays ${card.name}.`);
            if (effect.combo) callout("SETUP COMBO! +25%");
            Audio.play(card.action === "block" ? "block" : card.action === "damage" ? "attack" : "reward");
        } else if (effect.type === "enemy-attack" && target) {
            setAnimation(state.enemy, "attack");
            addProjectile({ x: state.enemy.x + 55, y: state.enemy.y + 100 }, target, {
                color: state.enemy.color, kind: "breath", duration: 800, size: 18
            });
            feed(`${state.enemy.name} attacks ${player.name}.`);
            Audio.play("attack");
        } else if ((effect.type === "hit" || effect.type === "block") && target) {
            if (effect.blocked > 0) {
                addFloating(target.x - 8, target.y - 36, `BLOCK ${effect.blocked}`, "#7bdfff", 14);
                hudPulse(player.index, "blocked");
            }
            if (effect.damage > 0) {
                addFloating(target.x + 18, target.y - 32, `-${effect.damage}`, "#ff7388", 22);
                setAnimation(player, "hurt");
                hudPulse(player.index, "hit");
                burst(target.x, target.y, "#ff5976", 13);
                Audio.play("hit");
            } else {
                Audio.play("block");
            }
        } else if (effect.type === "immune" && target) {
            addFloating(target.x, target.y - 25, "IMMUNE", "#8ff4ff", 14);
        } else if (effect.type === "floor") {
            setAnimation(state.enemy, "defeated");
            state.projectiles = [];
            callout(`FLOOR ${effect.floor} CLEARED`);
            Audio.play("reward");
        } else if (effect.type === "next-floor") {
            byId("game-overlay").hidden = true;
            feed(`Floor ${effect.floor} begins.`);
        } else if (effect.type === "reward" && player) {
            feed(`${player.name} chooses ${effect.choice}.`);
        }
    }

    function bindNetworkListeners(roomSocket) {
        if (!roomSocket) return;
        if (networkSocket && networkSocket !== roomSocket) {
            networkSocket.off("game:state", applyServerState);
            networkSocket.off("game:effect", handleNetworkEffect);
            networkSocket.off("game:cheat", handleNetworkCheat);
        }
        if (networkSocket === roomSocket) return;
        networkSocket = roomSocket;
        networkSocket.on("game:state", applyServerState);
        networkSocket.on("game:effect", handleNetworkEffect);
        networkSocket.on("game:cheat", handleNetworkCheat);
    }

    function handleNetworkCheat(info) {
        if (!state || !state.authoritative || !info) return;
        state.cheat = info.on === true;
        feed(`${info.by || "A Slayer"} ${state.cheat ? "enabled" : "disabled"} team cheat mode.`);
        paintMeters();
    }

    function draw(now) {
        if (!state || !context) return;
        context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        drawBackdrop(now);
        if (state.enemy) drawEntity(state.enemy, state.enemy.id, now, 360 * state.enemy.scale);
        state.players.forEach(player => {
            drawEntity(player, player.sprite, now, 240 * player.scale);
        });
        drawEffects(now);
        drawParticles();
        const vignette = context.createRadialGradient(480, 270, 170, 480, 270, 580);
        vignette.addColorStop(0, "rgba(0,0,0,0)");
        vignette.addColorStop(1, "rgba(4,3,10,0.4)");
        context.fillStyle = vignette;
        context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    }

    function updateEffects(delta) {
        state.projectiles.forEach(projectile => { projectile.age += delta; });
        [...state.projectiles].forEach(projectile => {
            if (projectile.age >= projectile.duration) {
                state.projectiles.splice(state.projectiles.indexOf(projectile), 1);
                if (projectile.onHit) projectile.onHit();
            }
        });
        state.hazards.forEach(hazard => { hazard.age += delta; });
        state.hazards = state.hazards.filter(hazard => hazard.age < hazard.duration);
        state.effects.forEach(effect => { effect.age += delta; });
        state.effects = state.effects.filter(effect => effect.age < effect.duration);
        state.particles.forEach(particle => {
            particle.age += delta;
            particle.x += particle.vx * delta / 1000;
            particle.y += particle.vy * delta / 1000;
            particle.vy += 90 * delta / 1000;
        });
        state.particles = state.particles.filter(particle => particle.age < particle.duration);
        state.floating.forEach(number => { number.age += delta; });
        state.floating = state.floating.filter(number => number.age < number.duration);
    }

    function updatePlayers(delta) {
        state.players.forEach(player => {
            if (player.hp <= 0) return;
            if (player.energy < player.energyMax) {
                player.energyProgress += delta;
                if (player.energyProgress >= ENERGY_INTERVAL_MS) {
                    player.energyProgress -= ENERGY_INTERVAL_MS;
                    player.energy = Math.min(player.energyMax, player.energy + 1);
                    player.lastEnergyCharge = state.clock;
                    Audio.play("reward");
                }
            } else {
                player.energyProgress = 0;
            }
        });
    }

    function loop(now) {
        if (!state) return;
        const rawDelta = Math.max(0, now - state.lastTick);
        const delta = Math.min(rawDelta, 100);
        state.lastTick = now;
        if (state.authoritative) {
            if (state.status === "active" && state.enemy) {
                state.timeRemaining = Math.max(0, state.timeRemaining - rawDelta);
                state.enemy.attackElapsed += rawDelta;
                if (state.enemy.attackElapsed > state.enemy.attackDelay) {
                    state.enemy.attackElapsed = state.enemy.attackDelay;
                }
            } else if (state.status === "reward") {
                state.rewardRemaining = Math.max(0, state.rewardRemaining - rawDelta);
                const rewardClock = byId("reward-clock");
                if (rewardClock) rewardClock.textContent = String(Math.ceil(state.rewardRemaining / 1000));
            }
        } else {
            state.clock += rawDelta;
            if (state.status === "active") {
                state.timeRemaining -= rawDelta;
                if (state.timeRemaining <= 0) {
                    state.timeRemaining = 0;
                    finishGame(false, "The master timer reached 00:00.");
                } else {
                    updatePlayers(rawDelta);
                    state.enemy.attackElapsed += rawDelta;
                    if (state.enemy.attackElapsed >= state.enemy.attackDelay) {
                        state.enemy.attackElapsed %= state.enemy.attackDelay;
                        fireEnemyAttack();
                    }
                }
            } else if (state.status === "reward") {
                const remaining = Math.max(0, state.rewardEndsAt - state.clock);
                const clock = byId("reward-clock");
                if (clock) clock.textContent = String(Math.ceil(remaining / 1000));
                if (remaining <= 0) nextFloor();
            }
        }

        updateEffects(delta);
        draw(now);
        if (now - lastHudPaint > 90) {
            paintMeters();
            lastHudPaint = now;
        }
        animationFrame = requestAnimationFrame(loop);
    }

    function toggleCheat() {
        if (!state || state.status === "over") return;
        if (state.authoritative) {
            if (socket && socket.connected) socket.emit("game:cheat", { on: !state.cheat });
            return;
        }
        const player = state.players[0];
        player.cheat = !player.cheat;
        feed(player.cheat ? `${player.name} enabled cheat mode.` : `${player.name} disabled cheat mode.`);
        paintMeters();
    }

    function handleKeydown(event) {
        if (!state || event.repeat) return;
        if (event.key.toLowerCase() === "c") {
            toggleCheat();
            return;
        }
        const slot = Number(event.key) - 1;
        if (slot >= 0 && slot < 4) {
            event.preventDefault();
            const button = byId("card-hand-0").querySelector(`[data-slot="${slot}"]`);
            playCard(0, slot, button);
        }
    }

    function bindListeners() {
        if (listenersBound) return;
        window.addEventListener("keydown", handleKeydown);
        // The sound button is the one in the top bar, shared with the lobby (lobby.js handles it outside the game)
        byId("music-toggle").addEventListener("click", () => { if (getComputedStyle(byId("game-view")).display !== "none") Audio.toggle(); });
        document.addEventListener("pointerdown", () => Audio.unlock(), { once: true });
        listenersBound = true;
    }

    function start(roomSocket, startInfo, currentUser) {
        stop();
        socket = roomSocket || null;
        localUsername = currentUser && currentUser.username;
        canvas = byId("game-canvas");
        context = canvas.getContext("2d");
        canvas.width = WORLD_WIDTH;
        canvas.height = WORLD_HEIGHT;
        bindListeners();
        loadAssets().then(() => {
            if (state && state.status !== "over") draw(performance.now());
        });

        const roomPlayers = (startInfo && startInfo.players) || [];
        const localPlayer = currentUser
            ? roomPlayers.find(player => player.username === currentUser.username) || roomPlayers[0]
            : roomPlayers[0];
        const authoritative = roomPlayers.length > 1;
        const orderedEnemies = shuffled(ENEMIES);
        const orderedPlayers = authoritative && localPlayer
            ? [localPlayer, ...roomPlayers.filter(player => player.username !== localPlayer.username)]
            : roomPlayers;
        state = {
            authoritative,
            status: authoritative ? "waiting" : "active",
            floor: 1,
            timeRemaining: MASTER_TIME_MS,
            clock: 0,
            lastTick: performance.now(),
            rewardEndsAt: 0,
            rewardRemaining: 0,
            cheat: false,
            players: authoritative
                ? orderedPlayers.map((player, index) => {
                    const view = makePlayer(index, orderedPlayers);
                    view.serverIndex = roomPlayers.findIndex(candidate => candidate.username === player.username);
                    view.username = player.username;
                    view.hand = [];
                    view.deck = [];
                    view.deckCount = 16;
                    return view;
                })
                : [makePlayer(0, localPlayer ? [localPlayer] : roomPlayers)],
            enemy: null,
            enemyOrder: orderedEnemies,
            projectiles: [],
            hazards: [],
            effects: [],
            particles: [],
            floating: [],
            lastUtility: null,
            stats: { damage: 0, cards: 0, floors: 0, blocks: 0, blocked: 0 }
        };

        byId("game-overlay").hidden = true;
        byId("help-button").style.display = "none";
        byId("battle-feed").replaceChildren();
        byId("player-hud-1").hidden = !authoritative;
        byId("mode-label").textContent = authoritative ? "CO-OP · 2 PLAYERS" : "SOLO RUN";
        Audio.syncMuted();                                  // keep the sound off in the game if it was turned off in the lobby
        byId("music-toggle").textContent = Audio.muted ? "Sound off" : "Sound on";
        lastHandSignature = "";
        if (authoritative) {
            bindNetworkListeners(socket);
            updateNames();
            renderHands();
            feed("Synchronizing the co-op battle…");
        } else {
            spawnEnemy();
            renderHands();
            paintMeters();
            feed("Click a card or press 1–4 to play it.");
        }
        Audio.unlock();
        animationFrame = requestAnimationFrame(loop);
    }

    function stop() {
        if (typeof GameOver !== "undefined") GameOver.hide();
        if (animationFrame) cancelAnimationFrame(animationFrame);
        animationFrame = null;
        state = null;
        lastHandSignature = "";
        clearTimeout(calloutTimer);
        if (canvas) context && context.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        Audio.stop();
        byId("game-overlay") && (byId("game-overlay").hidden = true);
        byId("help-button") && (byId("help-button").style.display = "");
        byId("player-hud-1") && (byId("player-hud-1").hidden = true);
    }

    // Enemy HP per floor as it really is in the game (base HP times the small floor multiplier), for the How to Play pages
    const FLOOR_HP = FLOOR_HEALTH.map((hp, i) => Math.round(hp * FLOOR_HEALTH_VARIANCE[i]));
    return { start, stop, CARD_POOL, ENEMIES, FLOOR_HEALTH: FLOOR_HP };
})();
