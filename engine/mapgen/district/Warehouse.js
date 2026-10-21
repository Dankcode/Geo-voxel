// PLAN-06 §5.6 — warehouse interiors for open-floor CQB.
//
// The hall of a `warehouse` building is laid out as a designed floor, not furnished at random:
//   distribution  double pallet racking (2 high, blocks sight) in rows with 3-wide aisles and a cross aisle
//   workshop      machine blocks, workbenches and drum stores in bays
//   cold-store    mesh cages (see-through, no cover) with racking along the walls
//   gutted        half-empty bulk floor: pallet and crate stacks on a storage grid (a good hold-zone floor)
// Structural columns (steel, very tough) stand on an 8-cell grid in every variant — the durable cover anchors.
// After the layout three passes enforce the CQB rules with a connectivity guard (nothing may cut off floor):
//   sightline breakers (no straight run of open floor longer than MAX_RUN), cover within COVER_REACH moves,
//   and door landings kept clear.
import { MAT, materialById, coverWeight } from '../../voxel/Materials.js';
import { k2, k3, registerCells } from './Core.js';
import { hashString, createRng } from '../../util/Rng.js';

export const WAREHOUSE_VARIANTS = Object.freeze(['distribution', 'workshop', 'cold-store', 'gutted']);
export const MAX_RUN = 14, COVER_REACH = 2, DEAD_END = 6;

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/**
 * Catwalk over the hall (2-storey warehouses): the storey-2 slab over the hall is removed except a 2-wide grated ring
 * along the walls and a 2-wide bridge across the middle, with railings on every open edge (half cover for the people
 * upstairs, who shoot down onto the floor). Two steel stairs climb from the floor; the upstairs front offices open onto
 * the ring through their existing doors, so the office row becomes a mezzanine. Returns the catwalk record.
 */
