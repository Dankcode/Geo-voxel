import { rasterRoadNetwork,pointInRegion } from './RoadGeometry.js';
import { solveReferenceParcels } from './ParcelFormula.js';
// PLAN-04 — the v3 map generator: plot → guide fields → districts → lots → buildings → line of play → layers →
// programmes → interiors → facades → bays (cover as WFC) → world edges → dressing. The result is a layout v3 (data:
// every choice is saved, so a package rebuilds byte-identically) that PackageBuilder compiles into voxels.
//
// Two entry points share everything after the plot:
//   generateOperation({ plot: 'downtown' | 'industrial' | 'suburb', seed, … })  the game's generated-map mode
//   solveLayoutV3(site, { seed, design })                                        a picture read (site.json) → map
import { LOT, BAY, STOREY } from './KitMetric.js';
import { createPlot, familyForSite, PLOT_FAMILIES, plotLot, SIDE_VEC, OPPOSITE } from './PlotCatalogue.js';
import { LOT_KINDS, DISTRICT_WALLS, DISTRICT_PALETTE, lotKindsFor } from './LotCatalogue.js';
import { Field, picturePrior, lineOfPlay, sightlineField, heightIntent, noiseField, gridPath, fbm, NOISE_LAYERS } from './Fields.js';
import { roadLotCells, solveDistricts, solveLots, placeBuildings, classifyBays, solveBays, piecesFromBays, planPockets } from './ExteriorSolver.js';
import { planParcelPins, planStreetTrees } from './ParcelTemplates.js';
import { placeCore, solveInteriorPlan, bayGridOf } from './InteriorPlanSolver.js';
import { solveFacadeV3 } from './FacadeSolver.js';
import { solveLayers } from './LayerSolver.js';
import { solveSite } from './SiteSolver.js';
import { designProgrammes, addPocketPods } from './OperationDesigner.js';
import { fireEscapeTemplate, FIRE_ESCAPE, SIDE_FRAME, facadeOrigin, facadeLength, landingEnd } from './AccessModules.js';
import { hashString } from '../util/Rng.js';
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
import { buildWithRepair } from './Repair.js';

export const GENERATOR_VERSION = '4.1.0';
const unit = s => (hashString(s) >>> 0) / 4294967296;
const SIDES = ['n', 'e', 's', 'w'];
const k2 = (x, y) => `${x},${y}`;

// ------------------------------------------------------------------------------------------------ ground
function groundFromPlot(plot, lotKind) {
    const { W, D } = plot, mat = new Array(W * D).fill('concrete'), cls = new Array(W * D).fill('concrete');
    for (const lot of plot.lots) {
        if (lot.road) for (const c of roadLotCells(lot.road)) { const i = lot.x0 + c.cx + (lot.y0 + c.cy) * W; mat[i] = c.mat; cls[i] = c.cls; }
        else {
            const g = LOT_KINDS[lotKind(lot)]?.ground || 'concrete';
            for (let y = lot.y0; y < lot.y0 + LOT; y++) for (let x = lot.x0; x < lot.x0 + LOT; x++) { mat[x + y * W] = g; cls[x + y * W] = g; }
        }
    }
    return { mat, cls };
}

/** Parking-bay stripes on parking lots (visual + road marks, no gameplay effect). */
function markParking(plot, ground, lotKind) {
    for (const lot of plot.lots) {
        if (lot.road || lotKind(lot) !== 'parking_lot') continue;
        void lot;   // PLAN-12: bay lines are drawn by the client road-paint overlay, not as voxel cells
    }
}

// ------------------------------------------------------------------------------------------------ buildings
/** Exits by lot socket: the street door on the frontage, a back/side door where a margin leaves an alley. */
function planExits(b, seed) {
    const exits = [], side = b.front, len = side === 'n' || side === 's' ? b.w : b.d;
    const mid = Math.floor(len / 2), pos = (mid % 2 ? mid : mid + 1) + 2 * Math.round((unit(`${seed}:${b.id}:door`) - 0.5) * 2);
    const at = (s, p) => s === 'n' ? { x: p, y: 0 } : s === 's' ? { x: p, y: b.d - 1 } : s === 'w' ? { x: 0, y: p } : { x: b.w - 1, y: p };
    const clamp = (p, l) => Math.max(1, Math.min(l - 2, p % 2 ? p : p - 1));
    exits.push({ ...at(side, clamp(pos, len)), side, socket: 'street' });
    const back = SIDES.filter(s => s !== side && b.margins[s] >= 2).sort((a, c) => b.margins[c] - b.margins[a] || (a === OPPOSITE[side] ? -1 : 1))[0];
    if (back) {
        const l2 = back === 'n' || back === 's' ? b.w : b.d, m2 = Math.floor(l2 / 2);
        exits.push({ ...at(back, clamp(m2 % 2 ? m2 : m2 + 1, l2)), side: back, socket: 'alley' });
    }
    return exits;
}
const inwardBay = (b, e) => [Math.max(0, Math.min(bayGridOf(b.w, b.d).nbx - 1, (e.x === 0 ? 1 : e.x === b.w - 1 ? b.w - 2 : e.x) - 1 >> 1)), Math.max(0, Math.min(bayGridOf(b.w, b.d).nby - 1, (e.y === 0 ? 1 : e.y === b.d - 1 ? b.d - 2 : e.y) - 1 >> 1))];

/**
 * Access plan in the uniform kit: 3–4 storeys get the 6 × 2 fire escape on the widest non-frontage margin (≥ 5 cells:
 * module, lip and apron), centred on a bay line, never across an exit; 1–2 storeys get a roof ladder on a blank bay
 * next to a corner. Returns null when no facade fits, and the building is regenerated rather than resized.
 */
