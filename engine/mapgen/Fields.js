import { smoothRoad, rasterRoadNetwork } from './RoadGeometry.js';
// PLAN-04 §5.3 step 2 — guide fields for field-guided WFC. Every field is a low-resolution scalar grid that is
// deterministic from the map id, the layer and the seed, so lockstep peers and the offline builder agree:
//
//   picture prior  P(kind, cell)  what the reference picture shows where (building / road / green / paved / height)
//   variety noise  N(cell)        seeded value-noise fBm, a different frequency per layer (district, lot, detail)
//   line of play   L(cell)        distance to the insertion → objective route and its left/right flanks
//   sightline      S(cell)        longest open run through a cell along the 4 axes (8 directions)
//   height intent  H(cell)        where tall buildings, rooftops and bridges should go
//
// A WFC tile weight becomes  w = base · P^α · f(N)^β · g(L, S, H)^γ  (see fieldWeight); the fields only bias the
// solver's choices, adjacency is still guaranteed by WFC itself.
import { hashString } from '../util/Rng.js';

export class Field {
    constructor(w, h, fill = 0) { this.w = w; this.h = h; this.data = new Float32Array(w * h).fill(fill); }
    inside(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    get(x, y) { x = Math.max(0, Math.min(this.w - 1, Math.floor(x))); y = Math.max(0, Math.min(this.h - 1, Math.floor(y))); return this.data[x + y * this.w]; }
    set(x, y, v) { if (this.inside(x, y)) this.data[x + y * this.w] = v; }
    map(fn) { const f = new Field(this.w, this.h); for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) f.data[x + y * this.w] = fn(this.get(x, y), x, y); return f; }
    /** Mean over a rectangle (inclusive cell bounds), used to read a field at lot or bay resolution. */
    mean(x0, y0, x1, y1) { let s = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.inside(x, y)) { s += this.get(x, y); n++; } return n ? s / n : 0; }
    max(x0, y0, x1, y1) { let s = -Infinity; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.inside(x, y)) s = Math.max(s, this.get(x, y)); return s; }
    range() { let lo = Infinity, hi = -Infinity; for (const v of this.data) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; }
    blur(r = 1) {
        const out = new Field(this.w, this.h);
        for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) out.data[x + y * this.w] = this.mean(x - r, y - r, x + r, y + r);
        return out;
    }
}

