export function hashString(text) {
    let h = 0x811c9dc5;
    for (const c of String(text)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
}
export function createRng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ a >>> 15, a | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    return { get state() { return a; }, next, int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        pick: list => list[Math.floor(next() * list.length)],
        shuffle(list) { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; } };
}