function planAccess(b, exits, W, D, seed = 1) {
    const sides = SIDES.filter(s => s !== b.front).sort((a, c) => b.margins[c] - b.margins[a] || (a === OPPOSITE[b.front] ? -1 : 1));
    // PLAN-14: fire escapes only on some tall blocks (the objective always keeps one: it is the flank into it); the rest
    // carry their stair core on up to the roof (a railed roof hatch), so not every building wears the same escape.
    if (b.storeys >= 3 && !b.objective && unit(`${seed}:${b.id}:escape`) >= 0.35) return { module: 'roof_stair' };
    if (b.storeys >= 3) {
        for (const side of sides) {
            if (b.margins[side] < FIRE_ESCAPE.out + FIRE_ESCAPE.lip + FIRE_ESCAPE.apron) continue;
            const len = facadeLength(b, side), options = [];
            for (let offset = 1; offset + 5 <= len - 2; offset += 2) {
                const span = [offset - 1, offset + 6];
                if (exits.some(e => e.side === side && (side === 'n' || side === 's' ? e.x : e.y) >= span[0] && (side === 'n' || side === 's' ? e.x : e.y) <= span[1])) continue;
                options.push(offset);
            }
            if (!options.length) continue;
            const offset = options.sort((a, c) => Math.abs(a + 2.5 - len / 2) - Math.abs(c + 2.5 - len / 2))[0];
            const doors = {}; for (let s = 1; s < b.storeys; s++) doors[s] = landingEnd(s) ? 4 : 0;
            return { module: 'fire_escape', side, offset, doors };
        }
        return { module: 'roof_stair' };   // PLAN-14: no facade fits an escape: the core reaches the roof instead
    }
    for (const side of sides) {
        if (b.margins[side] < 3) continue;
        const len = facadeLength(b, side);
        for (const offset of [1, len - 2]) {
            const p = side === 'n' || side === 's' ? { x: offset, y: side === 'n' ? 0 : b.d - 1 } : { x: side === 'w' ? 0 : b.w - 1, y: offset };
            if (exits.some(e => e.side === side && Math.abs((side === 'n' || side === 's' ? e.x : e.y) - offset) <= 1)) continue;
            return { module: 'roof_ladder', side, offset, slot: p };
        }
    }
    return null;
}
/** Local facade cells the access module needs solid (roof ladder column) or turns into doors (escape landings). */
function accessSlots(b, access) {
    if (!access || !access.side) return [];   // PLAN-14: a roof stair has no facade slots
    const at = off => access.side === 'n' ? { x: off, y: 0 } : access.side === 's' ? { x: off, y: b.d - 1 } : access.side === 'w' ? { x: 0, y: off } : { x: b.w - 1, y: off };
    if (access.module === 'roof_ladder') return [at(access.offset)];
    return [0, 4].map(u => at(access.offset + u));
}

// ------------------------------------------------------------------------------------------------ picture plots
/**
 * A picture read as a plot: the picture's buildings (bay-snapped, footprint IoU kept ≥ .85), surfaces and flow are
 * pinned; the map grows to whole lots; lots the picture leaves open are solved by the lot WFC.
 */
export function plotFromSite(site, seed) {
    const s = solveSite(site, seed);
    const cap=site.maxDimension??64;
    const W = Math.min(cap, Math.ceil(s.width / LOT) * LOT), D = Math.min(cap, Math.ceil(s.depth / LOT) * LOT);
    const buildings = s.buildings.map(b => {
        const w = b.w % 2 ? b.w : (b.w - 1 >= 11 ? b.w - 1 : b.w + 1), d = b.d % 2 ? b.d : (b.d - 1 >= 11 ? b.d - 1 : b.d + 1);
        return { ...b, w, d };
    });
    const family = familyForSite(site);
    const lots = [];
    for (let ly = 0; ly < D / LOT; ly++) for (let lx = 0; lx < W / LOT; lx++) lots.push({ lx, ly, x0: lx * LOT, y0: ly * LOT, road: null, block: 0 });
    const F = PLOT_FAMILIES[family];
    return { version: 1, family, theme: site.theme || F.theme, seed, W, D, LW: W / LOT, LD: D / LOT, datum: 4, height: 18, lots, blocks: [], roadExits: [], picture: true,
        insertion: { x: s.flow[0][0], y: s.flow[0][1], side: s.flow[0][0] < W / 2 ? 'w' : 'e' }, site: s, buildings, underground: site.underground?.kind || F.underground, times: F.times, districts: F.districts };
}

// ------------------------------------------------------------------------------------------------ the generator
/**
 * Solve a complete v3 layout. src: { plot } (a created plot) — picture plots carry their site solve.
 * opts: { seed, design (picture fixtures may pin one), objectiveKind, timeOfDay, id, name }
 */
