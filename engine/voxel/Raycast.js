// Amanatides–Woo voxel traversal, ported from vibe-game shared/combat/targeting/Ray.js (PLAN 15A §6.3)
// to this repo's corner convention (voxel x covers [x, x+1)). Points are {x, y, h}: h is height.
import { intersectCellShape } from './ConnectedShapes.js';
import { materialById } from './Materials.js';

/** Bullets: solid materials block; glass, foliage and open doors pass. */
export const blocksProjectile = (store, x, y, z) => { const m = materialById(store.get(x, y, z)); return m.projectile !== 'pass'; };
/** Sight: opaque materials block (closed doors, walls, foliage). */
export const blocksSight = (store, x, y, z) => materialById(store.get(x, y, z)).opaque;

/**
 * Walk the voxels between `from` and `to` (optionally continuing `extend` units past `to`).
 * @returns {{ hit: {x,y,z}|null, t, point, normal, length, visited }}  t is the distance travelled.
 */
export function castRay(store, from, to, { blocks = blocksProjectile, extend = 0, skipStart = true, visit = null } = {}) {
    const d = [to.x - from.x, to.y - from.y, to.h - from.h];
    const length = Math.hypot(d[0], d[1], d[2]);
    if (length < 1e-9) return { hit: null, t: 0, point: { ...from }, normal: null, length: 0 };
    const dir = d.map(c => c / length);
    const maxT = length + extend;
    const o = [from.x, from.y, from.h];
    const cell = o.map(Math.floor);
    const step = dir.map(c => (c > 0 ? 1 : c < 0 ? -1 : 0));
    const tDelta = dir.map(c => (c === 0 ? Infinity : Math.abs(1 / c)));
    const tMax = dir.map((c, i) => (c > 0 ? (cell[i] + 1 - o[i]) / c : c < 0 ? (o[i] - cell[i]) / -c : Infinity));
    let t = 0, axis = -1;
    const shapeHit = (enter, fallbackNormal) => {
        if (!blocks(store, cell[0], cell[1], cell[2])) return null;
        const h = intersectCellShape(store, ...cell, o, dir, enter, Math.min(maxT, ...tMax));
        if (!h) return null;
        return { hit: { x: cell[0], y: cell[1], z: cell[2] }, t: h.t, length, dir,
            point: { x: o[0] + dir[0]*h.t, y: o[1] + dir[1]*h.t, h: o[2] + dir[2]*h.t }, normal: h.normal || fallbackNormal };
    };
    if (!skipStart) { const hit = shapeHit(0, null); if (hit) return hit; }
    for (let guard = 0; guard < 4096; guard++) {
        axis = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        t = tMax[axis];
        if (t > maxT) break;
        cell[axis] += step[axis];
        tMax[axis] += tDelta[axis];
        if (cell[2] < -1 || cell[2] > store.height + 4) break;
        if (cell[0] < -1 || cell[1] < -1 || cell[0] > store.width || cell[1] > store.depth) break;
        if (visit) visit(cell[0], cell[1], cell[2], t);
        const normal = [0, 0, 0]; normal[axis] = -step[axis];
        const hit = shapeHit(t, normal);
        if (hit) return hit;
    }
    const end = Math.min(maxT, t > maxT ? maxT : t);
    return { hit: null, t: maxT, length, dir, point: { x: o[0] + dir[0] * maxT, y: o[1] + dir[1] * maxT, h: o[2] + dir[2] * maxT }, normal: null, end };
}

/** True when nothing opaque lies strictly between the two points. */
export function lineOfSight(store, from, to) {
    const r = castRay(store, from, to, { blocks: blocksSight });
    return !r.hit;
}

/**
 * Lob arc (ported from vibe-game Arc.js): chord plus a parabolic rise peaking `apex` above the higher end.
 * Returns the sampled points and where it was blocked, if anywhere.
 */
export function traceArc(store, from, to, apex) {
    const k = Math.max(from.h, to.h) + apex - (from.h + to.h) / 2;
    const horizontal = Math.hypot(to.x - from.x, to.y - from.y);
    const samples = Math.max(6, Math.ceil(Math.hypot(horizontal, 2 * k) / 0.2));
    const points = [];
    for (let i = 0; i <= samples; i++) {
        const s = i / samples;
        const p = { x: from.x + (to.x - from.x) * s, y: from.y + (to.y - from.y) * s, h: from.h + (to.h - from.h) * s + 4 * k * s * (1 - s) };
        points.push(p);
        if (i > 1 && i < samples) {
            const hit = castRay(store, points[i-1], p, { skipStart: false });
            if (hit.hit) return { ok: false, blockedAt: hit.point, points: points.slice() };
        }
    }
    return { ok: true, points };
}

/** Highest apex ≤ requested that clears every voxel, or null when even a 0.4 arc is blocked. */
export function fitArc(store, from, to, requestedApex = 3) {
    const first = traceArc(store, from, to, requestedApex);
    if (first.ok) return { apex: requestedApex, ...first };
    // Try higher arcs first (indoors a lower arc is often the only way), then lower ones.
    for (const apex of [requestedApex + 1.5, requestedApex * 0.6, 1.2, 0.6, 0.4]) {
        const r = traceArc(store, from, to, apex);
        if (r.ok) return { apex, ...r };
    }
    return { ...first, apex: null };
}
