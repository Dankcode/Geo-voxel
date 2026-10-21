// PLAN-06 §5.2–5.4 — blocks, parcel partition, the mix WFC and the gap strips.
//
//   1. blocks     maximal rectangles of free land on a 2-cell bay grid, one level each (roads, sidewalks, channels,
//                 retaining walls and existing buildings bound them)
//   2. partition  frontage-aware split of each block into parcel leaves sized for the mixes (depth first, then width)
//   3. WFC        each leaf takes a mix: hard fit (size, frontage, elevation option), no identical neighbours unless
//                 repeatable, zoning (no warehouse yard beside a house plot), landmark and cap counts, the building
//                 limit, and the hold-zone host pinned first when the objective is `hold`
//   4. layout     every parcel builds first (door approaches reserved), then every parcel dresses
//   5. strips     leftover land becomes alleys, verges, boundary paths, greens or world-edge strips
import { solveWaveFunctionCollapse, hashWaveSeed } from '../../generation/WaveFunctionCollapse.js';
import { fbm } from '../Fields.js';
import { MAT } from '../../voxel/Materials.js';
import { createRng, hashString } from '../../util/Rng.js';
import { frame, tag, tagAt, tagRect, groundAt, inMap, k2, put, registerSolids, SIDES, OPP } from './Core.js';
import { MIXES, MIX_IDS, mixWeight, mixFits } from './MixCatalogue.js';
import { paint, run, plantTree, canStand, addStall } from './Props.js';
import { fortifyHoldZone } from './HoldZone.js';

const ROADSIDE = new Set(['sidewalk', 'kerb', 'road', 'driveway']);
const ZONING = new Set(['warehouse-yard|house-plot', 'warehouse-yard|townhouse-row', 'warehouse-yard|playground', 'self-storage|house-plot']);
const zoned = (a, b) => ZONING.has(`${a}|${b}`) || ZONING.has(`${b}|${a}`);
const ZERO_BUILDING = MIX_IDS.filter(id => !MIXES[id].buildings);

/** 1. Blocks: maximal rectangles of available bays (2 × 2 cells, one level). */
export function extractBlocks(m, avail, { minCells = 8 } = {}) {
    const d = m.district, BW = d.W >> 1, BD = d.D >> 1;
    const bay = new Int16Array(BW * BD).fill(-1);
    for (let by = 0; by < BD; by++) for (let bx = 0; bx < BW; bx++) {
        let z = null, ok = true;
        for (let dy = 0; dy < 2 && ok; dy++) for (let dx = 0; dx < 2; dx++) {
            const x = bx * 2 + dx, y = by * 2 + dy;
            if (!avail(x, y)) { ok = false; break; }
            const g = groundAt(m, x, y); if (z === null) z = g; else if (g !== z) { ok = false; break; }
        }
        if (ok) bay[bx + by * BW] = z;
    }
    const used = new Uint8Array(BW * BD), blocks = [];
    for (let guard = 0; guard < 200; guard++) {
        const best = largestRect(bay, used, BW, BD, Math.ceil(minCells / 2));
        if (!best) break;
        for (let y = best.by; y < best.by + best.bd; y++) for (let x = best.bx; x < best.bx + best.bw; x++) used[x + y * BW] = 1;
        blocks.push({ id: `block-${blocks.length}`, x0: best.bx * 2, y0: best.by * 2, w: best.bw * 2, d: best.bd * 2, z: best.z });
    }
    return blocks;
}
function largestRect(bay, used, BW, BD, minB = 1) {
    let best = null;
    const levels = [...new Set(bay)].filter(z => z >= 0);
    for (const z of levels) {
        const h = new Int32Array(BW);
        for (let y = 0; y < BD; y++) {
            for (let x = 0; x < BW; x++) h[x] = bay[x + y * BW] === z && !used[x + y * BW] ? h[x] + 1 : 0;
            const stack = [];
            for (let x = 0; x <= BW; x++) {
                const cur = x === BW ? 0 : h[x];
                let start = x;
                while (stack.length && stack.at(-1)[1] >= cur) {
                    const [sx, sh] = stack.pop();
                    const area = sh * (x - sx), bw = x - sx, bd = sh;
                    // Prefer area, then squarer rectangles (they make better parcels).
                    const score = area - Math.abs(bw - bd) * 0.01;
                    if (bw >= minB && bd >= minB && (!best || score > best.score)) best = { bx: sx, by: y - sh + 1, bw, bd, z, area, score };
                    start = sx;
                }
                stack.push([start, cur]);
            }
        }
    }
    return best;
}