export function solveLayoutV3(plot, { seed = 1, design: pinnedDesign = null, objectiveKind = null, timeOfDay = null, id = null, name = null, siteRead = null, floorSpecs = [] } = {}) {
    const { W, D } = plot, repairs = [];
    const inRegion=(x,y)=>pointInRegion(plot.site?.boundary,x,y);
    const toCell = ([u, v]) => plot.picture ? [Math.round(plot.site.transform.margin + u * plot.site.transform.frame.width * plot.site.transform.scale), Math.round(plot.site.transform.margin + v * plot.site.transform.frame.height * plot.site.transform.scale)] : [Math.round(u * W), Math.round(v * D)];
    // ---- guide fields
    const prior = picturePrior(siteRead, W, D, toCell);
    if (!plot.picture) {
        // No picture: the family's own prior. Roads are known; building density is high along roads and varied by noise.
        const density = { downtown: 0.75, industrial: 0.6, suburb: 0.55 }[plot.family] ?? 0.6;
        const dn = noiseField(`${plot.family}:${seed}:density`, W, D, 'lot');
        for (const lot of plot.lots) for (let y = lot.y0; y < lot.y0 + LOT; y++) for (let x = lot.x0; x < lot.x0 + LOT; x++) {
            if (lot.road) { prior.road.set(x, y, 1); continue; }
            prior.building.set(x, y, Math.min(1, density * (0.55 + 0.9 * dn.get(x, y))));
            prior.green.set(x, y, plot.family === 'suburb' ? 0.7 : 0.25 * dn.get(y, x));
            prior.paved.set(x, y, plot.family === 'suburb' ? 0.2 : 0.6);
            prior.height.set(x, y, Math.min(1, 0.25 + 0.6 * dn.get(y, x)));
        }
    }
    const heightNoise = noiseField(`${plot.family}:${seed}`, W, D, 'district');
    let objectiveCell = plot.picture ? null : { x: (plot.objective.lx + 1) * LOT, y: (plot.objective.ly + 1) * LOT };
    const passPlot = (x, y) => x > 0 && y > 0 && x < W - 1 && y < D - 1;
    const prelim = objectiveCell ? lineOfPlay(W, D, passPlot, plot.insertion, objectiveCell) : null;
    const fields = { prior, height: heightIntent(prior, heightNoise, objectiveCell), play: prelim || { dist: new Field(W, D, 20), flank: new Field(W, D, 20), along: new Field(W, D) } };
    // ---- districts, lots, buildings
    let parcels, lotKindAt, buildings, districts;
    if (!plot.picture) {
        districts = solveDistricts(plot, fields, seed);
        const lots = solveLots(plot, districts, fields, seed);
        parcels = lots.parcels;
        lotKindAt = lot => lots.byLot.get(`${lot.lx},${lot.ly}`)?.kind || null;
        buildings = placeBuildings(plot, parcels, fields, seed);
        plot.lotKinds = Object.fromEntries([...lots.byLot].map(([k, p]) => [k, p.kind]));
    } else {
        ({ parcels, lotKindAt, buildings, districts } = pictureLots(plot, fields, seed, siteRead));
        // A pinned design decides the played heights (its floor programmes) and the objective building.
        if (pinnedDesign) for (const b of buildings) {
            const floors = pinnedDesign.programs.filter(p => p.building === b.id).length;
            if (floors && floors !== b.storeys) { repairs.push({ kind: 'played-height', id: b.id, observed: b.storeys, played: floors }); b.storeys = floors; }
            b.objective = b.id === pinnedDesign.mission.target.building;
        }
    }
    // ---- exits, access, core (geometry first; the interiors keep these bays playable)
    for (const b of buildings) {
        // Street door first, then the uniform access module, then a back/side door that keeps clear of the module.
        const [street, alley] = planExits(b, seed);
        b.access = planAccess(b, [street], W, D, seed);
        if (!b.access && b.storeys >= 3) { repairs.push({ kind: 'storeys-for-access', id: b.id, from: b.storeys, to: 2 }); b.storeys = 2; b.access = planAccess(b, [street], W, D, seed); }
        b.exits = [street];
        if (alley) {
            const span = b.access?.module === 'fire_escape' && b.access.side === alley.side ? [b.access.offset - 2, b.access.offset + 7] : b.access?.side === alley.side ? [b.access.offset - 2, b.access.offset + 2] : null;
            const pos = alley.side === 'n' || alley.side === 's' ? alley.x : alley.y, len = alley.side === 'n' || alley.side === 's' ? b.w : b.d;
            if (!span || pos < span[0] || pos > span[1]) b.exits.push(alley);
            else for (const p of [span[0] - 1, span[1] + 1, span[0] - 3, span[1] + 3]) if (p >= 1 && p <= len - 2 && p % 2 === 1) { b.exits.push(alley.side === 'n' || alley.side === 's' ? { ...alley, x: p } : { ...alley, y: p }); break; }
        }
    }
    // ---- line of play on the real footprints: insertion → the objective's street door
    const target = buildings.find(b => b.objective) || buildings.slice().sort((a, c) => c.storeys - a.storeys || c.w * c.d - a.w * a.d)[0];
    target.objective = true;
    const inside = (x, y) => buildings.some(b => x >= b.x0 && y >= b.y0 && x < b.x0 + b.w && y < b.y0 + b.d);
    const door = target.exits[0], [ox, oy] = SIDE_VEC[door.side];
    const goal = { x: target.x0 + door.x + ox * 3, y: target.y0 + door.y + oy * 3 };
    const accessObstacles=new Set(buildings.filter(b=>b.access?.module==='fire_escape').flatMap(b=>fireEscapeTemplate({side:b.access.side,origin:facadeOrigin(b,b.access.side,b.access.offset),datum:0,storeys:b.storeys}).cells.filter(c=>c.role==='post'&&c.z===1).map(c=>k2(c.x,c.y))));
    const passable = (x, y) => inRegion(x,y)&&!accessObstacles.has(k2(x,y)) && x > 0 && y > 0 && x < W - 1 && y < D - 1 && !inside(x, y);
    // A picture's designer flow is kept: its waypoints must be on open ground, and the main route threads them.
    const waypoints = plot.picture ? plot.site.flow.slice(1).map(([x, y]) => ({ x, y })) : [];
    for (const w of waypoints) if (!passable(w.x, w.y)) throw Error(`Gameplay waypoint ${w.x},${w.y} is blocked; revise image analysis flow`);
    const play = lineOfPlay(W, D, passable, plot.insertion, goal, { via: waypoints });
    fields.play = play;
    objectiveCell = { x: target.x0 + (target.w >> 1), y: target.y0 + (target.d >> 1) };
    // ---- protected cells: spawn, routes, exits, access aprons
    const protectedCells = new Set(), protect = (x, y, r = 0) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) protectedCells.add(k2(x + dx, y + dy)); };
    for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) protect(plot.insertion.x + dx, plot.insertion.y + dy);
    for (const p of play.main.path) protect(p.x, p.y);
    for (const f of play.flanks) for (const p of f.path) protect(p.x, p.y);
    for (const b of buildings) {
        for (const e of b.exits) { const [dx, dy] = SIDE_VEC[e.side]; for (let r = 1; r <= 3; r++) protect(b.x0 + e.x + dx * r, b.y0 + e.y + dy * r, 1); }
        if (b.access?.side) {
            const f = SIDE_FRAME[b.access.side], origin = facadeOrigin(b, b.access.side, b.access.offset);
            const span = b.access.module === 'fire_escape' ? [-1, 6, 5] : [-2, 2, 2];
            for (let u = span[0]; u <= span[1]; u++) for (let r = 1; r <= span[2]; r++) protectedCells.add(k2(origin[0] + f.a[0] * u + f.o[0] * r, origin[1] + f.a[1] * u + f.o[1] * r));
        }
    }
    // ---- layers: a flank tunnel from near the insertion to the objective's side door (its openings keep off the
    // access modules and the spawn; the tunnel itself may pass under anything)
    const moduleCells = new Set();
    for (let dy = -2; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) moduleCells.add(k2(plot.insertion.x + dx, plot.insertion.y + dy));
    for (const b of buildings) if (b.access?.side) {
        const f = SIDE_FRAME[b.access.side], origin = facadeOrigin(b, b.access.side, b.access.offset), span = b.access.module === 'fire_escape' ? [-2, 7, 6] : [-2, 2, 3];
        for (let u = span[0]; u <= span[1]; u++) for (let r = 1; r <= span[2]; r++) moduleCells.add(k2(origin[0] + f.a[0] * u + f.o[0] * r, origin[1] + f.a[1] * u + f.o[1] * r));
    }
    const parcels4 = [];
    for (let py = 0; py < Math.ceil(D / 4); py++) for (let px = 0; px < Math.ceil(W / 4); px++) {
        const cx = px * 4 + 2, cy = py * 4 + 2;
        parcels4.push({ id: `${px},${py}`, kind: inside(cx, cy) ? 'building' : prior.road.get(cx, cy) > 0.5 ? 'street' : 'sidewalk' });
    }
    const flank = play.flanks.slice().sort((a, c) => a.cost - c.cost)[0];
    // The manhole comes up beside the objective on the flank side nearest the squad (not its front door), so the
    // tunnel is a real alternative to the street rather than a detour.
    const freeCell = (x, y) => passable(x, y) && !moduleCells.has(k2(x, y)) && !buildings.some(b => x >= b.x0 - 1 && x <= b.x0 + b.w && y >= b.y0 - 1 && y <= b.y0 + b.d);
    const sideMid = s => s === 'n' ? { x: target.x0 + (target.w >> 1), y: target.y0 - 3 } : s === 's' ? { x: target.x0 + (target.w >> 1), y: target.y0 + target.d + 2 } : s === 'w' ? { x: target.x0 - 3, y: target.y0 + (target.d >> 1) } : { x: target.x0 + target.w + 2, y: target.y0 + (target.d >> 1) };
    const sideOrder = SIDES.filter(s => s !== target.front).sort((a, c) => Math.hypot(sideMid(a).x - plot.insertion.x, sideMid(a).y - plot.insertion.y) - Math.hypot(sideMid(c).x - plot.insertion.x, sideMid(c).y - plot.insertion.y));
    // …but never so close to the insertion that the tunnel is a few steps long (its guard would sit beside the squad).
    const approaches = sideOrder.map(sd => nearestFree(W, D, sideMid(sd), freeCell)).filter(Boolean);
    const approach = approaches.find(p => Math.hypot(p.x - plot.insertion.x, p.y - plot.insertion.y) >= 14) || approaches[0];
    const toward = (() => { const dx = approach.x - plot.insertion.x, dy = approach.y - plot.insertion.y, l = Math.hypot(dx, dy) || 1; return { x: Math.round(plot.insertion.x + dx / l * 8), y: Math.round(plot.insertion.y + dy / l * 8) }; })();
    const entrance = pickEntrance(plot, buildings, protectedCells, { path: [toward, toward, toward, toward, toward, toward, toward] }, W, D, (x, y) => passable(x, y) && !moduleCells.has(k2(x, y)));
    const layerLayout = { width: W, depth: D, buildings, flow: [[plot.insertion.x, plot.insertion.y]], parcels: parcels4 };
    const layerSite = { id: id || `${plot.family}-${seed}`, underground: { kind: plot.underground } };
    let layers = null;
    for (let attempt = 0; attempt < 4 && !layers; attempt++) {
        try {
            layers = solveLayers(layerLayout, layerSite, seed + attempt, { entrance, approach, kind: plot.underground, bridge: !!(siteRead?.levels?.includes('bridge') || siteRead?.underground?.kind === 'underpass'),
                avoid: (x, y) => moduleCells.has(k2(x, y)) });
        } catch (e) { if (attempt === 3) repairs.push({ kind: 'no-underground', reason: e.message }); }
    }
    if (layers) {
        layers.baffles = [0.3, 0.6, 0.85];
        for (const p of [layers.entrances[0], layers.entrances[1]]) protect(p.x, p.y, 2);
        layers.entrances[0].dir = entrance.dir;
        const run = stairRun(layers.entrances[0], buildings, W, D);
        for (const c of run?.cells || []) protect(c.x, c.y, 1);
    }
    // ---- design: programmes, objective, beats, pods
    const design = pinnedDesign || designProgrammes({ buildings, target, plot, seed, objectiveKind, timeOfDay, name, pockets: [] });
    // ---- interiors and facades
    for (const b of buildings) {
        const programmes = design.programs.filter(p => p.building === b.id).sort((a, c) => a.floor - c.floor);
        if (programmes.length !== b.storeys) throw Error(`design.program: ${b.id} needs ${b.storeys} floor programmes, got ${programmes.length}`);
        const exitBays = b.exits.map(e => inwardBay(b, e)), slots = accessSlots(b, b.access);
        const escapeBays = b.access?.module === 'fire_escape' ? slots.map(sl => inwardBay(b, sl)) : [];
        let core = null;
        if (b.storeys >= 2) {
            // PLAN-14: narrow footprint variants: when the back door blocks every core position, the back door goes.
            try { core = placeCore(b, { seed, avoid: [...exitBays, ...escapeBays] }); }
            catch (e) { if (b.exits.length < 2) throw e; b.exits = b.exits.slice(0, 1); repairs.push({ kind: 'drop-back-door', id: b.id }); core = placeCore(b, { seed, avoid: [inwardBay(b, b.exits[0]), ...escapeBays] }); }
        }
        b.floors = programmes.map(p => solveInteriorPlan(b, p, { seed, core, keepGameplay: [...(p.floor === 0 ? exitBays : []), ...(p.floor > 0 ? escapeBays : [])],
            prior: floorSpecs.find(f => f.building === b.id && f.floor === p.floor) || null }));
        b.facade = solveFacadeV3(b, b.floors, { seed, exits: b.exits, blank: slots });
        // Fire-escape doors land on bay cells: the end landing's u = 0 / 4 (odd facade offsets).
        if (b.access?.module === 'fire_escape') for (let s = 1; s < b.storeys; s++) b.access.doors[s] = landingEnd(s) ? 4 : 0;
    }
    reconcileDesign(design, buildings);
    // ---- bays: cover and props as WFC tiles, pockets pinned along the line of play
    const blocked = (x, y) => !inRegion(x,y)||buildings.some(b => x >= b.x0 - 1 && y >= b.y0 - 1 && x <= b.x0 + b.w && y <= b.y0 + b.d);
    const ground = plot.picture ? pictureGround(plot, siteRead, W, D) : groundFromPlot(plot, lotKindAt);
    if (!plot.picture) markParking(plot, ground, lotKindAt);
    let bayGrid = classifyBays(W, D, ground, blocked, protectedCells);
    const sight = sightlineField(W, D, (x, y) => !blocked(x, y));
    fields.sight = (x, y) => sight.get(x, y);
    const { pins, pockets } = planPockets(play.main.path, bayGrid, { seed: `${plot.family}:${seed}` });
    if (!pinnedDesign) addPocketPods(design, pockets.filter(p => Math.hypot(p.x - plot.insertion.x, p.y - plot.insertion.y) >= 16), seed);
    // The street drop goes where no pod will see it: early on the tunnel, as far as possible from every pod.
    if (layers) {
        const pods = [...design.encounters.filter(e => e.at).map(e => ({ ...e.at, own: null })), ...design.encounters.filter(e => !e.at).map(e => { const b = buildings.find(x => x.id === e.building); return b ? { x: b.x0 + b.w / 2, y: b.y0 + b.d / 2, own: b } : null; }).filter(Boolean)];
        // 2D occlusion by footprints (a building a pod is not inside blocks its view): a lower bound on cover.
        const hidden = (q, p) => {
            const d = Math.hypot(p.x - q.x, p.y - q.y); if (d >= 24) return true;
            for (let t = 0.5; t < d; t += 0.5) { const x = Math.floor(q.x + (p.x - q.x) * t / d), y = Math.floor(q.y + (p.y - q.y) * t / d); if (buildings.some(b => b !== q.own && x >= b.x0 && y >= b.y0 && x < b.x0 + b.w && y < b.y0 + b.d)) return true; }
            return false;
        };
        const route = layers.route, ends = layers.entrances;
        let best = null;
        for (let i = Math.floor(route.length * 0.15); i <= Math.floor(route.length * 0.7); i++) {
            const p = route[i]; if (ends.some(e => Math.hypot(e.x - p.x, e.y - p.y) < 5)) continue;
            if (pins.has(`${Math.floor(p.x / BAY)},${Math.floor(p.y / BAY)}`)) continue;
            const seen = pods.filter(q => !hidden(q, p) || !hidden(q, { x: p.x + 1, y: p.y })).length;
            const score = -seen * 40 + Math.min(30, ...pods.map(q => Math.hypot(q.x - p.x, q.y - p.y))) - Math.abs(i / route.length - 0.4) * 6;
            if (!best || score > best.score) best = { p, score };
        }
        if (best) layers.drop = { x: best.p.x, y: best.p.y };
        protect(layers.drop.x, layers.drop.y, 2);
        bayGrid = classifyBays(W, D, ground, blocked, protectedCells);
    }
    const lotPool = (lot, bay) => {
        if(bay.cls.startsWith('parking_'))return 'parking';
        if(bay.cls==='carriageway')return 'carriageway';
        if (bay.cls === 'sidewalk') return 'sidewalk';
        if (bay.cls === 'lane_x' || bay.cls === 'lane_y' || (lot.road && bay.cls === 'asphalt')) return 'lane';
        const kind = lotKindAt(lot);
        return LOT_KINDS[kind]?.pool || (plot.picture ? pictureBayPool(bay.cls) : 'yard_paved');
    };
    const roadAxis = lot => {
        if (lot.road) { const c = lot.road; return (c.e || c.w) && !c.n && !c.s ? 'x' : (c.n || c.s) && !c.e && !c.w ? 'y' : null; }
        return plot.picture ? (ground.axisAt?.(lot) ?? null) : null;
    };
    const solveArgs = { plot, bayGrid, lotPool, roadAxis, fields, seed, objectiveAt: objectiveCell };
    // PLAN-13: designed parcels (ParcelTemplates) and street trees first; line-of-play pockets win where they meet.
    if (!plot.picture) {
        const layoutPins = new Map([...planStreetTrees(bayGrid), ...planParcelPins(plot, bayGrid, lotKindAt, kind => LOT_KINDS[kind]?.pool)]);
        solveArgs.soft = new Set();
        for (const [id, piece] of layoutPins) if (!pins.has(id)) { pins.set(id, piece); solveArgs.soft.add(id); }
    }
    const bays = solveBays({ ...solveArgs, pins });
    const pieces = piecesFromBays(bays, bayGrid);
    // ---- world edges and dressing
    const edges = planEdges(plot, ground, buildings, districts, seed, protectedCells);
    const dressing = planDressing(plot, buildings, parcels, seed);
    const layout = {
        roads:plot.site?.roads||[],parking:plot.site?.parking||[],parcelAssignments:plot.parcelAssignments||[],
        version: 3, generatorVersion: GENERATOR_VERSION, datum: plot.datum, id: id || `${plot.family}-${seed}`, width: W, depth: D, height: plot.height,
        plot: { family: plot.family, theme: plot.theme, seed: plot.seed, lots: plot.lots.map(l => ({ lx: l.lx, ly: l.ly, road: l.road, kind: lotKindAt(l), district: districts?.at?.(l.lx, l.ly) ?? null })), roadExits: plot.roadExits, picture: !!plot.picture },
        ground: { mat: encodeGround(ground.mat) },
        buildings: buildings.map(b => ({ ...b, bounds: undefined })), pieces, edges, pockets, dressing,
        lineOfPlay: { main: play.main.path.map(p => [p.x, p.y]), cost: play.main.cost, flanks: play.flanks.map(f => ({ side: f.side, cost: f.cost, path: f.path.map(p => [p.x, p.y]) })) },
        insertion: plot.insertion, objective: { building: target.id, cell: objectiveCell },
        flow: plot.picture ? plot.site.flow.map(([x, y]) => [x, y]) : flowWaypoints(play.main.path), layers, parcels: parcels4, repairs,
        reference: buildings.map(b => ({ id: b.id, x0: b.x0, y0: b.y0, w: b.w, d: b.d, storeys: b.storeys })), congruence: buildings.map(b => ({ id: b.id, iou: 1, storeys: b.storeys })),
        transform: plot.picture ? plot.site.transform : { scale: 1, margin: 0, frame: { width: W, height: D } }, surfaces: []
    };
    if (plot.picture) {
        layout.reference = plot.site.reference; layout.congruence = plot.site.congruence.map(c => ({ ...c, iou: footprintIoU(plot.site.reference.find(r => r.id === c.id), buildings.find(b => b.id === c.id)) }));
        layout.repairs.push(...plot.site.repairs);
    }
    // The solver state stays beside the layout (never serialised) so the repair loop can re-collapse single lots.
    const context = { plot, bayGrid, bays, fields, pins: new Map(pins), solveArgs };
    return { layout, design, context };
}

