// PLAN-04 §5.4 — the gameplay critic. After assembly it scores how a map plays, beyond pass/fail gates, and the
// scores are saved with the mission (meta.critic) and the package manifest. The repair loop reads the gates; the
// critic's job is to make the trade-offs visible: pocket rhythm, flank concealment, vertical use, breach options in
// rooms, cover where room fights start, and how far the objective is from the evac.
import { reachable, nodeKey } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { castRay, blocksSight } from '../voxel/Raycast.js';
import { coverAt, COVER } from '../voxel/Cover.js';

const clamp01 = v => Math.max(0, Math.min(1, v));

export function critiqueMission(mission, layout) {
    if (!mission?.store || !layout) return null;
    const { store, spawns } = mission, G = mission.meta.streetDatum ?? 1;
    const search = reachable(store, spawns.player[0], Infinity, AGENT_PROFILES.player);
    const nodes = [...search.nodes.values()];
    // Pocket rhythm along the line of play (XCOM's move → cover → push cadence): gaps of 8–12 cells score best.
    const main = layout.lineOfPlay?.main || [], pockets = (layout.pockets || []).slice().sort((a, b) => a.along - b.along);
    const gaps = pockets.slice(1).map((p, i) => (p.along - pockets[i].along) * main.length);
    const pocketSpacing = { count: pockets.length, mean: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null, max: gaps.length ? Math.max(...gaps) : null };
    const rhythm = pockets.length < 2 ? 0 : clamp01(1 - gaps.reduce((s, g) => s + Math.max(0, Math.abs(g - 10) - 2), 0) / (gaps.length * 10));
    // Flank concealment: share of each flank's cells no enemy can see at the start.
    const sees = (e, p) => Math.hypot(e.pos.x - p[0], e.pos.y - p[1]) < 24 && !castRay(store, { x: e.pos.x + 0.5, y: e.pos.y + 0.5, h: e.pos.z + 2.5 }, { x: p[0] + 0.5, y: p[1] + 0.5, h: G + 2 }, { blocks: blocksSight }).hit;
    const flanks = (layout.lineOfPlay?.flanks || []).map(f => {
        const sample = f.path.filter((_, i) => i % 2 === 0);
        const hidden = sample.filter(p => !spawns.enemy.some(e => sees(e, p))).length / Math.max(1, sample.length);
        return { side: f.side, length: f.path.length, concealment: Math.round(hidden * 100) / 100 };
    });
    const concealment = flanks.length ? Math.max(...flanks.map(f => f.concealment)) : 0;
    // Vertical use: share of reachable tiles above or below the street.
    const vertical = nodes.filter(n => n.z !== G).length / Math.max(1, nodes.length);
    // Rooms: two ways in, and cover inside the first three cells from a door (where the breach fight happens).
    const rooms = mission.rooms.filter(r => r.gameplay && r.kind !== 'hall');
    const doors = mission.buildings.flatMap(b => b.doors.filter(d => !d.locked));
    const roomDoors = r => doors.filter(d => d.storey === r.storey && r.cells.some(([x, y]) => Math.abs(x - d.x) + Math.abs(y - d.y) === 1));
    const breach = rooms.filter(r => roomDoors(r).length >= 2).length / Math.max(1, rooms.length);
    const roomCover = rooms.filter(r => r.cells.some(([x, y]) => {
        const near = roomDoors(r).some(d => Math.max(Math.abs(x - d.x), Math.abs(y - d.y)) <= 3);
        if (!near) return false;
        const c = coverAt(store, x, y, r.floorZ); return Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF;
    })).length / Math.max(1, rooms.length);
    // Objective → evac (the insertion): path cost from the objective cell.
    const target = mission.objective?.item || (mission.objective?.zone ? { x: (mission.objective.zone.x0 + mission.objective.zone.x1) >> 1, y: (mission.objective.zone.y0 + mission.objective.zone.y1) >> 1, z: mission.objective.zone.z } : null);
    let evac = null;
    if (target) { const near = nodes.reduce((b, n) => (!b || Math.hypot(n.x - target.x, n.y - target.y) + Math.abs(n.z - (target.z ?? n.z)) < Math.hypot(b.x - target.x, b.y - target.y) + Math.abs(b.z - (target.z ?? b.z)) ? n : b), null); evac = near ? Math.round(search.costs.get(nodeKey(near))) : null; }
    const m = mission.metrics || {};
    const scores = {
        rhythm: Math.round(rhythm * 100), flankConcealment: Math.round(concealment * 100), verticalUse: Math.round(clamp01(vertical / 0.25) * 100),
        interiorBreach: Math.round(breach * 100), roomCover: Math.round(roomCover * 100),
        outdoorCover: Math.round(clamp01((m.outdoorCover ?? 0) / 0.35) * 100), sightlines: Math.round(clamp01(1 - Math.abs((m.sightlineMedian ?? 12) - 12) / 12) * 100),
        objectiveDistance: evac == null ? 0 : Math.round(clamp01(1 - Math.abs(evac - 45) / 45) * 100)
    };
    const weights = { rhythm: 1.2, flankConcealment: 1.4, verticalUse: 0.8, interiorBreach: 1, roomCover: 1, outdoorCover: 1, sightlines: 0.8, objectiveDistance: 0.8 };
    const total = Math.round(Object.entries(scores).reduce((s, [k, v]) => s + v * weights[k], 0) / Object.values(weights).reduce((a, b) => a + b, 0));
    return { version: 1, total, scores, pocketSpacing, flanks, evacCost: evac, rooms: rooms.length };
}
