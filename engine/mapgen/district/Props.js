// PLAN-06 sub-parcel pieces: ground, boundary fences, parking lots, yards, plazas and the small structures parcels
// are made of. Every voxel goes through Core.put with an origin, and every vehicle cell is registered as a stall,
// so nothing here is "scattered": each piece belongs to the parcel that asked for it.
import { MAT } from '../../voxel/Materials.js';
import { k2, put, tag, tagAt, groundAt, inMap, isFree, registerSolids, edgeCells, SIDES } from './Core.js';

const BLOCKING_TAGS = new Set(['road', 'kerb', 'sidewalk', 'driveway', 'building', 'outside', 'stall', 'aisle', 'level', 'channel']);

/** Paint the standing surface of a world rectangle and tag it. Never repaints roads or buildings. */
export function paint(m, r, key, landUse, { z = null, only = null } = {}) {
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
        if (!inMap(m, x, y) || !m.district.contains(x, y)) continue;
        const t = tagAt(m, x, y);
        if (t === 'road' || t === 'kerb' || t === 'building' || t === 'outside') continue;
        if (only && !only(x, y)) continue;
        const g = z ?? groundAt(m, x, y);
        if (m.store.topSolid(x, y) !== g) { if (landUse) tag(m, x, y, landUse); continue; }
        if (key) m.store.set(x, y, g, MAT[key]);
        if (landUse) tag(m, x, y, landUse);
    }
}

/** Can a prop stand on this cell? Free ground, not reserved, not a stall, not a road or a building. */
export function canStand(m, x, y) {
    if (!isFree(m, x, y)) return false;
    if (m.district.stallCells.has(k2(x, y))) return false;
    return !BLOCKING_TAGS.has(tagAt(m, x, y));
}

/** A run of `h`-high voxels over cells, skipping any cell a door, stall or road needs. Returns the cells used. */
export function run(m, cells, key, h, origin, { landUse = null, z = null } = {}) {
    const used = [];
    for (const [x, y] of cells) {
        if (!canStand(m, x, y)) continue;
        const g = z ?? groundAt(m, x, y);
        for (let k = 1; k <= h; k++) put(m, x, y, g + k, key, origin);
        if (landUse) tag(m, x, y, landUse);
        used.push([x, y]);
    }
    return used;
}

/**
 * A boundary fence along one edge of a parcel rectangle (on the parcel's own edge cells). The fence is skipped
 * where a neighbour already fenced the shared edge (no double fences), and broken by `gate` cells, door approaches
 * and stalls. kinds: privacy (full cover, timber), low-wall (half cover, brick), chain (no cover, blocks movement),
 * picket (half cover, timber), hoarding (full cover).
 */
export const FENCES = Object.freeze({
    privacy: { key: 'privacy_fence', h: 2 }, 'low-wall': { key: 'brick', h: 1 }, chain: { key: 'chainlink', h: 2 },
    picket: { key: 'fence', h: 1 }, hoarding: { key: 'privacy_fence', h: 2 }, rail: { key: 'railing', h: 1 }, wall: { key: 'concrete_wall', h: 1 }
});
export function fenceEdge(m, r, side, kind, origin, { gates = [], gateWidth = 2, skipShared = true } = {}) {
    const f = FENCES[kind], cells = edgeCells(r, side), [dx, dy] = SIDES[side];
    if (skipShared) {
        let shared = 0;
        for (const [x, y] of cells) if (tagAt(m, x + dx, y + dy) === 'fence') shared++;
        if (shared >= cells.length * 0.5) return [];
    }
    const gateSet = new Set();
    for (const g of gates) { const i = Math.max(0, Math.min(cells.length - gateWidth, Math.round(g * (cells.length - 1) - gateWidth / 2 + 0.5))); for (let j = 0; j < gateWidth; j++) gateSet.add(i + j); }
    // A gate keeps the cells just inside and outside it clear, so later props never block the way through.
    for (const i of gateSet) { const [x, y] = cells[i]; for (const k of [-2, -1, 1, 2]) { const gx = x - dx * k, gy = y - dy * k; if (inMap(m, gx, gy)) m.keep.add(k2(gx, gy)); } }
    const along = cells.filter((_, i) => !gateSet.has(i));
    return run(m, along, f.key, f.h, origin, { landUse: 'fence' });
}
/** Fence several edges; `open` lists edges left unfenced (usually the frontage). */
export function fenceRect(m, r, kind, origin, { open = [], gates = {} } = {}) {
    for (const side of ['n', 'e', 's', 'w']) if (!open.includes(side)) fenceEdge(m, r, side, kind, origin, { gates: gates[side] || [0.5] });
}

