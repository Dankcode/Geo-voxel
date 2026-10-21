// Geo import — road paint from the real road graph (presentation only; the client's RoadMarkings draws the plan).
//
// The client's own planner infers carriageways from 3–6-cell straight asphalt runs (PLAN-12), which is right for the
// generated grid but misfires on real roads (9–14 cells wide, curved, diagonal drives, car-park aisles → zebras
// everywhere). A geo map knows its centrelines, lane counts and junctions, so it ships an explicit plan instead:
//
//   junctions   centreline crossings (and road ends that meet another road); no line paint inside their box
//   centre      two-way streets: dashed yellow (collectors) or double solid yellow (arterials, US practice)
//   lanes       dashed white separators between same-direction lanes
//   edges       solid white edge lines on tertiary and larger roads
//   mouths      at each junction mouth on a street: a continental crosswalk and a stop bar on the approach lanes
//   lots        car-park stall dividers as thin white lines (the voxel stripes become plain asphalt)
//
// Output: { quads: [{ c: [[x, y] ×4], z, color: 'white' | 'yellow' }] } in cell coordinates (x right, y south).
const W_LINE = 0.12, W_EDGE = 0.14, DASH = 3, GAP = 5, BAR = 0.45, BAR_GAP = 0.4, BAR_LEN = 2.2, STOP = 0.4;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const len = v => Math.hypot(v[0], v[1]), norm = v => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
const perp = v => [-v[1], v[0]];

function segIntersect(p, p2, q, q2) {
    const r = sub(p2, p), s = sub(q2, q), d = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(d) < 1e-9) return null;
    const qp = sub(q, p), t = (qp[0] * s[1] - qp[1] * s[0]) / d, u = (qp[0] * r[1] - qp[1] * r[0]) / d;
    return t >= -0.02 && t <= 1.02 && u >= -0.02 && u <= 1.02 ? add(p, mul(r, t)) : null;
}
function closestOn(line, p) {
    let best = null;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1], ab = sub(b, a), L2 = ab[0] ** 2 + ab[1] ** 2 || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2)), q = add(a, mul(ab, t)), d = len(sub(p, q));
        if (!best || d < best.d) best = { d, q, i, t };
    }
    return best;
}
/** Samples along a polyline every `step` cells: { p, dir, s } (s = arc length). */
function samples(line, step = 0.5) {
    const out = []; let s = 0;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1], v = sub(b, a), L = len(v); if (L < 1e-6) continue;
        const dir = mul(v, 1 / L);
        for (let t = 0; t < L; t += step) out.push({ p: add(a, mul(dir, t)), dir, s: s + t });
        s += L;
    }
    if (line.length) { const a = line[line.length - 2] || line[0], b = line[line.length - 1]; out.push({ p: b, dir: norm(sub(b, a)), s }); }
    return out;
}

/**
 * roads: [{ id, cls, half, lanes, oneway, line }] (cell coordinates); isRoadCell(x, y) → bool; zAt(x, y) → ground z;
 * lots: [{ cells: [[x, y]] }] optional; crossings: [[[x, y], [x, y]]] OSM crossing lines (cells) optional.
 */
