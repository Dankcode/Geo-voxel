// Geo import — street straightening ("full grid"). A real street network is never on a voxel grid: a road 6° off an
// axis rasterises as a ragged staircase of kerb and sidewalk cells. This stage bends the map slightly instead, so every
// street is an exact grid line and every building wall lies on the grid, while the topology (which street meets which,
// which side a building stands on, the order of parallel carriageways) is kept.
//
//   1  frame angle   rotate by the length × class weighted 4θ mean of street segments and building walls, so the
//                    smallest possible correction is left for step 3 (Sester 2000-style least-squares generalisation)
//   2  simplify      Douglas–Peucker on every centreline, junction vertices pinned (shared OSM nodes), so a gentle
//                    curve becomes a few long segments rather than many short ones
//   3  snap          every segment is horizontal or vertical (true diagonals 30–60° become an L with a corner vertex);
//                    vertices joined by a horizontal segment share one y, by a vertical segment one x. Each shared
//                    coordinate is the weighted mean of its members' real coordinates — the least-squares solution
//                    of "keep every vertex where it was" under the grid constraints (schematisation, after Cabello,
//                    de Berg & van Kreveld). Parallel lines keep their real order and at least their real gap.
//   4  rubber sheet  everything else (buildings, land-use areas, crossings) moves with the streets: each point is
//                    displaced by the inverse-distance weighted displacement of the nearby street samples (classic
//                    map conflation rubber-sheeting, Saalfeld 1988)
//   5  square        each building outline is turned about its centroid by its own residual angle, so its walls lie
//                    on the grid (no sliver staircase), then pushed off any carriageway it now overlaps
//
// Pure geometry on cell coordinates; nothing here knows about voxels. Returns the rectified copy and a report of how
// far things moved (the distortion budget is information: a 79° crossing becomes 90°).

const k = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Weighted dominant grid angle (radians, −π/4..π/4) of polylines [{ pts, w }] and closed rings [{ pts, w, closed }]. */
export function weightedGridAngle(items) {
    let C = 0, S = 0;
    for (const { pts, w = 1, closed } of items) {
        const n = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length], L = len(a, b);
            if (L < 1) continue;
            const t = Math.atan2(b[1] - a[1], b[0] - a[0]);
            C += w * L * Math.cos(4 * t); S += w * L * Math.sin(4 * t);
        }
    }
    return C || S ? Math.atan2(S, C) / 4 : 0;
}

/** Douglas–Peucker keeping every index in `pin`. */
export function simplify(pts, tol, pin = new Set()) {
    if (pts.length <= 2) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    for (const i of pin) keep[i] = 1;
    const seg = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2)); return Math.hypot(a[0] + vx * t - p[0], a[1] + vy * t - p[1]); };
    const rec = (i, j) => {
        // split at pinned vertices first
        for (let m = i + 1; m < j; m++) if (keep[m]) { rec(i, m); rec(m, j); return; }
        let best = -1, bd = tol;
        for (let m = i + 1; m < j; m++) { const d = seg(pts[m], pts[i], pts[j]); if (d > bd) { bd = d; best = m; } }
        if (best >= 0) { keep[best] = 1; rec(i, best); rec(best, j); }
    };
    rec(0, pts.length - 1);
    return pts.filter((_, i) => keep[i]);
}

class DSU {
    constructor() { this.p = new Map(); }
    find(a) { let r = a; while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r); if (!this.p.has(a)) this.p.set(a, a); let c = a; while (c !== r) { const n = this.p.get(c); this.p.set(c, r); c = n; } return r; }
    union(a, b) { const x = this.find(a), y = this.find(b); if (x !== y) this.p.set(y, x); return x; }
}

/**
 * Straighten a road network and carry everything else along.
 * roads:   [{ id, line: [[x, y]…] (cells), cls (0 service … 4 motorway), half (half width, cells) }]
 * rings:   { buildings: [{ id, ring }], areas: [{ id, ring }], lines: [{ id, line }] } — moved by the rubber sheet;
 *          buildings are also squared to the grid
 * opts:    { tol (DP tolerance, cells), diagonal ([lo, hi] degrees that become an L), power (IDW falloff) }
 * Returns { roads, buildings, areas, lines, report }
 */
