// Card definitions + a per-player deck (Lab 4's deck idea, but NOT a global array:
// every player gets their own deck object, so two games never share a deck).
const CARDS = {
    slash:    { id: "slash",    name: "Slash",    cost: 1, type: "attack", damage: 6 },
    heavy:    { id: "heavy",    name: "Heavy Hit", cost: 2, type: "attack", damage: 14 },
    fireball: { id: "fireball", name: "Fireball", cost: 3, type: "attack", damage: 22 }
    // TODO (group): block, heal, buff, debuff, combo cards
};
const STARTER_POOL = ["slash", "slash", "slash", "slash", "heavy", "heavy", "heavy", "fireball", "fireball"];

function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function createDeck(pool = STARTER_POOL) {
    let cards = shuffle(pool);
    return {
        draw() {
            if (cards.length === 0) cards = shuffle(pool);   // reshuffle when empty
            return cards.pop();
        },
        size: () => cards.length
    };
}

module.exports = { CARDS, STARTER_POOL, createDeck };