/**
 * Keep the design's located references valid after interior repairs merged or dropped rooms: a beat, pod or the
 * objective that names a room no longer on its floor moves to that floor's largest gameplay room.
 */
function reconcileDesign(design, buildings) {
    const fix = ref => {
        const b = buildings.find(x => x.id === ref.building); if (!b) return;
        const f = b.floors[ref.floor], rooms = f.rooms.filter(r => r.gameplay !== false);
        if (rooms.some(r => r.id === ref.room || (ref.room !== 'hall' && r.kind === ref.room))) return;
        const best = rooms.filter(r => r.id !== 'hall').sort((a, c) => c.cells.length - a.cells.length)[0] || rooms[0];
        ref.room = best.id;
    };
    fix(design.mission.target);
    for (const beat of design.beats) fix(beat);
    for (const e of design.encounters) if (!e.at) fix(e);
    const programs = new Map(buildings.flatMap(b => b.floors.map(f => [`${b.id}:${f.floor}`, f])));
    for (const p of design.programs) { const f = programs.get(`${p.building}:${p.floor}`); if (f) p.rooms = p.rooms.filter(r => f.rooms.some(q => q.id === r.id)); }
    return design;
}

const footprintIoU = (a, b) => { const ox = Math.max(0, Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0)), oy = Math.max(0, Math.min(a.y0 + a.d, b.y0 + b.d) - Math.max(a.y0, b.y0)), n = ox * oy; return n / (a.w * a.d + b.w * b.d - n); };