export function addCatwalk(m, b, { origin = `warehouse:${b.id}` } = {}) {
    if (b.storeys < 2) return null;
    const s = m.store, hall = b.rooms.filter(r => (r.kind === 'warehouse' || r.kind === 'loading') && r.storey === 0).sort((a, c) => c.cells.length - a.cells.length)[0];
    if (!hall || hall.cells.length < 120) return null;
    const z = hall.floorZ, zc = z + 3;
    const cells = new Set(hall.cells.map(([x, y]) => k2(x, y)));
    // Distance of every hall cell from the hall edge.
    const dist = new Map(), q = [];
    for (const [x, y] of hall.cells) if (N4.some(([dx, dy]) => !cells.has(k2(x + dx, y + dy)))) { dist.set(k2(x, y), 1); q.push([x, y]); }
    for (let i = 0; i < q.length; i++) { const [x, y] = q[i], d = dist.get(k2(x, y)); for (const [dx, dy] of N4) { const k = k2(x + dx, y + dy); if (cells.has(k) && !dist.has(k)) { dist.set(k, d + 1); q.push([x + dx, y + dy]); } } }
    if (Math.max(...dist.values()) < 5) return null;
    const xs = hall.cells.map(c => c[0]), ys = hall.cells.map(c => c[1]);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const longX = box.x1 - box.x0 >= box.y1 - box.y0, mid = longX ? Math.floor((box.x0 + box.x1) / 2) : Math.floor((box.y0 + box.y1) / 2);
    const keep = new Set();
    for (const [x, y] of hall.cells) { const d = dist.get(k2(x, y)); if (d <= 2 || (longX ? x === mid || x === mid + 1 : y === mid || y === mid + 1)) keep.add(k2(x, y)); }
    // The building's own stair must still land on slab connected to the ring.
    for (const st of b.stairs || []) {
        if (st.storey !== 0) continue;
        const pts = [...st.cells, st.after].filter(Boolean);
        for (const p of pts) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cells.has(k2(p.x + dx, p.y + dy))) keep.add(k2(p.x + dx, p.y + dy));
        // A 2-wide strip from the landing to the nearest ring cell.
        const a = st.after; if (a && cells.has(k2(a.x, a.y))) {
            const prev = new Map([[k2(a.x, a.y), null]]), bq = [[a.x, a.y]]; let hit = null;
            for (let i = 0; i < bq.length && !hit; i++) { const [x, y] = bq[i]; if (dist.get(k2(x, y)) <= 2) { hit = [x, y]; break; } for (const [dx, dy] of N4) { const k = k2(x + dx, y + dy); if (cells.has(k) && !prev.has(k)) { prev.set(k, k2(x, y)); bq.push([x + dx, y + dy]); } } }
            for (let k = hit && k2(...hit); k; k = prev.get(k)) { const [x, y] = k.split(',').map(Number); keep.add(k); keep.add(k2(x + 1, y)); keep.add(k2(x, y + 1)); }
        }
    }
    const upper = b.rooms.filter(r => r.storey === 1 && r.cells.some(([x, y]) => cells.has(k2(x, y))));
    const voids = [];
    for (const [x, y] of hall.cells) {
        const k = k2(x, y);
        if (keep.has(k)) { if (s.get(x, y, zc) !== 0) s.set(x, y, zc, MAT.grate); continue; }
        for (let h = 0; h <= 2; h++) { s.set(x, y, zc + h, 0); delete m.hints[`${x},${y},${zc + h}`]; s.rooms[s.index(x, y, zc + h)] = hall.id; }
        voids.push([x, y]);
    }
    const voidSet = new Set(voids.map(c => k2(...c)));
    for (const r of upper) { r.cells = r.cells.filter(([x, y]) => !voidSet.has(k2(x, y))); if (!r.cells.length) r.gameplay = false; }
    // Steel stairs up from the floor at both ends of one long wall: three steps, the top one level with the ring.
    const stairs = [], reserve = [];
    const along = longX ? [1, 0] : [0, 1], across = longX ? [0, 1] : [1, 0];
    const span = longX ? box.x1 - box.x0 : box.y1 - box.y0, lo0 = longX ? box.x0 : box.y0;
    for (const end of [0.2, 0.8]) {
        // Preferred spot first, then walk along the wall (inwards from that end) until the racking leaves a gap.
        const pref = Math.round(lo0 + span * end), cands = [];
        for (let k = 0; k <= Math.floor(span * 0.28); k++) for (const sg of k ? [1, -1] : [1]) { const u = pref + sg * k; if ((end < 0.5 ? u < lo0 + span / 2 - 2 : u > lo0 + span / 2 + 2) && u > lo0 && u < lo0 + span) cands.push(u); }
        let done = false;
        for (const u of cands) for (const side of [1, -1]) {
            if (done) break;
            const wall = side > 0 ? (longX ? box.y0 : box.x0) : (longX ? box.y1 : box.x1);
            const at = d => longX ? [u, wall + side * (d - 1)] : [wall + side * (d - 1), u];
            const steps = [5, 4, 3].map((d, i) => ({ c: at(d), h: i + 1 })), foot = at(6);
            const okCell = ([x, y]) => cells.has(k2(x, y)) && voidSet.has(k2(x, y)) && !s.isSolid(x, y, z + 1);
            if (!steps.every(st => okCell(st.c)) || !okCell(foot) || !cells.has(k2(...at(2)))) continue;
            if (b.doors.concat(b.exits).some(d => Math.abs(d.x - foot[0]) + Math.abs(d.y - foot[1]) <= 2)) continue;
            for (const { c: [x, y], h } of steps) { for (let zz = z + 1; zz < z + h; zz++) s.set(x, y, zz, MAT.steel_post); s.set(x, y, z + h, MAT.steel_stair); }
            stairs.push({ cells: steps.map(({ c: [x, y], h }) => ({ x, y, z: z + h })), foot: { x: foot[0], y: foot[1], z }, top: { x: at(2)[0], y: at(2)[1], z: zc } });
            reserve.push(foot, at(7));
            done = true;
        }
    }
    // Railings on ring and bridge cells that face the void, except where a stair arrives.
    const landings = new Set(stairs.map(st => k2(st.top.x, st.top.y)));
    for (const st of stairs) { const t = st.cells.at(-1); for (const [dx, dy] of N4) landings.add(k2(t.x + dx, t.y + dy)); }
    const ring = [];
    for (const k of keep) {
        const [x, y] = k.split(',').map(Number);
        if (!cells.has(k) || s.get(x, y, zc) !== MAT.grate) continue;
        ring.push([x, y]);
        if (landings.has(k) || s.isSolid(x, y, zc + 1)) continue;
        if (N4.some(([dx, dy]) => voidSet.has(k2(x + dx, y + dy)))) s.set(x, y, zc + 1, MAT.railing);
    }
    const rec = { building: b.id, z: zc, cells: ring.length, voids: voids.length, stairs: stairs.map(st => ({ foot: st.foot, top: st.top })), reserve, sample: ring.slice(0, 6).map(([x, y]) => ({ x, y, z: zc })) };
    b.catwalk = rec;
    return rec;
}

