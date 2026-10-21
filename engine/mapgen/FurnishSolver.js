// PLAN-04 §5.3 step 5, pass B — furnishing by WFC over room slots, with clutter noise and the interior line of play.
//
// Each gameplay room is cut into slots: runs of wall-backed cells along each wall (chunks of 2–4) and 2-cell centre
// chunks clear of the walls. A slot's tiles are the room programme's pre-baked furniture clusters that fit it (the
// same clusters and tile-set pieces as ModernBuilder) or nothing. Sockets: footprints never overlap, a wall cluster's
// front row stays clear, centre clusters keep a cell of clearance all round, door swings and the stair core are never
// slots. Weights: the programme's order, a clutter noise (tidy office ↔ ransacked squat) for density, and the
// interior line of play — clusters that give cover 2–3 cells inside a breach door weigh more, so every room has cover
// where its fight starts. Story beats (the command room's CCTV bank or cash table, an arms cache) are pinned first.
// A connectivity guard drops any cluster that would split the floor (local repair).
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
import { FURNITURE_ITEMS, ROOM_FURNITURE, footprintApi, floorComponents, PLANT_ROOMS, YAW_OF } from '../mission/modern/ModernBuilder.js';
import { MAT, AIR } from '../voxel/Materials.js';
import { fbm, NOISE_LAYERS } from './Fields.js';
import { STOREY } from './KitMetric.js';
import { hashString } from '../util/Rng.js';

const k2 = (x, y) => `${x},${y}`;
const unit = s => (hashString(s) >>> 0) / 4294967296;
const SIDE = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** Story-beat clusters (PLAN-04: beat props are fixed tiles placed first, as WFC pins). */
export const BEAT_ITEMS = Object.freeze({
    cctv_bank: { mat: 'desk', len: 3, minLen: 2, dep: 1, h: 1, place: 'wall', piece: (i, j, n) => (i === 0 ? 'desk_end_l' : i === n - 1 ? 'desk_end_r' : 'desk_mid'),
        decor: (f, add) => { for (let i = 0; i < f.len; i++) { add('monitor', f.top(i)); add('office_chair', f.front(1, i)); } } },
    cash_table: { mat: 'desk', len: 2, dep: 1, h: 1, place: 'center', piece: i => (i === 0 ? 'desk_end_l' : 'desk_end_r'),
        decor: (f, add) => { add('cash_stack', f.top(0)); add('cash_stack', f.top(1)); add('office_chair', f.front(1, 0)); add('office_chair', f.front(-1, 1, Math.PI)); } },
    arms_cache: { mat: 'crate', len: 2, dep: 1, h: 1, place: 'wall', piece: () => null, decor: (f, add) => add('rifle_rack', f.top(0)) },
    squat: { mat: 'bed', len: 1, dep: 2, h: 1, place: 'wall', piece: (i, j) => (j === 0 ? 'bed_head_single' : 'bed_foot_single') }
});
const ITEMS = { ...FURNITURE_ITEMS, ...BEAT_ITEMS };
const COVER_ITEMS = new Set(['sofa', 'loveseat', 'kitchen', 'island', 'desk', 'desk_pair', 'conference', 'counter', 'reception', 'checkout', 'aisle', 'produce', 'hardware_shelf', 'warehouse_rack', 'stock_rack', 'wall_shelf', 'crates', 'pallet_stack', 'pallets', 'workbench', 'booth', 'bookcase', 'filing', 'wardrobe', 'lockers', 'cctv_bank', 'cash_table', 'arms_cache']);
const BEAT_FOR = { climax: { office: 'cctv_bank', warehouse: 'cctv_bank', garage: 'cctv_bank', house: 'cash_table', apartment: 'cash_table', shop: 'cash_table', diner: 'cash_table' }, escalation: 'arms_cache' };