/** Which side of a rectangle faces a road (sidewalk/kerb just outside it), and how much of the edge does. */
export function frontageOf(m, r) {
    let best = null;
    for (const side of ['s', 'n', 'e', 'w']) {
        const [dx, dy] = SIDES[side], cells = [];
        if (side === 'n' || side === 's') { const y = side === 'n' ? r.y0 - 1 : r.y0 + r.d; for (let x = r.x0; x < r.x0 + r.w; x++) cells.push([x, y]); }
        else { const x = side === 'w' ? r.x0 - 1 : r.x0 + r.w; for (let y = r.y0; y < r.y0 + r.d; y++) cells.push([x, y]); }
        let hit = 0, weight = 0;
        for (const [x, y] of cells) { for (let k = 0; k < 3; k++) if (ROADSIDE.has(tagAt(m, x + dx * k, y + dy * k))) { hit++; const kind = m.district.roadKind?.get(k2(x + dx * k, y + dy * k)); weight += kind === 'service' ? 0.55 : kind === 'cross' ? 0.9 : 1; break; } }
        const ratio = hit / cells.length, score = weight / cells.length;
        if (ratio >= 0.5 && (!best || best.ratio < 0.5 || score > best.score)) { best = { side, ratio, score }; continue; }
        if (!best || (best.ratio < 0.5 && ratio > best.ratio)) best = { side, ratio, score };
    }
    return best && best.ratio >= 0.5 ? best.side : null;
}

/** 2. Partition a block into parcel leaves. */
export function partitionBlock(m, block, { seed, family, elevated, rng, bias = {} }) {
    const wt = id => mixWeight(id, family) * (bias[id] ?? 1);
    const leaves = [], scraps = [];
    const allowed = MIX_IDS.filter(id => wt(id) > 0 && (MIXES[id].requires !== 'elevated' || elevated));
    const front = frontageOf(m, block);
    const visit = (r, depth) => {
        const fs = frontageOf(m, r), frontage = !!fs, side = fs || front || 's';
        const F = frame({ ...r, front: side });
        const pool = allowed.filter(id => !MIXES[id].frontage || frontage);
        if (!pool.length || F.U < 8 || F.V < 8) { scraps.push(r); return; }
        const maxV = Math.max(...pool.filter(id => MIXES[id].frontage === frontage || !frontage).map(id => MIXES[id].V[1]));
        // Depth: too deep for any frontage mix → keep a front strip, the rest becomes an interior (or opposite-road) leaf.
        if (F.V > maxV && depth < 6) {
            const n = fbm(`${seed}:depth`, r.x0, r.y0, { frequency: 1 / 9 });
            const lo = Math.min(...pool.map(id => MIXES[id].V[0])), vf = Math.max(lo, Math.min(maxV, Math.round((lo + (maxV - lo) * n) / 2) * 2));
            if (F.V - vf >= 10) { visit(F.rect(0, 0, F.U, vf), depth + 1); visit(F.rect(0, vf, F.U, F.V - vf), depth + 1); return; }
        }
        // Width: carve leaves along the frontage, sized for a noise-picked mix that fits this depth.
        const fitAll = pool.filter(id => F.V >= MIXES[id].V[0] && F.V <= MIXES[id].V[1]);
        const fitFront = fitAll.filter(id => MIXES[id].frontage);
        const fitV = frontage && fitFront.length ? fitFront : fitAll;
        if (!fitV.length) {
            // Nothing fits this depth exactly: try the shallower fitting depth at the front, scrap the rest.
            const shallow = pool.filter(id => MIXES[id].V[0] <= F.V).sort((a, b) => MIXES[b].V[1] - MIXES[a].V[1])[0];
            if (shallow && depth < 6) { const vf = Math.min(F.V, MIXES[shallow].V[1]); if (vf < F.V) { visit(F.rect(0, 0, F.U, vf), depth + 1); scraps.push(F.rect(0, vf, F.U, F.V - vf)); return; } }
            scraps.push(r); return;
        }
        let u = 0;
        while (u < F.U) {
            const rest = F.U - u;
            const fit = fitV.filter(id => MIXES[id].U[0] <= rest);
            if (!fit.length) { if (rest >= 2) scraps.push(F.rect(u, 0, rest, F.V)); break; }
            const pick = weightedPick(fit, id => wt(id) * (MIXES[id].buildings ? 1.5 : 1) * (MIXES[id].narrowBonus && Math.min(rest, F.V) < 18 ? MIXES[id].narrowBonus : 1) * (frontage && !MIXES[id].frontage ? 0.15 : 1) * (0.4 + fbm(`${seed}:mix:${id}`, r.x0 + u, r.y0, { frequency: 1 / 11 })), rng);
            const [lo, hi] = MIXES[pick].U;
            const t = rng.next(); let w = Math.min(hi, rest, lo + Math.round((Math.min(hi, rest) - lo) * t * t * 0.6 / 2) * 2);
            const after = rest - w;
            const minNext = Math.min(...fitV.map(id => MIXES[id].U[0]));
            if (after > 0 && after < minNext) { if (w + after <= hi) w += after; else if (after < 4) w = Math.min(hi, w + after); }
            leaves.push({ id: `p${leaves.length}`, rect: F.rect(u, 0, w, F.V), front: side, frontage, z: block.z, hint: pick, block: block.id });
            u += w;
        }
    };
    visit(block, 0);
    return { leaves, scraps };
}
function weightedPick(list, weight, rng) {
    const ws = list.map(weight), total = ws.reduce((a, b) => a + b, 0);
    let t = rng.next() * total;
    for (let i = 0; i < list.length; i++) { t -= ws[i]; if (t <= 0) return list[i]; }
    return list.at(-1);
}