export function planGeoRoadPaint(roads, { isRoadCell, zAt, crossings = [] } = {}) {
    const quads = [], streets = roads.filter(r => r.line?.length >= 2);
    const put = (a, b, off0, off1, color, dir) => {
        const n = perp(dir), c = [add(a, mul(n, off0)), add(b, mul(n, off0)), add(b, mul(n, off1)), add(a, mul(n, off1))];
        const m = mul(add(a, b), 0.5), mx = m[0] + n[0] * (off0 + off1) / 2, my = m[1] + n[1] * (off0 + off1) / 2;
        const cx = Math.floor(mx), cy = Math.floor(my);
        if (!isRoadCell(cx, cy)) return;
        quads.push({ c, z: zAt(cx, cy), color });
    };
    // ---- junctions
    const junctions = [];
    for (let i = 0; i < streets.length; i++) for (let j = i + 1; j < streets.length; j++) {
        const A = streets[i], B = streets[j];
        const pts = [];
        for (let a = 0; a + 1 < A.line.length; a++) for (let b = 0; b + 1 < B.line.length; b++) { const x = segIntersect(A.line[a], A.line[a + 1], B.line[b], B.line[b + 1]); if (x) pts.push(x); }
        for (const end of [A.line[0], A.line.at(-1)]) { const c = closestOn(B.line, end); if (c && c.d <= B.half + 1.5) pts.push(c.q); }
        for (const end of [B.line[0], B.line.at(-1)]) { const c = closestOn(A.line, end); if (c && c.d <= A.half + 1.5) pts.push(c.q); }
        for (const p of pts) {
            if (junctions.some(J => len(sub(J.p, p)) < 3 && J.roads.includes(A) && J.roads.includes(B))) continue;
            const near = junctions.find(J => len(sub(J.p, p)) < Math.max(A.half, B.half));
            if (near) { for (const r of [A, B]) if (!near.roads.includes(r)) near.roads.push(r); near.r = Math.max(near.r, A.half + 1, B.half + 1); continue; }
            junctions.push({ p, roads: [A, B], r: Math.max(A.half, B.half) + 1 });
        }
    }
    const inJunction = (p, pad = 0) => junctions.some(J => len(sub(J.p, p)) < J.r + pad);
    // ---- line paint
    for (const r of streets) {
        if (r.cls < 1) continue;
        const pts = samples(r.line, 0.5), twoWay = !r.oneway;
        const perDir = twoWay ? Math.max(1, Math.floor((r.lanes || 2) / 2)) : Math.max(1, r.lanes || 1);
        const laneW = twoWay ? r.half / perDir : (2 * r.half) / perDir;
        for (let k = 0; k + 1 < pts.length; k++) {
            const a = pts[k], b = pts[k + 1];
            if (inJunction(a.p, 0.5) || inJunction(b.p, 0.5)) continue;
            const dashOn = (a.s % (DASH + GAP)) < DASH;
            if (twoWay) {
                if (r.cls >= 3) { put(a.p, b.p, -0.22, -0.22 + W_LINE, 'yellow', a.dir); put(a.p, b.p, 0.1, 0.1 + W_LINE, 'yellow', a.dir); }
                else if (dashOn) put(a.p, b.p, -W_LINE / 2, W_LINE / 2, 'yellow', a.dir);
                if (dashOn) for (let l = 1; l < perDir; l++) for (const sgn of [-1, 1]) { const o = sgn * l * laneW; put(a.p, b.p, o - W_LINE / 2, o + W_LINE / 2, 'white', a.dir); }
            } else if (dashOn) for (let l = 1; l < perDir; l++) { const o = -r.half + l * laneW; put(a.p, b.p, o - W_LINE / 2, o + W_LINE / 2, 'white', a.dir); }
            if (r.cls >= 2) for (const sgn of [-1, 1]) { const o = sgn * (r.half - 0.45); put(a.p, b.p, Math.min(o, o + sgn * W_EDGE), Math.max(o, o + sgn * W_EDGE), 'white', a.dir); }
        }
    }
    // ---- junction mouths: continental crosswalk + stop bar (streets only; drives meet the street with a stop bar)
    const osmNear = p => crossings.some(([a, b]) => { const c = closestOn([a, b], p); return c && c.d < 4; });
    const walks = [];
    for (const J of junctions) for (const r of J.roads) {
        const pts = samples(r.line, 0.25); if (!pts.length) continue;
        const at = pts.reduce((best, q) => len(sub(q.p, J.p)) < len(sub(best.p, J.p)) ? q : best, pts[0]);
        const street = r.cls >= 1 && J.roads.some(o => o !== r && o.cls >= 1);
        for (const sgn of [-1, 1]) {
            const s0 = at.s + sgn * J.r, mouth = pts.find(q => Math.abs(q.s - s0) < 0.26);
            if (!mouth || junctions.some(K => K !== J && len(sub(K.p, mouth.p)) < K.r)) continue;
            if (!isRoadCell(Math.floor(mouth.p[0]), Math.floor(mouth.p[1]))) continue;
            const dirOut = mul(mouth.dir, sgn);             // from the junction outward along this arm
            // one crosswalk per crossing: none within 6 cells of one already painted (divided roads and slip lanes put
            // several junction mouths side by side), none across a slip lane
            const zebra = street && !r.link && !osmNear(mouth.p) && !walks.some(w => len(sub(w, mouth.p)) < 6 + r.half);
            if (zebra) walks.push(mouth.p);
            if (zebra) for (let o = -r.half + 0.3; o + BAR <= r.half - 0.3; o += BAR + BAR_GAP)
                put(add(mouth.p, mul(dirOut, 0.3)), add(mouth.p, mul(dirOut, 0.3 + BAR_LEN)), o, o + BAR, 'white', dirOut);
            // Stop bar on the lanes that drive INTO the junction. Travel = −dirOut; with y pointing south, the
            // right-hand side of travel is perp(−dirOut) = −perp(dirOut), i.e. negative offsets in this frame.
            const flowsIn = !r.oneway ? true : (r.oneway === -1 ? sgn > 0 : sgn < 0);
            if (!flowsIn) continue;
            const span = r.oneway ? [-r.half + 0.3, r.half - 0.3] : [-r.half + 0.3, -0.2];
            const sb = add(mouth.p, mul(dirOut, street ? 0.3 + BAR_LEN + 0.6 : 0.4));
            put(sb, add(sb, mul(dirOut, STOP)), span[0], span[1], 'white', dirOut);
        }
    }
    // ---- OSM-mapped crossings: zebra bars along the crossing line
    for (const [p0, p1] of crossings) {
        const dir = norm(sub(p1, p0)), L = len(sub(p1, p0));
        for (let t = 0.2; t + BAR <= L; t += BAR + BAR_GAP) {
            const a = add(p0, mul(dir, t)), b = add(p0, mul(dir, t + BAR));
            put(a, b, -BAR_LEN / 2, BAR_LEN / 2, 'white', dir);
        }
    }
    return { quads, junctions: junctions.map(J => ({ x: +J.p[0].toFixed(2), y: +J.p[1].toFixed(2), r: +J.r.toFixed(2), roads: J.roads.map(r => r.id) })) };
}

