// PLAN-06 core: the district context shared by every stage of the parcel-mix generator.
//
//  * land use  — one tag per cell (road, sidewalk, lot, yard, fence, warehouse apron …). Gates and the topography
//                debugger read it; an untagged playable cell is "plain ground" and the land-use gate caps it.
//  * ground    — the standing level of every cell (terraces, sunken streets, raised parks), so props, vehicles and
//                gates all agree on what is "above ground".
//  * origins   — every exterior voxel a stage places is registered with the rule that put it there
//                (`mix:<id>/<part>`, `strip:<kind>`, `road:<rule>`, `level:<connector>`, `story:<beat>` …).
//                Nothing is scattered: the prop-origin gate fails any unregistered exterior solid.
//  * stalls    — the only cells vehicles may use (parking stalls, kerb lanes, docks, driveways, salvage).
import { MAT, materialById } from '../../voxel/Materials.js';

export const SIDES = Object.freeze({ n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] });
export const OPP = Object.freeze({ n: 's', s: 'n', e: 'w', w: 'e' });
export const k2 = (x, y) => `${x},${y}`;
export const k3 = (x, y, z) => `${x},${y},${z}`;

/** Land-use tags and their one-character codes (serialised for the debugger as meta.landUse.codes). */
export const LAND_USE = Object.freeze({
    plain: '.', outside: 'X', road: 'R', kerb: 'K', sidewalk: 'S', driveway: 'D', building: 'B', stall: 'L', aisle: 'A',
    yard: 'Y', plaza: 'P', fence: 'F', apron: 'W', green: 'G', construction: 'C', utility: 'U', alley: 'T', verge: 'V',
    edge: 'E', level: 'Z', channel: 'H', insertion: 'I', storage: 'Q', forecourt: 'O', path: 'p', park: 'g', zone: 'z'
});
const CODE_TAG = Object.fromEntries(Object.entries(LAND_USE).map(([t, c]) => [c, t]));
export const tagOfCode = c => CODE_TAG[c] || 'plain';

/** Attach the district context to a MapKit map. contains(x,y) is the playable footprint. */
export function initDistrict(m, { contains = () => true, family = 'mixed', seed = 1 } = {}) {
    const s = m.store, W = s.width, D = s.depth;
    const d = {
        W, D, family, seed, contains,
        tags: new Array(W * D).fill('plain'),
        ground: new Int16Array(W * D).fill(m.G),
        // Road ownership survives later land-use changes and building placement; a column may
        // contain both a lower road and an explicitly authored upper crossing.
        roadOwnership: new Map(),
        origins: new Map(),
        stallCells: new Set(),
        stalls: [], hosts: [], warehouses: [], bridges: [], zones: [], connectors: [], parcels: [], strips: [], levels: [],
        vehicles: [], furniture: [], notes: []
    };
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (!contains(x, y)) d.tags[x + y * W] = 'outside';
    m.district = d;
    return d;
}

export const inMap = (m, x, y) => x >= 0 && y >= 0 && x < m.district.W && y < m.district.D;
export function tagAt(m, x, y) { return inMap(m, x, y) ? m.district.tags[x + y * m.district.W] : 'outside'; }
export function tag(m, x, y, t, { force = false } = {}) {
    if (!inMap(m, x, y)) return;
    const i = x + y * m.district.W, cur = m.district.tags[i];
    if (cur === 'outside') return;
    if (!force && (cur === 'road' || cur === 'kerb' || cur === 'building') && t !== cur) return;
    m.district.tags[i] = t;
}
export function tagRect(m, r, t, opts) { for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) tag(m, x, y, t, opts); }
export function groundAt(m, x, y) { return inMap(m, x, y) ? m.district.ground[x + y * m.district.W] : m.G; }
export function setGround(m, x, y, z) { if (inMap(m, x, y)) m.district.ground[x + y * m.district.W] = z; }

