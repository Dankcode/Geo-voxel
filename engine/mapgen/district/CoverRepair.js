// PLAN-06 §5.10 — cover repair by land use. When the outdoor cover gap (PLAN-01's "no killing fields": no outdoor
// tile more than COVER_GAP moves from cover) still fails after the parcels, slots and street rules, the worst tile gets
// the piece its land use would really have, placed as close to it as the rules allow:
//   road / kerb      a stalled car in the kerb lane (a vehicle slot) or a roadworks barrier pair beside the kerb
//   sidewalk         a utility cabinet or a pair of wheelie bins against the frontage side
//   stall / aisle    a kerbed lot island (low concrete) at the end of a row
//   plaza / zone     a low brick seat wall
//   apron / forecourt / storage / construction   a pallet stack or a jersey barrier pair
//   yard / green / park / verge / edge / path     a tree, or a low brick garden wall
//   alley            bins against the wall
// Each piece carries the origin `repair:<land use>/<piece>`, so the prop-origin gate still accounts for it.
import { reachable } from '../../world/PathSearch.js';
import { AGENT_PROFILES } from '../../world/TraversalRules.js';
import { coverAt, COVER } from '../../voxel/Cover.js';
import { tagAt, groundAt, put, k2, inMap } from './Core.js';
import { addStall, plantTree } from './Props.js';
import { placeStreetVehicle } from '../StreetDressing.js';
import { registerCells } from './Core.js';

export const REPAIR_GAP = 5;
const PIECES = {
    sidewalk: [['appliance', 1, 2], ['bin', 1, 2]], kerb: [['jersey', 1, 2]], road: [['jersey', 1, 2]], aisle: [['concrete_wall', 1, 2]], stall: [['concrete_wall', 1, 2]],
    plaza: [['brick', 1, 3]], zone: [['brick', 1, 2]], apron: [['pallet', 1, 2], ['jersey', 1, 2]], forecourt: [['jersey', 1, 2]], storage: [['pallet', 1, 2]], construction: [['pallet', 1, 2]],
    yard: [['tree'], ['brick', 1, 3]], green: [['tree'], ['brick', 1, 3]], park: [['tree']], verge: [['tree']], edge: [['tree']], path: [['brick', 1, 2]], alley: [['bin', 1, 2]],
    insertion: [['jersey', 1, 2]], driveway: [], level: [], building: [], channel: [['concrete_wall', 1, 2]], utility: [['pallet', 1, 2]], fence: []
};

export function repairCover(m, { spawn, maxGap = REPAIR_GAP, budget = 80, traffic = 'normal' } = {}) {
    const s = m.store, placed = [];
    if (!spawn) return placed;
    let search = reachable(s, spawn, Infinity, AGENT_PROFILES.player);
    const key = n => `${n.x},${n.y},${n.z}`;
    const outdoor = () => [...search.nodes.values()].filter(n => s.roomAt(n.x, n.y, n.z + 1) < 0 && m.district.contains(n.x, n.y));
    let nodes = outdoor();
    const covered = new Map();
    const isCovered = n => { const c = coverAt(s, n.x, n.y, n.z); return Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF; };
    for (const n of nodes) covered.set(key(n), isCovered(n));
    const gaps = () => {
        const map = new Map(nodes.map(n => [key(n), n])), d = new Map(), q = [];
        for (const n of nodes) if (covered.get(key(n))) { d.set(key(n), 0); q.push(n); }
        for (let i = 0; i < q.length; i++) { const n = q[i], v = d.get(key(n)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dz of [0, 1, -1]) { const k = `${n.x + dx},${n.y + dy},${n.z + dz}`, o = map.get(k); if (o && !d.has(k)) { d.set(k, v + 1); q.push(o); } } }
        return nodes.map(n => ({ n, d: d.get(key(n)) ?? 99 })).filter(e => e.d > maxGap).sort((a, b) => b.d - a.d || a.n.x - b.n.x || a.n.y - b.n.y);
    };
    const tried = new Set();
    for (let it = 0; it < budget; it++) {
        const far = gaps().filter(e => !tried.has(key(e.n)));
        if (!far.length) break;
        const target = far[0].n; tried.add(key(target));
        // Search outward for a spot where the land-use piece fits, nearest first.
        // Nearest first, but anything off the carriageway beats a car on it.
        const cand = [];
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx || dy) cand.push([target.x + dx, target.y + dy, Math.max(Math.abs(dx), Math.abs(dy))]);
        cand.sort((a, b) => (tagAt(m, a[0], a[1]) === 'road') - (tagAt(m, b[0], b[1]) === 'road') || a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
        let done = null;
        for (const [cx, cy] of cand) { done = tryPiece(m, cx, cy, target, traffic !== 'none'); if (done) break; }
        if (!done) continue;
        placed.push(done);
        // Refresh the walkable set and cover near the change.
        search = reachable(s, spawn, Infinity, AGENT_PROFILES.player);
        nodes = outdoor();
        for (const n of nodes) if (Math.abs(n.x - done.x) <= 3 && Math.abs(n.y - done.y) <= 3 || !covered.has(key(n))) covered.set(key(n), isCovered(n));
    }
    m.district.repairs = placed;
    return placed;
}

