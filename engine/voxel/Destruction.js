// Voxel damage, explosions and structural collapse. Pure and deterministic (no RNG).
import { MATERIALS, MAT, AIR, materialById } from './Materials.js';

/** Structural damage multipliers by element against material families (GEO concussion cracks stone). */
const ELEMENT_VS_FAMILY = {
    geo: { stone: 2, metal: 1.5, wood: 1.2, glass: 2, earth: 1.5 },
    pyro: { wood: 1.5, plant: 3, ice: 3 },
    cryo: { glass: 1.5, ice: 0 },
    hydro: { plant: 0, wood: 0, stone: 0, metal: 0, earth: 0.3, glass: 0, ice: 0.5 },
    anemo: { plant: 1.5, glass: 1.5 }
};

export function voxelDamageMultiplier(material, element) {
    if (!element) return 1;
    const row = ELEMENT_VS_FAMILY[element];
    return row?.[material.family] ?? 1;
}

/**
 * Damage one voxel. Destroyed voxels become air; explosive ones queue an explosion.
 * @returns {{ destroyed: boolean, material, explosion?: {x,y,h,...} }}
 */
export function damageVoxel(store, x, y, z, amount, { element = null } = {}) {
    const id = store.get(x, y, z);
    const m = materialById(id);
    if (id === AIR || m.liquid || m.hp === Infinity || amount <= 0) return { destroyed: false, material: m };
    const dmg = Math.round(amount * voxelDamageMultiplier(m, element));
    if (dmg <= 0) return { destroyed: false, material: m };
    const before = store.hpAt(x, y, z), hp = before - dmg;
    if (hp > 0) {
        store.hp[store.index(x, y, z)] = hp;
        // Damage stays visible (PLAN-07): crossing 66 % or 33 % HP redraws the chunk with cracks.
        if (damageBand(m, before) !== damageBand(m, hp)) store.markDirty(x, y, z);
        return { destroyed: false, material: m, hp };
    }
    destroyVoxel(store, x, y, z);
    const result = { destroyed: true, material: m };
    if (m.explosive) result.explosion = { x: x + 0.5, y: y + 0.5, h: z + 0.5, ...m.explosive, source: m.key };
    return result;
}

/** Visible damage band of a voxel at `hp`: 0 intact, 1 cracked (≤ 66 %), 2 heavy (≤ 33 %). */
export function damageBand(m, hp) { if (!Number.isFinite(m.hp) || m.hp <= 1) return 0; const r = hp / m.hp; return r <= 0.33 ? 2 : r <= 0.66 ? 1 : 0; }

/** Remove a voxel cleanly; destruction never creates replacement debris. */
export function destroyVoxel(store, x, y, z) {
    store.set(x, y, z, AIR);
    store.markScar?.(x, y, z);
}

/**
 * PLAN-07 burn marks: every solid cell within the blast radius is blackened, darkest at the centre
 * (3 inside 40 % of the radius, 2 inside 75 %, 1 to the edge). Pure; no RNG.
 */
export function scorchBlast(store, b) {
    if (!store.addScorch || !(b.radius > 0)) return;
    const r = b.radius + 0.5, r2 = r * r;
    for (let z = Math.floor(b.h - r); z <= Math.floor(b.h + r); z++) for (let y = Math.floor(b.y - r); y <= Math.floor(b.y + r); y++) for (let x = Math.floor(b.x - r); x <= Math.floor(b.x + r); x++) {
        const d2 = (x + 0.5 - b.x) ** 2 + (y + 0.5 - b.y) ** 2 + (z + 0.5 - b.h) ** 2;
        if (d2 > r2) continue;
        const k = Math.sqrt(d2) / r;
        store.addScorch(x, y, z, k < 0.4 ? 3 : k < 0.75 ? 2 : 1);
    }
}

