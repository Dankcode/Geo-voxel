// Footprint → wings: an OSM building outline as a cell mask, cut into axis-aligned wing rectangles at its reflex
// corners (largest rectangle first, wings share wall lines — after Camozzato et al., "Procedural floor plan
// generation from building sketches", SIGGRAPH 2015), plus mask clean-up and single party walls between touching
// buildings. Pure functions on [x, y] cell lists.
const k2 = (x, y) => `${x},${y}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const MIN_WING = 5;

/** Largest axis-aligned rectangle of cells in `set` (histogram method). Returns { x0, y0, w, d } or null. */
export function largestRectangle(set, box) {
    const W = box.x1 - box.x0 + 1, H = box.y1 - box.y0 + 1, h = new Int32Array(W);
    let best = null, bestA = 0;
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) h[i] = set.has(k2(box.x0 + i, box.y0 + j)) ? h[i] + 1 : 0;
        const st = [];
        for (let i = 0; i <= W; i++) {
            const cur = i < W ? h[i] : 0;
            while (st.length && h[st[st.length - 1]] >= cur) {
                const top = st.pop(), height = h[top], left = st.length ? st[st.length - 1] + 1 : 0, width = i - left;
                // prefer squarer wings at equal area: they plan into better rooms
                const a = height * width - (Math.abs(height - width) > 3 * Math.min(height, width) ? 0.5 : 0);
                if (height && width && a > bestA) { bestA = a; best = { x0: box.x0 + left, y0: box.y0 + j - height + 1, w: width, d: height }; }
            }
            st.push(i);
        }
    }
    return best;
}

/**
 * Wings of a mask: rectangles that share boundary lines (overlap by exactly one cell row/column where they meet).
 * Returns { wings: [{x0,y0,w,d}], mass: [[x,y]] (mask cells no wing covers) }.
 */
export function decomposeFootprint(cells, { minWing = MIN_WING, maxWings = 8 } = {}) {
    const mask = new Set(cells.map(([x, y]) => k2(x, y))), remaining = new Set(mask);
    const box = { x0: Math.min(...cells.map(c => c[0])), y0: Math.min(...cells.map(c => c[1])), x1: Math.max(...cells.map(c => c[0])), y1: Math.max(...cells.map(c => c[1])) };
    const wings = [], covered = new Set();
    while (wings.length < maxWings) {
        const r = largestRectangle(remaining, box);
        if (!r || r.w < minWing || r.d < minWing) break;
        wings.push(r);
        const inR = (x, y) => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d;
        const drop = [];
        for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
            covered.add(k2(x, y));
            const edge = x === r.x0 || y === r.y0 || x === r.x0 + r.w - 1 || y === r.y0 + r.d - 1;
            // a boundary cell next to unclaimed mask stays available: the next wing shares this wall line
            const shared = edge && N4.some(([dx, dy]) => !inR(x + dx, y + dy) && remaining.has(k2(x + dx, y + dy)) && !covered.has(k2(x + dx, y + dy)));
            if (!shared) drop.push(k2(x, y));
        }
        for (const k of drop) remaining.delete(k);
        // stop if what is left is only the shared lines themselves
        if (![...remaining].some(k => !covered.has(k))) break;
    }
    const mass = cells.filter(([x, y]) => !covered.has(k2(x, y)));
    return { wings, mass };
}

/**
 * Clean a raw mask: drop spur cells (fewer than two 4-neighbours) and fill single-cell holes.
 */
export function cleanMask(cells) {
    let set = new Set(cells.map(([x, y]) => k2(x, y)));
    for (let it = 0; it < 4; it++) {
        const drop = [...set].filter(k => { const [x, y] = k.split(',').map(Number); return N4.filter(([dx, dy]) => set.has(k2(x + dx, y + dy))).length < 2; });
        if (!drop.length) break; for (const k of drop) set.delete(k);
    }
    const xs = [...set].map(k => +k.split(',')[0]), ys = [...set].map(k => +k.split(',')[1]);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++)
        if (!set.has(k2(x, y)) && N4.filter(([dx, dy]) => set.has(k2(x + dx, y + dy))).length >= 3) set.add(k2(x, y));
    return [...set].map(k => k.split(',').map(Number));
}

/**
 * Resolve real footprints against each other. Genuine overlaps (mapping errors) go to the larger building. Then,
 * where two footprints touch (4-adjacent cells), the larger one also claims the smaller one's boundary cells: both
 * build their wall on that one line — a single party wall, owned by both, as in a real terrace. Input:
 * [{ id, cells, area }]. Mutates cells; returns the set of party-wall cell keys.
 */
export function resolveParty(footprints) {
    const owner = new Map();
    for (const f of footprints.slice().sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1)))
        for (const [x, y] of f.cells) if (!owner.has(k2(x, y))) owner.set(k2(x, y), f);
    const masks = new Map(footprints.map(f => [f, new Set()]));
    for (const [k, f] of owner) masks.get(f).add(k);
    const party = new Set();
    for (const [k, f] of owner) {
        const [x, y] = k.split(',').map(Number);
        for (const [dx, dy] of N4) {
            const g = owner.get(k2(x + dx, y + dy));
            if (!g || g === f) continue;
            // the larger (then lower id) footprint extends onto the other's boundary cell
            const big = f.area > g.area || f.area === g.area && f.id < g.id ? f : g, small = big === f ? g : f;
            const cell = big === f ? k2(x + dx, y + dy) : k;
            if (owner.get(cell) !== small) continue;
            masks.get(big).add(cell); party.add(cell);
        }
    }
    for (const f of footprints) f.cells = [...masks.get(f)].map(s => s.split(',').map(Number));
    return party;
}

const sideOf = (r, side) => {
    const out = [];
    if (side === 'n' || side === 's') { const y = side === 'n' ? r.y0 : r.y0 + r.d - 1; for (let x = r.x0; x < r.x0 + r.w; x++) out.push([x, y]); }
    else { const x = side === 'w' ? r.x0 : r.x0 + r.w - 1; for (let y = r.y0; y < r.y0 + r.d; y++) out.push([x, y]); }
    return out;
};
const OUT = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