const touches = (a, b) => {
    const ax1 = a.x0 + a.w, ay1 = a.y0 + a.d, bx1 = b.x0 + b.w, by1 = b.y0 + b.d;
    const ox = Math.min(ax1, bx1) - Math.max(a.x0, b.x0), oy = Math.min(ay1, by1) - Math.max(a.y0, b.y0);
    return (ox >= 2 && (ay1 === b.y0 || by1 === a.y0)) || (oy >= 2 && (ax1 === b.x0 || bx1 === a.x0));
};

/** 3. Assign a mix to every leaf. */
export function assignMixes(m, leaves, { seed, family, elevated, buildingCap = Infinity, hold = null, spawn = null, bias = {} }) {
    const wt = id => mixWeight(id, family) * (bias[id] ?? 1);
    const sizeOf = l => { const F = frame({ ...l.rect, front: l.front }); return { U: F.U, V: F.V, frontage: l.frontage }; };
    const domains = new Map();
    for (const l of leaves) domains.set(l.id, MIX_IDS.filter(id => wt(id) > 0 && mixFits(id, sizeOf(l), { elevated })));
    const usable = leaves.filter(l => domains.get(l.id).length);
    // Hold zone: pin the host first, as far from the insertion as the map allows.
    let host = null;
    if (hold) {
        const order = ['office-plaza', 'strip-mall', 'warehouse-yard', 'supermarket'];
        const cands = usable.filter(l => domains.get(l.id).some(id => MIXES[id].holdHost)).map(l => ({ l, d: spawn ? Math.hypot(l.rect.x0 + l.rect.w / 2 - spawn.x, l.rect.y0 + l.rect.d / 2 - spawn.y) : 0 })).sort((a, b) => b.d - a.d);
        if (cands.length) { host = cands[0].l; const id = order.find(o => domains.get(host.id).includes(o)); domains.set(host.id, [id]); }
    }
    const nodes = usable.map(l => ({ id: l.id, neighbors: usable.filter(o => o !== l && touches(l.rect, o.rect)).map(o => ({ id: o.id, direction: 'adjacent' })) }));
    const weightOf = (node, tile) => {
        const l = leaves.find(x => x.id === node), base = wt(tile);
        const noise = (hashWaveSeed(`${seed}:${node}:${tile}`) % 1000) / 1000;
        const sz = sizeOf(l), narrow = Math.min(sz.U, sz.V) < 18 && MIXES[tile].narrowBonus ? MIXES[tile].narrowBonus : 1;
        return base * narrow * (0.35 + noise) * (l.hint === tile ? 2.5 : 1) * (l.frontage && !MIXES[tile].frontage ? 0.15 : 1);
    };
    const solve = (strict) => solveWaveFunctionCollapse({ nodes, tiles: MIX_IDS.map(id => ({ id })), seed: `mix:${seed}`, domains: new Map([...domains].filter(([k]) => nodes.some(n => n.id === k))),
        compatible: (a, b) => (a !== b || !!MIXES[a].repeat) && (!strict || !zoned(a, b)), nodeWeights: weightOf });
    let assignment = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        try { assignment = solve(attempt < 4); } catch { assignment = null; }
        if (!assignment) { // Relax: drop the no-identical rule for the most constrained node.
            const tight = [...domains].filter(([k, v]) => v.length === 1 && k !== host?.id)[0]; if (tight) domains.set(tight[0], MIX_IDS.filter(id => mixFits(id, sizeOf(leaves.find(l => l.id === tight[0])), { elevated }))); continue;
        }
        // Count constraints: one landmark, per-mix caps, the building limit.
        const counts = new Map(); let fixed = false;
        for (const [k, v] of assignment) counts.set(v, (counts.get(v) || 0) + 1);
        const landmarks = [...assignment].filter(([, v]) => MIXES[v].landmark);
        if (landmarks.length > 1) { const [k, v] = landmarks.at(-1); domains.set(k, domains.get(k).filter(id => !MIXES[id].landmark)); fixed = true; }
        for (const [id, n] of counts) if (MIXES[id].cap && n > MIXES[id].cap) { const k = [...assignment].filter(([, v]) => v === id).at(-1)[0]; domains.set(k, domains.get(k).filter(x => x !== id)); fixed = true; }
        if (fixed) { for (const [k, v] of domains) if (!v.length) domains.delete(k); nodes.splice(0, nodes.length, ...nodes.filter(n => domains.has(n.id))); for (const n of nodes) n.neighbors = n.neighbors.filter(x => domains.has(x.id)); continue; }
        break;
    }
    assignment ||= new Map(usable.map(l => [l.id, domains.get(l.id)[0]]));
    // Building limit: trade building parcels for open ones, farthest from the action first.
    let total = [...assignment.values()].reduce((s, id) => s + (MIXES[id].buildings || 0), 0);
    if (total > buildingCap) {
        const order = [...assignment].sort((a, b) => (MIXES[b[1]].buildings || 0) - (MIXES[a[1]].buildings || 0));
        for (const [k, id] of order) {
            if (total <= buildingCap || k === host?.id) continue;
            const l = leaves.find(x => x.id === k), alt = ZERO_BUILDING.find(z => mixFits(z, { ...sizeOf(l), frontage: false }, { elevated }));
            total -= MIXES[id].buildings || 0;
            if (alt) assignment.set(k, alt); else assignment.set(k, 'open-green');
        }
    }
    // Building floor: a district needs rooms to fight through (and enemy groups need a building to hold). If the
    // solve left fewer than four buildings, the largest open parcels take the best-weighted building mix they fit.
    const floor = Math.min(buildingCap, 4);
    if (total < floor) {
        const open = [...assignment].filter(([k, id]) => !(MIXES[id]?.buildings) && k !== host?.id).map(([k]) => leaves.find(x => x.id === k)).filter(Boolean).sort((a, b) => b.rect.w * b.rect.d - a.rect.w * a.rect.d);
        for (const l of open) {
            if (total >= floor) break;
            const alt = (domains.get(l.id) || []).filter(id => MIXES[id].buildings > 0).sort((a, b) => wt(b) - wt(a))[0];
            if (alt) { assignment.set(l.id, alt); total += MIXES[alt].buildings; }
        }
    }
    return { assignment, host: host?.id || null };
}

