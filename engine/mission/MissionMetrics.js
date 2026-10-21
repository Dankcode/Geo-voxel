// Map design metrics and gates (PLAN-01 rev 2 §13.1). Measured on the surfaces a squad can actually reach.
import { reachable, pathTo, nodeKey } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { coverAt, COVER } from '../voxel/Cover.js';
import { castRay, blocksSight } from '../voxel/Raycast.js';
import { materialById, coverWeight } from '../voxel/Materials.js';

export const DEFAULT_GATES = Object.freeze({
    coverDensity: [0.18, 0.6], outdoorCover: [0.2, 1], coverGap: [0, 6], fullCoverShare: [0.05, 1], killingField: [0, 14], sightlineMedian: [5, 22],
    lanes: [2, 99], breachability: [0.5, 1], destructibleCover: [0.4, 1], spawnSafe: [1, 1]
});

export function measureMission(mission, { search = null, gates = DEFAULT_GATES } = {}) {
    const { store } = mission;
    const start = mission.spawns.player[0];
    search ||= reachable(store, start, Infinity, AGENT_PROFILES.player);
    const nodes = [...search.nodes.values()];
    let covered = 0, full = 0, indoor = 0, coverVoxels = 0, destructible = 0;
    const open = new Map();
    for (const n of nodes) {
        const c = coverAt(store, n.x, n.y, n.z);
        const best = Math.max(c.n, c.e, c.s, c.w);
        if (best >= COVER.HALF) covered++;
        if (best >= COVER.FULL) full++;
        if (store.roomAt(n.x, n.y, n.z + 1) >= 0) indoor++;
        else if (best === COVER.NONE) open.set(`${n.x},${n.y}`, true);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const m = materialById(store.get(n.x + dx, n.y + dy, n.z + 1));
            if (coverWeight(m) >= 1) { coverVoxels++; if (m.hp !== Infinity && m.hp <= 9) destructible++; }
        }
    }
    // Outdoor cover: share of outdoor tiles with cover, and the farthest any outdoor tile is from a covered one.
    const outdoorNodes = nodes.filter(n => store.roomAt(n.x, n.y, n.z + 1) < 0);
    const covKey = n => `${n.x},${n.y},${n.z}`;
    const gap = new Map(), queue = [];
    for (const n of outdoorNodes) { const c = coverAt(store, n.x, n.y, n.z); if (Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF) { gap.set(covKey(n), 0); queue.push(n); } }
    const outdoorSet = new Map(outdoorNodes.map(n => [covKey(n), n]));
    for (let i = 0; i < queue.length; i++) {
        const n = queue[i], d = gap.get(covKey(n));
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dz of [0, 1, -1]) {
            const k = `${n.x + dx},${n.y + dy},${n.z + dz}`, m = outdoorSet.get(k);
            if (m && !gap.has(k)) { gap.set(k, d + 1); queue.push(m); }
        }
    }
    let coverGap = 0, outdoorCovered = 0;
    for (const n of outdoorNodes) { const d = gap.get(covKey(n)); if (d === 0) outdoorCovered++; coverGap = Math.max(coverGap, d ?? 99); }
    // Largest open square (no cover, outdoors).
    let killingField = 0;
    const dp = new Map();
    for (let y = 0; y < store.depth; y++) for (let x = 0; x < store.width; x++) {
        if (!open.has(`${x},${y}`)) continue;
        const v = 1 + Math.min(dp.get(`${x - 1},${y}`) || 0, dp.get(`${x},${y - 1}`) || 0, dp.get(`${x - 1},${y - 1}`) || 0);
        dp.set(`${x},${y}`, v); killingField = Math.max(killingField, v);
    }
    // Sightlines from a deterministic sample of reachable tiles.
    const sample = nodes.filter((_, i) => i % Math.max(1, Math.floor(nodes.length / 60)) === 0).slice(0, 60);
    // Every ray counts (to the first opaque voxel or the map edge), so open plazas and alleys both show.
    const lengths = [];
    for (const n of sample) {
        const eye = { x: n.x + 0.5, y: n.y + 0.5, h: n.z + 2.55 };
        for (let k = 0; k < 16; k++) {
            const a = k / 16 * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
            const tx = dx > 0 ? (store.width - eye.x) / dx : dx < 0 ? -eye.x / dx : Infinity;
            const ty = dy > 0 ? (store.depth - eye.y) / dy : dy < 0 ? -eye.y / dy : Infinity;
            const edge = Math.min(40, tx, ty);
            const r = castRay(store, eye, { x: eye.x + dx * edge, y: eye.y + dy * edge, h: eye.h }, { blocks: blocksSight });
            lengths.push(r.hit ? r.t : edge);
        }
    }
    const longest = lengths.sort((a, b) => a - b);
    const sightlineMedian = longest.length ? longest[Math.floor(longest.length / 2)] : 0;
    // Lanes: shortest route, then block a corridor around it and look again.
    const zone=mission.objective?.zone,inZone=b=>zone&&(zone.x0+zone.x1)/2>=b.x0&&(zone.x0+zone.x1)/2<b.x0+b.w&&(zone.y0+zone.y1)/2>=b.y0&&(zone.y0+zone.y1)/2<b.y0+b.d;
    const targetBuilding=mission.meta?.imageGenerated?mission.buildings.find(b=>b.id===mission.objective?.item?.building)||mission.buildings.find(inZone)||mission.buildings.find(b=>b.id===mission.meta?.objectiveBuilding)||mission.buildings[0]:null;
    const z0=mission.meta?.lanesGoal==='objective'&&mission.objective?.zone,g0=typeof mission.meta?.lanesGoal==='object'?mission.meta.lanesGoal:null;
    const enemyCentre = g0?g0:z0?{x:(z0.x0+z0.x1)/2,y:(z0.y0+z0.y1)/2,z:z0.z??0}:targetBuilding?{x:targetBuilding.x0-2,y:targetBuilding.entry.y,z:targetBuilding.baseZ}:centroid(mission.spawns.enemy.map(e => e.pos));
    const goal = nodes.reduce((b, n) => (!b || dist(n, enemyCentre) < dist(b, enemyCentre) ? n : b), null);
    let lanes = 0, shortest = Infinity, advance = { run: 0, at: null };
    const blocked = new Set();
    for (let attempt = 0; attempt < 4 && goal; attempt++) {
        const s = reachable(store, start, Infinity, AGENT_PROFILES.player, { blocked: p => blocked.has(`${p.x},${p.y},${p.z}`) });
        const cost = s.costs.get(nodeKey(goal));
        if (cost == null) break;
        if (attempt === 0) shortest = cost;
        if (cost > shortest * 1.8) break;
        lanes++;
        const path = pathTo(s, nodeKey(goal));
        if (attempt === 0) advance = advanceExposure(store, path);
        for (const p of path.slice(Math.floor(path.length * 0.2), Math.floor(path.length * 0.8))) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blocked.add(`${p.x + dx},${p.y + dy},${p.z}`);
    }
    // Rooms with two or more ways in.
    const doorsPerRoom = new Map();
    for (const b of mission.buildings || []) for (const d of b.doors.filter(d => !d.locked)) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = store.roomAt(d.x + dx, d.y + dy, d.z + 1);
        if (r >= 0) doorsPerRoom.set(r, (doorsPerRoom.get(r) || 0) + 1);
    }
    const rooms = (mission.rooms || []).filter(r => r.gameplay !== false);
    const breachability = rooms.length ? rooms.filter(r => (doorsPerRoom.get(r.id) || 0) >= 2).length / rooms.length : 1;
    // Spawn safety.
    let spawnSafe = 1, firstContact = Infinity;
    for (const e of mission.spawns.enemy) for (const p of mission.spawns.player) {
        firstContact = Math.min(firstContact, Math.hypot(e.pos.x - p.x, e.pos.y - p.y));
        const r = castRay(store, { x: e.pos.x + 0.5, y: e.pos.y + 0.5, h: e.pos.z + 2.5 }, { x: p.x + 0.5, y: p.y + 0.5, h: p.z + 2 }, { blocks: blocksSight });
        if (!r.hit && Math.hypot(e.pos.x - p.x, e.pos.y - p.y) < 24) spawnSafe = 0;
    }
    const n = Math.max(1, nodes.length);
    const metrics = {
        reachableTiles: nodes.length, coverDensity: covered / n, outdoorCover: outdoorNodes.length ? outdoorCovered / outdoorNodes.length : 1, coverGap, fullCoverShare: full / n, interiorShare: indoor / n, killingField,
        sightlineMedian, lanes, breachability, advanceExposure: advance.run, advanceExposureAt: advance.at, destructibleCover: coverVoxels ? destructible / coverVoxels : 0, spawnSafe, firstContact,
        rooms: rooms.length, buildings: (mission.buildings || []).length
    };
    metrics.gates = Object.fromEntries(Object.entries(gates).map(([k, [lo, hi]]) => [k, metrics[k] >= lo && metrics[k] <= hi]));
    metrics.pass = Object.values(metrics.gates).every(Boolean);
    return metrics;
}

/**
 * PLAN-11 cover chain (after the Gears of War MP map theory notes on traversal between cover): along the main line of
 * advance, the longest run of outdoor steps with no half-or-better cover on the tile or a neighbour — the stretch a
 * squad would have to cross in the open. Returns { run, at } (at = the middle of that run).
 */
export function advanceExposure(store, path) {
    let run = 0, best = { run: 0, at: null }, startIdx = 0;
    const covered = p => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = coverAt(store, p.x + dx, p.y + dy, p.z); if (Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF) return true; } return false; };
    path.forEach((p, i) => {
        const exposed = store.roomAt(p.x, p.y, p.z + 1) < 0 && !covered(p);
        if (exposed) { if (!run) startIdx = i; run++; if (run > best.run) best = { run, at: path[startIdx + Math.floor(run / 2)] }; }
        else run = 0;
    });
    return best.at ? { run: best.run, at: { x: best.at.x, y: best.at.y, z: best.at.z } } : best;
}

const centroid = ps => ({ x: ps.reduce((s, p) => s + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((s, p) => s + p.y, 0) / Math.max(1, ps.length) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