function nearestFree(W, D, p, ok) {
    for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = p.x + dx, y = p.y + dy;
        if (x >= 2 && y >= 2 && x < W - 2 && y < D - 2 && ok(x, y)) return { x, y };
    }
    return p;
}

/** The subway stairs: an open cell near the insertion, a few cells off the main route, with a clear 4-cell run. */
function pickEntrance(plot, buildings, protectedCells, flank, W, D, passable) {
    const near = (x, y) => buildings.some(b => x >= b.x0 - 1 && x <= b.x0 + b.w && y >= b.y0 - 1 && y <= b.y0 + b.d);
    const start = flank?.path?.[Math.min(flank.path.length - 1, 6)] || { x: plot.insertion.x, y: plot.insertion.y - 4 };
    let best = null;
    for (let y = 2; y < D - 2; y++) for (let x = 2; x < W - 2; x++) {
        if (!passable(x, y) || near(x, y)) continue;
        const run = stairRun({ x, y }, buildings, W, D, (cx, cy) => passable(cx, cy) && !near(cx, cy));
        if (!run) continue;
        const di = Math.hypot(x - plot.insertion.x, y - plot.insertion.y);
        if (di < 5) continue;
        const score = Math.hypot(x - start.x, y - start.y) + (protectedCells.has(k2(x, y)) ? 3 : 0);
        if (!best || score < best.score) best = { x, y, dir: run.dir, score };
    }
    return best ? { x: best.x, y: best.y, dir: best.dir } : { x: plot.insertion.x, y: plot.insertion.y - 3 };
}
/** The subway stair run: the first side whose 4 cells are in bounds, off every footprint and allowed by `ok`. */
function stairRun(e, buildings, W, D, ok = () => true) {
    for (const [dx, dy] of e.dir ? [e.dir] : [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const cells = Array.from({ length: 4 }, (_, i) => ({ x: e.x + dx * (i + 1), y: e.y + dy * (i + 1) }));
        if (cells.every(p => p.x >= 0 && p.y >= 0 && p.x < W && p.y < D && !buildings.some(b => p.x >= b.x0 && p.x < b.x0 + b.w && p.y >= b.y0 && p.y < b.y0 + b.d) && ok(p.x, p.y)))
            return { dir: [dx, dy], cells: [{ x: e.x, y: e.y }, ...cells.slice(0, 3)] };
    }
    return null;
}

function flowWaypoints(path) {
    const out = [[path[0].x, path[0].y]];
    for (let i = 10; i < path.length - 4; i += 10) out.push([path[i].x, path[i].y]);
    out.push([path.at(-1).x, path.at(-1).y]);
    return out;
}

const GROUND_CODES = { air:'v',concrete: 'c', asphalt: 'a', road_mark: 'm', paving: 'p', lawn: 'l', gravel: 'g', deck: 'd', soil: 's' };
const GROUND_KEYS = Object.fromEntries(Object.entries(GROUND_CODES).map(([k, v]) => [v, k]));
export const encodeGround = mat => mat.map(m => GROUND_CODES[m] || 'c').join('');
export const decodeGround = str => [...str].map(c => GROUND_KEYS[c] || 'concrete');

// ------------------------------------------------------------------------------------------------ picture mode
function pictureLots(plot, fields, seed, siteRead) {
    const theme = plot.theme, district = { Suburbs: 'residential', Downtown: 'commercial', Industrial: 'industrial', Roadside: 'commercial' }[theme] || 'commercial';
    const programPool = { house: 'yard_garden', office: 'yard_paved', shop: 'yard_paved', diner: 'yard_paved', warehouse: 'yard_industrial', garage: 'yard_industrial' };
    const site = plot.site, W = plot.W, D = plot.D;
    const asphalt = new Set();
    for (const s of site.surfaces) if (s.material === 'asphalt') for (let y = s.y0; y < s.y0 + s.d; y++) for (let x = s.x0; x < s.x0 + s.w; x++) asphalt.add(k2(x, y));
    const buildings = plot.buildings.map((b, i) => {
        const tallest = plot.buildings.slice().sort((a, c) => c.storeys - a.storeys)[0] === b;
        return { id: b.id, parcel: null, kind: 'picture', program: b.program, district, x0: b.x0, y0: b.y0, w: b.w, d: b.d, storeys: b.storeys, observedStoreys: b.observedStoreys ?? b.storeys, front: b.front,
            margins: { n: b.y0, s: D - (b.y0 + b.d), w: b.x0, e: W - (b.x0 + b.w) }, wall: (DISTRICT_WALLS[district])[Math.floor(unit(`${seed}:${b.id}:wall`) * 3) % DISTRICT_WALLS[district].length],
            roof: 'flat', accent: DISTRICT_PALETTE[district][i % DISTRICT_PALETTE[district].length], objective: tallest };
    });
    const parcelAssignments=solveReferenceParcels(siteRead||{},buildings,seed);
    plot.parcelAssignments=parcelAssignments;
    for(const p of parcelAssignments){const b=buildings.find(b=>b.id===p.slot);b.parcel=p.prototype;b.wall=p.wall;}
    // Real margins: distance to the next footprint on each side (or the map edge).
    for (const b of buildings) for (const o of buildings) if (o !== b) {
        const overlapX = Math.min(b.x0 + b.w, o.x0 + o.w) > Math.max(b.x0, o.x0), overlapY = Math.min(b.y0 + b.d, o.y0 + o.d) > Math.max(b.y0, o.y0);
        if (overlapX && o.y0 >= b.y0 + b.d) b.margins.s = Math.min(b.margins.s, o.y0 - (b.y0 + b.d));
        if (overlapX && o.y0 + o.d <= b.y0) b.margins.n = Math.min(b.margins.n, b.y0 - (o.y0 + o.d));
        if (overlapY && o.x0 >= b.x0 + b.w) b.margins.e = Math.min(b.margins.e, o.x0 - (b.x0 + b.w));
        if (overlapY && o.x0 + o.w <= b.x0) b.margins.w = Math.min(b.margins.w, b.x0 - (o.x0 + o.w));
    }
    // Lot kinds: lots under a footprint are the picture's; the rest is a small WFC over open kinds for the theme.
    const kinds = new Map(), open = lotKindsFor(plot.family).filter(k => !LOT_KINDS[k].building && LOT_KINDS[k].districts.includes(district));
    const nodes = [], domains = new Map();
    for (const lot of plot.lots) {
        const id = k2(lot.lx, lot.ly);
        const covered = buildings.some(b => b.x0 - 1 < lot.x0 + LOT && b.x0 + b.w + 1 > lot.x0 && b.y0 - 1 < lot.y0 + LOT && b.y0 + b.d + 1 > lot.y0);
        let asph = 0; for (let y = lot.y0; y < lot.y0 + LOT; y++) for (let x = lot.x0; x < lot.x0 + LOT; x++) if (asphalt.has(k2(x, y))) asph++;
        if (covered) { const b = buildings.find(b => b.x0 - 1 < lot.x0 + LOT && b.x0 + b.w + 1 > lot.x0 && b.y0 - 1 < lot.y0 + LOT && b.y0 + b.d + 1 > lot.y0); kinds.set(id, { picture: true, pool: programPool[b.program] }); continue; }
        if (asph >= 24) { kinds.set(id, { street: true }); continue; }
        nodes.push({ id, neighbors: SIDES.map(s => k2(lot.lx + SIDE_VEC[s][0], lot.ly + SIDE_VEC[s][1])).map(n => ({ id: n, direction: 'adj' })) });
        domains.set(id, open.filter(k => k !== 'subway_plaza' || plot.family === 'downtown'));
    }
    for (const n of nodes) n.neighbors = n.neighbors.filter(x => domains.has(x.id));
    if (nodes.length) {
        const a = solveWaveFunctionCollapse({ nodes, tiles: open.map(id => ({ id, weight: LOT_KINDS[id].w })), domains, compatible: (x, y) => !(x === y && ['construction_site', 'vacant_lot'].includes(x)), seed: `${plot.family}:${seed}:picture-lots`,
            nodeWeights: (id, t) => { const [lx, ly] = id.split(',').map(Number); return LOT_KINDS[t].w * (0.4 + fbm(`${seed}:lot`, lx * 8, ly * 8, NOISE_LAYERS.lot)) * (['pocket_park', 'backyard'].includes(t) ? 0.5 + fields.prior.green.mean(lx * 8, ly * 8, lx * 8 + 7, ly * 8 + 7) : 1); } });
        for (const [id, t] of a) kinds.set(id, { kind: t });
    }
    const lotKindAt = lot => kinds.get(k2(lot.lx, lot.ly))?.kind || null;
    plot.pictureLots = kinds;
    plot.lotKinds = Object.fromEntries([...kinds].map(([k, v]) => [k, v.kind || (v.picture ? 'picture' : 'street')]));
    return { parcels: [], lotKindAt, buildings, districts: { at: () => district } };
}
function pictureBayPool(cls) { if(cls.startsWith('parking_'))return 'parking';if(cls==='carriageway')return 'carriageway';return cls === 'lawn' ? 'yard_garden' : cls === 'asphalt' ? 'parking' : cls === 'gravel' ? 'vacant' : 'yard_paved'; }
function pictureGround(plot, siteRead, W, D) {
    const site = plot.site, base = plot.theme === 'Suburbs' ? 'lawn' : 'concrete';
    const mat = new Array(W * D).fill(base), cls = new Array(W * D).fill(base);
    for (const lot of plot.lots) { const k = plot.pictureLots?.get(k2(lot.lx, lot.ly))?.kind; if (k) { const g = LOT_KINDS[k].ground; for (let y = lot.y0; y < lot.y0 + LOT; y++) for (let x = lot.x0; x < lot.x0 + LOT; x++) { mat[x + y * W] = g; cls[x + y * W] = g; } } }
    for (const s of site.surfaces) for (let y = s.y0; y < Math.min(D, s.y0 + s.d); y++) for (let x = s.x0; x < Math.min(W, s.x0 + s.w); x++) { mat[x + y * W] = s.material; cls[x + y * W] = s.material === 'concrete' ? 'sidewalk' : s.material; }
    // Picture roads: carriageway cells within two of a kerb run along the road are the parking lane.
    for (const s of site.surfaces) if (s.material === 'asphalt') {
        const alongX = s.w >= s.d;
        for (let y = s.y0; y < Math.min(D, s.y0 + s.d); y++) for (let x = s.x0; x < Math.min(W, s.x0 + s.w); x++) {
            const edge = alongX ? Math.min(y - s.y0, s.y0 + s.d - 1 - y) : Math.min(x - s.x0, s.x0 + s.w - 1 - x);
            cls[x + y * W] = edge < 2 ? (alongX ? 'lane_x' : 'lane_y') : 'asphalt';
        }
    }
    for(const p of site.parking||[])for(let y=p.y0;y<Math.min(D,p.y0+p.d);y++)for(let x=p.x0;x<Math.min(W,p.x0+p.w);x++) {
        mat[x+y*W]='asphalt';cls[x+y*W]=`parking_${p.axis||'y'}`;
    }
    const owned=(x,y)=>plot.buildings.some(b=>x>=b.x0-1&&y>=b.y0-1&&x<=b.x0+b.w&&y<=b.y0+b.d);
    for(const c of rasterRoadNetwork(site.roads||[],W,D,{blocked:owned})) {mat[c.x+c.y*W]=c.material;cls[c.x+c.y*W]=c.road?(c.edge<1.5?`lane_${c.axis}`:'carriageway'):'sidewalk';}
    if(site.boundary)for(let y=0;y<D;y++)for(let x=0;x<W;x++)if(!pointInRegion(site.boundary,x,y)){mat[x+y*W]='air';cls[x+y*W]='outside';}
    return { mat, cls, axisAt: lot => { const c = cls[lot.x0 + 4 + (lot.y0 + 4) * W]; return c === 'lane_x' ? 'x' : c === 'lane_y' ? 'y' : null; } };
}

// ------------------------------------------------------------------------------------------------ world edges
/**
 * A map is a window into a city (PLAN-04 §5.3 step 7): open map borders are closed by world pieces (a neighbouring
 * building face downtown, fences and hedges in the suburbs, chain-link and containers in the yards), and every
 * road that leaves the map ends in a police barricade, so the plot reads as continuous.
 */
export function planEdges(plot, ground, buildings, districts, seed, protectedCells) {
    const { W, D } = plot, out = [];
    const isAsphalt = (x, y) => ['asphalt', 'road_mark'].includes(ground.mat[x + y * W]) && (plot.picture || !!plotLot(plot, Math.floor(x / LOT), Math.floor(y / LOT))?.road);
    const occupied = (x, y) => buildings.some(b => x >= b.x0 && y >= b.y0 && x < b.x0 + b.w && y < b.y0 + b.d);
    const runs = [];
    for (const side of SIDES) {
        const len = side === 'n' || side === 's' ? W : D;
        let run = null;
        for (let t = 0; t < len; t++) {
            const [x, y] = side === 'n' ? [t, 0] : side === 's' ? [t, D - 1] : side === 'w' ? [0, t] : [W - 1, t];
            const kind = ground.mat[x+y*W]==='air'||occupied(x, y) ? null : isAsphalt(x, y) ? 'road' : 'open';
            if (run && run.kind === kind) run.cells.push([x, y]);
            else { if (run) runs.push(run); run = kind ? { side, kind, cells: [[x, y]] } : null; }
        }
        if (run) runs.push(run);
    }
    for (const run of runs) {
        const [mx, my] = run.cells[run.cells.length >> 1], district = districts?.at?.(Math.floor(mx / LOT), Math.floor(my / LOT)) || 'commercial';
        if (run.kind === 'road') { out.push({ kind: 'barricade', side: run.side, cells: run.cells }); continue; }
        const style = district === 'commercial' || district === 'plaza' ? (unit(`${seed}:${mx},${my}:edge`) < 0.7 ? 'facade' : 'wall')
            : district === 'industrial' || district === 'yard' ? 'chainlink' : 'fence';
        out.push({ kind: style, side: run.side, cells: run.cells, height: style === 'facade' ? 6 + 3 * Math.floor(unit(`${seed}:${mx},${my}:h`) * 2) : 2 });
    }
    return out;
}

/** Texture variants by low-frequency noise: whole buildings and lots age together (no per-tile flicker). */
function planDressing(plot, buildings, parcels, seed) {
    const tint = (n, base) => { const v = 1 - 0.18 * n; return [v * base[0], v * base[1], v * base[2]].map(c => Math.round(c * 1000) / 1000); };
    const wear = n => (n < 0.33 ? 'clean' : n < 0.66 ? 'worn' : 'dirty');
    return {
        buildings: buildings.map(b => { const n = fbm(`${plot.family}:${seed}:wear`, b.x0 + b.w / 2, b.y0 + b.d / 2, NOISE_LAYERS.wear); return { id: b.id, wear: wear(n), tint: tint(n, [1, 0.99, 0.97]), accent: b.accent }; }),
        lots: plot.lots.map(l => { const n = fbm(`${plot.family}:${seed}:wear`, l.x0 + 4, l.y0 + 4, NOISE_LAYERS.wear); return { lx: l.lx, ly: l.ly, wear: wear(n), tint: tint(n * 0.7, [1, 1, 1]) }; })
    };
}

export const OPERATION_OBJECTIVES = Object.freeze(['recover', 'extract', 'hold', 'eliminate']);
export const OPERATION_TIMES = Object.freeze(['day', 'dawn', 'dusk', 'overcast', 'night', 'night-ops']);
/** Validate and normalise an operation descriptor (menu, URL, server room): unknown values fall back to auto. */
export function operationOptions(o = {}) {
    return { plot: PLOT_FAMILIES[o.plot] ? o.plot : 'downtown', objective: OPERATION_OBJECTIVES.includes(o.objective) ? o.objective : null, timeOfDay: OPERATION_TIMES.includes(o.timeOfDay) ? o.timeOfDay : null };
}

/**
 * The game's generated-map mode: plot family + seed (+ objective, time of day) → a playable, gate-checked mission.
 * Solve, compile, repair locally; if the repair budget runs out, reseed deterministically (bounded).
 * Returns { site, layout, design, mission }.
 */
export function generateOperation({ plot: family = 'downtown', seed = 1, objective = null, timeOfDay = null, compile = true } = {}) {
    if (!PLOT_FAMILIES[family]) throw Error(`operation.plot: unknown plot ${family}`);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('operation.seed: integer 0–4294967295 required');
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
        const s = (seed + attempt * 7919) >>> 0;
        try {
            const plot = createPlot(family, s);
            const time = timeOfDay || plot.times[Math.floor(unit(`${family}:${seed}:time`) * plot.times.length)];
            const { layout, design, context } = solveLayoutV3(plot, { seed: s, objectiveKind: objective, timeOfDay: time, id: 'operation', name: null });
            if (attempt) layout.repairs.push({ kind: 'reseed-operation', from: seed, attempt, reason: last?.message?.slice(0, 160) });
            const site = siteFromLayout(layout, { family, time, seed });
            const op = { site, layout, design, context };
            if (compile) op.mission = buildWithRepair(op, { seed });
            delete op.context;
            return op;
        } catch (e) { last = e; }
    }
    throw Error(`operation.generate: ${last?.message}`);
}

