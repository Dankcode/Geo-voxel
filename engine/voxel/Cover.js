// XCOM-style cover readout derived from the voxels themselves (Phoenix Point-style ballistics do the
// real work; this is what the HUD shields and the AI's tile scoring read).
import { collisionFootprint, intersectCellShape } from './ConnectedShapes.js';
import { materialById, coverWeight } from './Materials.js';

export const DIRS4 = Object.freeze([
    { id: 'n', dx: 0, dy: -1 }, { id: 'e', dx: 1, dy: 0 }, { id: 's', dx: 0, dy: 1 }, { id: 'w', dx: -1, dy: 0 }
]);
export const COVER = Object.freeze({ NONE: 0, HALF: 1, FULL: 2 });

/** Cover a unit standing on surface (x, y, z) gets from the neighbour in direction d. */
export function coverToward(store, x, y, z, d, travel = null, elevated = false) {
    const nx = x + d.dx, ny = y + d.dy;
    const low = travel ? protectionAlong(store, x, y, nx, ny, z + 1, travel) : protection(store, nx, ny, z + 1, d);
    const high = travel ? protectionAlong(store, x, y, nx, ny, z + 2, travel) : protection(store, nx, ny, z + 2, d);
    if (low >= 0.8 && high >= 0.8) return COVER.FULL;
    // From two voxels above, low protection below the chest no longer rates as half cover.
    // Upper protection (an overhang/window band) still counts, and the pitched samples can see over a wall.
    if (elevated) return high >= 0.4 ? COVER.HALF : COVER.NONE;
    if (low >= 0.4) return COVER.HALF;
    if (high >= 0.4) return COVER.HALF;          // window gap / overhang still hides the upper body
    return COVER.NONE;
}

/** { n, e, s, w } cover levels at a standing position. */
export function coverAt(store, x, y, z) {
    const out = {};
    for (const d of DIRS4) out[d.id] = coverToward(store, x, y, z, d);
    return out;
}

/** Cover against a shooter at (sx, sy): the best cover among the faces that look toward the shooter. */
export function coverAgainst(store, x, y, z, sx, sy, sz = z) {
    const dx = sx - x, dy = sy - y;
    let best = COVER.NONE;
    for (const d of DIRS4) {
        const dot = d.dx * dx + d.dy * dy;
        if (dot <= 0) continue;
        // A face counts when the shooter is within ~60° of it.
        const len = Math.hypot(dx, dy) || 1;
        if (dot / len < 0.5) continue;
        // Sample along the actual line of fire, so an oblique shot that comes round a wall end or corner post is
        // rated by what it would really cross (the HUD shields per face still use the straight-on rating).
        best = Math.max(best, coverToward(store, x, y, z, d, [-dx / len, -dy / len, -(sz-z)/len], sz-z>=2));
    }
    return best;
}

/** Energy of a standard rifle round (5.56): the HUD rates cover as soft when such a round would pass through it. */
export const STANDARD_ROUND_ENERGY = 6;
/**
 * PLAN-07: is the cover on face d soft, i.e. would a round with `energy` pass through every voxel that gives it?
 * A face without cover is not soft (there is nothing to be soft).
 */
export function softToward(store, x, y, z, d, energy = STANDARD_ROUND_ENERGY) {
    let any = false;
    for (const h of [1, 2]) {
        const m = materialById(store.get(x + d.dx, y + d.dy, z + h));
        if (coverWeight(m) < 1) continue;
        any = true;
        if (!(m.resistance < energy)) return false;
    }
    return any;
}
/** { n, e, s, w } → true where that face's cover is soft against `energy`. */
export function softAt(store, x, y, z, energy = STANDARD_ROUND_ENERGY) {
    const out = {};
    for (const d of DIRS4) out[d.id] = softToward(store, x, y, z, d, energy);
    return out;
}
/** Cover against a shooter, discounting soft faces: { level, soft } where soft = the best face's cover is soft. */
export function hardCoverAgainst(store, x, y, z, sx, sy, sz = z, energy = STANDARD_ROUND_ENERGY) {
    const dx = sx - x, dy = sy - y, len = Math.hypot(dx, dy) || 1;
    let best = COVER.NONE, soft = false;
    for (const d of DIRS4) {
        const dot = d.dx * dx + d.dy * dy;
        if (dot <= 0 || dot / len < 0.5) continue;
        const c = coverToward(store, x, y, z, d, [-dx / len, -dy / len, -(sz - z) / len], sz - z >= 2);
        if (!c) continue;
        const s = softToward(store, x, y, z, d, energy);
        if (c > best || (c === best && soft && !s)) { best = c; soft = s; }
    }
    return { level: best, soft };
}

/** True when no face toward the attacker has cover (XCOM "flanked"). */
export function isFlanked(store, x, y, z, sx, sy, sz = z) {
    return coverAgainst(store, x, y, z, sx, sy, sz) === COVER.NONE;
}

// Sample a body-width band through the actual footprint. A narrow end post cannot claim full cover.
function protection(store, x, y, z, d) {
    const weight = coverWeight(materialById(store.get(x,y,z)));
    if (weight < 1) return 0; // concealment, open doors and water are not ballistic cover
    if (!collisionFootprint(store,x,y,z)) return weight;
    let hits = 0;
    for (const offset of [-0.38,-0.19,0,0.19,0.38]) {
        const origin = [x+0.5-d.dx*0.5+d.dy*offset, y+0.5-d.dy*0.5-d.dx*offset, z+0.5];
        if (intersectCellShape(store,x,y,z,origin,[d.dx,d.dy,0],0,1)) hits++;
    }
    return hits/5;
}

/**
 * Protection a face-neighbour cell gives against fire travelling along `travel` (unit vector, shooter → unit): five
 * rays across a 0.76-cell body band aimed at the unit's cell, counting those that meet the neighbour's real shape
 * while crossing that cell.
 */
function protectionAlong(store, ux, uy, x, y, z, travel) {
    const weight = coverWeight(materialById(store.get(x, y, z)));
    if (weight < 1) return 0;
    const [tx, ty, tz = 0] = travel, px = -ty, py = tx;
    let hits = 0;
    for (const offset of [-0.38, -0.19, 0, 0.19, 0.38]) {
        const ox = ux + 0.5 + px * offset - tx * 2.5, oy = uy + 0.5 + py * offset - ty * 2.5, oh=z+0.5-tz*2.5;
        // Interval of the ray inside the neighbour cell (2D slab test).
        let t0 = 0, t1 = 2.5, ok = true;
        for (const [o, d, lo] of [[ox, tx, x], [oy, ty, y]]) {
            if (Math.abs(d) < 1e-9) { if (o < lo || o > lo + 1) ok = false; continue; }
            let a = (lo - o) / d, b = (lo + 1 - o) / d;
            if (a > b) [a, b] = [b, a];
            t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        }
        // Clip against the voxel's vertical slab as well as its horizontal footprint.
        if(Math.abs(tz)>1e-9) {
            let a=(z-oh)/tz,b=(z+1-oh)/tz;if(a>b)[a,b]=[b,a];
            t0=Math.max(t0,a);t1=Math.min(t1,b);
        }
        if (!ok || t0 > t1) continue;
        if (!collisionFootprint(store, x, y, z)) { hits++; continue; }
        if (intersectCellShape(store, x, y, z, [ox, oy, oh], [tx, ty, tz], t0, t1)) hits++;
    }
    return hits / 5 * Math.min(1, weight);
}