/** Register a vehicle slot. cells: the footprint the vehicle would occupy. */
export function addStall(m, { x, y, axis, length = 4, width = 2, types = ['car'], kind = 'stall', priority = 0.5, z = null, origin }) {
    const cells = [];
    for (let i = 0; i < length; i++) for (let j = 0; j < width; j++) cells.push(axis === 'x' ? [x + i, y + j] : [x + j, y + i]);
    for (const [cx, cy] of cells) if (!inMap(m, cx, cy) || !m.district.contains(cx, cy) || m.keep.has(k2(cx, cy))) return null;
    const stall = { x, y, axis, length, width, types, kind, priority, z: z ?? groundAt(m, x, y), origin, cells };
    m.district.stalls.push(stall);
    for (const [cx, cy] of cells) { m.district.stallCells.add(k2(cx, cy)); if (tagAt(m, cx, cy) !== 'road') tag(m, cx, cy, 'stall'); }
    return stall;
}

/**
 * A parking lot inside a parcel, in the parcel's local frame (F). Stalls are 3 wide (a 2-wide car plus a painted
 * line, so cars never touch) and 5 deep; cars point along v. The aisle stays clear and connects to the frontage
 * through `entranceU`. Returns the stalls and the open centre (a hold-zone host).
 */
export function parkingLot(m, F, area, { origin, entranceU = null, islands = true, z = null, frontage = true, priorityFrom = 'back' } = {}) {
    const { u0, v0, uw, vd } = area, g = z ?? m.G;
    const world = F.rect(u0, v0, uw, vd);
    paint(m, world, 'asphalt', 'aisle', { z });
    const rows = [];
    if (vd >= 14) rows.push({ v: v0, depth: 5, carV: v0 + 1 }, { v: v0 + 9, depth: 5, carV: v0 + 9 });
    else if (vd >= 9) rows.push({ v: v0 + 4, depth: 5, carV: v0 + 4 });
    const aisle = vd >= 14 ? { v: v0 + 5, depth: 4 } : { v: v0, depth: 4 };
    const entry = entranceU ?? (u0 + Math.floor(uw / 2) - 2);
    const stalls = [];
    const islandU = islands && uw >= 14 ? [u0, u0 + uw - 2] : [];
    for (const row of rows) {
        for (let u = u0 + (islandU.length ? 2 : 0); u + 2 < u0 + uw - (islandU.length ? 2 : 0); u += 3) {
            if (row.v === v0 && vd >= 14 && frontage && u + 3 > entry && u < entry + 4) continue; // the driveway cut through the front row
            const cells = [];
            for (let du = 0; du < 2; du++) for (let dv = 0; dv < 4; dv++) cells.push(F.at(u + du, row.carV + dv));
            const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
            const x = Math.min(...xs), y = Math.min(...ys), axis = F.vAxis;
            const pr = priorityFrom === 'back' ? (row.carV - v0) / Math.max(1, vd) : 1 - (row.carV - v0) / Math.max(1, vd);
            const st = addStall(m, { x, y, axis, length: 4, width: 2, kind: 'stall', z: g, priority: 0.5 + 0.5 * pr, origin: `${origin}/stall` });
            if (st) stalls.push(st);
            // Painted divider on the third column of the stall.
            for (let dv = 0; dv < row.depth; dv++) { const [px, py] = F.at(u + 2, row.v + dv); if (m.store.topSolid(px, py) === g && tagAt(m, px, py) === 'aisle') m.store.set(px, py, g, MAT.road_mark); }
        }
        for (const iu of islandU) {
            const r = F.rect(iu, row.v, 2, row.depth);
            paint(m, r, 'lawn', 'green', { z });
            const [tx, ty] = F.at(iu + (iu === u0 ? 0 : 1), row.v + 2);
            plantTree(m, tx, ty, `${origin}/island-tree`);
            const [bx, by] = F.at(iu + (iu === u0 ? 1 : 0), row.v + (row.v === v0 ? 0 : row.depth - 1));
            run(m, [[bx, by]], 'steel_post', 1, `${origin}/light-pole-base`);
        }
    }
    const centre = F.rect(u0 + 2, aisle.v, Math.max(2, uw - 4), aisle.depth);
    return { stalls, centre, world, entry, aisle };
}