/** Lay out the hall of a warehouse building. Returns a report used by the warehouse gate. */
export function layoutWarehouse(m, b, { variant = null, seed = 1, origin = null } = {}) {
    const rng = createRng(hashString(`warehouse:${m.id}:${b.id}:${seed}`));
    variant ||= WAREHOUSE_VARIANTS[rng.int(0, WAREHOUSE_VARIANTS.length - 1)];
    origin ||= `warehouse:${b.id}`;
    const hall = b.rooms.filter(r => (r.kind === 'warehouse' || r.kind === 'loading') && r.storey === 0).sort((a, c) => c.cells.length - a.cells.length)[0];
    if (!hall) return { building: b.id, variant, pass: false, reason: 'no hall' };
    const s = m.store, z = hall.floorZ;
    const cells = new Set(hall.cells.map(([x, y]) => k2(x, y)));
    const xs = hall.cells.map(c => c[0]), ys = hall.cells.map(c => c[1]);
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const longX = box.x1 - box.x0 >= box.y1 - box.y0;
    // Local (i along the long axis, j across) ↔ world.
    const I = (longX ? box.x1 - box.x0 : box.y1 - box.y0) + 1, J = (longX ? box.y1 - box.y0 : box.x1 - box.x0) + 1;
    const W = (i, j) => longX ? [box.x0 + i, box.y0 + j] : [box.x0 + j, box.y0 + i];

    // Door landings (interior side of every door that touches the hall) stay clear, 2 cells deep.
    const landing = new Set();
    for (const [x, y] of b.catwalk?.reserve || []) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) landing.add(k2(x + dx, y + dy));
    for (const d of b.doors.concat(b.exits.map(e => ({ ...e, z })))) {
        if (d.z != null && d.z !== z) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 2) landing.add(k2(d.x + dx, d.y + dy));
    }
    const placed = [];
    const free = (x, y) => cells.has(k2(x, y)) && !landing.has(k2(x, y)) && !s.isSolid(x, y, z + 1);
    const setCol = (x, y, key, h, part) => { const cs = []; for (let k = 1; k <= h; k++) { s.set(x, y, z + k, MAT[key]); cs.push([x, y, z + k]); } registerCells(m, cs, `${origin}/${part}`); placed.push({ x, y, key, h, part }); };
    const unset = p => { for (let k = 1; k <= p.h; k++) s.set(p.x, p.y, z + k, 0); };

    // Connectivity guard: every open hall cell must stay reachable from the hall's doors.
    const entries = [...landing].filter(k => cells.has(k)).map(k => k.split(',').map(Number));
    const connected = () => {
        const open = c => cells.has(k2(c[0], c[1])) && !s.isSolid(c[0], c[1], z + 1);
        const start = entries.find(open) || hall.cells.find(open);
        if (!start) return false;
        const seen = new Set([k2(...start)]), q = [start];
        while (q.length) { const [x, y] = q.pop(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [x + dx, y + dy], k = k2(...n); if (!seen.has(k) && open(n)) { seen.add(k); q.push(n); } } }
        return hall.cells.every(c => !open(c) || seen.has(k2(...c)));
    };
    let deadCap = null;
    const tryPut = (x, y, key, h, part) => { if (!free(x, y)) return false; deadCap ??= Math.max(DEAD_END, deadEndLength(s, cells, z)); setCol(x, y, key, h, part); if (connected() && deadEndLength(s, cells, z) <= deadCap) return true; unset(placed.pop()); return false; };

    // Columns on an 8-cell grid, offset from the walls.
    for (let i = 4; i < I - 3; i += 8) for (let j = 3; j < J - 2; j += 7) { const [x, y] = W(i, j); tryPut(x, y, 'steel_post', 2, 'column'); }

    if (variant === 'distribution' || variant === 'cold-store') {
        const mid = Math.floor(J / 2);
        // Cold stores keep a 2-cell aisle in front of the cage line so racking and cages never form blind slots.
        const segs = [[3, mid - 2], [mid + 2, variant === 'cold-store' ? J - 8 : J - 4]].filter(([a, c]) => c - a >= 1);
        const start = variant === 'cold-store' ? 3 : 3;
        for (let i = start; i + 1 < I - 3; i += 5) for (const [a, c] of segs) for (let j = a; j <= c; j++) for (const di of [0, 1]) {
            const [x, y] = W(i + di, j);
            if (variant === 'cold-store' && (j === a || j === c)) continue;
            tryPut(x, y, 'shelving', 2, 'racking');
        }
        if (variant === 'cold-store') {
            // Mesh cages against the far wall: see-through, a gated door on the aisle side.
            for (let i = 3; i + 4 < I - 3; i += 7) {
                const ring = [];
                for (let di = 0; di < 4; di++) ring.push([i + di, J - 5], [i + di, J - 2]);
                for (let dj = -4; dj <= -1; dj++) ring.push([i, J + dj], [i + 3, J + dj]);
                for (const [ii, jj] of ring) { if (ii === i + 1 && jj === J - 5) continue; const [x, y] = W(ii, jj); tryPut(x, y, 'chainlink', 2, 'cage'); }
            }
        }
    } else if (variant === 'workshop') {
        for (let i = 3; i + 2 < I - 3; i += 6) for (const j of [3, J - 5]) {
            // Machine block (2 × 2, full cover) beside a workbench run (half cover).
            for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const [x, y] = W(i + di, j + dj); tryPut(x, y, 'appliance', 2, 'machine'); }
            for (let di = 0; di < 3; di++) { const [x, y] = W(i + di, j === 3 ? j + 3 : j - 2); tryPut(x, y, 'shelving', 1, 'workbench'); }
        }
        for (let i = 6; i < I - 4; i += 9) { const [x, y] = W(i, Math.floor(J / 2)); tryPut(x, y, 'barrel_powder', 1, 'drum-store'); const [x2, y2] = W(i + 1, Math.floor(J / 2)); tryPut(x2, y2, 'barrel_water', 1, 'drum-store'); }
    } else {
        // Gutted bulk floor: 2 × 2 stacks on a 5-cell storage grid; alternate pallets (half) and crates (full).
        for (let i = 3; i + 1 < I - 3; i += 5) for (let j = 3; j + 1 < J - 3; j += 5) {
            const full = ((i + j) / 5) % 2 === 0;
            for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const [x, y] = W(i + di, j + dj); tryPut(x, y, full ? 'crate' : 'pallet', full ? 2 : 1, full ? 'crate-stack' : 'pallet-stack'); }
        }
    }
    // A shipping container on the bulk floor of big halls (full cover, very tough).
    if (I >= 20 && J >= 12 && variant !== 'cold-store') {
        const i = Math.floor(I / 2) - 2, j = 1;
        const cs = []; for (let di = 0; di < 5; di++) for (let dj = 0; dj < 2; dj++) cs.push(W(i + di, j + dj));
        if (cs.every(([x, y]) => free(x, y) && !s.isSolid(x, y, z + 2))) {
            const before = placed.length;
            for (const [x, y] of cs) setCol(x, y, 'container', 2, 'container');
            if (!connected()) while (placed.length > before) unset(placed.pop());
            else m.object('container', cs.flatMap(([x, y]) => [[x, y, z + 1], [x, y, z + 2]]), { axis: longX ? 'x' : 'y', dir: 1, size: [5, 2], tint: [0.16, 0.3, 0.5] });
        }
    }
    // A forklift parked at an aisle end (half cover).
    { const [x, y] = W(2, Math.floor(J / 2)), [x2, y2] = W(3, Math.floor(J / 2));
        if (free(x, y) && free(x2, y2)) { setCol(x, y, 'appliance', 1, 'forklift'); setCol(x2, y2, 'appliance', 1, 'forklift'); if (!connected()) { unset(placed.pop()); unset(placed.pop()); } } }

    // Sightline breakers: no straight open run longer than MAX_RUN cells (crate stacks block sight).
    for (let pass = 0; pass < 6; pass++) {
        const long = longestRuns(s, cells, z, box);
        if (!long.length) break;
        let fixed = false;
        for (const r of long) {
            const mid = (r.cells.length - 1) / 2;
            const order = r.cells.map((_, i) => i).filter(i => i >= 3 && i <= r.cells.length - 4).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
            for (const idx of order) { const [x, y] = r.cells[idx]; if (tryPut(x, y, 'crate', 2, 'sightline-breaker')) { fixed = true; break; } }
        }
        if (!fixed) break;
    }
    // Cover within COVER_REACH moves of every open hall cell (pallet stacks, half cover).
    for (let pass = 0; pass < 40; pass++) {
        const far = coverDistances(s, cells, z).filter(c => c.d > COVER_REACH).sort((a, c) => c.d - a.d);
        if (!far.length) break;
        let ok = false;
        for (const c of far.slice(0, 4)) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2], [1, 1], [-1, 1], [1, -1], [-1, -1]]) if (!ok && tryPut(c.x + dx, c.y + dy, 'pallet', 1, 'bulk-stack')) ok = true;
        if (!ok) break;
    }
    // Racking uses open steel beams; workshop benches use a table/pegboard silhouette.
    for(const p of placed)if(p.key==='shelving')for(let h=0;h<p.h;h++){
        const piece=p.part==='workbench'?'workbench':h===0?'warehouse_rack_lower':'warehouse_rack_upper';
        m.hints[k3(p.x,p.y,z+1+h)]={piece,yaw:longX?Math.PI/2:0};
    }
    const report = warehouseReport(m, b, hall, { variant, cells, box, z, landing });
    m.district?.warehouses.push(report);
    return report;
}