/** Capture the initial ground/foundation boundary, excluding furniture, walls and upper storeys. */
export function groundFloorLevels(mission) {
    const { store } = mission, { width: W, depth: D, height: H } = store;
    const levels = new Int16Array(W * D).fill(-1);
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        for (let z = 0; z < H; z++) {
            const m = store.material(x, y, z);
            if (!m.solid || !m.walkable || !m.structural || m.part) break;
            levels[x + y * W] = z;
        }
    }
    // Authored building bases also cover slabs above basements or raised loading decks.
    // A shop above another building is an upper storey, not a second protected ground floor.
    const bases = new Int16Array(W * D).fill(-1);
    for (const b of mission.buildings || []) {
        if (!Number.isInteger(b.baseZ)) continue;
        for (let y = Math.max(0, b.y0); y < Math.min(D, b.y0 + b.d); y++)
            for (let x = Math.max(0, b.x0); x < Math.min(W, b.x0 + b.w); x++) {
                const i = x + y * W;
                bases[i] = bases[i] < 0 ? b.baseZ : Math.min(bases[i], b.baseZ);
            }
    }
    for (let i = 0; i < levels.length; i++) if (bases[i] >= 0) levels[i] = bases[i];
    return levels;
}

/**
 * Explosion: every voxel within `radius` of the centre takes power × falloff damage.
 * Powder kegs caught in the blast chain into further explosions (breadth-first, capped).
 * @returns {{ destroyed: [x,y,z,matKey][], explosions: object[] }}
 */
export function explodeVoxels(store, blast, { maxChain = 8, maxVoxels = 900, canDamage = null } = {}) {
    const queue = [blast], explosions = [], destroyed = [];
    let chain = 0;
    while (queue.length && chain <= maxChain) {
        const b = queue.shift(); chain++;
        explosions.push(b);
        const r = b.radius, r2 = r * r;
        const x0 = Math.floor(b.x - r), x1 = Math.floor(b.x + r), y0 = Math.floor(b.y - r), y1 = Math.floor(b.y + r);
        const z0 = Math.floor(b.h - r), z1 = Math.floor(b.h + r);
        const cells = [];
        for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const d2 = (x + 0.5 - b.x) ** 2 + (y + 0.5 - b.y) ** 2 + (z + 0.5 - b.h) ** 2;
            if (d2 <= r2 && store.get(x, y, z) !== AIR) cells.push([x, y, z, Math.sqrt(d2)]);
        }
        cells.sort((a, c) => a[3] - c[3] || a[2] - c[2] || a[1] - c[1] || a[0] - c[0]);
        for (const [x, y, z, d] of cells) {
            if (destroyed.length >= maxVoxels) break;
            if (canDamage && !canDamage(x, y, z)) continue;
            const falloff = 1 - d / (r + 0.5);
            const before = materialById(store.get(x, y, z));
            const res = damageVoxel(store, x, y, z, b.power * falloff, { element: b.element });
            if (res.destroyed) {
                destroyed.push([x, y, z, before.key]);
                if (res.explosion) queue.push(res.explosion);
            }
        }
    }
    return { destroyed, explosions };
}

/**
 * Structural support: every non-liquid, non-air voxel must connect (6-neighbour) to the bedrock layer.
 * Unsupported pieces are removed without depositing rubble. Fall locations remain in collapse events.
 * @returns {{ fallen: {x,y,from,to,material}[], removed: number }}
 */