/** Wall runs and centre chunks of a room (cells already free of doors, stairs and the core). */
export function roomSlots(store, room, free, fz) {
    const inRoom = new Set(room.cells.map(([x, y]) => k2(x, y)));
    const wallAt = (x, y) => !inRoom.has(k2(x, y)) && store.isSolid(x, y, fz + 1) && store.get(x, y, fz + 1) !== MAT.door;
    const claimed = new Set(), slots = [];
    for (const side of ['n', 'e', 's', 'w']) {
        const [dx, dy] = SIDE[side], along = dx ? [0, 1] : [1, 0];
        const cells = room.cells.filter(([x, y]) => free.has(k2(x, y)) && !claimed.has(k2(x, y)) && wallAt(x + dx, y + dy))
            .sort((a, b) => (a[1] - b[1]) * (dx ? 1 : 0) + (a[0] - b[0]) * (dx ? 0 : 1) || a[0] - b[0] || a[1] - b[1]);
        // Maximal straight runs along the wall, cut into chunks of 3 (a short tail joins its neighbour).
        let run = [];
        const flush = () => {
            for (let i = 0; i < run.length;) {
                const rest = run.length - i, len = rest <= 4 ? rest : 3;
                if (len >= 1) slots.push({ id: `w${slots.length}`, kind: 'wall', side, cells: run.slice(i, i + len), along, away: [-dx, -dy] });
                i += len;
            }
            run = [];
        };
        for (const c of cells) {
            const last = run.at(-1);
            if (last && !(c[0] === last[0] + along[0] && c[1] === last[1] + along[1])) flush();
            run.push(c);
        }
        flush();
        for (const s of slots.filter(s => s.side === side)) for (const c of s.cells) claimed.add(k2(...c));
    }
    // Centre chunks: cells whose four neighbours are all in the room, away from the wall slots.
    const xs = room.cells.map(c => c[0]), ys = room.cells.map(c => c[1]);
    const longX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys), along = longX ? [1, 0] : [0, 1];
    const centre = room.cells.filter(([x, y]) => free.has(k2(x, y)) && !claimed.has(k2(x, y)) && Object.values(SIDE).every(([dx, dy]) => inRoom.has(k2(x + dx, y + dy))))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const used = new Set();
    for (const c of centre) {
        if (used.has(k2(...c))) continue;
        const next = [c[0] + along[0], c[1] + along[1]];
        const pair = centre.some(o => o[0] === next[0] && o[1] === next[1]) && !used.has(k2(...next)) ? [c, next] : [c];
        for (const p of pair) used.add(k2(...p));
        slots.push({ id: `c${slots.length}`, kind: 'center', cells: pair, along, away: longX ? [0, 1] : [1, 0] });
    }
    return slots;
}

/** Footprint of an item in a slot (null when it does not fit). */
function footprint(slot, itemId, len, free) {
    const item = ITEMS[itemId];
    if ((item.place === 'wall') !== (slot.kind === 'wall')) return null;
    if (len > slot.cells.length) return null;
    const o = { x: slot.cells[0][0], y: slot.cells[0][1], along: slot.along, away: slot.away, back: slot.side, center: slot.kind === 'center' };
    const cells = [];
    for (let i = 0; i < len; i++) for (let j = 0; j < item.dep; j++) cells.push({ x: o.x + o.along[0] * i + o.away[0] * j, y: o.y + o.along[1] * i + o.away[1] * j, i, j });
    if (!cells.every(c => free.has(k2(c.x, c.y)))) return null;
    const front = slot.kind === 'wall' ? cells.filter(c => c.j === item.dep - 1).map(c => [c.x + o.away[0], c.y + o.away[1]]) : [];
    const ring = slot.kind === 'center' ? cells.flatMap(c => Object.values(SIDE).map(([dx, dy]) => [c.x + dx, c.y + dy])).filter(([x, y]) => !cells.some(c => c.x === x && c.y === y)) : [];
    return { o, cells, front, ring, len };
}

/**
 * Furnish a compiled v3 building (all floors). m: MapKit map, b: layout building, out: compiled building record.
 * opts.beats: design beats on this building; opts.seed.
 */