export function rectifyNetwork(roads, { buildings = [], areas = [], lines = [] } = {}, { tol = 1.5, diagonal = [30, 60], power = 3, minGap = 2 } = {}) {
    // ---- 2  simplify (junction vertices pinned)
    const use = new Map();
    for (const r of roads) for (const p of r.line) use.set(k(p), (use.get(k(p)) || 0) + 1);
    const simp = roads.map(r => {
        const pin = new Set(); r.line.forEach((p, i) => { if (use.get(k(p)) > 1) pin.add(i); });
        const pts = simplify(r.line, tol, pin);
        return { r, pts };
    });

    // ---- 3  snap: orientation per segment (diagonals → L), then shared coordinates by union-find
    const vert = new Map();   // key → { p (original), w, roads:Set }
    const V = (p, r) => { const key = k(p); let v = vert.get(key); if (!v) vert.set(key, v = { key, p: p.slice(), w: 0, roads: new Set() }); v.w += 1 + (r?.cls ?? 0); if (r) v.roads.add(r.id); return v; };
    const edges = [];
    for (const { r, pts } of simp) {
        const chain = [V(pts[0], r)];
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1];
            const ang = Math.abs(Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI);
            if (ang > diagonal[0] && ang < diagonal[1] && len(a, b) > 4) {
                // a true diagonal: go along the longer component first, turn once
                const corner = Math.abs(dx) >= Math.abs(dy) ? [b[0], a[1]] : [a[0], b[1]];
                chain.push(V(corner, r));
            }
            chain.push(V(b, r));
        }
        for (let i = 1; i < chain.length; i++) {
            const a = chain[i - 1], b = chain[i]; if (a === b) continue;
            const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
            edges.push({ a, b, road: r, axis: Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V', L: Math.hypot(dx, dy) });
        }
    }
    // horizontal edges tie y, vertical edges tie x — long, important edges first; an edge whose merge would collapse
    // two classes that are really apart (a short connector between parallel carriageways) is left to bend instead
    const ys = new DSU(), xs = new DSU();
    const order = edges.slice().sort((e, f) => (f.road.cls - e.road.cls) || (f.L - e.L));
    const members = { x: new Map(), y: new Map() };
    const spread = (d, axis, a, b) => {
        const ra = d.find(a.key), rb = d.find(b.key), M = members[axis];
        const ma = M.get(ra) || [a], mb = M.get(rb) || [b], i = axis === 'y' ? 1 : 0;
        const avg = ms => ms.reduce((s, v) => s + v.p[i] * v.w, 0) / ms.reduce((s, v) => s + v.w, 0);
        return { ra, rb, ma, mb, gap: Math.abs(avg(ma) - avg(mb)) };
    };
    for (const e of order) {
        const axis = e.axis === 'H' ? 'y' : 'x', d = axis === 'y' ? ys : xs, M = members[axis];
        const { ra, rb, ma, mb, gap } = spread(d, axis, e.a, e.b);
        if (ra === rb) continue;
        // tie only when the edge itself spans the offset (angle ≤ ~25°): offset ≤ 0.47 × its length
        // (a long segment always ties: a boulevard drifting a few degrees becomes one straight line, not a jogged one)
        if (e.L < 12 && gap > Math.max(1.5, 0.47 * e.L)) { e.bend = true; continue; }
        const root = d.union(ra, rb);
        M.set(root, [...ma, ...mb]); if (root !== ra) M.delete(ra); if (root !== rb) M.delete(rb);
    }
    const solved = new Map();
    for (const v of vert.values()) solved.set(v.key, [null, null]);
    for (const axis of ['x', 'y']) {
        const d = axis === 'y' ? ys : xs, i = axis === 'y' ? 1 : 0, groups = new Map();
        for (const v of vert.values()) { const r = d.find(v.key); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); }
        // least squares under "equal coordinate": the weighted mean of the members
        const lines = [...groups.values()].map(ms => ({ ms, c: ms.reduce((s, v) => s + v.p[i] * v.w, 0) / ms.reduce((s, v) => s + v.w, 0), lo: Math.min(...ms.map(v => v.p[i])), hi: Math.max(...ms.map(v => v.p[i])) }));
        // keep the real order and gap of parallel lines that overlap along the other axis
        const j = 1 - i;
        for (const g of lines) { g.span = [Math.min(...g.ms.map(v => v.p[j])), Math.max(...g.ms.map(v => v.p[j]))]; g.real = mean(g.ms, i); }
        const multi = lines.filter(g => g.ms.length >= 2);
        for (let pass = 0; pass < 4; pass++) for (const A of multi) for (const B of multi) {
            if (A === B) continue;
            const [a0, a1] = A.span, [b0, b1] = B.span; if (a1 < b0 || b1 < a0) continue;
            const real = B.real - A.real; if (Math.abs(real) < 1e-6) continue;
            const want = Math.sign(real) * Math.min(Math.abs(real), Math.max(minGap, Math.abs(real) * 0.5));
            const now = B.c - A.c;
            if (Math.sign(now) !== Math.sign(real) || Math.abs(now) < Math.abs(want)) { const fix = (want - now) / 2; A.c -= fix; B.c += fix; }
        }
        for (const g of lines) for (const v of g.ms) solved.get(v.key)[i] = g.c;
    }
    const at = v => solved.get(v.key);
    const outRoads = simp.map(({ r }) => ({ ...r, line: [] }));
    const byId = new Map(outRoads.map(r => [r.id, r]));
    // rebuild each road's line from its snapped chain (consecutive duplicate points dropped)
    for (const e of edges) {
        const r = byId.get(e.road.id), A = at(e.a), B = at(e.b);
        let pa = A, pb = B;
        if (e.bend) pb = e.axis === 'H' ? [B[0], A[1]] : [A[0], B[1]];   // an untied connector keeps its axis by ending square
        const last = r.line.at(-1);
        if (!last || last[0] !== pa[0] || last[1] !== pa[1]) r.line.push(pa.slice());
        if (e.bend && (pb[0] !== B[0] || pb[1] !== B[1])) r.line.push(pb.slice());
        r.line.push(B.slice());
    }
    for (const r of outRoads) r.line = r.line.filter((p, i, a) => !i || len(a[i - 1], p) > 1e-6);

    // ---- 4  rubber sheet: displacement samples along every original segment (linear between its snapped ends)
    const samples = [];
    for (const e of edges) {
        const A0 = e.a.p, B0 = e.b.p, A1 = at(e.a), B1 = at(e.b), n = Math.max(1, Math.ceil(e.L / 3));
        for (let t = 0; t <= n; t++) {
            const u = t / n;
            samples.push({ p: [A0[0] + (B0[0] - A0[0]) * u, A0[1] + (B0[1] - A0[1]) * u], d: [A1[0] - A0[0] + (B1[0] - A1[0] - B0[0] + A0[0]) * u, A1[1] - A0[1] + (B1[1] - A1[1] - B0[1] + A0[1]) * u] });
        }
    }
    const GRID = 8, bins = new Map();
    for (const s of samples) { const b = `${Math.floor(s.p[0] / GRID)},${Math.floor(s.p[1] / GRID)}`; if (!bins.has(b)) bins.set(b, []); bins.get(b).push(s); }
    const displace = p => {
        // nearest samples first (ring search), then IDW over everything within 3× the nearest distance
        let near = [], r = 0;
        const bx = Math.floor(p[0] / GRID), by = Math.floor(p[1] / GRID);
        while (r < 40 && near.length < 12) { near = []; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) near.push(...(bins.get(`${bx + dx},${by + dy}`) || [])); r += 2; }
        if (!near.length) return [0, 0];
        let W = 0, X = 0, Y = 0;
        for (const s of near) { const w = 1 / Math.pow(len(s.p, p) ** 2 + 1, power / 2); W += w; X += w * s.d[0]; Y += w * s.d[1]; }
        return [X / W, Y / W];
    };
    const move = ring => ring.map(p => { const d = displace(p); return [p[0] + d[0], p[1] + d[1]]; });

    // ---- 5  square each building to the grid, then push it off carriageways
    const outB = buildings.map(b => {
        const moved = move(b.ring), c = centroid(moved);
        const res = weightedGridAngle([{ pts: moved, closed: true }]);
        const cs = Math.cos(-res), sn = Math.sin(-res);
        const ring = moved.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs]; });
        return { ...b, ring: orthogonalizeRing(ring, { tol: 0.6 }), moved: len(c, centroid(b.ring)), turned: res };
    });
    const segs = outRoads.flatMap(r => r.line.slice(1).map((p, i) => ({ a: r.line[i], b: p, half: r.half + 1, road: r })));
    let pushed = 0;
    for (const b of outB) for (let it = 0; it < 4; it++) {
        // the deepest overlap of any outline vertex or edge midpoint with a carriageway (axis-aligned segments)
        let fix = null;
        const probe = b.ring.flatMap((p, i) => [p, [(p[0] + b.ring[(i + 1) % b.ring.length][0]) / 2, (p[1] + b.ring[(i + 1) % b.ring.length][1]) / 2]]);
        const c = centroid(b.ring);
        for (const s of segs) {
            const H = Math.abs(s.b[1] - s.a[1]) < 1e-6, lo = H ? Math.min(s.a[0], s.b[0]) : Math.min(s.a[1], s.b[1]), hi = H ? Math.max(s.a[0], s.b[0]) : Math.max(s.a[1], s.b[1]);
            for (const p of probe) {
                const along = H ? p[0] : p[1], off = H ? p[1] - s.a[1] : p[0] - s.a[0];
                if (along < lo || along > hi || Math.abs(off) >= s.half) continue;
                const side = Math.sign((H ? c[1] - s.a[1] : c[0] - s.a[0]) || 1), need = side * s.half - off;
                if (!fix || Math.abs(need) > Math.abs(fix.n)) fix = { n: need, H };
            }
        }
        if (!fix) break;
        b.ring = b.ring.map(([x, y]) => fix.H ? [x, y + fix.n] : [x + fix.n, y]); pushed++;
    }
    const outA = areas.map(a => ({ ...a, ring: orthogonalizeRing(move(a.ring), { tol: 1.5 }) }));
    const outL = lines.map(l => ({ ...l, line: move(l.line) }));
    const shifts = [...vert.values()].map(v => len(v.p, at(v)));
    return { roads: outRoads, buildings: outB, areas: outA, lines: outL, displace,
        report: { vertices: vert.size, edges: edges.length, bent: edges.filter(e => e.bend).length, maxShift: +Math.max(0, ...shifts).toFixed(2), meanShift: +(shifts.reduce((a, b) => a + b, 0) / Math.max(1, shifts.length)).toFixed(2),
            buildingsMoved: +(outB.reduce((a, b) => a + b.moved, 0) / Math.max(1, outB.length)).toFixed(2), buildingsTurnedDeg: +(outB.reduce((a, b) => Math.max(a, Math.abs(b.turned)), 0) * 180 / Math.PI).toFixed(2), pushedOffRoads: pushed } };
}
/**
 * Orthogonalise a closed ring: every edge horizontal or vertical. Simplify (DP), give each edge its nearest axis
 * (30–60° diagonals become an L), merge runs on one axis, then each edge's coordinate is the length-weighted mean of
 * its real endpoints and each vertex is where an H edge meets a V edge. Rings that collapse return the input.
 */