/** Set one exterior voxel and record why it exists. */
export function put(m, x, y, z, key, origin) {
    if (!m.store.inBounds(x, y, z)) return false;
    m.store.set(x, y, z, MAT[key] ?? key);
    if (origin) m.district.origins.set(k3(x, y, z), origin);
    return true;
}
export function registerCells(m, cells, origin) { for (const c of cells) { const [x, y, z] = Array.isArray(c) ? c : [c.x, c.y, c.z]; m.district.origins.set(k3(x, y, z), origin); } }
/** Register every solid already standing above ground in a box (used after composite helpers such as trees). */
export function registerSolids(m, r, origin, { z0 = null, z1 = null } = {}) {
    const s = m.store;
    for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
        if (!inMap(m, x, y)) continue;
        const g = z0 ?? groundAt(m, x, y) + 1;
        for (let z = g; z <= (z1 ?? s.height - 1); z++) if (s.isSolid(x, y, z) && !m.district.origins.has(k3(x, y, z))) m.district.origins.set(k3(x, y, z), origin);
    }
}
export const isFree = (m, x, y, { keep = true, z = null } = {}) => {
    if (!inMap(m, x, y) || !m.district.contains(x, y)) return false;
    if (keep && m.keep.has(k2(x, y))) return false;
    const g = z ?? groundAt(m, x, y);
    return m.store.topSolid(x, y) === g;
};
export const inBuilding = (m, x, y) => m.buildings.some(b => x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.d);

/**
 * Local frame of a parcel rectangle: u runs along the front, v from the front (0) to the back (V-1). The mapping is
 * the same as ModernBuilder's, so a building and its parcel agree on what "front" means.
 */
export function frame(r) {
    const { x0, y0, w, d, front = 's' } = r;
    const ns = front === 'n' || front === 's';
    const U = ns ? w : d, V = ns ? d : w;
    const at = (u, v) => front === 's' ? [x0 + u, y0 + d - 1 - v] : front === 'n' ? [x0 + w - 1 - u, y0 + v]
        : front === 'e' ? [x0 + w - 1 - v, y0 + u] : [x0 + v, y0 + d - 1 - u];
    const rect = (u0, v0, uw, vd) => {
        const a = at(u0, v0), b = at(u0 + uw - 1, v0 + vd - 1);
        return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]) + 1, d: Math.abs(a[1] - b[1]) + 1 };
    };
    const uLow = { s: 'w', n: 'e', e: 'n', w: 's' }[front];
    const toLocal = (x, y) => front === 's' ? [x - x0, y0 + d - 1 - y] : front === 'n' ? [x0 + w - 1 - x, y - y0]
        : front === 'e' ? [y - y0, x0 + w - 1 - x] : [y0 + d - 1 - y, x - x0];
    return {
        U, V, at, rect, toLocal, front, back: OPP[front], left: uLow, right: OPP[uLow],
        uAxis: ns ? 'x' : 'y', vAxis: ns ? 'y' : 'x',
        /** World side of a local edge: 'front' | 'back' | 'left' (u = 0) | 'right' (u = U-1). */
        side: e => ({ front, back: OPP[front], left: uLow, right: OPP[uLow] })[e]
    };
}

/** Footprint cells on one side of a rectangle (inside the rectangle), in order along the edge. */
export function edgeCells(r, side) {
    const out = [];
    if (side === 'n' || side === 's') { const y = side === 'n' ? r.y0 : r.y0 + r.d - 1; for (let x = r.x0; x < r.x0 + r.w; x++) out.push([x, y]); }
    else { const x = side === 'w' ? r.x0 : r.x0 + r.w - 1; for (let y = r.y0; y < r.y0 + r.d; y++) out.push([x, y]); }
    return out;
}

/** Serialise the land-use map for the debugger: one code per cell, row-major. */
export function landUseSnapshot(m) {
    const d = m.district;
    return { width: d.W, depth: d.D, legend: LAND_USE, codes: d.tags.map(t => LAND_USE[t] || '.').join('') };
}

/** Solid materials that count as the hard, durable cover a hold zone keeps after soft cover burns away. */
export function isHardCover(mat) {
    const m = typeof mat === 'number' ? materialById(mat) : mat;
    if (!m || !m.solid || m.projectile === 'pass') return false;
    return m.hp === Infinity || m.hp >= 12 || m.debris === 'rubble';
}
