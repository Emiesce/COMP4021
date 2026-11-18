// A small in-memory "too many failed attempts" limiter (used for sign-in).
//   fail(key)  records a failed attempt; after `max` failures within `windowMs` the key is locked
//              for `lockMs`
//   check(key) -> { blocked, retryAfter } (retryAfter in seconds)
//   reset(key) forgets the key (call it after a success)
function createLimiter({ max, windowMs, lockMs }) {
    const entries = new Map();      // key -> { fails: [timestamps], lockedUntil }

    const check = function(key) {
        const entry = entries.get(key);
        const now = Date.now();
        if (entry && entry.lockedUntil > now) {
            return { blocked: true, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
        }
        return { blocked: false, retryAfter: 0 };
    };

    const fail = function(key) {
        const now = Date.now();
        const entry = entries.get(key) || { fails: [], lockedUntil: 0 };
        entry.fails = entry.fails.filter(t => now - t < windowMs);
        entry.fails.push(now);
        if (entry.fails.length >= max) {
            entry.lockedUntil = now + lockMs;
            entry.fails = [];
        }
        entries.set(key, entry);
    };

    const reset = function(key) {
        entries.delete(key);
    };

    // Forget old entries once a minute so the map cannot grow forever
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of entries) {
            const recent = entry.fails.some(t => now - t < windowMs);
            if (!recent && entry.lockedUntil <= now) entries.delete(key);
        }
    }, 60000).unref();

    return { check, fail, reset };
}

module.exports = { createLimiter };