export function orthogonalizeRing(ring, { tol = 1, diagonal = [30, 60] } = {}) {
    let pts = ring.slice(); if (pts.length > 3 && len(pts[0], pts.at(-1)) < 1e-6) pts.pop();
    if (pts.length < 3) return ring;
    // simplify the closed ring as a path that starts at its farthest-from-centroid vertex
    const c = centroid(pts), s0 = pts.reduce((bi, p, i) => len(p, c) > len(pts[bi], c) ? i : bi, 0);
    const path = [...pts.slice(s0), ...pts.slice(0, s0), pts[s0]];
    const simp = simplify(path, tol); simp.pop();
    const edges = [];
    for (let i = 0; i < simp.length; i++) {
        const a = simp[i], b = simp[(i + 1) % simp.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
        if (L < 1e-6) continue;
        const ang = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
        if (ang > diagonal[0] && ang < diagonal[1] && L > 3) {
            const m = Math.abs(dx) >= Math.abs(dy) ? [b[0], a[1]] : [a[0], b[1]];
            edges.push({ axis: Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V', a, b: m, L: len(a, m) }, { axis: Math.abs(dx) >= Math.abs(dy) ? 'V' : 'H', a: m, b, L: len(m, b) });
        } else edges.push({ axis: Math.abs(dx) >= Math.abs(dy) ? 'H' : 'V', a, b, L });
    }
    // merge consecutive runs on the same axis (wrapping)
    const runs = [];
    for (const e of edges) { const r = runs.at(-1); if (r && r.axis === e.axis) { r.v += (e.axis === 'H' ? (e.a[1] + e.b[1]) / 2 : (e.a[0] + e.b[0]) / 2) * e.L; r.L += e.L; } else runs.push({ axis: e.axis, v: (e.axis === 'H' ? (e.a[1] + e.b[1]) / 2 : (e.a[0] + e.b[0]) / 2) * e.L, L: e.L }); }
    if (runs.length > 1 && runs[0].axis === runs.at(-1).axis) { const r = runs.pop(); runs[0].v += r.v; runs[0].L += r.L; }
    if (runs.length < 4 || runs.length % 2) return ring;
    for (const r of runs) r.c = r.v / (r.L || 1);
    const out = [];
    for (let i = 0; i < runs.length; i++) {
        const A = runs[i], B = runs[(i + 1) % runs.length];
        out.push(A.axis === 'H' ? [B.c, A.c] : [A.c, B.c]);
    }
    return Math.abs(polyArea(out)) < 0.25 * Math.abs(polyArea(pts)) ? ring : out;
}
/** An open polyline (a footpath) on the grid: simplified, then every segment within 25° of an axis is snapped straight
 *  and steeper ones become an L (longer leg first); consecutive collinear legs merge. */
export function orthogonalizeLine(line, { tol = 1.2 } = {}) {
    const pts = simplify(line, tol);
    if (pts.length < 2) return line;
    const out = [pts[0].slice()];
    for (let i = 1; i < pts.length; i++) {
        const a = out.at(-1), b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], ang = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
        if (ang <= 25) out.push([b[0], a[1]]);
        else if (ang >= 65) out.push([a[0], b[1]]);
        else if (Math.abs(dx) >= Math.abs(dy)) { out.push([b[0], a[1]]); out.push([b[0], b[1]]); }
        else { out.push([a[0], b[1]]); out.push([b[0], b[1]]); }
    }
    // merge collinear runs, drop zero-length legs
    const res = [out[0]];
    for (const p of out.slice(1)) {
        const q = res.at(-1); if (len(p, q) < 1e-6) continue;
        const r = res.at(-2);
        if (r && ((r[0] === q[0] && q[0] === p[0]) || (r[1] === q[1] && q[1] === p[1]))) res[res.length - 1] = p; else res.push(p);
    }
    return res;
}
const polyArea = r => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const mean = (ms, i) => ms.reduce((s, v) => s + v.p[i] * v.w, 0) / ms.reduce((s, v) => s + v.w, 0);
function centroid(r) { let a = 0, x = 0, y = 0; for (let i = 0; i < r.length; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length], f = x0 * y1 - x1 * y0; a += f; x += (x0 + x1) * f; y += (y0 + y1) * f; } return Math.abs(a) < 1e-9 ? [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length] : [x / (3 * a), y / (3 * a)]; }
