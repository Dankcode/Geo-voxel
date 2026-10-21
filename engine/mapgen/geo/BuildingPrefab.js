// Building prefabs: a generated building (a real one from a geo import, or any ModernBuilder building) frozen into a
// reusable asset that any map can stamp down at any of 4 rotations, optionally mirrored.
//
//   bakePrefab(mission, group)   → prefab JSON: the building's voxels (walls, floors, stairs, glazing, furniture,
//                                  roof plant) inside its own footprint, its rooms, building records (wings, exits,
//                                  doors, windows, stairs, approach), render hints and decor, half-window openings —
//                                  in local coordinates, with a material palette (survives the material table changing)
//   stampPrefab(m, prefab, at)   → writes it into a MapKit map: voxels and room ids, new room records, building
//                                  records in m.buildings, hints/decor, keep-clear approaches; returns the records
//   transformCell / sides        → the shared rotation/mirror rules
//
// Rotation k turns the prefab clockwise on the grid by k × 90° (north → east); mirror flips it east–west first.
// Mirroring flips furniture yaw too, but a mesh that is not left–right symmetric is still drawn unmirrored.
import { MATERIALS, MAT, AIR } from '../../voxel/Materials.js';

export const PREFAB_FORMAT = 'voxel-tactics/building-prefab@1';
const SIDE_CW = { n: 'e', e: 's', s: 'w', w: 'n' }, SIDE_MIRROR = { e: 'w', w: 'e', n: 'n', s: 's' };

/** Local frame → placed frame. size [w, d]; returns { cell([x, y]) for cell indices, point([x, y]) for continuous
 *  coordinates, side(s), yawHint(y), yawDecor(y), axis(a), size: [w', d'] }. */
export function transformFor([w, d], { rot = 0, mirror = false } = {}) {
    const k = ((rot % 4) + 4) % 4;
    const cell = ([x, y]) => { if (mirror) x = w - 1 - x; let W = w, D = d; for (let i = 0; i < k; i++) { [x, y] = [D - 1 - y, x]; [W, D] = [D, W]; } return [x, y]; };
    const point = ([x, y]) => { if (mirror) x = w - x; let W = w, D = d; for (let i = 0; i < k; i++) { [x, y] = [D - y, x]; [W, D] = [D, W]; } return [x, y]; };
    const side = s => { if (!s) return s; if (mirror) s = SIDE_MIRROR[s]; for (let i = 0; i < k; i++) s = SIDE_CW[s]; return s; };
    const yawHint = y => (mirror ? Math.PI - y : y) - k * Math.PI / 2;     // hints: facing (cos yaw, −sin yaw)
    const yawDecor = y => (mirror ? -y : y) - k * Math.PI / 2;             // decor: facing (sin yaw, cos yaw)
    const axis = a => k % 2 ? (a === 'x' ? 'y' : a === 'y' ? 'x' : a) : a;
    return { cell, point, side, yawHint, yawDecor, axis, size: k % 2 ? [d, w] : [w, d], k, mirror };
}

/**
 * Bake one building (all wing records sharing `group`, or the record with that id) out of a finished mission.
 * opts: { id, name, source: { place, osm } }
 */
