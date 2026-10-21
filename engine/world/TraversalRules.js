export const AGENT_PROFILES = Object.freeze(Object.fromEntries(Object.entries({
    player: { width: 1, clearance: 2, maxStep: 1, stairs: true, doors: true, swim: 'shallow' },
    npc: { width: 1, clearance: 2, maxStep: 1, stairs: true, doors: true, swim: false },
    critter: { width: 1, clearance: 1, maxStep: 1, stairs: false, doors: false, swim: false },
    brute: { width: 2, clearance: 3, maxStep: 1, stairs: false, doors: false, swim: false }
}).map(([key, value]) => [key, Object.freeze(value)])));
const stairParts = new Set([4, 10, 11, 12, 13, 19, 20, 21, 22, 25]);
function admissible(s, p) {
    return s.headroom >= p.clearance && (p.doors || s.voxel.building !== 2) &&
        (p.stairs || !stairParts.has(s.voxel.building)) &&
        (s.voxel.element !== 2 || p.swim === 'shallow' && s.info.traversal === 'wade');
}
export function surfacesAt(world, x, y, profile = AGENT_PROFILES.player) {
    // Memoised per profile on stores that keep the cache (VoxelStore drops entries on every write to the column;
    // wide profiles read neighbouring columns too, so only width-1 profiles are cached).
    const cache = profile.width === 1 ? world.profileSurfaceCache : null;
    if (cache && x >= 0 && y >= 0 && x < world.width && y < world.depth) {
        let m = cache.get(profile); if (!m) cache.set(profile, m = new Map());
        const k = x + y * world.width;
        let v = m.get(k);
        if (!v) { v = world.surfaces(x, y).filter(s => admissible(s, profile)); m.set(k, v); }
        return v;
    }
    return world.surfaces(x, y).filter(s => admissible(s, profile) &&
        (profile.width === 1 || footprintFits(world, s, profile)));
}
function footprintFits(world, s, profile) {
    for (let dx = 0; dx < profile.width; dx++) for (let dy = 0; dy < profile.width; dy++) {
        if (!world.surfaces(s.x + dx, s.y + dy).some(next => next.z === s.z && admissible(next, profile))) return false;
    }
    return true;
}
export function canStep(world, from, to, profile = AGENT_PROFILES.player) {
    if (![from.x, from.y, from.z, to.x, to.y, to.z].every(Number.isInteger)) return false;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(dz) > profile.maxStep) return false;
    const a = surfacesAt(world, from.x, from.y, profile).find(s => s.z === from.z);
    const b = surfacesAt(world, to.x, to.y, profile).find(s => s.z === to.z);
    if (!a || !b || dx === 0 && dy === 0 && dz !== 0) return false;
    if ([24, 25].includes(a.voxel.building) && b.voxel.element === 2 || [24, 25].includes(b.voxel.building) && a.voxel.element === 2) return false;
    // During an uphill step, the body also sweeps above the source floor.
    const high = Math.max(from.z, to.z);
    for (const p of [from, to]) for (let x = 0; x < profile.width; x++) for (let y = 0; y < profile.width; y++) {
        for (let z = high + 1; z <= high + profile.clearance; z++) if (world.isSolid(p.x + x, p.y + y, z)) return false;
    }
    if (dx && dy) {
        // Both cardinal corners must admit the complete body and both halves of
        // the step. A free topmost tile alone cannot prove a diagonal is clear.
        return [[to.x, from.y], [from.x, to.y]].every(([x, y]) =>
            surfacesAt(world, x, y, profile).some(s => canStep(world, from, s, profile) && canStep(world, s, to, profile)));
    }
    return true;
}
export function stepCost(world, from, to, profile = AGENT_PROFILES.player) {
    if (!canStep(world, from, to, profile)) return Infinity;
    const destination = world.surfaces(to.x, to.y).find(s => s.z === to.z);
    const info = destination.info;
    const dz = to.z - from.z;
    // Stairs have a fixed traversal cost. Their decorative texture must not
    // make an otherwise identical one-voxel rise slower than another.
    const terrainCost = stairParts.has(destination.voxel.building) ? 1 : (info.moveCost ?? 1);
    return (from.x !== to.x && from.y !== to.y ? 1.414 : 1) * terrainCost + (dz > 0 ? dz * 0.5 : -dz * 0.15);
}