/** Generalised shell merge (x- or y-adjacent shells): a 3-wide passage through the shared walls. */
export function mergeShells(m, a, b) {
    if (a.baseZ !== b.baseZ) return null;
    const xAdj = a.x0 + a.w === b.x0 || b.x0 + b.w === a.x0, yAdj = a.y0 + a.d === b.y0 || b.y0 + b.d === a.y0;
    if (!xAdj && !yAdj) return null;
    const [L, Rr] = xAdj ? (a.x0 < b.x0 ? [a, b] : [b, a]) : (a.y0 < b.y0 ? [a, b] : [b, a]);
    const z = a.baseZ, cells = [];
    // Never cut through a stair run, its landings or the cells beside them.
    const stairCells = new Set([L, Rr].flatMap(b => (b.stairs || []).flatMap(st => [...st.cells, st.before, st.after].filter(Boolean).flatMap(c => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => `${c.x + dx},${c.y + dy}`)))));
    // Closed rooms (restrooms, plant rooms) stay closed: the passage never cuts into them.
    for (const b of [L, Rr]) for (const r of b.rooms || []) if (r.gameplay === false && r.storey === 0) for (const [x, y] of r.cells) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) stairCells.add(`${x + dx},${y + dy}`);
    const clear = (xs, ys) => xs.every(x => ys.every(y => !stairCells.has(`${x},${y}`)));
    const pick = (lo, hi, test) => { const mid = lo + Math.floor((hi - lo) / 2) - 1; for (let o = 0; o <= hi - lo; o++) for (const c of [mid - o, mid + o]) if (c >= lo + 1 && c + 2 <= hi - 2 && test(c)) return c; return null; };
    if (xAdj) {
        const lo = Math.max(L.y0, Rr.y0), hi = Math.min(L.y0 + L.d, Rr.y0 + Rr.d); if (hi - lo < 6) return null;
        const y = pick(lo, hi, c => clear([Rr.x0 - 2, Rr.x0 - 1, Rr.x0, Rr.x0 + 1], [c, c + 1, c + 2])); if (y == null) return null;
        for (let x = Rr.x0 - 2; x <= Rr.x0 + 1; x++) for (let dy = 0; dy < 3; dy++) { m.store.set(x, y + dy, z, MAT.ceramic); for (let h = 1; h <= 2; h++) { m.store.set(x, y + dy, z + h, 0); delete m.hints[`${x},${y + dy},${z + h}`]; } m.reserve(x, y + dy, x, y + dy); if (dy === 1) cells.push({ x, y: y + dy, z }); }
    } else {
        const lo = Math.max(L.x0, Rr.x0), hi = Math.min(L.x0 + L.w, Rr.x0 + Rr.w); if (hi - lo < 6) return null;
        const x = pick(lo, hi, c => clear([c, c + 1, c + 2], [Rr.y0 - 2, Rr.y0 - 1, Rr.y0, Rr.y0 + 1])); if (x == null) return null;
        for (let y = Rr.y0 - 2; y <= Rr.y0 + 1; y++) for (let dx = 0; dx < 3; dx++) { m.store.set(x + dx, y, z, MAT.ceramic); for (let h = 1; h <= 2; h++) { m.store.set(x + dx, y, z + h, 0); delete m.hints[`${x + dx},${y},${z + h}`]; } m.reserve(x + dx, y, x + dx, y); if (dx === 1) cells.push({ x: x + dx, y, z }); }
    }
    // Exits that now open into the neighbour keep their landings clear.
    const inUnion = (x, y) => [L, Rr].some(s => x >= s.x0 && x < s.x0 + s.w && y >= s.y0 && y < s.y0 + s.d);
    // An exit whose landing is a protected stair or closed room cannot open: it is walled up and dropped.
    for (const s of [L, Rr]) {
        const keep = [];
        for (const e of s.exits || []) {
            const [dx, dy] = SIDES[e.side];
            const landing = [1, 2].map(i => [e.x + dx * i, e.y + dy * i]).filter(([x, y]) => inUnion(x, y));
            if (e.storey == null && landing.length && stairCells.has(`${landing[0][0]},${landing[0][1]}`)) {
                for (let h = 1; h <= 2; h++) { m.store.set(e.x, e.y, z + h, MAT[s.wall] ?? MAT.brick); delete m.hints[`${e.x},${e.y},${z + h}`]; }
                continue;
            }
            for (const [x, y] of landing) if (!stairCells.has(`${x},${y}`)) for (let h = 1; h <= 2; h++) { m.store.set(x, y, z + h, 0); delete m.hints[`${x},${y},${z + h}`]; }
            keep.push(e);
        }
        if (s.exits) s.exits.splice(0, s.exits.length, ...keep);
    }
    (a.mergedWith ||= []).push(b.id); (b.mergedWith ||= []).push(a.id);
    return { id: `${a.id}-${b.id}`, template: 'merged-retail-passage', cells, sockets: [cells[0], cells.at(-1)] };
}

