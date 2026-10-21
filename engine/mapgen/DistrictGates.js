// PLAN-06 §5.11 — district gates. They read the land-use map, the origin registry and the compiled mission.
//
//   landUse      untagged ("plain") playable ground ≤ 8 %, no plain square larger than 8 × 8
//   propOrigin   every exterior solid above the ground has an origin (no scatter, no stray boxes)
//   vehicles     every vehicle stands in a registered slot
//   roadAir      nothing solid over road, kerb, sidewalk or driveway cells except vehicles in kerb lanes, street
//                furniture on sidewalks and skybridges at storey height
//   skybridges   both ends reachable
//   levels       (terraced maps) every level reachable, ≥ 2 routes per adjacent pair, ≥ 1 of them not a ladder
//   warehouses   every warehouse hall passes its CQB gate
//   hold         the hold zone passes its gate (HoldZone.js)
import { reachable, nodeKey } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { materialById } from '../voxel/Materials.js';
import { k2, k3, groundAt, tagAt } from './district/Core.js';
import { evaluateHoldZone } from './district/HoldZone.js';

export const DISTRICT_LIMITS = Object.freeze({ plainShare: 0.08, plainSquare: 8 });
const VEHICLES = new Set(['car', 'abandoned_car', 'truck', 'bus', 'semitrailer', 'eighteen_wheeler']);
const ROADWAY = new Set(['road', 'kerb', 'sidewalk', 'driveway']);