export function tryPiece(m, x, y, target, allowVehicles) {
    if (!inMap(m, x, y) || !m.district.contains(x, y)) return null;
    const s = m.store, t = tagAt(m, x, y), g = groundAt(m, x, y);
    if (g !== target.z || s.topSolid(x, y) !== g || m.keep.has(k2(x, y)) || m.district.stallCells.has(k2(x, y))) return null;
    if (t === 'road') return roadPiece(m, x, y, g, allowVehicles);
    for (const [key, h = 1, len = 1] of PIECES[t] || []) {
        if (key === 'tree') { if (plantTree(m, x, y, `repair:${t}/tree`)) return { x, y, piece: 'tree', tag: t }; continue; }
        for (const [ax, ay] of [[1, 0], [0, 1]]) {
            const cells = Array.from({ length: len }, (_, i) => [x + ax * i, y + ay * i]);
            if (!cells.every(([cx, cy]) => inMap(m, cx, cy) && tagAt(m, cx, cy) === t && groundAt(m, cx, cy) === g && s.topSolid(cx, cy) === g && !m.keep.has(k2(cx, cy)) && !m.district.stallCells.has(k2(cx, cy)) && !s.isSolid(cx, cy, g + 1))) continue;
            // Never seal a 2-wide passage: each cell must keep a free neighbour on both sides across the run.
            const across = [ay, ax];
            if (!cells.every(([cx, cy]) => !s.isSolid(cx + across[0], cy + across[1], g + 1) || !s.isSolid(cx - across[0], cy - across[1], g + 1))) continue;
            for (const [cx, cy] of cells) for (let k = 1; k <= h; k++) put(m, cx, cy, g + k, key, `repair:${t}/${key}`);
            return { x, y, piece: key, tag: t, len };
        }
    }
    return null;
}

/** On the carriageway only the kerb lanes take anything: a stalled car if a slot fits, else roadworks barriers. */
function roadPiece(m, x, y, g, allowVehicles) {
    const s = m.store, nb = d => tagAt(m, x + d[0], y + d[1]);
    const kerbSide = [[0, -1], [0, 1], [-1, 0], [1, 0]].find(d => nb(d) === 'kerb');
    if (!kerbSide) return null;
    const axis = kerbSide[0] === 0 ? 'x' : 'y';
    const cells = axis === 'x' ? [[x, y], [x + 1, y]] : [[x, y], [x, y + 1]];
    if (!cells.every(([cx, cy]) => tagAt(m, cx, cy) === 'road' && !s.isSolid(cx, cy, g + 1) && !m.district.stallCells.has(k2(cx, cy)))) return null;
    // A car needs 2 × 4 in the lane; try it first (vehicles are better cover and read as traffic).
    const lane = axis === 'x' ? { x, y: kerbSide[1] < 0 ? y : y - 1 } : { x: kerbSide[0] < 0 ? x : x - 1, y };
    const st = allowVehicles ? addStall(m, { x: lane.x, y: lane.y, axis, length: 4, kind: 'salvage', types: ['abandoned_car'], priority: 1, z: g, origin: `repair:road/stalled-car` }) : null;
    if (st) {
        const v = placeStreetVehicle(m, 'abandoned_car', st.x, st.y, { axis, z: g });
        if (v) { const vc = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) vc.push(axis === 'x' ? [st.x + i, st.y + j, g + 1] : [st.x + j, st.y + i, g + 1]); registerCells(m, vc.filter(c => s.isSolid(...c)), 'vehicle:repair'); m.district.vehicles.push({ ...v, kind: 'salvage', origin: 'repair:road' }); return { x, y, piece: 'abandoned_car', tag: 'road' }; }
    }
    for (const [cx, cy] of cells) put(m, cx, cy, g + 1, 'jersey', 'roadset:repair/roadworks');
    return { x, y, piece: 'roadworks', tag: 'road' };
}