/** Driveway cut through the sidewalk/kerb in front of a parcel edge cell: flat concrete, never furnished. */
export function driveway(m, x, y, side, width = 4, depth = 6) {
    const [dx, dy] = SIDES[side], cells = [];
    const along = side === 'n' || side === 's' ? [1, 0] : [0, 1];
    for (let i = 1; i <= depth; i++) for (let j = 0; j < width; j++) {
        const cx = x + dx * i + along[0] * j, cy = y + dy * i + along[1] * j, t = tagAt(m, cx, cy);
        if (t === 'road') break;
        if (t !== 'sidewalk' && t !== 'kerb' && t !== 'verge' && t !== 'plain') continue;
        if (m.store.topSolid(cx, cy) === groundAt(m, cx, cy)) m.store.set(cx, cy, groundAt(m, cx, cy), MAT.concrete);
        tag(m, cx, cy, 'driveway', { force: true }); cells.push([cx, cy]);
    }
    m.district.connectors.push({ id: `driveway-${x}-${y}`, template: 'dropped-kerb-driveway', cells: cells.map(([cx, cy]) => ({ x: cx, y: cy, z: groundAt(m, cx, cy) })), sockets: [] });
    return cells;
}

/**
 * Tree species and their gameplay canopies (cover and sight) — each matches its mesh in the tile set:
 *   oak         short trunk, wide low crown (radius 2)      parks, edge belts, big yards
 *   maple       the round street tree                         greens, plazas, yards
 *   birch       slender, tall narrow crown                    yards, park edges
 *   ornamental  compact head on a short trunk                 street pits, lot islands, plazas
 *   cypress     columnar evergreen                            boundaries, cemetery-like edges
 *   conifer     tiered evergreen                              edge belts, parks
 * The species comes from the planting context (the origin) and the cell, so rows vary instead of repeating one shape.
 */
export const TREE_SPECIES = Object.freeze({
    oak: { piece: 'tree_oak', radius: 2, trunk: 3, crown: [[3, 2], [4, 1]] },
    maple: { piece: 'tree_round', radius: 1, trunk: 3, crown: [[3, 1], [4, 1], [5, 0]] },
    birch: { piece: 'tree_birch', radius: 1, trunk: 3, crown: [[4, 1], [5, 0], [6, 0]] },
    ornamental: { piece: 'tree_ornamental', radius: 1, trunk: 2, crown: [[3, 1], [4, 0]] },
    cypress: { piece: 'tree_cypress', radius: 1, trunk: 1, crown: [[2, 0], [3, 1], [4, 0], [5, 0], [6, 0]] },
    conifer: { piece: 'tree_conifer', radius: 1, trunk: 1, crown: [[2, 1], [3, 0], [4, 0], [5, 0]] }
});
const CONTEXT_SPECIES = [
    [/street-tree|island-tree|tree-pit/, ['ornamental', 'ornamental', 'maple', 'birch']],
    [/yard-tree|garden|play/, ['birch', 'maple', 'ornamental', 'oak']],
    [/tree-belt|edge|boundary/, ['oak', 'conifer', 'cypress', 'oak', 'maple']],
    [/overgrowth|vacant/, ['oak', 'birch', 'conifer']],
    [/park|green|playground|repair/, ['oak', 'maple', 'birch', 'conifer', 'maple']]
];
export function speciesFor(origin = '', x = 0, y = 0) {
    const pool = (CONTEXT_SPECIES.find(([re]) => re.test(origin)) || [null, ['maple', 'oak', 'birch', 'ornamental', 'conifer']])[1];
    const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 997;
    return pool[h % pool.length];
}
export function plantTree(m, x, y, origin, kind = null) {
    if (!canStand(m, x, y)) return false;
    const sp = TREE_SPECIES[kind] || TREE_SPECIES[speciesFor(origin, x, y)], R = sp.radius;
    // The crown spreads around the trunk: keep it inside the playable footprint and off door approaches.
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (!inMap(m, x + dx, y + dy) || !m.district.contains(x + dx, y + dy)) return false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (m.keep.has(k2(x + dx, y + dy))) return false;
    const g = groundAt(m, x, y), s = m.store, cells = [];
    const set = (cx, cy, cz, key) => { if (s.inBounds(cx, cy, cz) && !s.isSolid(cx, cy, cz)) { s.set(cx, cy, cz, MAT[key]); cells.push([cx, cy, cz]); } };
    for (let h = 1; h <= sp.trunk; h++) set(x, y, g + h, 'trunk');
    for (const [dz, r] of sp.crown) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > r + (r >= 2 ? 0 : 0) || (dx === 0 && dy === 0 && dz <= sp.trunk)) continue;
        // Ragged edge: drop some outer cells by hash so crowns are not perfect diamonds.
        if (Math.abs(dx) + Math.abs(dy) === r && r >= 1 && ((x * 31 + y * 17 + dx * 7 + dy * 13 + dz) % 5 === 0)) continue;
        set(x + dx, y + dy, g + dz, 'leaves');
    }
    if (!cells.length) return false;
    const base = `${x},${y},${g + 1}`, hh = (((x * 92837111) ^ (y * 689287499)) >>> 0) / 4294967296;
    m.hints[base] = { piece: sp.piece, yaw: hh * 6.28, scale: 0.86 + ((hh * 7) % 1) * 0.3, tree: true, cells: cells.map(c => c.join(',')) };
    for (const c of cells) if (c.join(',') !== base) m.hints[c.join(',')] = { member: base, tree: true };
    for (const c of cells) m.district.origins.set(c.join(','), `${origin}/${kind || 'tree'}`);
    return true;
}