export function evaluateDistrictGates(mission, m, { search = null } = {}) {
    const d = m.district, s = mission.store;
    search ||= reachable(s, mission.spawns.player[0], Infinity, AGENT_PROFILES.player);
    const inBuilding = (x, y) => mission.buildings.some(b => x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.d);
    // Land use.
    let playable = 0, plain = 0;
    const dp = new Int16Array(d.W * d.D);
    let square = 0;
    for (let y = 0; y < d.D; y++) for (let x = 0; x < d.W; x++) {
        if (!d.contains(x, y)) continue;
        playable++;
        const t = d.tags[x + y * d.W];
        if (t !== 'plain') continue;
        plain++;
        const v = 1 + Math.min(x ? dp[x - 1 + y * d.W] : 0, y ? dp[x + (y - 1) * d.W] : 0, x && y ? dp[x - 1 + (y - 1) * d.W] : 0);
        dp[x + y * d.W] = v; square = Math.max(square, v);
    }
    // Origins and the road air column.
    const unregistered = [], roadAir = [];
    for (let y = 0; y < d.D; y++) for (let x = 0; x < d.W; x++) {
        if (!d.contains(x, y)) continue;
        const g = groundAt(m, x, y), t = tagAt(m, x, y), inside = inBuilding(x, y);
        const roads = d.roadOwnership.get(k2(x, y)) || (ROADWAY.has(t) ? [{ tag: t, z: g }] : []);
        if (inside && !roads.length) continue;
        const bottom = Math.min(g, ...roads.map(r => r.z));
        for (let z = bottom + 1; z < s.height; z++) {
            const mat = materialById(s.get(x, y, z));
            if (!mat.solid) continue;
            const o = d.origins.get(k3(x, y, z));
            if (!inside && z > g && !o && unregistered.length < 50) unregistered.push({ x, y, z, material: mat.key, tag: t });
            for (const road of roads) {
                if (z <= road.z) continue;
                // Authored split-level road crossings are registered at both datums. Their
                // upper road slab may bridge the lower one, with two cells of clearance.
                const crossing = z >= road.z + 3 && roads.some(r => r.z > road.z && z <= r.z);
                const rt = road.tag;
                const ok = crossing || o && ((o.startsWith('vehicle:') || o.startsWith('roadset:')) && (rt === 'road' || rt === 'kerb') || (o.startsWith('road:') || o.startsWith('repair:')) && (rt === 'sidewalk' || rt === 'kerb') || o.includes('street-tree') && (mat.key === 'leaves' || mat.key === 'trunk') && z >= road.z + 3 || o.startsWith('skybridge:') && z >= road.z + 3);
                if (!ok) { roadAir.push({ x, y, z, material: mat.key, tag: rt, origin: o || null }); break; }
            }
        }
    }
    let unregisteredCount = 0;
    for (let y = 0; y < d.D; y++) for (let x = 0; x < d.W; x++) { if (!d.contains(x, y) || inBuilding(x, y)) continue; const g = groundAt(m, x, y); for (let z = g + 1; z < s.height; z++) if (materialById(s.get(x, y, z)).solid && !d.origins.has(k3(x, y, z))) unregisteredCount++; }
    // Vehicles stand in slots.
    const offSlot = [];
    for (const [key, h] of Object.entries(mission.visual?.hints || {})) {
        if (!h.piece || !VEHICLES.has(h.piece)) continue;
        for (const c of h.cells || [key]) { const [x, y] = c.split(',').map(Number); if (!d.stallCells.has(k2(x, y))) { offSlot.push({ piece: h.piece, x, y }); break; } }
    }
    // Skybridges and connector sockets.
    const reach = p => [0, 1, -1].some(dz => search.costs.has(nodeKey({ x: p.x, y: p.y, z: p.z + dz })));
    const bridges = d.bridges.map(b => ({ id: b.id, pass: b.sockets.every(reach) }));
    // Catwalks: reachable from the floor (both stair tops) and from the building.
    const warehouses = d.warehouses.map(w => {
        const cw = w.catwalk, catwalk = !cw || (cw.top.length >= 1 && cw.top.every(reach));
        return { building: w.building, variant: w.variant, pass: w.pass && catwalk, gates: { ...w.gates, catwalk }, longestRun: w.longestRun, coverReach: w.coverReach, catwalk: cw ? { cells: cw.cells, stairs: cw.stairs } : null };
    });
    const levels = d.levels.length ? evaluateLevels(m, search) : null;
    const zone = mission.objective?.kind === 'hold' ? d.zones.find(z => z.objective) || d.zones[0] : null;
    const hold = zone ? evaluateHoldZone(mission, zone, { origins: d.origins }) : null;
    const metrics = { playable, plainShare: playable ? plain / playable : 0, plainSquare: square, unregistered: unregisteredCount, roadAir: roadAir.length, vehiclesOffSlot: offSlot.length,
        vehicles: d.vehicles.length, stalls: d.stalls.length, parcels: d.parcels.length, strips: d.strips.length };
    const gates = {
        landUse: metrics.plainShare <= DISTRICT_LIMITS.plainShare && square <= DISTRICT_LIMITS.plainSquare,
        propOrigin: unregisteredCount === 0,
        vehicles: offSlot.length === 0,
        roadAir: roadAir.length === 0,
        skybridges: bridges.every(b => b.pass),
        warehouses: warehouses.every(w => w.pass),
        ...(levels ? { levels: levels.pass } : {}),
        ...(hold ? { hold: hold.pass } : {})
    };
    return { pass: Object.values(gates).every(Boolean), gates, metrics, samples: { unregistered: unregistered.slice(0, 12), roadAir: roadAir.slice(0, 12), offSlot: offSlot.slice(0, 12) }, bridges, warehouses, levels, hold };
}

/** Terraced maps: each level reachable; each adjacent pair joined by ≥ 2 routes ≥ 10 cells apart, ≥ 1 not a ladder. */
export function evaluateLevels(m, search) {
    const d = m.district, levels = [...new Set(d.levels.map(l => l.z))].sort((a, b) => a - b);
    const reachedLevel = z => [...search.nodes.values()].some(n => n.z === z && groundAt(m, n.x, n.y) === z);
    const pairs = [];
    for (let i = 1; i < levels.length; i++) {
        const lo = levels[i - 1], hi = levels[i];
        const routes = d.connectors.filter(c => c.levels && c.levels[0] === lo && c.levels[1] === hi && c.sockets.every(p => [0, 1, -1].some(dz => search.costs.has(nodeKey({ x: p.x, y: p.y, z: p.z + dz })))));
        let spread = 0;
        for (const a of routes) for (const b of routes) spread = Math.max(spread, Math.hypot(a.sockets[0].x - b.sockets[0].x, a.sockets[0].y - b.sockets[0].y));
        pairs.push({ lo, hi, routes: routes.map(r => r.template), pass: routes.length >= 2 && spread >= 10 && routes.some(r => r.template !== 'terrace-ladder') });
    }
    const reached = levels.map(z => ({ z, reached: reachedLevel(z) }));
    return { pass: reached.every(r => r.reached) && pairs.every(p => p.pass), levels: reached, pairs };
}