const WALLS = { warehouse: 'siding', garage: 'siding', office: 'concrete_wall', station: 'concrete_wall' };
/** 4. Lay out every leaf: build pass, dress pass, default fill. */
export function layoutLeaves(m, leaves, assignment, { seed, family, remix, hostId = null, buildingCap = Infinity, glaze = null }) {
    const d = m.district, rng = createRng(hashString(`layout:${m.id}:${seed}`)), assignments = [], connectors = [];
    let built = 0;
    const tall = [];
    const ctxs = [];
    for (const l of leaves) {
        const id = assignment.get(l.id); if (!id) continue;
        const R = { ...l.rect, front: l.front }, F = frame(R);
        const ctx = {
            m, R, F, z: l.z, seed, family, remix, frontage: l.frontage, hold: l.id === hostId, rng: createRng(hashString(`${m.id}:${seed}:${l.id}:${id}`)),
            id: l.id, mix: id, origin: `mix:${id}/${l.id}`,
            siblings: [],
            build(local, spec) {
                if (built >= buildingCap) return null;
                const r = F.rect(local.u0, local.v0, local.uw, local.vd), bz = spec.baseZ ?? l.z;
                // Shells in a row may stand on their siblings' side-door approaches: the merge opens those doors into them.
                const sibling = new Set(spec.joinSiblings ? ctx.siblings.flatMap(b => b.approach.map(([x, y]) => k2(x, y))) : []);
                for (let y = r.y0 - 1; y <= r.y0 + r.d; y++) for (let x = r.x0 - 1; x <= r.x0 + r.w; x++) {
                    const inside = x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d;
                    if (!inMap(m, x, y) || !d.contains(x, y)) { if (inside) return null; continue; }
                    const t = tagAt(m, x, y);
                    if (t === 'road' || t === 'kerb') return null;
                    if (inside && (t === 'building' || t === 'channel' || (t === 'level' && spec.baseZ == null) || (m.keep.has(k2(x, y)) && !sibling.has(k2(x, y))))) return null;
                }
                let storeys = Array.isArray(spec.storeys) ? spec.storeys[0] + Math.floor(ctx.rng.next() * (spec.storeys[1] - spec.storeys[0] + 1)) : spec.storeys || 1;
                if (spec.program !== 'townhouse') storeys = Math.max(remix.minStoreys, Math.min(remix.maxStoreys, storeys));
                else storeys = Math.min(Math.max(2, remix.minStoreys), Math.max(remix.maxStoreys, 2));
                const cx = r.x0 + r.w / 2, cy = r.y0 + r.d / 2;
                if (remix.maxStoreys > remix.minStoreys && storeys === remix.maxStoreys && tall.some(t => Math.hypot(t[0] - cx, t[1] - cy) < 22)) storeys = Math.max(remix.minStoreys, storeys - 1);
                const wall = remix.wall !== 'mixed' ? remix.wall : spec.wall || WALLS[spec.program] || ['brick', 'stucco', 'brick', 'siding'][ctx.rng.int(0, 3)];
                const b = m.building({ id: `${l.id}-${spec.part}`, program: spec.program, x0: r.x0, y0: r.y0, w: r.w, d: r.d, baseZ: bz, storeys, front: spec.front || F.front, wall,
                    // Era → edges (BuildingEra.js): modern rounded, old straight. The remix can force one for every building.
                    rounded: remix.corners !== 'mixed' ? remix.corners === 'rounded' : spec.rounded ?? ctx.rng.next() > 0.45,
                    ...(remix.corners === 'mixed' && spec.era ? { era: spec.era } : {}),
                    furnish: spec.furnish === false ? false : remix.furnish, ...(spec.foundation === false ? { foundation: false } : {}), ...(glaze ? { glaze } : {}) });
                built++; ctx.siblings.push(b);
                if (storeys === remix.maxStoreys) tall.push([cx, cy]);
                tagRect(m, r, 'building', { force: true });
                // Fire escapes and other access modules the builder hangs outside the shell belong to the building.
                registerSolids(m, { x0: r.x0 - 3, y0: r.y0 - 3, w: r.w + 6, d: r.d + 6 }, `building:${b.id}/access`);
                assignments.push({ id: b.id, program: b.program, storeys: b.storeys, mix: id, parcel: l.id });
                return b;
            },
            merge(a, b) { const c = mergeShells(m, a, b); if (c) connectors.push(c); return c; },
            connector(c) { connectors.push(c); },
            furniture(piece, [x, y], axis, key, h = 1) {
                const cells = [[x, y], axis === 'x' ? [x + 1, y] : [x, y + 1]];
                if (!cells.every(([cx, cy]) => canStand(m, cx, cy))) return false;
                const out = [];
                for (const [cx, cy] of cells) for (let k = 1; k <= h; k++) { put(m, cx, cy, groundAt(m, cx, cy) + k, key, `${ctx.origin}/${piece}`); out.push([cx, cy, groundAt(m, cx, cy) + k]); }
                m.object(piece, out, { axis, dir: 1, size: [2, 1] });
                return true;
            },
            holdZone(r, kind) { const z = { x0: r.x0, y0: r.y0, x1: r.x0 + r.w - 1, y1: r.y0 + r.d - 1, z: l.z, host: l.id, kind, mix: id }; d.zones.push(z); fortifyHoldZone(m, z, ctx.origin); return z; }
        };
        ctxs.push({ ctx, l, id });
        d.parcels.push({ id: l.id, mix: id, rect: l.rect, front: l.front, frontage: l.frontage, z: l.z });
    }
    // Pass 1: buildings everywhere first, so every door approach is reserved before any fence goes up.
    for (const c of ctxs) c.state = MIXES[c.id]?.plan ? MIXES[c.id].plan(c.ctx) : {};
    // Pass 2: dressing.
    for (const c of ctxs) {
        if (MIXES[c.id]) MIXES[c.id].dress(c.ctx, c.state || {});
        else openGreen(m, c.ctx);
        const [fillTag, fillKey] = MIXES[c.id]?.fill || ['green', 'lawn'];
        paint(m, c.l.rect, fillKey, fillTag, { z: c.l.z, only: (x, y) => tagAt(m, x, y) === 'plain' });
    }
    return { assignments, connectors };
}