/**
 * Car-park stripes: every `road_mark` voxel on lot ground becomes asphalt again and each straight run of them a thin
 * white line along its centre. Returns the quads (mutates the store).
 */
export function lotStripesToPaint(store, cells, MAT, zAt = (x, y) => store.topSolid(x, y)) {
    const set = new Set(cells.map(([x, y]) => `${x},${y}`)), mark = (x, y) => set.has(`${x},${y}`) && store.get(x, y, zAt(x, y)) === MAT.road_mark;
    const quads = [], seen = new Set();
    for (const [x, y] of cells) {
        if (!mark(x, y) || seen.has(`${x},${y}`)) continue;
        const alongX = mark(x + 1, y) || mark(x - 1, y);
        let x0 = x, y0 = y; while (alongX ? mark(x0 - 1, y0) : mark(x0, y0 - 1)) alongX ? x0-- : y0--;
        let x1 = x0, y1 = y0; while (alongX ? mark(x1 + 1, y1) : mark(x1, y1 + 1)) alongX ? x1++ : y1++;
        const z = zAt(x0, y0);
        for (let cx = x0, cy = y0; ; alongX ? cx++ : cy++) { seen.add(`${cx},${cy}`); store.set(cx, cy, zAt(cx, cy), MAT.asphalt); if (cx === x1 && cy === y1) break; }
        const c = alongX ? [[x0 + 0.1, y0 + 0.5 - W_LINE / 2], [x1 + 0.9, y0 + 0.5 - W_LINE / 2], [x1 + 0.9, y0 + 0.5 + W_LINE / 2], [x0 + 0.1, y0 + 0.5 + W_LINE / 2]]
            : [[x0 + 0.5 - W_LINE / 2, y0 + 0.1], [x0 + 0.5 + W_LINE / 2, y0 + 0.1], [x0 + 0.5 + W_LINE / 2, y1 + 0.9], [x0 + 0.5 - W_LINE / 2, y1 + 0.9]];
        quads.push({ c, z, color: 'white' });
    }
    return quads;
}
