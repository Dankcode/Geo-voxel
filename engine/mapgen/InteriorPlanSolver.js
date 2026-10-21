// PLAN-04 §5.3 step 5, pass A — interior plans by WFC on the bay grid, varied by each building's own noise.
//
// A footprint of n × m bays + shell has walls on the bay lines (even local offsets) and bay cells at odd offsets.
// Every floor shares one stacked stair core (3 × 2 bays, pinned before anything else, the same on every storey).
// Interior noise (its own seed and frequency per building and floor) picks the circulation — a spine corridor, an
// L, or open plan — then a weighted WFC assigns each remaining bay to a programme room, with soft Voronoi priors
// from noise-spread room seeds, service rooms kept off exit and fire-escape bays. Repair passes keep each room in
// one piece, door every room (on bay lines, never onto stair runs), give most rooms a second way in, and lock
// service rooms. The output is the layout's floor contract (rooms, partition walls, doors, core), so the same
// compiler builds v2 and v3 buildings.
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
import { fbm, NOISE_LAYERS } from './Fields.js';
import { hashString } from '../util/Rng.js';

const unit = s => (hashString(s) >>> 0) / 4294967296;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const k2 = (x, y) => `${x},${y}`;

/** Bay grid of a footprint (w, d odd). */
export function bayGridOf(w, d) { return { nbx: (w - 1) / 2, nby: (d - 1) / 2 }; }
export const bayCell = (i, j) => [1 + 2 * i, 1 + 2 * j];

/**
 * Pick the stacked core (3 × 2 bays) for a building: away from the exits, off the fire-escape bays, varied by noise.
 * Returns { ci, cj, x, y } with x, y the local top-left cell of the 5 × 3 core.
 */
export function placeCore(b, { seed, avoid = [] } = {}) {
    const { nbx, nby } = bayGridOf(b.w, b.d);
    if (nbx < 3 || nby < 2) throw Error(`interior.core: ${b.id} (${b.w}×${b.d}) cannot fit the 3×2-bay stair core`);
    let best = null;
    for (let cj = 0; cj <= nby - 2; cj++) for (let ci = 0; ci <= nbx - 3; ci++) {
        const bays = []; for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) bays.push([ci + i, cj + j]);
        if (bays.some(([i, j]) => avoid.some(([a, c]) => a === i && c === j))) continue;
        // Prefer an inner position (rooms all round) shifted by noise; never hug both ends.
        const centre = Math.hypot(ci + 1 - (nbx - 1) / 2, cj + 0.5 - (nby - 1) / 2);
        const score = centre + 2.5 * unit(`${seed}:${b.id}:core:${ci},${cj}`);
        if (!best || score < best.score) best = { ci, cj, score };
    }
    if (!best) throw Error(`interior.core: ${b.id} (${b.w}×${b.d}) has no core position clear of its exits ${JSON.stringify(avoid)}`);
    return { ci: best.ci, cj: best.cj, x: 1 + 2 * best.ci, y: 1 + 2 * best.cj, layout: 'v3' };
}

/** Cells of the core that hold stair runs or their arrival holes (doors and furniture keep off them). */
export function coreStairCells(core) {
    const out = new Set();
    // Even runs climb row y from x (before) through x+1..x+3; odd runs climb row y+2 from x+4 through x+3..x+1.
    // On the floor above, the slab is open over each run's before cell and first two steps.
    for (let i = 0; i <= 3; i++) out.add(k2(core.x + i, core.y));
    for (let i = 1; i <= 4; i++) out.add(k2(core.x + i, core.y + 2));
    return out;
}

/**
 * Solve one floor. b: { id, w, d, storeys }, programme: { floor, rooms: [{ id, kind, areaShare, gameplay }] },
 * opts: { seed, core, keepGameplay: [[i, j]] bays that must be gameplay space (exits, escape doors), storeys }
 */
