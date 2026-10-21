// Compile a layout v3 (PLAN-04) into a mission: ground, buildings (shell, interiors, facades, access modules),
// underground layers, bay pieces, world edges, spawns, pods, objective — then the gates, the critic and the meta the
// AI reads (pockets, flanks). Pure and deterministic: the same layout and seed give the same matrix on every peer.
import { createMap } from '../mission/modern/MapKit.js';
import { MAT } from '../voxel/Materials.js';
import { compileBuilding } from './StoreyCompiler.js';
import { compileUnderground } from './UndergroundCompiler.js';
import { checkGeneratedGates, evaluateGeneratedGates, secureStreetDrops } from './Gates.js';
import { designSlate } from './DesignSlate.js';
import { decodeGround } from './Generator.js';
import { reachable, nodeKey, pathTo } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { hashString } from '../util/Rng.js';
import { critiqueMission } from './Critic.js';

const unit = s => (hashString(s) >>> 0) / 4294967296;

/** One bay piece into voxels (+ whole-object hints and decor) at the street datum. */
export function compilePiece(m, p, district = 'commercial') {
    if(m.connectorFootprint?.has(`${Math.floor(p.x)},${Math.floor(p.y)}`))return;
    const G = m.G, s = m.store;
    if (p.base === 'car') { m.car(p.x, p.y, p.axis, unit(`${m.id}:${p.x},${p.y}:car`) < 0.5 ? 1 : -1, null, G); return; }
    if (p.base === 'container') { m.container(p.x, p.y, 'x', null, G, unit(`${m.id}:${p.x},${p.y}:stack`) < 0.25); return; }
    if (p.base === 'dumpster') { m.dumpster(p.cells[0][0], p.cells[0][1], p.axis, G); return; }
    if (p.base === 'tree') { m.tree(p.cells[0][0], p.cells[0][1], district === 'residential' || district === 'park' ? (unit(`${m.id}:${p.x},${p.y}:tree`) < 0.3 ? 'conifer' : 'round') : 'round', G); return; }
    if (p.base === 'lamp') return; // Old packages may retain lamps; the curb planner replaces them.
    for (const [x, y, stack] of p.cells) stack.forEach((key, k) => s.set(x, y, G + 1 + k, MAT[key]));
    if (p.base === 'bus_stop') m.decorAt('bus_stop', p.x + 1, p.y + 0.5, { z: G + 1, yaw: 0, free: true });
    if (p.base === 'planter' && unit(`${m.id}:${p.x},${p.y}:flowers`) < 0.4) m.decorAt('flowers', p.cells[0][0], p.cells[0][1], { z: G + 2, free: true });
}

/** World edges: barricades across off-map roads, neighbouring facades, walls, fences and chain-link. */
export function compileEdges(m, edges) {
    const G = m.G, s = m.store;
    for (const e of edges) {
        const key = { barricade: 'jersey', facade: 'concrete_wall', wall: 'brick', chainlink: 'chainlink', fence: 'privacy_fence' }[e.kind];
        const h = e.kind === 'barricade' ? 1 : e.height || 2;
        e.cells.forEach(([x, y], i) => {
            if (s.isSolid(x, y, G + 1)) return;
            // Yard fences stand on concrete blocks every fourth cell: real cover along an industrial edge.
            const blockAt = e.kind === 'chainlink' && i % 4 === 2;
            for (let k = 1; k <= h; k++) s.set(x, y, G + k, MAT[blockAt && k === 1 ? 'jersey' : key]);
            if (e.kind === 'barricade' && i % 3 === 1) m.decorAt('cordon', x, y, { z: G + 2, yaw: e.side === 'n' || e.side === 's' ? 0 : Math.PI / 2, free: true });
            if (e.kind === 'facade' && i % 4 === 2) {
                const [ox, oy] = { w: [1, 0], e: [-1, 0], n: [0, 1], s: [0, -1] }[e.side];        // the face looks into the map
                m.decorAt(i % 8 === 2 ? 'wall_sign' : 'wall_vent', x + ox * 0.55, y + oy * 0.55, { z: G + 2 + (i % 8 === 2 ? 1 : 0), yaw: Math.atan2(ox, oy), free: true });
            }
        });
    }
}