/** Longest chain of open cells (degree ≤ 2) that ends blind: long blind slots between props are traps, not cover. */
export function deadEndLength(s, cells, z) {
    const open = (x, y) => cells.has(k2(x, y)) && !s.isSolid(x, y, z + 1);
    let deadEnd = 0;
    for (const k of cells) {
        const [x, y] = k.split(',').map(Number); if (!open(x, y)) continue;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => open(x + dx, y + dy));
        if (nb.length !== 1) continue;
        let len = 1, px = x, py = y, [cx, cy] = [x + nb[0][0], y + nb[0][1]];
        while (len < 20) {
            const n2 = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy]).filter(([ax, ay]) => open(ax, ay) && !(ax === px && ay === py));
            if (n2.length !== 1) break;
            len++; [px, py] = [cx, cy]; [cx, cy] = n2[0];
        }
        deadEnd = Math.max(deadEnd, len);
    }
    return deadEnd;
}

/** Straight runs of open floor (rows and columns of the hall's bounding box) longer than MAX_RUN. */
export function longestRuns(s, cells, z, box) {
    const out = [];
    const scan = (pts) => {
        let cur = [];
        const flush = () => { if (cur.length > MAX_RUN) out.push({ cells: cur }); cur = []; };
        for (const [x, y] of pts) { if (cells.has(k2(x, y)) && !blocksSightAt(s, x, y, z)) cur.push([x, y]); else flush(); }
        flush();
    };
    for (let y = box.y0; y <= box.y1; y++) { const pts = []; for (let x = box.x0; x <= box.x1; x++) pts.push([x, y]); scan(pts); }
    for (let x = box.x0; x <= box.x1; x++) { const pts = []; for (let y = box.y0; y <= box.y1; y++) pts.push([x, y]); scan(pts); }
    return out.sort((a, c) => c.cells.length - a.cells.length);
}
const blocksSightAt = (s, x, y, z) => { const m = materialById(s.get(x, y, z + 2)); return m.solid && m.opaque !== false; };