export function furnishBuilding(m, b, out, { beats = [], seed = m.seed } = {}) {
    const s = m.store, hints = m.ctx.hints, decor = m.ctx.decor, report = [];
    for (const f of b.floors) {
        const fz = m.G + STOREY * f.floor, rooms = out.rooms.filter(r => r.storey === f.floor);
        const floorSet = new Set(rooms.filter(r => r.gameplay).flatMap(r => r.cells.map(c => k2(...c))));
        const keep = new Set(), blocked = new Set();
        const doors = out.doors.filter(d => d.storey === f.floor && !d.locked);
        for (const d of doors) { floorSet.add(k2(d.x, d.y)); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keep.add(k2(d.x + dx, d.y + dy)); }
        for (const run of out.stairs) if (run.storey === f.floor || run.storey === f.floor - 1) for (const c of [run.before, ...run.cells, run.after]) { keep.add(k2(c.x, c.y)); blocked.add(k2(c.x, c.y)); }
        for (const c of rooms.find(r => r.kind === 'hall')?.cells || []) keep.add(k2(...c));
        // PLAN-10: ground-floor windows are vault lines, so the cell inside each one stays clear as a landing.
        if (f.floor === 0) for (const w of out.windows.filter(w => w.storey === 0 && (w.kind === 'window' || w.kind === 'band')))
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (floorSet.has(k2(w.x + dx, w.y + dy))) keep.add(k2(w.x + dx, w.y + dy));
        let parts = floorComponents(floorSet, blocked);
        for (const room of rooms) {
            if (!room.gameplay || room.kind === 'hall') continue;
            const free = new Set(room.cells.filter(([x, y]) => !keep.has(k2(x, y)) && !blocked.has(k2(x, y)) && s.get(x, y, fz + 1) === AIR).map(c => k2(...c)));
            const slots = roomSlots(s, room, free, fz);
            const beatHere = beats.find(bt => bt.floor === f.floor && (bt.room === room.name || bt.room === room.kind) && bt.id !== 'approach');
            if (!slots.length) {
                if (beatHere) { const [x, y] = room.cells[Math.floor(room.cells.length / 2)]; decor.push({ kind: beatHere.id === 'climax' ? 'cash_stack' : 'rifle_rack', x, y, z: fz + 1, yaw: 0, room: room.id }); report.push({ kind: 'beat', beat: beatHere.id, item: 'decor', room: room.name }); }
                continue;
            }
            const cx = room.cells.reduce((a, c) => a + c[0], 0) / room.cells.length, cy = room.cells.reduce((a, c) => a + c[1], 0) / room.cells.length;
            const clutter = fbm(`${seed}:${b.id}:clutter`, cx, cy + f.floor * 17, NOISE_LAYERS.clutter);
            const roomDoors = doors.filter(d => room.cells.some(([x, y]) => Math.abs(x - d.x) + Math.abs(y - d.y) === 1));
            const fight = cells => Math.min(9, ...cells.map(c => Math.min(9, ...roomDoors.map(d => Math.max(Math.abs(c.x - d.x), Math.abs(c.y - d.y))))));
            // Beat pin: the beat's cluster on the slot that fits it best (largest first).
            const beat = beats.find(bt => bt.floor === f.floor && (bt.room === room.name || bt.room === room.kind) && bt.id !== 'approach');
            const beatWanted = beat ? (beat.id === 'climax' ? BEAT_FOR.climax[b.program] || 'cash_table' : BEAT_FOR.escalation) : null;
            // The beat falls back through the other beat clusters until one fits a slot in this room.
            const beatItem = beatWanted ? [beatWanted, 'cash_table', 'cctv_bank', 'arms_cache'].find(id => slots.some(sl => [ITEMS[id].len, ITEMS[id].minLen].filter(Boolean).some(len => footprint(sl, id, len, free)))) || null : null;
            if (beat && !beatItem) {
                // No slot fits any beat cluster: the beat is dressed as props on the floor (visual), never omitted.
                const [x, y] = room.cells.filter(([x, y]) => free.has(k2(x, y)))[0] || room.cells[0];
                decor.push({ kind: beat.id === 'climax' ? 'cash_stack' : 'rifle_rack', x, y, z: fz + 1, yaw: 0, room: room.id });
                report.push({ kind: 'beat', beat: beat.id, item: 'decor', room: room.name });
            }
            const pool = [...new Set([...(ROOM_FURNITURE[room.kind] || []), ...(beatItem ? [beatItem] : [])])];
            const order = new Map((ROOM_FURNITURE[room.kind] || []).map((id, i) => [id, i]));
            const geo = new Map(), domains = new Map(), fixed = new Map();
            for (const slot of slots) {
                const dom = ['empty'];
                for (const id of pool) for (const len of [...new Set([ITEMS[id].len, ITEMS[id].minLen].filter(Boolean))]) {
                    const g = footprint(slot, id, len, free); if (!g) continue;
                    const t = `${id}@${len}`; dom.push(t); geo.set(`${slot.id}|${t}`, g);
                }
                domains.set(slot.id, dom);
            }
            if (beatItem) {
                const host = slots.map(sl => ({ sl, t: domains.get(sl.id).filter(t => t.startsWith(`${beatItem}@`)).sort().reverse()[0] })).filter(x => x.t)[0];
                if (host) { fixed.set(host.sl.id, host.t); domains.set(host.sl.id, [host.t]); }
            }
            const near = (a, b) => a.cells.some(([x, y]) => b.cells.some(([u, v]) => Math.abs(x - u) + Math.abs(y - v) <= 2));
            const nodes = slots.map(sl => ({ id: sl.id, neighbors: slots.filter(o => o !== sl && near(sl, o)).map(o => ({ id: o.id, direction: 'near' })) }));
            const g = (slot, t) => (t === 'empty' ? null : geo.get(`${slot}|${t}`));
            const clash = (A, B) => {
                if (!A || !B) return false;
                const has = (list, x, y) => list.some(c => (c.x ?? c[0]) === x && (c.y ?? c[1]) === y);
                return A.cells.some(c => has(B.cells, c.x, c.y) || has(B.front, c.x, c.y) || has(B.ring, c.x, c.y)) || B.cells.some(c => has(A.front, c.x, c.y) || has(A.ring, c.x, c.y));
            };
            const weight = (slotId, t) => {
                if (t === 'empty') return 0.3 + 1.2 * (1 - clutter);
                const id = t.split('@')[0], G = geo.get(`${slotId}|${t}`);
                let w = 1.6 - 0.25 * (order.get(id) ?? 3);
                const d = fight(G.cells);
                if (COVER_ITEMS.has(id) && d >= 2 && d <= 3) w *= 2.5;
                if (id === beatItem) w *= 4;
                return Math.max(0.05, w * (0.8 + clutter));
            };
            let pick;
            try { pick = solveWaveFunctionCollapse({ nodes, tiles: [...new Set([...domains.values()].flat())].map(id => ({ id, weight: 1 })), domains, fixed, nodeWeights: weight, compatible: (a, c, _d, src, dst) => !clash(g(src, a), g(dst, c)), seed: `${seed}:${b.id}:${f.floor}:${room.name}:furnish` }); }
            catch { pick = new Map(slots.map(sl => [sl.id, fixed.get(sl.id) || 'empty'])); }
            // Place in priority order with the connectivity guard and the furniture cap.
            const cap = Math.ceil(room.cells.length * (0.25 + 0.2 * clutter));
            let used = 0;
            const chosen = slots.map(sl => ({ sl, t: pick.get(sl.id) })).filter(x => x.t && x.t !== 'empty')
                .sort((a, c) => (a.t.startsWith(`${beatItem}@`) ? -1 : 0) - (c.t.startsWith(`${beatItem}@`) ? -1 : 0) || (order.get(a.t.split('@')[0]) ?? 9) - (order.get(c.t.split('@')[0]) ?? 9));
            // Each cluster appears as often as the programme lists it (the beat once); WFC picks where, not how many.
            const allowed = new Map(); for (const id of ROOM_FURNITURE[room.kind] || []) allowed.set(id, (allowed.get(id) || 0) + 1);
            if (beatItem) allowed.set(beatItem, 1);
            const count = new Map();
            for (const { sl, t } of chosen) {
                const [id] = t.split('@'), item = ITEMS[id], G = geo.get(`${sl.id}|${t}`);
                if ((count.get(id) || 0) >= (allowed.get(id) || 0)) continue;
                if (used + G.cells.length > cap && id !== beatItem) continue;
                for (const c of G.cells) blocked.add(k2(c.x, c.y));
                const after = floorComponents(floorSet, blocked);
                if (after > parts) { for (const c of G.cells) blocked.delete(k2(c.x, c.y)); report.push({ kind: 'guard-drop', room: room.name, item: id }); continue; }
                parts = after; used += G.cells.length; count.set(id, (count.get(id) || 0) + 1);
                const yaw = Math.atan2(-G.o.along[1], G.o.along[0]);
                for (const c of G.cells) for (let h = 0; h < item.h; h++) {
                    s.set(c.x, c.y, fz + 1 + h, MAT[item.mat]);
                    const piece = item.piece(c.i, c.j, G.len, h);
                    if (piece) hints[`${c.x},${c.y},${fz + 1 + h}`] = { piece, yaw };
                }
                const api = footprintApi(G.o, G.cells, G.len, item.dep, fz, yaw);
                const add = (kind, p, extra = {}) => { if (p) decor.push({ kind, x: p.x, y: p.y, z: p.z ?? fz + 1, yaw: p.yaw ?? yaw, ...extra, room: room.id }); };
                if (item.top) add(item.top, api.top((G.len - 1) / 2));
                item.decor?.(api, add);
                if (id === beatItem) report.push({ kind: 'beat', beat: beat.id, item: id, room: room.name });
            }
            // Dressing: plants in free corners, wall art, and clutter (papers, debris) where the noise says ransacked.
            const isFree = (x, y) => free.has(k2(x, y)) && !blocked.has(k2(x, y)) && s.get(x, y, fz + 1) === AIR;
            const wallSides = (x, y) => Object.entries(SIDE).filter(([, [dx, dy]]) => !room.cells.some(c => c[0] === x + dx && c[1] === y + dy) && s.isSolid(x + dx, y + dy, fz + 1));
            if (PLANT_ROOMS.has(room.kind)) for (const [x, y] of room.cells.filter(([x, y]) => isFree(x, y) && wallSides(x, y).length >= 2).slice(0, 1 + (clutter < 0.5 ? 1 : 0)))
                decor.push({ kind: unit(`${seed}:${room.id}:${x},${y}`) < 0.5 ? 'plant' : 'plant_tall', x, y, z: fz + 1, yaw: unit(`${room.id}:${x}:${y}`) * 6.28, room: room.id });
            if (['living', 'bedroom', 'lobby', 'unit', 'office', 'meeting'].includes(room.kind)) {
                const wc = room.cells.filter(([x, y]) => wallSides(x, y).length)[Math.floor(unit(`${seed}:${room.id}:art`) * 4)];
                if (wc) { const [side] = wallSides(...wc)[0]; decor.push({ kind: 'wall_art', x: wc[0], y: wc[1], z: fz + 2, yaw: YAW_OF[side] + Math.PI / 2, side, room: room.id }); }
            }
            const mess = clutter > 0.62 ? Math.round((clutter - 0.55) * 10) : 0;
            for (const [x, y] of room.cells.filter(([x, y]) => isFree(x, y)).sort((a, c) => unit(`${room.id}:${a}`) - unit(`${room.id}:${c}`)).slice(0, mess))
                decor.push({ kind: clutter > 0.78 && unit(`${room.id}:d:${x},${y}`) < 0.4 ? 'debris' : 'papers', x, y, z: fz + 1, yaw: unit(`${room.id}:p:${x},${y}`) * 6.28, room: room.id });
            room.clutter = Math.round(clutter * 100) / 100;
        }
    }
    out.furnishing = report;
    return report;
}