export function compileV3Map({ site, layout, design, manifest }, { seed = 1, gates = true, evaluateOnly = false } = {}) {
    const { width, depth, height } = layout;
    const m = createMap({ id: site.id, width, depth, height, seed, datum: layout.datum ?? 4, ground: 'concrete' });
    const G = m.G, mats = decodeGround(layout.ground.mat);
    for (let y = 0; y < depth; y++) for (let x = 0; x < width; x++) {
        const material=mats[x+y*width];m.store.set(x,y,G,MAT[material]);
        if(material==='air')for(let z=0;z<G;z++)m.store.set(x,y,z,0);
    }
    m.escapeBlocked = () => false;
    m.lightRoutes=layout.roads||[];
    m.beats = design.beats;
    for (const b of layout.buildings) compileBuilding(m, b);
    m.connectorPaths=new Set([...(layout.lineOfPlay?.main||[]),...(layout.lineOfPlay?.flanks||[]).flatMap(f=>f.path)].map(([x,y])=>`${x},${y}`));
    const underground = compileUnderground(m, layout.layers);
    const district = (x, y) => layout.plot?.lots?.find(l => l.lx === x >> 3 && l.ly === y >> 3)?.district || 'commercial';
    for (const p of layout.pieces) compilePiece(m, p, district(p.x, p.y));
    compileEdges(m, layout.edges || []);
    // Street dressing that never blocks: street lights along sidewalks every ~10 cells, drains on the carriageway.
    const ins = layout.insertion, [sx, sy] = [ins.x, ins.y];
    // Visual-only dressing from the authored packages: checkpoint signs either side of the insertion, cable spools
    // inside industrial edges.
    for (const [x, y] of [[sx - 3, sy], [sx + 3, sy]]) if (m.store.inBounds(x, y, G + 1) && !m.keep.has(`${x},${y}`) && !m.store.isSolid(x, y, G + 1)) m.decorAt('checkpoint_sign', x, y, { z: G + 1 });
    if (layout.plot?.family === 'industrial') {
        const spots = (layout.edges || []).filter(e => e.kind === 'chainlink').flatMap(e => e.cells.filter((_, i) => i % 9 === 4).map(([x, y]) => [x + Math.sign(width / 2 - x) * (x === 0 || x === width - 1), y + Math.sign(depth / 2 - y) * (y === 0 || y === depth - 1)]));
        for (const [x, y] of spots.slice(0, 4)) if (!m.keep.has(`${x},${y}`) && !m.store.isSolid(x, y, G + 1)) m.decorAt('cable_spool', x, y, { z: G + 1 });
    }
    // Spawns, pods and the objective.
    const enemies = [];
    for (const e of design.encounters) for (const type of e.types) enemies.push(e.at ? { type, group: e.group, at: { x: e.at.x, y: e.at.y, z: G } } : { type, group: e.group, room: { building: e.building, storey: e.floor, kind: e.room } });
    if (underground) enemies.push({ type: 'cultist', group: 99, pos: underground.guard });
    const target = design.mission.target;
    const targetRoom = m.ctx.rooms.find(r => r.buildingId === target.building && r.storey === target.floor && (r.name === target.room || r.kind === target.room));
    if (!targetRoom) throw Error(`design.objective: target room ${target.building}/${target.floor}/${target.room} does not exist`);
    const xs = targetRoom.cells.map(c => c[0]), ys = targetRoom.cells.map(c => c[1]);
    const zone = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), z: targetRoom.floorZ, dz: 0 };
    const item = { room: { building: target.building, storey: target.floor, kind: targetRoom.kind, index: m.ctx.rooms.filter(r => r.buildingId === target.building && r.storey === target.floor && r.kind === targetRoom.kind).indexOf(targetRoom) }, label: 'Syndicate intelligence' };
    const kind = design.mission.kind;
    const objective = kind === 'recover' ? { kind, item, text: design.mission.briefing ? 'Recover the intelligence from the command room.' : 'Recover the intelligence.' }
        : kind === 'hold' ? { kind, zone, rounds: 3, needed: 2, text: 'Take and hold the command room.' }
        : kind === 'extract' ? { kind, zone, needed: 3, text: 'Reach the upper rendezvous with three soldiers.' } : { kind, text: 'Clear the Syndicate from the block.' };
    const flow = layout.flow;
    const storeysMax = Math.max(...layout.buildings.map(b => b.storeys));
    const mission = m.finish({
        name: design.mission.title,
        spawns: { player: [[-1, 0], [1, 0], [0, 0], [-1, 1], [1, 1], [0, 1]].map(([dx, dy]) => ({ x: sx + dx, y: sy + dy, z: G })), enemy: enemies },
        objective,
        meta: {
            theme: site.theme || 'Downtown', lighting: design.mission.timeOfDay || site.timeOfDay, timeOfDay: design.mission.timeOfDay || site.timeOfDay, defaultCut: G + 3, streetDatum: G,
            cutLevels: [G, ...Array.from({ length: storeysMax }, (_, s) => G + 3 * (s + 1)), Infinity], imageGenerated: true, generatorVersion: layout.generatorVersion, underground, source: site.source,
            flow, briefing: design.mission.briefing, storyBeats: design.beats, congruence: layout.congruence, repairs: layout.repairs, packageId: manifest?.id, concepts: manifest?.concepts || [],
            objectiveBuilding: layout.objective?.building, plot: layout.plot ? { family: layout.plot.family, seed: layout.plot.seed, picture: layout.plot.picture } : null,
            parcelAssignments:layout.parcelAssignments||[],roads:layout.roads||[],pockets: layout.pockets || [], lineOfPlay: layout.lineOfPlay, dressing: layout.dressing,
            backdrop: { family: layout.plot?.family, roadExits: (layout.edges || []).filter(e => e.kind === 'barricade').map(e => ({ side: e.side, from: e.cells[0], to: e.cells.at(-1) })) }
        }
    });
    secureStreetDrops(mission);
    // Outdoor flow between the waypoints, traced on the compiled matrix (the slate shows these).
    const routes = [];
    for (let i = 1; i < flow.length; i++) {
        const start = { x: flow[i - 1][0], y: flow[i - 1][1], z: G }, goal = { x: flow[i][0], y: flow[i][1], z: G };
        const search = reachable(mission.store, start, Infinity, AGENT_PROFILES.player, { vault: false, blocked: p => mission.store.roomAt(p.x, p.y, p.z + 1) >= 0, goal: p => nodeKey(p) === nodeKey(goal) });
        const path = pathTo(search, goal);
        if (path.length) routes.push(path);
    }
    mission.meta.flowRoutes = routes;
    mission.meta.flanks = (layout.lineOfPlay?.flanks || []).map(f => ({ side: f.side, cells: f.path }));
    if (gates) checkGeneratedGates(mission, { site, layout, design });
    else if (evaluateOnly) evaluateGeneratedGates(mission, { site, layout, design });
    mission.meta.critic = critiqueMission(mission, layout);
    mission.visual.slate = designSlate(mission);
    mission.visual.wear = wearOf(layout);
    return mission;
}

/** Per-building and per-lot wear tints for the renderer (texture variants by noise, PLAN-04 P8). */
export function wearOf(layout) {
    const d = layout.dressing; if (!d) return null;
    return { buildings: d.buildings.map(w => { const b = layout.buildings.find(x => x.id === w.id); return { x0: b.x0, y0: b.y0, x1: b.x0 + b.w - 1, y1: b.y0 + b.d - 1, tint: w.tint, wear: w.wear, accent: w.accent }; }),
        lots: d.lots.map(l => ({ x0: l.lx * 8, y0: l.ly * 8, x1: l.lx * 8 + 7, y1: l.ly * 8 + 7, tint: l.tint, wear: l.wear })) };
}