export function bakePrefab(mission, group, { id = group, name = null, source = null } = {}) {
    const s = mission.store, recs = mission.buildings.filter(b => (b.group || b.id) === group);
    if (!recs.length) throw Error(`prefab: no building ${group}`);
    const z0 = Math.min(...recs.map(r => r.baseZ)), top = Math.max(...recs.map(r => r.top)), z1 = Math.min(s.height - 1, top + 2);
    // footprint: wing rectangles + solid wall mass columns (outline slivers built to the roofline)
    let x0 = Math.min(...recs.map(r => r.x0)), y0 = Math.min(...recs.map(r => r.y0)), x1 = Math.max(...recs.map(r => r.x0 + r.w - 1)), y1 = Math.max(...recs.map(r => r.y0 + r.d - 1));
    const inRec = (x, y) => recs.some(r => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d);
    const others = mission.buildings.filter(b => !recs.includes(b));
    const theirs = (x, y) => others.some(r => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d);
    const massCol = (x, y) => { if (theirs(x, y)) return false; for (let z = z0 + 1; z <= top; z++) if (!s.isSolid(x, y, z)) return false; return true; };
    const foot = new Set();
    for (let y = y0 - 2; y <= y1 + 2; y++) for (let x = x0 - 2; x <= x1 + 2; x++) if (inRec(x, y) || massCol(x, y) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inRec(x + dx, y + dy) || massCol(x + dx, y + dy) && inRec(x + 2 * dx, y + 2 * dy))) foot.add(`${x},${y}`);
    for (const k of foot) { const [x, y] = k.split(',').map(Number); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const W = x1 - x0 + 1, D = y1 - y0 + 1, H = z1 - z0 + 1;
    const roomIds = new Map(), rooms = [];
    for (const r of mission.rooms) if (recs.some(b => b.id === r.buildingId)) { roomIds.set(r.id, rooms.length); rooms.push(r); }
    const palette = [], pal = new Map();
    const P = id => { if (!pal.has(id)) { pal.set(id, palette.length); palette.push(MATERIALS[id]?.key ?? 'air'); } return pal.get(id); };
    // RLE over (z, y, x): [count, material (palette index, −1 = not part of the building), room (local index, −1)]
    const voxels = [];
    let run = null;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const mine = foot.has(`${x},${y}`);
        const m = mine ? P(s.get(x, y, z)) : -1, room = mine ? (roomIds.get(s.roomAt(x, y, z)) ?? -1) : -1;
        if (run && run[1] === m && run[2] === room) run[0]++; else { if (run) voxels.push(...run); run = [1, m, room]; }
    }
    if (run) voxels.push(...run);
    const L = ([x, y]) => [x - x0, y - y0], Lz = z => z - z0;
    const lp = o => o && { ...o, x: o.x - x0, y: o.y - y0, ...(o.z != null ? { z: Lz(o.z) } : {}) };
    const lr = r => ({ ...r, id: roomIds.get(r.id), buildingId: r.buildingId, cells: r.cells.map(L), floorZ: Lz(r.floorZ), doors: (r.doors || []).map(lp) });
    const records = recs.map(b => ({ ...b, x0: b.x0 - x0, y0: b.y0 - y0, baseZ: Lz(b.baseZ), top: Lz(b.top),
        rooms: b.rooms.map(r => roomIds.get(r.id)), doors: (b.doors || []).map(lp), windows: (b.windows || []).map(lp),
        stairs: (b.stairs || []).map(st => ({ ...st, cells: st.cells.map(lp), before: lp(st.before), after: lp(st.after) })),
        approach: (b.approach || []).map(L), entry: lp(b.entry), exits: (b.exits || []).map(lp), floorCells: (b.floorCells || []).map(L) }));
    // hints and decor inside the footprint
    const hints = {};
    const inFoot = (x, y) => foot.has(`${Math.floor(x)},${Math.floor(y)}`);
    for (const [key, h] of Object.entries(mission.visual?.hints || {})) {
        const [x, y, z] = key.split(',').map(Number);
        if (!inFoot(x, y) || z < z0 || z > z1) continue;
        const lk = c => { const [a, b, cz] = c.split(',').map(Number); return `${a - x0},${b - y0},${cz - z0}`; };
        const o = { ...h };
        if (o.member) o.member = lk(o.member);
        if (o.cells) o.cells = o.cells.map(lk);
        if (o.centre) o.centre = [o.centre[0] - x0, o.centre[1] - y0];
        if (o.z != null) o.z = Lz(o.z);
        if (o.materials) o.materials = o.materials.map(P);
        hints[lk(key)] = o;
    }
    const decor = (mission.visual?.decor || []).filter(dd => inFoot(dd.x + 0.5, dd.y + 0.5) && dd.z >= z0 && dd.z <= z1 + 1)
        .map(dd => ({ ...dd, x: dd.x - x0, y: dd.y - y0, z: Lz(dd.z), room: dd.room != null ? roomIds.get(dd.room) ?? null : undefined }));
    const openings = [...s.windowOpenings].filter(([k]) => { const [x, y, z] = k.split(',').map(Number); return foot.has(`${x},${y}`) && z >= z0 && z <= z1; })
        .map(([k, a]) => { const [x, y, z] = k.split(',').map(Number); return [x - x0, y - y0, z - z0, a]; });
    const corners = [...s.squareCorners].filter(k => foot.has(k)).map(k => L(k.split(',').map(Number)));
    const main = recs.find(r => r.wing === 0) || recs[0];
    return { format: PREFAB_FORMAT, id, name: name || main.realName || main.name || id, source, program: main.program, storeys: main.storeys, front: main.front,
        size: [W, D, H], footprint: [...foot].map(k => L(k.split(',').map(Number))), palette, voxels, rooms: rooms.map(lr), records, hints, decor, openings, corners };
}

/**
 * Stamp a prefab into a MapKit map. at: { x, y, z (world baseZ), rot, mirror, as (id prefix) }.
 * register(cells, origin) is called with every written voxel (e.g. district origin bookkeeping). Returns the records.
 */
