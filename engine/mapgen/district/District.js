// PLAN-06 §5.1 — the district pipeline after the skeleton (footprint, levels, roads and landmark features) is down:
//   blocks → parcel partition → mix WFC → build pass → dress pass → strips → skybridges → street rules → vehicles.
// Callers own the skeleton (LargeDistricts, ConnectingDistricts, TerraceLevels); everything that fills the land
// between the roads happens here, so every generated district follows the same rules and passes the same gates.
import { createRng, hashString } from '../../util/Rng.js';
import { reachable, nodeKey } from '../../world/PathSearch.js';
import { AGENT_PROFILES } from '../../world/TraversalRules.js';
import { groundAt, setGround, tag, tagAt, inBuilding, registerSolids, landUseSnapshot } from './Core.js';
import { extractBlocks, partitionBlock, assignMixes, layoutLeaves, dressStrips } from './MixSolver.js';
import { kerbStalls, busStops, streetFurniture, streetTrees, roadSets, streetPosts } from '../StreetDressing.js';
import { plantTree } from './Props.js';
import { buildSkybridges } from './Skybridge.js';
import { placeVehicles, pocketWeight } from './VehicleNoise.js';
import { evaluateDistrictGates } from '../DistrictGates.js';
import { repairCover } from './CoverRepair.js';
import { STOREY } from '../../mission/modern/ModernBuilder.js';

/** Snapshot the standing level of every cell once the skeleton's terrain is final. */
export function snapshotGround(m) {
    const d = m.district;
    for (let y = 0; y < d.D; y++) for (let x = 0; x < d.W; x++) if (d.contains(x, y)) { const t = m.store.topSolid(x, y); if (t >= 0) setGround(m, x, y, t); }
}

/**
 * Fill the district. opts: { seed, remix, family, roads, spawn, target, hold, extraBuildings }
 * Returns a report the caller stores in mission.meta.
 */
export function fillDistrict(m, { seed = 1, remix, family = 'mixed', roads = [], spawn = null, target = null, hold = false, existingBuildings = m.buildings.length, glaze = null, bias = {} } = {}) {
    const d = m.district, rng = createRng(hashString(`district:${m.id}:${seed}`));
    const avail = (x, y) => d.contains(x, y) && tagAt(m, x, y) === 'plain' && !inBuilding(m, x, y) && m.store.topSolid(x, y) === groundAt(m, x, y);
    const blocks = extractBlocks(m, avail);
    const leaves = [], scraps = [];
    for (const b of blocks) { const r = partitionBlock(m, b, { seed, family, elevated: remix.elevated, rng, bias }); leaves.push(...r.leaves.map(l => ({ ...l, id: `${b.id}-${l.id}` }))); scraps.push(...r.scraps); }
    const cap = Math.max(0, remix.buildingCount - existingBuildings);
    const { assignment, host } = assignMixes(m, leaves, { seed, family, elevated: remix.elevated, buildingCap: cap, hold, spawn, bias });
    const { assignments, connectors } = layoutLeaves(m, leaves, assignment, { seed, family, remix, hostId: host, buildingCap: cap, glaze });
    d.connectors.push(...connectors);
    const strips = dressStrips(m, (x, y) => d.contains(x, y) && !inBuilding(m, x, y) && m.store.topSolid(x, y) === groundAt(m, x, y), { seed });
    // Skybridges: only between buildings whose storey-2 landings are already reachable.
    let bridges = [];
    if (remix.skybridges !== false && spawn) {
        const pre = reachable(m.store, spawn, Infinity, AGENT_PROFILES.player);
        const landing = b => b.storeys >= 2 && b.rooms.some(r => r.storey === 1 && r.cells.some(([x, y]) => pre.costs.has(nodeKey({ x, y, z: b.baseZ + STOREY }))));
        const ok = new Set(m.buildings.filter(landing).map(b => b.id));
        const keep = m.buildings; m.buildings = keep.filter(b => ok.has(b.id) || b.storeys < 2);
        try { bridges = buildSkybridges(m, roads.filter(r => r.kind !== 'service'), { max: 2, rng }); } finally { m.buildings = keep; }
    }
    // Street rules after the parcels (they need the driveways and the shop doors).
    const sets = roadSets(m, roads, { spawn });
    kerbStalls(m, roads, { avoid: (x, y) => spawn && Math.hypot(x - spawn.x, y - spawn.y) < 10 });
    const shelters = remix.traffic === 'none' ? [] : busStops(m, roads);
    const furniture = [...streetFurniture(m, roads, { pedestrian: remix.pedestrian }), ...streetPosts(m, roads)];
    streetTrees(m, roads, { plant: (x, y, origin) => { const t = tagAt(m, x, y); tag(m, x, y, 'verge', { force: true }); const ok = plantTree(m, x, y, origin); tag(m, x, y, ok ? 'sidewalk' : t, { force: true }); return ok; } });
    placeVehicles(m, { seed, traffic: remix.traffic, timeOfDay: remix.timeOfDay, pocket: pocketWeight(spawn, target) });
    const repairs = repairCover(m, { spawn, traffic: remix.traffic });
    return {
        blocks: blocks.length, blockRects: blocks, leaves: leaves.map(l => ({ id: l.id, mix: assignment.get(l.id) || null, rect: l.rect, front: l.front, frontage: l.frontage })),
        holdHost: host, repairs, assignments, strips: strips.map(s => ({ kind: s.kind, cells: s.cells })), bridges, roadSets: sets, streetObjects: [...shelters, ...furniture, ...d.vehicles.map(v => ({ type: v.type, x: v.x, y: v.y, z: v.z, kind: v.kind }))],
        scraps: scraps.length
    };
}

/** After MapKit.finish: gates, land-use snapshot and the debug report. */
export function finishDistrict(mission, m, report, { enforce = true } = {}) {
    const gates = evaluateDistrictGates(mission, m);
    mission.meta.districtGates = gates;
    mission.meta.landUse = landUseSnapshot(m);
    mission.meta.district = { ...report, origins: m.district.origins.size, vehicles: m.district.vehicles.length, zones: m.district.zones, levels: m.district.levels, warehouses: m.district.warehouses };
    if (enforce && !gates.pass) {
        const failed = Object.entries(gates.gates).filter(([, pass]) => !pass).map(([name]) => name);
        const error = new Error(`${mission.id} seed ${m.seed}: district gates failed (${failed.join(', ')})`);
        error.districtGates = gates;
        throw error;
    }
    return gates;
}

export { registerSolids };
