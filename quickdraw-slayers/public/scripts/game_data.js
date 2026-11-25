(function(root, factory) {
    const data = factory();
    if (typeof module === "object" && module.exports) module.exports = data;
    else root.QuickdrawGameData = data;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    return {
        MASTER_TIME_MS: 240000,
        ENERGY_INTERVAL_MS: 1800,
        REWARD_TIME_MS: 5000,
        MAX_SHIELD: 60,
        DECK_COPIES: 2,
        CARD_SLOT_COOLDOWN_MS: 650,
        STATE_RATE_MS: 100,
        FLOOR_HEALTH: [145, 220, 320],
        FLOOR_HEALTH_VARIANCE: [1, 1.02, 1.04],
        PLAYER_SCALING: { healthPerExtra: 0.8, damagePerExtra: 0.25 },
        CARD_POOL: [
            { id: "pop_quiz", name: "Pop Quiz", type: "ATTACK", cost: 1, action: "damage", value: 16,
                image: "/images/cards/pop_quiz.jpg", color: "#ffcf66", description: "Fast strike. 16 damage." },
            { id: "dragonboat", name: "Dragonboat", type: "ATTACK", cost: 2, action: "damage", value: 32,
                image: "/images/cards/dragonboat.jpg", color: "#ff8d53", description: "Heavy strike. 32 damage." },
            { id: "final_exam", name: "Final Exam", type: "ATTACK", cost: 3, action: "damage", value: 54,
                image: "/images/cards/final_exam.jpg", color: "#f45d8e", description: "Devastating strike. 54 damage." },
            { id: "lab_explosion", name: "Lab Explosion", type: "ATTACK", cost: 3, action: "damage", value: 48,
                image: "/images/cards/lab_explosion.jpg", color: "#ffad50", description: "Explosive hit. 48 damage." },
            { id: "shield", name: "Shield", type: "BLOCK", cost: 1, action: "block", value: 24,
                image: "/images/cards/shield.jpg", color: "#63dcff", description: "Gain 24 Shield." },
            { id: "office_hours", name: "Office Hours", type: "BLOCK", cost: 1, action: "block", value: 20,
                image: "/images/cards/office_hours.jpg", color: "#76cfff", description: "Gain 20 Shield. Find an opening." },
            { id: "group_project", name: "Group Project", type: "UTILITY", cost: 2, action: "weaken", value: 2,
                image: "/images/cards/group_project.jpg", color: "#b888ff", description: "Enemy deals 35% less damage for 2 attacks." },
            { id: "bell_curve", name: "Bell Curve", type: "UTILITY", cost: 2, action: "vulnerable", value: 8000,
                image: "/images/cards/bell_curve.jpg", color: "#d989ff", description: "Enemy takes 45% more damage for 8s." },
            { id: "milk_tea", name: "Milk Tea", type: "UTILITY", cost: 1, action: "heal", value: 24,
                image: "/images/cards/milk_tea.jpg", color: "#79e49d", description: "Recover 24 HP." },
            { id: "extension", name: "Extension", type: "UTILITY", cost: 2, action: "energy", value: 2,
                image: "/images/cards/extension.jpg", color: "#ffe078", description: "Restore 2 Energy for all players." }
        ],
        ENEMIES: [
            {
                id: "enemy_typhoon", name: "Campus Typhoon", intent: "Cyclone Spiral",
                attackDelay: 5200, image: "/images/sprites/enemy_typhoon_sheet.png",
                baseDamage: 12, color: "#65c8ff"
            },
            {
                id: "enemy_firebird", name: "Feral Firebird", intent: "Crimson Dive",
                attackDelay: 5000, image: "/images/sprites/enemy_firebird_sheet.png",
                baseDamage: 13, color: "#ff7a55"
            },
            {
                id: "enemy_dragon", name: "Thesis Dragon", intent: "Thesis Breath",
                attackDelay: 4700, image: "/images/sprites/enemy_dragon_sheet.png",
                baseDamage: 14, color: "#c77dff"
            }
        ]
    };
});