/** Solid block (shed, transformer, storage unit, portacabin): h high, a roof material on top. */
export function block(m, r, wallKey, h, origin, { roofKey = null, landUse = null } = {}) {
    const cells = [];
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) if (!canStand(m, x, y)) return null; else cells.push([x, y]);
    for (const [x, y] of cells) { const g = groundAt(m, x, y); for (let k = 1; k <= h; k++) put(m, x, y, g + k, k === h && roofKey ? roofKey : wallKey, origin); if (landUse) tag(m, x, y, landUse); }
    return cells;
}

/** A booth: a ring of walls with one doorway and a roof slab (guard booth, kiosk, ticket hut). */
export function booth(m, r, doorSide, origin) {
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) if (!canStand(m, x, y)) return false;
    const door = edgeCells(r, doorSide)[Math.floor((doorSide === 'n' || doorSide === 's' ? r.w : r.d) / 2)];
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
        const g = groundAt(m, x, y), edge = x === r.x0 || y === r.y0 || x === r.x0 + r.w - 1 || y === r.y0 + r.d - 1;
        if (edge && !(x === door[0] && y === door[1])) for (let k = 1; k <= 2; k++) put(m, x, y, g + k, 'concrete_wall', origin);
        put(m, x, y, g + 3, 'roof', origin);
        tag(m, x, y, 'utility');
    }
    const [dx, dy] = SIDES[doorSide];
    m.reserve(door[0] + dx, door[1] + dy, door[0] + dx, door[1] + dy);
    return true;
}

/** Canopy on posts (fuel forecourt, loading shelter, market roof): posts at the corners, a slab three up. */
export function canopy(m, r, origin, { z = null } = {}) {
    const g = z ?? groundAt(m, r.x0, r.y0);
    const corners = [[r.x0, r.y0], [r.x0 + r.w - 1, r.y0], [r.x0, r.y0 + r.d - 1], [r.x0 + r.w - 1, r.y0 + r.d - 1]];
    for (const [x, y] of corners) if (m.store.isSolid(x, y, g + 1) || m.keep.has(k2(x, y))) return false;
    for (const [x, y] of corners) for (let k = 1; k <= 2; k++) put(m, x, y, g + k, 'steel_post', origin);
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) if (!m.store.isSolid(x, y, g + 3)) put(m, x, y, g + 3, 'roof_metal', origin);
    return true;
}

/** Brick dumpster enclosure (open to one side) around a whole 2-cell dumpster: purposeful rear-service cover. */
export function dumpsterEnclosure(m, x, y, openSide, origin) {
    const along = openSide === 'n' || openSide === 's' ? 'x' : 'y';
    const r = { x0: x, y0: y, w: along === 'x' ? 4 : 3, d: along === 'x' ? 3 : 4 };
    for (let yy = r.y0; yy < r.y0 + r.d; yy++) for (let xx = r.x0; xx < r.x0 + r.w; xx++) if (!canStand(m, xx, yy)) return false;
    for (const side of ['n', 'e', 's', 'w']) if (side !== openSide) run(m, edgeCells(r, side), 'brick', 2, origin, { landUse: 'utility' });
    const cx = x + 1, cy = y + 1, g = groundAt(m, cx, cy);
    m.dumpster(cx, cy, along, g);
    registerSolids(m, { x0: cx, y0: cy, w: along === 'x' ? 2 : 1, d: along === 'x' ? 1 : 2 }, origin);
    for (const [dx, dy] of along === 'x' ? [[0, 0], [1, 0]] : [[0, 0], [0, 1]]) tag(m, cx + dx, cy + dy, 'utility');
    return true;
}

/** A frame of play equipment: four posts, a rail on two sides. */
export function playFrame(m, x, y, origin) {
    const posts = [[x, y], [x + 2, y], [x, y + 2], [x + 2, y + 2]];
    for (const [px, py] of posts) if (!canStand(m, px, py)) return false;
    for (const [px, py] of posts) run(m, [[px, py]], 'steel_post', 2, origin);
    run(m, [[x + 1, y]], 'railing', 1, origin); run(m, [[x + 1, y + 2]], 'railing', 1, origin);
    return true;
}