export function solveInteriorPlan(b, programme, { seed = 1, core = null, keepGameplay = [], prior = null } = {}) {
    const { nbx, nby } = bayGridOf(b.w, b.d), floor = programme.floor;
    const noise = (i, j) => fbm(`${seed}:${b.id}:interior:${floor}`, i * 2, j * 2, NOISE_LAYERS.interior);
    const region = new Map();                      // 'i,j' → 'hall' | room id
    const inCore = (i, j) => core && i >= core.ci && i < core.ci + 3 && j >= core.cj && j < core.cj + 2;
    if (core) for (let j = core.cj; j < core.cj + 2; j++) for (let i = core.ci; i < core.ci + 3; i++) region.set(k2(i, j), 'hall');
    // Circulation style by noise: spine corridor (long axis, through the core row), an L, or open plan.
    const styleRoll = unit(`${seed}:${b.id}:${floor}:style`);
    const rooms = programme.rooms.slice();
    const freeCount = nbx * nby - region.size;
    const style = rooms.length <= 2 || freeCount < 10 ? 'open' : styleRoll < 0.5 ? 'spine' : styleRoll < 0.8 ? 'L' : 'open';
    const alongX = nbx >= nby;
    if (style !== 'open') {
        const row = core ? (alongX ? core.cj + (unit(`${seed}:${b.id}:${floor}:row`) < 0.5 ? 0 : 1) : core.ci + 1) : Math.floor((alongX ? nby : nbx) / 2);
        const len = alongX ? nbx : nby;
        const from = unit(`${seed}:${b.id}:${floor}:from`) < 0.3 ? 1 : 0, to = len - (unit(`${seed}:${b.id}:${floor}:to`) < 0.3 ? 2 : 1);
        for (let t = from; t <= to; t++) { const [i, j] = alongX ? [t, row] : [row, t]; if (!region.has(k2(i, j))) region.set(k2(i, j), 'hall'); }
        if (style === 'L') {
            const at = alongX ? (unit(`${seed}:${b.id}:${floor}:leg`) < 0.5 ? from : to) : row, crossLen = alongX ? nby : nbx;
            const dir = unit(`${seed}:${b.id}:${floor}:legdir`) < 0.5 ? -1 : 1;
            for (let t = row + dir; t >= 0 && t < crossLen && Math.abs(t - row) <= 2; t += dir) { const [i, j] = alongX ? [at, t] : [t, at]; if (!region.has(k2(i, j))) region.set(k2(i, j), 'hall'); }
        }
    }
    // Room count fits the free bays (≥ 2 bays a room); extras are dropped with a repair record.
    const repairs = [];
    let free = []; for (let j = 0; j < nby; j++) for (let i = 0; i < nbx; i++) if (!region.has(k2(i, j))) free.push([i, j]);
    const maxRooms = Math.max(1, Math.floor(free.length / 2));
    if (rooms.length > maxRooms) {
        const keep = rooms.filter(r => r.gameplay !== false).concat(rooms.filter(r => r.gameplay === false)).slice(0, maxRooms);
        repairs.push({ kind: 'drop-rooms', floor, dropped: rooms.filter(r => !keep.includes(r)).map(r => r.id) });
        rooms.splice(0, rooms.length, ...rooms.filter(r => keep.includes(r)));
    }
    const mustPlay = new Set(keepGameplay.map(([i, j]) => k2(i, j)));
    // Room seeds: noise-led farthest-point sampling; service rooms never seed on bays that must stay gameplay.
    const seeds = new Map();
    const order = rooms.slice().sort((a, c) => (c.areaShare || 1) - (a.areaShare || 1));
    for (const r of order) {
        let best = null;
        // A floorspec read back from concept art puts the room's seed where the art drew it.
        const read = prior?.rooms?.find(p => p.kind === r.kind && Array.isArray(p.center));
        if (read) {
            const ti = Math.min(nbx - 1, Math.max(0, Math.round(read.center[0] * nbx - 0.5))), tj = Math.min(nby - 1, Math.max(0, Math.round(read.center[1] * nby - 0.5)));
            for (const [i, j] of free) {
                if (r.gameplay === false && mustPlay.has(k2(i, j))) continue;
                if ([...seeds.values()].some(([a, c]) => a === i && c === j)) continue;
                const score = -Math.hypot(i - ti, j - tj);
                if (!best || score > best.score) best = { score, at: [i, j] };
            }
            if (best) { seeds.set(r.id, best.at); continue; }
        }
        for (const [i, j] of free) {
            if (r.gameplay === false && mustPlay.has(k2(i, j))) continue;
            if ([...seeds.values()].some(([a, c]) => a === i && c === j)) continue;
            const d = seeds.size ? Math.min(...[...seeds.values()].map(([a, c]) => Math.abs(a - i) + Math.abs(c - j))) : 0;
            const score = d * 1.5 + noise(i, j) * 2 + (r.gameplay === false ? -0.4 * Math.min(i, nbx - 1 - i, j, nby - 1 - j) : 0);
            if (!best || score > best.score) best = { score, at: [i, j] };
        }
        if (best) seeds.set(r.id, best.at);
    }
    const placed = rooms.filter(r => seeds.has(r.id));
    // Field-guided WFC: nearest seeds get the weight, noise breaks ties, service rooms keep off exit/escape bays.
    const nodes = free.map(([i, j]) => ({ id: k2(i, j), neighbors: N4.map(([dx, dy]) => k2(i + dx, j + dy)).filter(id => free.some(([a, c]) => k2(a, c) === id)).map(id => ({ id, direction: 'adj' })) }));
    const domains = new Map(), fixed = new Map();
    for (const [i, j] of free) {
        const ranked = placed.filter(r => !(r.gameplay === false && mustPlay.has(k2(i, j)))).map(r => ({ r, d: Math.abs(seeds.get(r.id)[0] - i) + Math.abs(seeds.get(r.id)[1] - j) })).sort((a, c) => a.d - c.d || (a.r.id < c.r.id ? -1 : 1));
        const dom = ranked.slice(0, 3).map(x => x.r.id);
        domains.set(k2(i, j), dom.length ? dom : [placed.find(r => r.gameplay !== false)?.id ?? placed[0].id]);
        for (const r of placed) if (seeds.get(r.id)[0] === i && seeds.get(r.id)[1] === j && domains.get(k2(i, j)).includes(r.id)) fixed.set(k2(i, j), r.id);
    }
    const weight = (id, tile) => {
        const [i, j] = id.split(',').map(Number), r = placed.find(x => x.id === tile), [si, sj] = seeds.get(tile);
        const d = Math.abs(si - i) + Math.abs(sj - j);
        return (r.areaShare || 1) * placed.length / (0.35 + d * d) * (0.6 + noise(i + si * 0.13, j + sj * 0.17));
    };
    // Rooms whose kinds must touch (programme adjacencies) may not be split by a third room along a shared edge.
    let assignment = new Map();
    if (nodes.length) assignment = solveWaveFunctionCollapse({ nodes, tiles: placed.map(r => ({ id: r.id, weight: 1 })), domains, fixed, nodeWeights: weight, compatible: () => true, seed: `${seed}:${b.id}:plan:${floor}` });
    for (const [id, t] of assignment) region.set(id, t);
    // Repair 1: one connected piece per room; stray pieces join their best neighbour (or the hall).
    for (const r of placed) {
        const bays = [...region].filter(([, t]) => t === r.id).map(([id]) => id.split(',').map(Number));
        const comps = components(bays);
        const seedKey = k2(...seeds.get(r.id));
        const keep = comps.find(c => c.some(([i, j]) => k2(i, j) === seedKey)) || comps.sort((a, c) => c.length - a.length)[0] || [];
        for (const comp of comps) if (comp !== keep) for (const [i, j] of comp) {
            const counts = new Map();
            for (const [dx, dy] of N4) { const t = region.get(k2(i + dx, j + dy)); if (t && t !== r.id) counts.set(t, (counts.get(t) || 0) + 1); }
            // Fragments join gameplay space first; a service room only takes one when nothing else touches it.
            const ranked = [...counts].sort((a, c) => (placed.find(x => x.id === a[0])?.gameplay === false) - (placed.find(x => x.id === c[0])?.gameplay === false) || c[1] - a[1] || (a[0] < c[0] ? -1 : 1));
            const target = ranked[0]?.[0] || 'hall';
            const tr = placed.find(x => x.id === target);
            region.set(k2(i, j), tr && tr.gameplay === false && mustPlay.has(k2(i, j)) ? 'hall' : target);
            repairs.push({ kind: 'merge-fragment', floor, from: r.id, to: region.get(k2(i, j)) });
        }
    }
    // Repair 2: a gameplay room one bay wide (a 1-cell strip) joins the neighbour it shares most wall with.
    for (const r of placed.filter(r => r.gameplay !== false)) {
        const bays = [...region].filter(([, t]) => t === r.id).map(([id]) => id.split(',').map(Number));
        if (!bays.length) continue;
        // Thin = no 2 × 2 block of its own bays anywhere: every part of the room is a one-cell strip.
        const own = new Set(bays.map(([i, j]) => k2(i, j)));
        const thin = !bays.some(([i, j]) => own.has(k2(i + 1, j)) && own.has(k2(i, j + 1)) && own.has(k2(i + 1, j + 1)));
        if (!thin) continue;
        const counts = new Map();
        for (const [i, j] of bays) for (const [dx, dy] of N4) { const t = region.get(k2(i + dx, j + dy)); if (t && t !== r.id && (t === 'hall' || placed.find(x => x.id === t)?.gameplay !== false)) counts.set(t, (counts.get(t) || 0) + (t === 'hall' ? 0.5 : 1)); }
        const target = [...counts].sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1))[0]?.[0];
        if (!target) continue;
        // Keep the programme room if it is the only one of its kind on this floor and the target is the hall: grow it instead.
        for (const [i, j] of bays) region.set(k2(i, j), target);
        repairs.push({ kind: 'merge-thin-room', floor, from: r.id, to: target });
    }
    // Repair 3: service rooms stay small (a WC, a plant room): bays beyond their share, farthest from their seed
    // first, go to the gameplay space next to them.
    const cap = Math.max(2, Math.round(free.length * 0.14));
    for (const r of placed.filter(r => r.gameplay === false)) {
        const [si, sj] = seeds.get(r.id) || [0, 0];
        const bays = [...region].filter(([, t]) => t === r.id).map(([id]) => id.split(',').map(Number)).sort((a, c) => Math.hypot(c[0] - si, c[1] - sj) - Math.hypot(a[0] - si, a[1] - sj));
        for (let n = 0; n < 6 && bays.length > cap; n++) for (let k = 0; k < bays.length && bays.length > cap; k++) {
            const [i, j] = bays[k];
            const next = N4.map(([dx, dy]) => region.get(k2(i + dx, j + dy))).filter(t => t && t !== r.id && (t === 'hall' || placed.find(x => x.id === t)?.gameplay !== false));
            if (!next.length) continue;
            const rest = bays.filter((_, q) => q !== k);
            if (components(rest).length > 1) continue;
            region.set(k2(i, j), next.sort()[0]); bays.splice(k, 1); k--;
        }
    }
    // Repair 4: the hall is one piece (the core and its corridor); a stray hall fragment joins a neighbouring room.
    const hallBays = [...region].filter(([, t]) => t === 'hall').map(([id]) => id.split(',').map(Number));
    if (hallBays.length) {
        const parts = components(hallBays), main = core ? parts.find(c => c.some(([i, j]) => inCore(i, j))) : parts.sort((a, c) => c.length - a.length)[0];
        for (const part of parts) if (part !== main) for (const [i, j] of part) {
            const next = N4.map(([dx, dy]) => region.get(k2(i + dx, j + dy))).filter(t => t && t !== 'hall' && placed.find(x => x.id === t)?.gameplay !== false);
            if (next.length) { region.set(k2(i, j), next.sort()[0]); repairs.push({ kind: 'hall-fragment', floor, to: next.sort()[0] }); }
        }
    }
    const live = placed.filter(r => [...region.values()].includes(r.id));
    return finishPlan(b, floor, region, live, core, repairs, seed);
}