// ------------------------------------------------------------------------------------------------ variety noise
const seedHashes = new Map();
const seedHash = seed => { let h = seedHashes.get(seed); if (h === undefined) { h = hashString(seed); if (seedHashes.size > 512) seedHashes.clear(); seedHashes.set(seed, h); } return h; };
/** Integer lattice hash (murmur3 finaliser) → [0, 1). */
function lattice(seed, x, y) {
    let h = (seedHash(seed) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
/** Seeded 2D value noise in [0, 1], continuous (smoothstep-interpolated lattice). */
export function valueNoise(seed, x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = smooth(x - x0), ty = smooth(y - y0);
    const a = lattice(seed, x0, y0), b = lattice(seed, x0 + 1, y0), c = lattice(seed, x0, y0 + 1), d = lattice(seed, x0 + 1, y0 + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
/** Fractal value noise: `octaves` layers, each `lacunarity` × the frequency and `gain` × the amplitude. Range [0, 1]. */
export function fbm(seed, x, y, { frequency = 1 / 8, octaves = 3, lacunarity = 2, gain = 0.5 } = {}) {
    let sum = 0, amp = 1, norm = 0, f = frequency;
    for (let o = 0; o < octaves; o++) { sum += amp * valueNoise(`${seed}:${o}`, x * f, y * f); norm += amp; amp *= gain; f *= lacunarity; }
    return sum / norm;
}
/** The noise layers used by the generator; each has its own frequency so districts, lots and details vary independently. */
export const NOISE_LAYERS = Object.freeze({ district: { frequency: 1 / 24, octaves: 2 }, lot: { frequency: 1 / 10, octaves: 3 }, detail: { frequency: 1 / 4, octaves: 2 }, interior: { frequency: 1 / 5, octaves: 2 }, clutter: { frequency: 1 / 3, octaves: 2 }, wear: { frequency: 1 / 14, octaves: 2 } });
export function noiseField(seed, w, h, layer = 'lot') {
    const opts = NOISE_LAYERS[layer] || NOISE_LAYERS.lot, f = new Field(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f.data[x + y * w] = fbm(`${seed}:${layer}`, x, y, opts);
    return f;
}

// ------------------------------------------------------------------------------------------------ picture prior
const SURFACE_KIND = { asphalt: 'road', lawn: 'green', deck: 'green', concrete: 'paved', paving: 'paved' };
/**
 * Rasterise the vision read (site.json: building bounds with storeys, surfaces) onto the map grid and soften it.
 * toCell([u, v]) maps normalised picture coordinates to cells. Returns one Field per kind plus `height` (0..1 = 4 storeys).
 */
export function picturePrior(site, w, h, toCell, { blur = 1 } = {}) {
    const kinds = { building: new Field(w, h), road: new Field(w, h), green: new Field(w, h), paved: new Field(w, h), water: new Field(w, h), height: new Field(w, h) };
    const fillRect = (bounds, fn) => {
        const [x0, y0] = toCell(bounds.slice(0, 2)), [x1, y1] = toCell(bounds.slice(2));
        for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) fn(x, y);
    };
    for (const s of site?.surfaces || []) { const k = SURFACE_KIND[s.material]; if (k) fillRect(s.bounds, (x, y) => { for (const o of Object.keys(SURFACE_KIND).map(m => SURFACE_KIND[m])) kinds[o].set(x, y, 0); kinds[k].set(x, y, 1); }); }
    const roads=(site?.roads||[]).map(r=>({id:r.id,width:r.width*Math.hypot(...toCell([1,0]).map((v,i)=>v-toCell([0,0])[i]))/(site.frame.width||1),points:smoothRoad(r.points.map(toCell))}));
    for(const c of rasterRoadNetwork(roads,w,h)) {kinds.road.set(c.x,c.y,c.road?1:0);kinds.paved.set(c.x,c.y,c.road?0:1);kinds.green.set(c.x,c.y,0);}
    for (const b of site?.buildings || []) fillRect(b.bounds, (x, y) => { kinds.building.set(x, y, 1); kinds.road.set(x, y, 0); kinds.height.set(x, y, Math.min(1, (b.storeys || 1) / 4)); });
    for (const wtr of site?.water || []) fillRect(wtr.bounds, (x, y) => kinds.water.set(x, y, 1));
    if (blur) for (const k of Object.keys(kinds)) kinds[k] = kinds[k].blur(blur);
    return kinds;
}

// ------------------------------------------------------------------------------------------------ line of play
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/**
 * Grid shortest path with PathSearch's flat-ground rules (cardinal 1, diagonal 1.414, no corner cutting).
 * extraCost(x, y) adds a penalty per entered cell (used to push flanks away from the main route).
 */
export function gridPath(w, h, passable, start, goal, extraCost = () => 0) {
    const dist = new Float64Array(w * h).fill(Infinity), prev = new Int32Array(w * h).fill(-1), done = new Uint8Array(w * h);
    const idx = (x, y) => x + y * w, heap = [];
    const push = (i, d) => { heap.push([d, i]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] < heap[c][0] || (heap[p][0] === heap[c][0] && heap[p][1] <= heap[c][1])) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; for (const k of [l, r]) if (k < heap.length && (heap[k][0] < heap[m][0] || (heap[k][0] === heap[m][0] && heap[k][1] < heap[m][1]))) m = k; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    if (!passable(start.x, start.y) || !passable(goal.x, goal.y)) return null;
    dist[idx(start.x, start.y)] = 0; push(idx(start.x, start.y), 0);
    while (heap.length) {
        const [d, i] = pop(); if (done[i]) continue; done[i] = 1;
        const x = i % w, y = (i - x) / w;
        if (x === goal.x && y === goal.y) break;
        for (const [dx, dy] of DIRS8) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !passable(nx, ny)) continue;
            if (dx && dy && (!passable(x + dx, y) || !passable(x, y + dy))) continue;
            const nd = d + (dx && dy ? 1.414 : 1) + extraCost(nx, ny), j = idx(nx, ny);
            if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push(j, nd); }
        }
    }
    const gi = idx(goal.x, goal.y);
    if (!Number.isFinite(dist[gi])) return null;
    const path = [];
    for (let i = gi; i >= 0; i = prev[i]) path.push({ x: i % w, y: Math.floor(i / w) });
    return { cost: dist[gi], path: path.reverse() };
}

/** Distance (in cells, 8-connected Chebyshev-ish BFS) from every cell to the nearest seed cell. */
export function distanceField(w, h, seeds, passable = () => true) {
    const f = new Field(w, h, Infinity), q = [];
    for (const p of seeds) if (f.inside(p.x, p.y) && f.get(p.x, p.y) !== 0) { f.set(p.x, p.y, 0); q.push(p); }
    for (let i = 0; i < q.length; i++) {
        const p = q[i], d = f.get(p.x, p.y);
        for (const [dx, dy] of DIRS8) {
            const nx = p.x + dx, ny = p.y + dy;
            if (!f.inside(nx, ny) || f.get(nx, ny) <= d + 1 || !passable(nx, ny)) continue;
            f.set(nx, ny, d + 1); q.push({ x: nx, y: ny });
        }
    }
    return f.map(v => (Number.isFinite(v) ? v : 99));
}

/**
 * The line of play: the main route insertion → objective plus a left and a right flank (each kept ≥ `spread` cells
 * from the main route where the ground allows). Returns the routes and the fields the WFC stages read:
 *   dist   distance to the nearest route cell      along   0..1 progress toward the objective (nearest main cell)
 *   flank  distance to the nearest flank cell
 */
export function lineOfPlay(w, h, passable, start, goal, { spread = 7, via = [] } = {}) {
    // The main route threads any designer waypoints in order (a picture's flow), then reaches the goal.
    let main = null;
    for (const [a, b] of [start, ...via, goal].slice(1).map((p, i, all) => [[start, ...via, goal][i], p])) {
        const leg = gridPath(w, h, passable, a, b);
        if (!leg) throw Error(`fields.lineOfPlay: no route from ${a.x},${a.y} to ${b.x},${b.y}`);
        main = main ? { cost: main.cost + leg.cost, path: [...main.path, ...leg.path.slice(1)] } : leg;
    }
    const near = distanceField(w, h, main.path);
    const dx = goal.x - start.x, dy = goal.y - start.y, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const flanks = [];
    for (const side of [1, -1]) {
        // Push the flank through a waypoint off the route's midpoint, then keep it away from the main route.
        const mid = main.path[Math.floor(main.path.length / 2)];
        let way = null;
        for (let k = spread + 4; k >= 3 && !way; k--) {
            const px = Math.round(mid.x + nx * side * k), py = Math.round(mid.y + ny * side * k);
            if (px >= 1 && py >= 1 && px < w - 1 && py < h - 1 && passable(px, py)) way = { x: px, y: py };
        }
        if (!way) continue;
        const penalty = (x, y) => Math.max(0, spread - near.get(x, y)) * 0.6;
        const a = gridPath(w, h, passable, start, way, penalty), b = gridPath(w, h, passable, way, goal, penalty);
        if (a && b) flanks.push({ side: side > 0 ? 'left' : 'right', cost: a.cost + b.cost, path: [...a.path, ...b.path.slice(1)] });
    }
    const along = new Field(w, h);
    const nearestMain = new Field(w, h, -1);
    // Progress along the main route, spread to every cell from its nearest route cell.
    const q = main.path.map((p, i) => ({ ...p, t: i / Math.max(1, main.path.length - 1) }));
    for (const p of q) { nearestMain.set(p.x, p.y, 1); along.set(p.x, p.y, p.t); }
    for (let i = 0; i < q.length; i++) {
        const p = q[i];
        for (const [ddx, ddy] of DIRS8) {
            const ax = p.x + ddx, ay = p.y + ddy;
            if (!along.inside(ax, ay) || nearestMain.get(ax, ay) > 0) continue;
            nearestMain.set(ax, ay, 1); along.set(ax, ay, p.t); q.push({ x: ax, y: ay, t: p.t });
        }
    }
    const flankCells = flanks.flatMap(f => f.path);
    return { main, flanks, dist: near, along, flank: flankCells.length ? distanceField(w, h, flankCells) : new Field(w, h, 99) };
}

// ------------------------------------------------------------------------------------------------ sightlines
/** Longest open run through each cell along the 4 axes (both directions, so 8 directions). Blocked cells read 0. */
export function sightlineField(w, h, open) {
    const f = new Field(w, h);
    const axes = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of axes) {
        const fwd = new Float32Array(w * h), back = new Float32Array(w * h);
        const xs = dx >= 0 ? [...Array(w).keys()] : [...Array(w).keys()].reverse();
        const ys = dy >= 0 ? [...Array(h).keys()] : [...Array(h).keys()].reverse();
        for (const y of ys) for (const x of xs) { if (!open(x, y)) continue; const px = x - dx, py = y - dy; fwd[x + y * w] = 1 + (px >= 0 && py >= 0 && px < w && py < h ? fwd[px + py * w] : 0); }
        for (const y of [...ys].reverse()) for (const x of [...xs].reverse()) { if (!open(x, y)) continue; const px = x + dx, py = y + dy; back[x + y * w] = 1 + (px >= 0 && py >= 0 && px < w && py < h ? back[px + py * w] : 0); }
        for (let i = 0; i < w * h; i++) if (fwd[i]) f.data[i] = Math.max(f.data[i], (fwd[i] + back[i] - 1) * (dx && dy ? 1.414 : 1));
    }
    return f;
}

// ------------------------------------------------------------------------------------------------ height intent
/**
 * Height intent 0..1: the picture's height cue, raised near the objective (the landmark overlooks the approach) and
 * varied by noise; the design's played heights override it per building later.
 */
export function heightIntent(prior, noise, objective, { reach = 18 } = {}) {
    return prior.height.map((v, x, y) => {
        const near = objective ? Math.max(0, 1 - Math.hypot(x - objective.x, y - objective.y) / reach) : 0;
        return Math.min(1, 0.55 * v + 0.3 * near + 0.25 * noise.get(x, y));
    });
}

/** w = base · P^α · f(N)^β · g^γ, with every factor clamped away from 0 so a field can bias but never forbid. */
export function fieldWeight(base, { prior = 1, noise = 1, play = 1 }, { alpha = 1, beta = 1, gamma = 1 } = {}) {
    const c = v => Math.max(0.02, v);
    return base * c(prior) ** alpha * c(noise) ** beta * c(play) ** gamma;
}