export function settleUnsupported(store) {
    let standRemoved=0;
    // Steel stands (fire escapes, bridges): a group falls once every post is gone, every post column is broken
    // somewhere along its height (PLAN-04 §5.2 posts) and no wall anchor holds it. Groups with no support listed never fall here.
    for(const group of store.supportGroups||[]) {
        const posts=group.posts||[],columns=group.columns||[],anchors=group.anchors||[];
        if(!posts.length&&!columns.length&&!anchors.length)continue;
        const postsGone=posts.every(p=>store.get(...p)!==MAT.steel_post),columnsGone=columns.every(col=>col.some(p=>store.get(...p)!==MAT.steel_post));
        if(postsGone&&columnsGone&&!anchors.some(p=>store.isSolid(...p)))for(const p of group.members)if(store.get(...p)!==AIR){store.set(...p,AIR);standRemoved++;}
    }
    const { width: W, depth: D, height: H } = store;
    const seen = new Uint8Array(W * D * H);
    const stack = [];
    const attached = id => id !== AIR && !MATERIALS[id].liquid;
    // Only solid voxels carry load. Ladders, doors and leaves hang on whatever holds them but never hold anything up,
    // and a steel stand (fire escape) is held by its own posts rule above: neither may keep a building standing.
    const hangs = new Uint8Array(W * D * H);
    // Railings (stairwell balustrades, balconies) are bolted on too: they never hold a floor up (PLAN-11).
    for (let i = 0; i < store.mat.length; i++) if (store.mat[i] !== AIR && (!MATERIALS[store.mat[i]].solid || store.mat[i] === MAT.railing)) hangs[i] = 1;
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const i = store.index(x, y, 0);
        if (attached(store.mat[i])) { seen[i] = 1; stack.push(i); }
    }
    // Standing steel stands are bolted together: their surviving members count as supported (their own rule above
    // decided whether they stand), so a stair stringer between two landings never reads as a floating voxel.
    for (const group of store.supportGroups || []) for (const p of [...group.members, ...(group.columns || []).flat()]) {
        if (!store.inBounds(...p)) continue;
        const i = store.index(...p);
        hangs[i] = 1;
        if (!seen[i] && attached(store.mat[i])) { seen[i] = 1; stack.push(i); }
    }
    const WD = W * D;
    let bears = true;
    while (stack.length) {
        const i = stack.pop();
        bears = !hangs[i];
        const z = Math.floor(i / WD), rem = i - z * WD, y = Math.floor(rem / W), x = rem - y * W;
        if (x > 0) push(i - 1); if (x < W - 1) push(i + 1);
        if (y > 0) push(i - W); if (y < D - 1) push(i + W);
        if (z > 0) push(i - WD); if (z < H - 1) push(i + WD);
    }
    function push(j) { if (!seen[j] && attached(store.mat[j]) && (bears || hangs[j])) { seen[j] = 1; stack.push(j); } }

    // A facade anchor must itself reach bedrock. A floating upper slab cannot keep its balcony suspended.
    for(const group of store.supportGroups||[]) {
        if((group.posts||[]).length||(group.columns||[]).length||!group.anchors?.length)continue;
        if(group.anchors.some(p=>store.inBounds(...p)&&seen[store.index(...p)]))continue;
        for(const p of group.members)if(store.get(...p)!==AIR){store.set(...p,AIR);standRemoved++;}
    }
    const loose = [];
    for (let i = 0; i < store.mat.length; i++) if (!seen[i] && attached(store.mat[i])) loose.push(i);
    if (!loose.length) return { fallen: [], removed: standRemoved };
    // Remove every loose voxel and retain column fall metadata for collapse feedback.
    const columns = new Map();
    for (const i of loose) {
        const z = Math.floor(i / WD), rem = i - z * WD, y = Math.floor(rem / W), x = rem - y * W;
        const m = MATERIALS[store.mat[i]];
        store.set(x, y, z, AIR);
        if (m.structural && m.family !== 'glass') {
            const key = x + y * W;
            const c = columns.get(key) || { x, y, top: 0, material: m.key };
            c.top = Math.max(c.top, z); columns.set(key, c);
        }
    }
    const fallen = [];
    for (const c of [...columns.values()].sort((a, b) => a.y - b.y || a.x - b.x)) {
        let floor = c.top; while (floor >= 0 && !store.isSolid(c.x, c.y, floor)) floor--;
        fallen.push({ x: c.x, y: c.y, from: c.top, to: floor + 1, material: c.material });
    }
    return { fallen, removed: loose.length+standRemoved };
}
