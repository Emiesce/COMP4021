// The battle runs on the server (server/game.js), for solo and co-op alike. This file only draws what the server
// sends (game:state snapshots and game:effect cues) and sends the player's intent (play a card, pick a reward, cheat).
const Game = (function() {
    "use strict";

    const WORLD_WIDTH = 960;
    const WORLD_HEIGHT = 540;
    // The background image is 16:9, same as the canvas. Lift it so the courtyard meets the sprites,
    // and stretch the bottom edge to cover the strip that lift uncovers.
    const BACKGROUND_SHIFT = 96;
    const {
        MASTER_TIME_MS, ENERGY_INTERVAL_MS,
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

    function setAnimation(entity, name) {
        entity.animation = { name, startedAt: performance.now() };
    }

    // Each seat is always the same character on every screen: seat 0 is the straw-hat Grade Farmer on the left,
    // seat 1 is the shield-bearing Deadline Fighter on the right. `index` is the on-screen slot used for the HUD
    // and hand (0 = you); `seat` is the server's player order (0 = the player who created the room).
    function applySeat(player, seat) {
        const layout = PLAYER_LAYOUT[seat] || PLAYER_LAYOUT[0];
        player.sprite = layout.sprite;
        player.x = layout.x;
        player.y = layout.y;
        player.scale = layout.scale;
        const hud = byId(`player-hud-${player.index}`);
        if (hud) {                                     // the HUD sits under its own character
            hud.classList.remove("slayer-0", "slayer-1");
            hud.classList.add(`slayer-${seat === 1 ? 1 : 0}`);
        }
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
            hand: [],
            deckCount: 16,
            lockedSlots: new Set(),
            lastEnergyCharge: -Infinity,
            lastDeckReset: -Infinity,
            animation: { name: "idle", startedAt: performance.now() },
            rewardChoice: null
        };
        return player;
    }

    // Sound: one music file for the battle plus short sound-effect files (all in public/sounds/), played with
    // HTML audio elements. Browsers only allow sound after the player has clicked the page, so everything starts in unlock().
    const SOUND_EFFECTS = ["attack", "block", "hit", "reward", "victory", "defeat", "error"];
    const SOUND_VOLUME = 0.4;

    const Audio = {
        music: null,
        effects: null,
        started: false,
        muted: false,
        lastError: 0,

        unlock() {
            if (!this.effects) {
                this.effects = {};
                SOUND_EFFECTS.forEach(name => {
                    const clip = new window.Audio(`/sounds/${name}.wav`);
                    clip.preload = "auto";
                    this.effects[name] = clip;
                });
            }
            if (!this.music) {
                this.music = new window.Audio("/sounds/boss_music_1.mp3");
                this.music.loop = true;
                this.music.volume = 0.3;
            }
            if (!this.started && !this.muted) this.playMusic();
        },

        // Browsers may refuse to start audio before the player has clicked the page: ignore that and retry later
        playMusic() {
            const attempt = this.music.play();
            if (attempt && attempt.then) attempt.then(() => { this.started = true; }, () => {});
        },

        // Play a copy of the clip so that quick repeats overlap instead of cutting each other off
        play(name) {
            if (this.muted || !this.effects || !this.effects[name]) return;
            if (name === "error") {                         // holding a key down must not turn into a buzz
                const now = Date.now();
                if (now - this.lastError < 250) return;
                this.lastError = now;
            }
            const clip = this.effects[name].cloneNode();
            clip.volume = SOUND_VOLUME;
            const attempt = clip.play();
            if (attempt && attempt.catch) attempt.catch(() => {});
        },

        // The mute setting is shared with the lobby music button (SoundSetting, defined in lobby.js)
        syncMuted() {
            this.muted = SoundSetting.muted;
        },

        toggle() {
            this.syncMuted();
            this.unlock();
            this.muted = !this.muted;
            if (this.muted) {
                this.music.pause();
                this.started = false;
            } else {
                this.playMusic();
            }
            SoundSetting.muted = this.muted;
            byId("music-toggle").textContent = this.muted ? "Sound off" : "Sound on";
        },

        stop() {
            if (this.music) this.music.pause();
            this.started = false;
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
                    player.lockedSlots.has(index) || (!state.cheat && player.energy < card.cost);
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
                const full = index < player.energy || state.cheat;
                const charging = index === Math.floor(player.energy) && player.energy < player.energyMax;
                const fill = full ? 100 : (charging ? player.energyProgress / ENERGY_INTERVAL_MS * 100 : 0);
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
            const tag = byId(`player-tag-${player.index}`);
            const isYou = player.username === localUsername;
            tag.textContent = isYou ? `YOU · ${player.name}` : player.name;
            tag.classList.toggle("you", isYou);
            if (player.index === 0) {
                const deckLength = player.deckCount;
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
        byId("cheat-badge").classList.toggle("visible", state.cheat);
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

    // The server decides what a card does: the browser only asks to play the card in this slot
    function playCard(playerIndex, cardIndex, button) {
        Audio.unlock();
        if (!state || state.status !== "active") return;
        const player = state.players[playerIndex];
        if (!player) return;
        const card = player.hand[cardIndex];
        if (!card || player.hp <= 0 || player.lockedSlots.has(cardIndex)) return;
        if (!state.cheat && player.energy < card.cost) {
            button && button.classList.add("invalid");
            setTimeout(() => button && button.classList.remove("invalid"), 280);
            feed(`${player.name} needs ${card.cost} Energy for ${card.name}.`);
            Audio.play("error");
            return;
        }
        if (socket && socket.connected) {
            player.lockedSlots.add(cardIndex);
            burnCard(button, card.color);
            updateCardAvailability();
            socket.emit("game:play", { slot: cardIndex });
        }
    }

    function chooseReward(playerIndex, choice) {
        if (!state || state.status !== "reward") return;
        const player = state.players[playerIndex];
        if (player.rewardChoice) return;
        player.rewardChoice = choice;
        if (socket && socket.connected) socket.emit("game:reward", { choice });
        document.querySelectorAll(`#reward-player-${playerIndex} .reward-button`).forEach(button => {
            button.disabled = true;
            button.classList.toggle("chosen", button.dataset.reward === choice);
        });
        byId(`reward-player-${playerIndex}`).classList.add("complete");
        Audio.play("reward");
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
        if (!state || !snapshot || !Array.isArray(snapshot.players)) return;
        const previous = new Map(state.players.map(player => [player.username, player]));
        const serverLocal = snapshot.players.find(player => player.username === localUsername);
        const ordered = serverLocal
            ? [serverLocal, ...snapshot.players.filter(player => player.username !== localUsername)]
            : [...snapshot.players];
        const previousStatus = state.status;
        const previousFloor = state.floor;

        state.status = snapshot.status;
        if (snapshot.status === "over" && previousStatus !== "over" && snapshot.floor === 3 && snapshot.enemy.hp <= 0) {
            Audio.play("victory");
        } else if (snapshot.status === "over" && previousStatus !== "over") {
            Audio.play("defeat");
        }
        state.floor = snapshot.floor;
        state.clock = snapshot.t;
        state.timeRemaining = snapshot.timeLeft;
        state.rewardRemaining = snapshot.rewardEndsIn;
        state.cheat = snapshot.cheat === true;
        state.scaling = snapshot.scaling;
        state.players = ordered.map((player, index) => {
            const old = previous.get(player.username);
            const lockedSlots = new Set(
                (player.cooldowns || []).map((remaining, slot) => remaining > 0 ? slot : -1).filter(slot => slot >= 0)
            );
            const next = {
                ...old,
                index,
                serverIndex: player.index,
                username: player.username,
                name: player.name,
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
                awayEndsIn: player.awayEndsIn,
                damageBoost: player.damageBoost,
                lastEnergyCharge: old && old.lastEnergyCharge != null ? old.lastEnergyCharge : -Infinity,
                lastDeckReset: old && old.lastDeckReset != null ? old.lastDeckReset : -Infinity,
                animation: old && old.animation ? old.animation : { name: "idle", startedAt: performance.now() }
            };
            applySeat(next, player.index);
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
        paintAwayBanner();
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

    // "Bob lost connection..." while the partner's seat is held for them (the server gives the seconds left)
    function paintAwayBanner() {
        const banner = byId("away-banner");
        const away = state ? state.players.find(player => player.away && player.username !== localUsername) : null;
        banner.hidden = !away;
        if (away) {
            const seconds = Math.ceil((Number(away.awayEndsIn) || 0) / 1000);
            banner.textContent = `${away.name} lost connection. Waiting for them to come back… ${seconds}s`;
        }
    }

    function handleNetworkEffect(effect) {
        if (!state || !effect) return;
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
        if (!state || !info) return;
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

    function loop(now) {
        if (!state) return;
        const rawDelta = Math.max(0, now - state.lastTick);
        const delta = Math.min(rawDelta, 100);
        state.lastTick = now;
        // Between snapshots the clocks keep running so the timers move smoothly
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
        if (socket && socket.connected) socket.emit("game:cheat", { on: !state.cheat });
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
        const orderedPlayers = localPlayer
            ? [localPlayer, ...roomPlayers.filter(player => player.username !== localPlayer.username)]
            : roomPlayers;
        state = {
            status: "waiting",                          // until the first snapshot arrives
            floor: 1,
            timeRemaining: MASTER_TIME_MS,
            clock: 0,
            lastTick: performance.now(),
            rewardRemaining: 0,
            cheat: false,
            players: orderedPlayers.map((player, index) => {
                const view = makePlayer(index, orderedPlayers);
                view.serverIndex = roomPlayers.findIndex(candidate => candidate.username === player.username);
                view.username = player.username;
                applySeat(view, view.serverIndex);
                return view;
            }),
            enemy: null,
            projectiles: [],
            hazards: [],
            effects: [],
            particles: [],
            floating: []
        };

        byId("game-overlay").hidden = true;
        byId("help-button").style.display = "none";
        byId("battle-feed").replaceChildren();
        byId("player-hud-1").hidden = state.players.length < 2;
        byId("mode-label").textContent = state.players.length > 1 ? "CO-OP · 2 PLAYERS" : "SOLO RUN";
        Audio.syncMuted();                                  // keep the sound off in the game if it was turned off in the lobby
        byId("music-toggle").textContent = Audio.muted ? "Sound off" : "Sound on";
        lastHandSignature = "";
        bindNetworkListeners(socket);
        updateNames();
        renderHands();
        feed("Starting the battle…");
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
        byId("away-banner") && (byId("away-banner").hidden = true);
    }

    // Enemy HP per floor as it really is in the game (base HP times the small floor multiplier), for the How to Play pages
    const FLOOR_HP = FLOOR_HEALTH.map((hp, i) => Math.round(hp * FLOOR_HEALTH_VARIANCE[i]));
    return { start, stop, CARD_POOL, ENEMIES, FLOOR_HEALTH: FLOOR_HP };
})();