/** Moves from every open hall cell to the nearest cell with cover beside it. */
export function coverDistances(s, cells, z) {
    const open = (x, y) => cells.has(k2(x, y)) && !s.isSolid(x, y, z + 1);
    const covered = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => coverWeight(materialById(s.get(x + dx, y + dy, z + 1))) >= 1);
    const dist = new Map(), q = [];
    for (const k of cells) { const [x, y] = k.split(',').map(Number); if (open(x, y) && covered(x, y)) { dist.set(k, 0); q.push([x, y]); } }
    for (let i = 0; i < q.length; i++) { const [x, y] = q[i], d = dist.get(k2(x, y)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = k2(x + dx, y + dy); if (!dist.has(k) && open(x + dx, y + dy)) { dist.set(k, d + 1); q.push([x + dx, y + dy]); } } }
    const out = [];
    for (const k of cells) { const [x, y] = k.split(',').map(Number); if (open(x, y)) out.push({ x, y, d: dist.get(k) ?? 99 }); }
    return out;
}

export function warehouseReport(m, b, hall, { variant, cells, box, z, landing }) {
    const s = m.store;
    const runs = longestRuns(s, cells, z, box);
    const dists = coverDistances(s, cells, z);
    const sides = new Set(b.exits.map(e => e.side));
    // Loops: removing any single open cell of degree 2 in a corridor must not disconnect the hall too often — we
    // approximate "no long dead ends" by the longest chain of degree-1/2 cells that ends in a dead end.
    const deadEnd = deadEndLength(s, cells, z);
    const coverReach = Math.max(0, ...dists.map(d => d.d));
    const longestRun = runs.length ? runs[0].cells.length : 0;
    const report = { building: b.id, variant, hallCells: cells.size, longestRun, coverReach, deadEnd, entrances: b.exits.length, entranceSides: sides.size,
        catwalk: b.catwalk ? { z: b.catwalk.z, cells: b.catwalk.cells, stairs: b.catwalk.stairs.length, sample: b.catwalk.sample, top: b.catwalk.stairs.map(st => st.top) } : null, gates: {} };
    report.gates = { sightline: longestRun <= MAX_RUN, cover: coverReach <= COVER_REACH, deadEnds: deadEnd <= DEAD_END, entrances: b.exits.length >= 3 && sides.size >= 2 };
    report.pass = Object.values(report.gates).every(Boolean);
    return report;
}
