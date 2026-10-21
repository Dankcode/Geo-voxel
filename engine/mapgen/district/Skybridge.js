// PLAN-06 §5.7 — buildings stay off the street; the one exception is a skybridge, a connector building that spans
// a road from one building to the building facing it.
//
// Rules: both ends are buildings of 2+ storeys on opposite sides of the same road, directly facing (≥ 5 cells of
// overlap along the road); the bridge floor is at storey 2 (baseZ + 3), which leaves the street below its clearance;
// it is 3 cells wide inside (walls and a glazed band either side, a roof slab); doors are cut into both facades with
// clear landings; nothing stands in the carriageway. The corridor is registered as a room so cutaways and noise
// treat it as interior.
import { MAT } from '../../voxel/Materials.js';
import { put, k3 } from './Core.js';
import { STOREY } from '../../mission/modern/ModernBuilder.js';

const CLEARABLE = new Set([MAT.door, MAT.door_open, MAT.glass, MAT.brick, MAT.stucco, MAT.concrete_wall, MAT.siding, MAT.plaster, MAT.cabinet, MAT.shelving, MAT.desk, MAT.sofa, MAT.appliance, MAT.furniture, MAT.shelf, MAT.bed]);

export function buildSkybridges(m, roads, { max = 2, rng } = {}) {
    const out = [];
    for (const r of roads) {
        if (out.length >= max) break;
        const across = r.axis === 'x' ? 'y' : 'x';
        const sideA = m.buildings.filter(b => b.storeys >= 2 && (across === 'y' ? b.y0 + b.d - 1 < r.lo - 1 : b.x0 + b.w - 1 < r.lo - 1));
        const sideB = m.buildings.filter(b => b.storeys >= 2 && (across === 'y' ? b.y0 > r.hi + 1 : b.x0 > r.hi + 1));
        const pairs = [];
        for (const a of sideA) for (const b of sideB) {
            if (a.baseZ !== b.baseZ) continue;
            const [lo, hi] = across === 'y' ? [Math.max(a.x0, b.x0) + 1, Math.min(a.x0 + a.w, b.x0 + b.w) - 2] : [Math.max(a.y0, b.y0) + 1, Math.min(a.y0 + a.d, b.y0 + b.d) - 2];
            if (hi - lo < 4) continue;
            const gap = across === 'y' ? b.y0 - (a.y0 + a.d) : b.x0 - (a.x0 + a.w);
            if (gap > 20 || gap < r.hi - r.lo + 3) continue;
            pairs.push({ a, b, c: Math.floor((lo + hi) / 2), gap });
        }
        pairs.sort((p, q) => p.gap - q.gap || p.c - q.c);
        for (const p of pairs) { if (out.length >= max) break; const br = tryBridge(m, r, p, across); if (br) out.push(br); }
    }
    return out;
}

function tryBridge(m, road, { a, b: bB, c }, across) {
    const b = bB;
    const s = m.store, z = a.baseZ + STOREY, id = `skybridge-${a.id}-${b.id}`;
    // Local: t runs across the road (from a's facade to b's), w along it (-2..2; ±2 are the walls).
    const span = across === 'y' ? [a.y0 + a.d, b.y0 - 1] : [a.x0 + a.w, b.x0 - 1];
    const at = (t, w) => across === 'y' ? [c + w, t] : [t, c + w];
    for (let t = span[0]; t <= span[1]; t++) for (let w = -2; w <= 2; w++) { const [x, y] = at(t, w); for (let h = 0; h <= 3; h++) if (s.isSolid(x, y, z + h)) return null; }
    // Facade cells and the landing just inside each building must be storey-2 floor, not a stair.
    const facades = [[span[0] - 1, span[0] - 2], [span[1] + 1, span[1] + 2]];
    for (const [wall, inside] of facades) for (let w = -1; w <= 1; w++) {
        const [ix, iy] = at(inside, w);
        if (!s.isSolid(ix, iy, z) || [MAT.stairs_wood, MAT.stairs_stone, MAT.steel_stair].includes(s.get(ix, iy, z + 1))) return null;
        const [wx, wy] = at(wall, w); if (!s.isSolid(wx, wy, z)) return null;
    }
    const cells = [];
    for (let t = span[0]; t <= span[1]; t++) for (let w = -2; w <= 2; w++) {
        const [x, y] = at(t, w), o = `skybridge:${id}`;
        put(m, x, y, z, 'concrete', o);
        if (Math.abs(w) === 2) { put(m, x, y, z + 1, 'concrete_wall', o); put(m, x, y, z + 2, 'glass', o); }
        else cells.push([x, y]);
        put(m, x, y, z + 3, 'roof', o);
    }
    // Doorways through both facades, landings cleared of partitions and furniture.
    for (const [wall, inside] of facades) for (let w = -1; w <= 1; w++) for (const t of [wall, inside]) {
        const [x, y] = at(t, w);
        for (let h = 1; h <= 2; h++) { const v = s.get(x, y, z + h); if (t === wall || CLEARABLE.has(v)) { s.set(x, y, z + h, 0); delete m.hints[k3(x, y, z + h)]; } }
    }
    const roomId = m.ctx.nextRoomId();
    for (const [x, y] of cells) for (let h = 1; h <= 2; h++) s.rooms[s.index(x, y, z + h)] = roomId;
    m.ctx.rooms.push({ id: roomId, buildingId: id, storey: 1, kind: 'corridor', gameplay: true, cells, floorZ: z, lit: true, doors: [] });
    // Record the two doorways on their buildings so breach counts see the corridor's two ways in.
    for (const [owner, [wall]] of [[a, facades[0]], [b, facades[1]]]) { const [x, y] = at(wall, 0); owner.doors.push({ x, y, z, storey: 1, exterior: false, open: true, locked: false }); }
    const ends = [at(span[0] - 2, 0), at(span[1] + 2, 0)];
    const bridge = { id, road: road.id, from: a.id, to: b.id, z, cells: cells.length, sockets: ends.map(([x, y]) => ({ x, y, z })) };
    m.district.bridges.push(bridge);
    m.district.connectors.push({ id, template: 'skybridge', sockets: bridge.sockets, cells: cells.filter((_, i) => i % 3 === 1).map(([x, y]) => ({ x, y, z })) });
    return bridge;
}