/** Fallback for a parcel no mix may take (building limit reached on a large leaf): a planted green with a path. */
function openGreen(m, ctx) {
    const { F } = ctx;
    paint(m, ctx.R, 'lawn', 'green', { z: ctx.z });
    paint(m, F.rect(0, Math.floor(F.V / 2) - 1, F.U, 2), 'gravel', 'path', { z: ctx.z });
    for (let u = 3; u < F.U - 2; u += 7) for (let v = 3; v < F.V - 2; v += 7) plantTree(m, ...F.at(u, v), `${ctx.origin}/tree`);
}

/** 5. Strips: classify the remaining land and give it a purpose. */
export function dressStrips(m, avail, { seed }) {
    const d = m.district, seen = new Set(), strips = [];
    for (let y = 0; y < d.D; y++) for (let x = 0; x < d.W; x++) {
        if (seen.has(k2(x, y)) || tagAt(m, x, y) !== 'plain' || !avail(x, y)) continue;
        const comp = [], q = [[x, y]]; seen.add(k2(x, y));
        while (q.length) { const [cx, cy] = q.pop(); comp.push([cx, cy]); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy, k = k2(nx, ny); if (!seen.has(k) && inMap(m, nx, ny) && tagAt(m, nx, ny) === 'plain' && avail(nx, ny) && groundAt(m, nx, ny) === groundAt(m, cx, cy)) { seen.add(k); q.push([nx, ny]); } } }
        const xs = comp.map(c => c[0]), ys = comp.map(c => c[1]);
        const box = { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, d: Math.max(...ys) - Math.min(...ys) + 1 };
        // Thickness: twice the deepest distance from the strip's edge (an L-shaped strip is as thick as its arms).
        const inComp = new Set(comp.map(c => k2(...c))), dist = new Map(), bq = [];
        for (const [cx, cy] of comp) if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inComp.has(k2(cx + dx, cy + dy)))) { dist.set(k2(cx, cy), 0); bq.push([cx, cy]); }
        for (let i = 0; i < bq.length; i++) { const [cx, cy] = bq[i], v = dist.get(k2(cx, cy)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = k2(cx + dx, cy + dy); if (inComp.has(k) && !dist.has(k)) { dist.set(k, v + 1); bq.push([cx + dx, cy + dy]); } } }
        const thick = 2 * Math.max(0, ...dist.values()) + 1;
        const around = new Map();
        for (const [cx, cy] of comp) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const t = tagAt(m, cx + dx, cy + dy); around.set(t, (around.get(t) || 0) + 1); }
        const edgeOfMap = comp.some(([cx, cy]) => cx === 0 || cy === 0 || cx === d.W - 1 || cy === d.D - 1) || around.has('outside');
        let kind;
        const perimeter = [...around].filter(([t]) => t !== 'plain').reduce((a, [, n]) => a + n, 0) || 1;
        const roadside = [...around.keys()].some(t => ROADSIDE.has(t)), byBuilding = (around.get('building') || 0) >= Math.max(4, perimeter * 0.12);
        if (byBuilding && thick >= 9) kind = 'curtilage';
        else if (byBuilding && thick <= 8 && roadside) kind = 'frontage';
        else if (byBuilding && thick <= 8) kind = 'service';
        else if ((around.get('building') || 0) >= comp.length * 0.4 && thick <= 5) kind = 'alley';
        else if (thick >= 6 && comp.length >= 48) kind = 'green';
        else if ([...around.keys()].some(t => ROADSIDE.has(t))) kind = 'verge';
        else if (edgeOfMap) kind = 'edge';
        else kind = 'path';
        const set = new Set(comp.map(c => k2(...c)));
        const only = (cx, cy) => set.has(k2(cx, cy));
        const origin = `strip:${kind}:${strips.length}`;
        if (kind === 'alley') {
            paint(m, box, 'asphalt', 'alley', { only });
            // Bins and a dumpster against the wall every 8 cells, only where the alley is 3+ wide.
            if (thick >= 3) comp.filter(([cx, cy], i) => (cx + cy) % 8 === 0 && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'building')).forEach(([cx, cy], i) => run(m, [[cx, cy]], 'bin', 1, `${origin}/bins`));
        } else if (kind === 'curtilage') {
            dressCurtilage(m, comp, set, origin);
        } else if (kind === 'frontage') {
            // Shop-front apron: paving, and vending machines / bins against the building wall every 7 cells.
            paint(m, box, 'paving', 'plaza', { only });
            const wallSide = comp.filter(([cx, cy]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'building'));
            wallSide.filter(([cx, cy], i) => (cx + cy) % 7 === 0).forEach(([cx, cy], i) => run(m, [[cx, cy]], i % 2 ? 'appliance' : 'bin', i % 2 ? 2 : 1, `${origin}/${i % 2 ? 'vending' : 'bins'}`));
        } else if (kind === 'service') {
            // Service yard behind buildings: tarmac, dumpster enclosures, bins and a delivery bay.
            paint(m, box, 'asphalt', 'alley', { only });
            const wallSide = comp.filter(([cx, cy]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'building'));
            wallSide.filter(([cx, cy]) => (cx + cy) % 9 === 0).forEach(([cx, cy], i) => run(m, [[cx, cy]], 'bin', 1, `${origin}/bins`));
            if (thick >= 4 && Math.max(box.w, box.d) >= 14) { const along = box.w >= box.d ? 'x' : 'y'; const sx = along === 'x' ? box.x0 + Math.floor(box.w / 2) - 3 : box.x0 + Math.floor(box.w / 2) - 1, sy = along === 'x' ? box.y0 + Math.floor(box.d / 2) - 1 : box.y0 + Math.floor(box.d / 2) - 3; addStall(m, { x: sx, y: sy, axis: along, length: 6, kind: 'dock', types: ['truck'], priority: 0.6, origin: `${origin}/delivery-bay` }); }
        } else if (kind === 'green') {
            paint(m, box, 'lawn', 'green', { only });
            if (edgeOfMap) { const outer = comp.filter(([cx, cy]) => cx === 0 || cy === 0 || cx === d.W - 1 || cy === d.D - 1 || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'outside')); run(m, outer.filter(([cx, cy]) => (cx + cy) % 12 > 1), 'brick', 2, `${origin}/boundary-wall`, { landUse: 'edge' }); }
            for (const [cx, cy] of comp) if (cx % 7 === 3 && cy % 7 === 3) plantTree(m, cx, cy, origin);
        } else if (kind === 'verge') {
            paint(m, box, 'lawn', 'verge', { only });
            // Street trees every ~5 cells along the verge, on the side away from the kerb.
            for (const [cx, cy] of comp) if ((box.w >= box.d ? cx : cy) % 7 === 3 && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ['kerb', 'road', 'driveway'].includes(tagAt(m, cx + dx, cy + dy)))) plantTree(m, cx, cy, `${origin}/street-tree`);
            if (thick >= 3) { const outer = comp.filter(([cx, cy]) => cx === 0 || cy === 0 || cx === d.W - 1 || cy === d.D - 1 || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'outside')); run(m, outer.filter(([cx, cy]) => (cx + cy) % 12 > 1), 'brick', 2, `${origin}/boundary-wall`, { landUse: 'verge' }); }
        } else if (kind === 'edge') {
            paint(m, box, 'lawn', 'edge', { only });
            // World edge: a boundary wall on the outermost cells (gaps every 12) and a tree belt inside it.
            const outer = comp.filter(([cx, cy]) => cx === 0 || cy === 0 || cx === d.W - 1 || cy === d.D - 1 || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => tagAt(m, cx + dx, cy + dy) === 'outside'));
            run(m, outer.filter(([cx, cy]) => (cx + cy) % 12 > 1), 'brick', 2, `${origin}/boundary-wall`, { landUse: 'edge' });
            for (const [cx, cy] of comp) if (!outer.some(([ox, oy]) => ox === cx && oy === cy) && (cx * 3 + cy * 5) % 14 === 0) plantTree(m, cx, cy, `${origin}/tree-belt`);
        } else paint(m, box, 'gravel', 'path', { only });
        strips.push({ id: origin, kind, cells: comp.length, box });
    }
    d.strips.push(...strips);
    return strips;
}