/** A synthetic "read" for an operation, so the package compiler and its validators see the same contract as a picture map. */
export function siteFromLayout(layout, { family, time, seed }) {
    const W = layout.width, D = layout.depth;
    const n = (x, y) => [Math.min(0.999, Math.max(0.001, x / W)), Math.min(0.999, Math.max(0.001, y / D))];
    const PROGRAM = { apartment: 'house', motel: 'house', bar: 'diner' };   // PLAN-14 programmes map to the site contract's
    return {
        version: 2, id: layout.id, name: `${PLOT_FAMILIES[family].name} · ${seed}`, theme: PLOT_FAMILIES[family].theme, timeOfDay: time, frame: { width: W, height: D }, plot: family,
        buildings: layout.buildings.map(b => ({ id: b.id, bounds: [...n(b.x0, b.y0), ...n(b.x0 + b.w, b.y0 + b.d)], program: PROGRAM[b.program] || b.program, front: b.front, storeys: b.storeys })),
        surfaces: [], insertion: n(layout.insertion.x, layout.insertion.y).map(v => Math.min(0.94, Math.max(0.06, v))),
        flow: layout.flow.slice(1).map(([x, y]) => n(x, y)), underground: { kind: layout.layers?.kind || 'subway' }, generated: true
    };
}