export function stampPrefab(m, prefab, { x = 0, y = 0, z = 1, rot = 0, mirror = false, as = prefab.id, register = null } = {}) {
    if (prefab.format !== PREFAB_FORMAT) throw Error(`prefab: unknown format ${prefab.format}`);
    const s = m.store, [W, D, H] = prefab.size, T = transformFor([W, D], { rot, mirror });
    const ids = prefab.palette.map(k => k === 'air' ? AIR : MAT[k]);
    if (ids.some(v => v == null)) throw Error(`prefab ${prefab.id}: material missing from this build`);
    const wc = (lx, ly) => { const [a, b] = T.cell([lx, ly]); return [x + a, y + b]; };
    const wp = (lx, ly) => { const [a, b] = T.point([lx, ly]); return [x + a, y + b]; };
    // rooms first (new ids), then voxels with room ids
    const roomRecs = prefab.rooms.map(r => ({ ...r, id: m.ctx.nextRoomId(), buildingId: `${as}:${r.buildingId}`, cells: r.cells.map(([a, b]) => wc(a, b)), floorZ: r.floorZ + z,
        doors: (r.doors || []).map(dd => ({ ...dd, ...xyOf(wc(dd.x, dd.y)), z: dd.z + z })) }));
    const written = [];
    let i = 0;
    for (let r = 0; r < prefab.voxels.length; r += 3) {
        const [count, mat, room] = [prefab.voxels[r], prefab.voxels[r + 1], prefab.voxels[r + 2]];
        if (mat >= 0) for (let c = 0; c < count; c++) {
            const idx = i + c, lx = idx % W, ly = Math.floor(idx / W) % D, lz = Math.floor(idx / (W * D));
            const [wx, wy] = wc(lx, ly), wz = z + lz;
            if (!s.inBounds(wx, wy, wz)) continue;
            s.set(wx, wy, wz, ids[mat]);
            s.rooms[s.index(wx, wy, wz)] = room >= 0 ? roomRecs[room].id : -1;
            if (ids[mat] !== AIR) written.push([wx, wy, wz]);
        }
        i += count;
    }
    for (const r of roomRecs) m.ctx.rooms.push(r);
    const P = o => o && { ...o, ...xyOf(wc(o.x, o.y)), ...(o.z != null ? { z: o.z + z } : {}), ...(o.side ? { side: T.side(o.side) } : {}) };
    const out = prefab.records.map(b => {
        const [ax, ay] = wc(b.x0, b.y0), [bx, by] = wc(b.x0 + b.w - 1, b.y0 + b.d - 1);
        return { ...b, id: `${as}:${b.id}`, group: as, x0: Math.min(ax, bx), y0: Math.min(ay, by), w: Math.abs(bx - ax) + 1, d: Math.abs(by - ay) + 1, baseZ: b.baseZ + z, top: b.top + z,
            front: T.side(b.front), rooms: b.rooms.map(ri => roomRecs[ri]), doors: (b.doors || []).map(P), windows: (b.windows || []).map(P),
            stairs: (b.stairs || []).map(st => ({ ...st, cells: st.cells.map(P), before: P(st.before), after: P(st.after) })),
            approach: (b.approach || []).map(([a, c]) => wc(a, c)), entry: P(b.entry), exits: (b.exits || []).map(P), floorCells: (b.floorCells || []).map(([a, c]) => wc(a, c)),
            mergedWith: (b.mergedWith || []).map(idd => `${as}:${idd}`), prefab: { id: prefab.id, rot, mirror } };
    });
    for (const b of out) {
        m.buildings.push(b);
        for (const [a, c] of b.approach) m.keep.add(`${a},${c}`);
        for (const e of b.exits) m.keep.add(`${e.x},${e.y}`);
    }
    const wk = key => { const [a, b, c] = key.split(',').map(Number); const [wx, wy] = wc(a, b); return `${wx},${wy},${c + z}`; };
    for (const [key, h] of Object.entries(prefab.hints)) {
        const o = { ...h };
        if (o.member) o.member = wk(o.member);
        if (o.cells) o.cells = o.cells.map(wk);
        if (o.centre) o.centre = wp(o.centre[0], o.centre[1]);
        if (o.z != null) o.z = o.z + z;
        if (o.yaw != null) o.yaw = T.yawHint(o.yaw);
        if (o.materials) o.materials = o.materials.map(pi => ids[pi]);
        m.ctx.hints[wk(key)] = o;
    }
    for (const dd of prefab.decor) {
        const [wx, wy] = wc(dd.x, dd.y);
        m.ctx.decor.push({ ...dd, x: wx, y: wy, z: dd.z + z, ...(dd.yaw != null ? { yaw: T.yawDecor(dd.yaw) } : {}), ...(dd.room != null ? { room: roomRecs[dd.room]?.id } : {}) });
    }
    for (const [a, b, c, ax] of prefab.openings) { const [wx, wy] = wc(a, b); s.windowOpenings.set(`${wx},${wy},${c + z}`, T.axis(ax)); }
    for (const [a, b] of prefab.corners) { const [wx, wy] = wc(a, b); s.squareCorners.add(`${wx},${wy}`); }
    register?.(written, `prefab:${prefab.id}`);
    return out;
}
const xyOf = ([x, y]) => ({ x, y });

/** Bake every real building of a geo mission (one prefab per outline group). */
export function bakePlacePrefabs(mission, { place }) {
    const groups = [...new Set(mission.buildings.map(b => b.group || b.id))];
    return groups.map(g => { const b = mission.buildings.find(r => (r.group || r.id) === g); return bakePrefab(mission, g, { id: `${place}--${g}`, source: { place, osm: b.osm || null, group: g } }); });
}