function components(bays) {
    const left = new Set(bays.map(([i, j]) => k2(i, j))), out = [];
    while (left.size) {
        const start = [...left][0], q = [start.split(',').map(Number)], comp = [];
        left.delete(start);
        for (let n = 0; n < q.length; n++) {
            const [i, j] = q[n]; comp.push([i, j]);
            for (const [dx, dy] of N4) { const k = k2(i + dx, j + dy); if (left.has(k)) { left.delete(k); q.push([i + dx, j + dy]); } }
        }
        out.push(comp);
    }
    return out;
}

/** Turn a bay → region map into room cells, partition walls and doors (the floor contract). */
function finishPlan(b, floor, region, rooms, core, repairs, seed) {
    const { nbx, nby } = bayGridOf(b.w, b.d);
    const at = (i, j) => region.get(k2(i, j));
    const cellRegion = new Map();          // local cell → region (bay cells and same-region joints)
    for (let j = 0; j < nby; j++) for (let i = 0; i < nbx; i++) {
        const r = at(i, j), [x, y] = bayCell(i, j); cellRegion.set(k2(x, y), r);
        if (i + 1 < nbx && at(i + 1, j) === r) cellRegion.set(k2(x + 1, y), r);
        if (j + 1 < nby && at(i, j + 1) === r) cellRegion.set(k2(x, y + 1), r);
        if (i + 1 < nbx && j + 1 < nby && at(i + 1, j) === r && at(i, j + 1) === r && at(i + 1, j + 1) === r) cellRegion.set(k2(x + 1, y + 1), r);
    }
    const walls = [];
    for (let y = 1; y < b.d - 1; y++) for (let x = 1; x < b.w - 1; x++) if (!cellRegion.has(k2(x, y))) walls.push([x, y]);
    // Candidate door joints between two different regions.
    const stair = core ? coreStairCells(core) : new Set();
    const joints = [];
    for (let j = 0; j < nby; j++) for (let i = 0; i < nbx; i++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const a = at(i, j), c = at(i + dx, j + dy); if (!c || a === c) continue;
        const [x, y] = bayCell(i, j), jx = x + dx, jy = y + dy;
        const sides = [[x, y], [x + 2 * dx, y + 2 * dy]];
        if (sides.some(([sx, sy]) => stair.has(k2(sx, sy)))) continue;
        joints.push({ x: jx, y: jy, a, c, i, j, dx, dy });
    }
    const roomOf = id => rooms.find(r => r.id === id);
    const gameplay = id => id === 'hall' || roomOf(id)?.gameplay !== false;
    // The spanning tree grows from the hall; an open-plan floor without one grows from its largest gameplay room.
    const root = [...region.values()].includes('hall') ? 'hall' : rooms.filter(r => r.gameplay !== false).sort((a, c) => (c.areaShare || 1) - (a.areaShare || 1) || (a.id < c.id ? -1 : 1))[0]?.id;
    const doors = [], doorCount = new Map(), linked = new Set([root]), used = new Set();
    const addDoor = (jt, a, c) => {
        if (used.has(k2(jt.x, jt.y))) return false;
        // No two doors side by side on the same wall run.
        if (doors.some(d => Math.abs(d.x - jt.x) + Math.abs(d.y - jt.y) <= 2 && (d.x === jt.x || d.y === jt.y) && ((d.room === a && d.other === c) || (d.room === c && d.other === a)))) return false;
        const locked = !gameplay(a) || !gameplay(c);
        doors.push({ x: jt.x, y: jt.y, room: a === 'hall' ? c : a, other: a === 'hall' ? 'hall' : c, locked });
        used.add(k2(jt.x, jt.y)); doorCount.set(a, (doorCount.get(a) || 0) + 1); doorCount.set(c, (doorCount.get(c) || 0) + 1);
        return true;
    };
    const pick = list => list.slice().sort((p, q) => unit(`${seed}:${b.id}:${floor}:door:${p.x},${p.y}`) - unit(`${seed}:${b.id}:${floor}:door:${q.x},${q.y}`))[0];
    // Spanning tree from the hall outward: service rooms only ever get their one locked door.
    for (let guard = 0; guard < rooms.length * 2 && rooms.some(r => !linked.has(r.id)); guard++) {
        let progress = false;
        for (const r of rooms.slice().sort((a, c) => (a.gameplay === false) - (c.gameplay === false))) {
            if (linked.has(r.id)) continue;
            const options = joints.filter(jt => (jt.a === r.id && linked.has(jt.c) && gameplay(jt.c)) || (jt.c === r.id && linked.has(jt.a) && gameplay(jt.a)));
            const toHall = options.filter(jt => jt.a === root || jt.c === root);
            const choice = pick(toHall.length ? toHall : options);
            if (choice && addDoor(choice, choice.a === r.id ? choice.c : choice.a, r.id)) { linked.add(r.id); progress = true; }
        }
        if (!progress) break;
    }
    // Unlinked rooms (walled in by service rooms): fold into the hall rather than ship a sealed room.
    for (const r of rooms) if (!linked.has(r.id)) {
        for (const [id, t] of region) if (t === r.id) region.set(id, 'hall');
        repairs.push({ kind: 'unreachable-room-to-hall', floor, room: r.id });
        return finishPlan(b, floor, region, rooms.filter(x => x !== r), core, repairs, seed);
    }
    // Second ways in (XCOM breaching): gameplay rooms get another door on a different joint where one exists.
    for (const r of rooms.filter(r => r.gameplay !== false)) {
        if ((doorCount.get(r.id) || 0) >= 2) continue;
        const own = doors.filter(d => d.room === r.id || d.other === r.id);
        const options = joints.filter(jt => (jt.a === r.id || jt.c === r.id) && gameplay(jt.a) && gameplay(jt.c) && !own.some(d => Math.abs(d.x - jt.x) + Math.abs(d.y - jt.y) < 3));
        const other = options.filter(jt => !own.some(d => (d.room === jt.a || d.other === jt.a) && (d.room === jt.c || d.other === jt.c)));
        const choice = pick(other.length ? other : options);
        if (choice) addDoor(choice, choice.a, choice.c);
    }
    const cellsOf = id => [...cellRegion].filter(([, r]) => r === id).map(([k]) => k.split(',').map(Number));
    const out = [{ id: 'hall', kind: 'hall', gameplay: true, cells: cellsOf('hall') }];
    for (const r of rooms) out.push({ id: r.id, kind: r.kind, gameplay: r.gameplay !== false, areaShare: r.areaShare, cells: cellsOf(r.id), bays: [...region].filter(([, t]) => t === r.id).map(([k]) => k.split(',').map(Number)) });
    return { floor, layout: 'v3', rooms: out.filter(r => r.cells.length), walls, doors, core: core ? { x: core.x, y: core.y, ci: core.ci, cj: core.cj, layout: 'v3' } : { x: 1, y: 1, layout: 'v3', none: true },
        regions: Object.fromEntries(region), repairs };
}