/**
 * Curtilage: the land a building owns around itself when no parcel rectangle fits (rings around hand-placed
 * buildings, odd corners). Customer parking runs along its walls (cars nose-in, clear of the door approaches), the
 * outer edge gets a low wall or chain-link with gates, and where the ring meets a sidewalk there is a dropped kerb.
 */
function dressCurtilage(m, comp, set, origin) {
    const s = m.store, inSet = (x, y) => set.has(k2(x, y));
    const touching = m.buildings.filter(b => comp.some(([x, y]) => x >= b.x0 - 1 && x <= b.x0 + b.w && y >= b.y0 - 1 && y <= b.y0 + b.d));
    const industrial = touching.some(b => ['warehouse', 'garage'].includes(b.program)), home = touching.every(b => ['house', 'bungalow', 'townhouse'].includes(b.program));
    const [key, use] = home ? ['lawn', 'yard'] : industrial ? ['concrete', 'apron'] : ['asphalt', 'aisle'];
    for (const [x, y] of comp) { if (s.topSolid(x, y) === groundAt(m, x, y)) s.set(x, y, groundAt(m, x, y), MAT[key]); tag(m, x, y, use); }
    // Nose-in stalls along each wall: 2 cells clear of the wall (door approaches), 4 deep, a stripe between cars.
    if (!home) for (const b of touching) for (const [side, dx, dy] of [['n', 0, -1], ['s', 0, 1], ['w', -1, 0], ['e', 1, 0]]) {
        const along = dx === 0 ? 'x' : 'y', len = along === 'x' ? b.w : b.d;
        for (let i = 1; i + 1 < len - 1; i += 3) {
            const wx = along === 'x' ? b.x0 + i : (dx < 0 ? b.x0 - 1 : b.x0 + b.w), wy = along === 'y' ? b.y0 + i : (dy < 0 ? b.y0 - 1 : b.y0 + b.d);
            const cells = [];
            for (let r = 2; r < 6; r++) for (let j = 0; j < 2; j++) cells.push(along === 'x' ? [wx + j, wy + dy * r] : [wx + dx * r, wy + j]);
            if (!cells.every(([x, y]) => inSet(x, y) && !m.keep.has(k2(x, y)) && !m.district.stallCells.has(k2(x, y)) && s.topSolid(x, y) === groundAt(m, x, y))) continue;
            const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
            addStall(m, { x: Math.min(...xs), y: Math.min(...ys), axis: along === 'x' ? 'y' : 'x', length: 4, kind: 'stall', priority: 0.6, origin: `${origin}/customer-stall` });
        }
    }
    // Outer edge: a boundary on cells that face neither the building nor a road; gaps every 10 cells.
    const edge = comp.filter(([x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const t = tagAt(m, x + dx, y + dy); return !inSet(x + dx, y + dy) && t !== 'building' && !ROADSIDE.has(t) && t !== 'outside'; }));
    run(m, edge.filter(([x, y]) => (x * 3 + y) % 10 > 1), industrial ? 'chainlink' : home ? 'privacy_fence' : 'brick', industrial || home ? 2 : 1, `${origin}/boundary`, { landUse: 'fence' });
    // Planted corners on whatever stays open far from the walls.
    for (const [x, y] of comp) if ((x * 5 + y * 3) % 23 === 0 && !m.district.stallCells.has(k2(x, y))) plantTree(m, x, y, `${origin}/tree`);
}
