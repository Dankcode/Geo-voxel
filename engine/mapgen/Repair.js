// PLAN-04 §5.4 — local repair by re-collapse (after Merrell's model synthesis). When a gate fails, only the region
// around the failure is un-collapsed and re-solved with weights or pins pushed toward the fix; the rest of the map is
// kept. Every repair is deterministic and recorded in layout.repairs, so peers and the offline builder agree.
//
//   coverGap / killingField   pin a cover piece facing the objective in the bay nearest the worst cell; re-solve its lot
//   sightlineMedian (too long) pin full cover in the longest-sightline open bays; re-solve those lots
//   dropSafe / flankHidden    move the street drop along the tunnel to a point no pod can see; clear pieces over it
//   firstContact / spawnSafe  move the nearest outdoor pod to a later pocket (or drop it)
//   floorsReachable … (rooms) re-plan that building's interiors with a new interior seed
import { compileV3Map } from './ExteriorCompiler.js';
import { evaluateGeneratedGates } from './Gates.js';
import { solveBays, piecesFromBays } from './ExteriorSolver.js';
import { BAY_PIECES } from './LotCatalogue.js';
import { castRay, blocksSight } from '../voxel/Raycast.js';
import { reachable, nodeKey } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { coverAt, COVER } from '../voxel/Cover.js';
import { critiqueMission } from './Critic.js';
import { DEFAULT_GATES } from '../mission/MissionMetrics.js';
import { designSlate } from './DesignSlate.js';
import { wearOf } from './ExteriorCompiler.js';

const BAY = 2;
const OUTDOOR_GATES = new Set(['advanceCover', 'coverGap', 'killingField', 'outdoorCover', 'coverDensity', 'fullCoverShare', 'sightlineMedian', 'destructibleCover']);

/** Compile with gates evaluated (not thrown) and finish the mission the same way compileV3Map does. */
export function compileEvaluated(op, seed) {
    const m = compileV3Map(op, { seed, gates: false });
    const gates = evaluateGeneratedGates(m, op);
    m.meta.critic = critiqueMission(m, op.layout);
    return { m, failures: Object.entries(gates).filter(([, ok]) => !ok).map(([k]) => k) };
}

/** Outdoor cells farthest from cover (the coverGap BFS of MissionMetrics, on reachable street cells). */
function worstGapCells(m) {
    const s = m.store, search = reachable(s, m.spawns.player[0], Infinity, AGENT_PROFILES.player);
    const out = [...search.nodes.values()].filter(n => s.roomAt(n.x, n.y, n.z + 1) < 0);
    const k = n => `${n.x},${n.y},${n.z}`, gap = new Map(), q = [];
    for (const n of out) { const c = coverAt(s, n.x, n.y, n.z); if (Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF) { gap.set(k(n), 0); q.push(n); } }
    const set = new Map(out.map(n => [k(n), n]));
    for (let i = 0; i < q.length; i++) { const n = q[i], d = gap.get(k(n)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dz of [0, 1, -1]) { const kk = `${n.x + dx},${n.y + dy},${n.z + dz}`, mm = set.get(kk); if (mm && !gap.has(kk)) { gap.set(kk, d + 1); q.push(mm); } } }
    return out.map(n => ({ ...n, d: gap.get(k(n)) ?? 99 })).sort((a, b) => b.d - a.d || a.y - b.y || a.x - b.x);
}

/** Re-solve the lots holding `pins` (bay id → piece), or the given lots, keeping every other lot as fixed context. */
function resolveLots(op, pins, reason, { lots: only = null, boost = null } = {}) {
    const ctx = op.context; if (!ctx) return false;
    const lots = only || [...new Set([...pins.keys()].map(id => { const [bx, by] = id.split(',').map(Number); return `${Math.floor(bx / 4)},${Math.floor(by / 4)}`; }))].map(id => id.split(',').map(Number));
    const allPins = new Map([...ctx.pins, ...pins]);
    for (const k of pins.keys()) ctx.solveArgs.soft?.delete(k);   // PLAN-13: a repair pin outranks a parcel-layout pin
    ctx.pins = allPins;
    // Un-collapse the chosen lots (drop their bays from the previous result) and re-solve only those.
    const previous = new Map([...ctx.bays].filter(([id]) => { const [bx, by] = id.split(',').map(Number); return !lots.some(([lx, ly]) => Math.floor(bx / 4) === lx && Math.floor(by / 4) === ly); }));
    ctx.bays = solveBays({ ...ctx.solveArgs, pins: allPins, lots, previous, ...(boost ? { weightBoost: boost } : {}) });
    op.layout.pieces = piecesFromBays(ctx.bays, ctx.bayGrid);
    op.layout.repairs.push({ kind: 'local-recollapse', reason, lots: lots.map(l => l.join(',')) });
    return true;
}

/** Pin a cover piece facing the objective in the first unblocked bay (by distance) around a cell. */
function pinCoverNear(op, cell, { full = false, destructible = false } = {}) {
    const ctx = op.context, obj = op.layout.objective.cell;
    const dx = obj.x - cell.x, dy = obj.y - cell.y, toward = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
    // PLAN-10: no crates or pallets. PLAN-13: no vending boxes, bins or sandbags either — cover a street really has.
    const bases = destructible ? ['planter', 'bench', 'hedge', 'fence', 'low_wall'] : full ? ['tall_planter', 'fence'] : ['planter', 'low_wall', 'hedge', 'jersey', 'bench'];
    const bx0 = Math.floor(cell.x / BAY), by0 = Math.floor(cell.y / BAY);
    for (let r = 0; r <= 3; r++) for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const bay = ctx.bayGrid.at(bx0 + ox, by0 + oy);
        if (!bay || bay.blocked || ctx.pins.has(`${bay.bx},${bay.by}`)) continue;
        if (bay.cls === 'carriageway' || bay.cls.startsWith('lane_') || bay.cls.startsWith('parking_')) continue;   // PLAN-10/11: never in the road
        for (const facing of [toward, ...['n', 'e', 's', 'w'].filter(f => f !== toward)]) for (const base of bases) {
            const id = `${base}_${facing}`, p = BAY_PIECES[id];
            if (!p || p.cells.some(([x, y]) => bay.protected.some(([px, py]) => px === x && py === y))) continue;
            if (p.surfaces && !p.surfaces.includes(bay.cls.startsWith('parking_')||bay.cls==='carriageway'?'asphalt':bay.cls === 'lane_x' || bay.cls === 'lane_y' ? 'lane' : bay.cls) && !(bay.cls.startsWith('lane') && p.surfaces.includes('asphalt'))) continue;
            return new Map([[`${bay.bx},${bay.by}`, id]]);
        }
    }
    return null;
}

/** Move the street drop to a tunnel point hidden from every pod; clear any piece over it. */
function moveDrop(op, m) {
    const layers = op.layout.layers; if (!layers) return false;
    const route = layers.route, G = m.meta.streetDatum;
    const sees = (e, p) => Math.hypot(e.pos.x - p.x, e.pos.y - p.y) < 24 && !castRay(m.store, { x: e.pos.x + 0.5, y: e.pos.y + 0.5, h: e.pos.z + 2.5 }, { x: p.x + 0.5, y: p.y + 0.5, h: p.z + 2 }, { blocks: blocksSight }).hit;
    const tried = new Set((op.layout.repairs || []).filter(r => r.kind === 'move-drop').map(r => `${r.to.x},${r.to.y}`));
    const order = route.map((p, i) => ({ p, i, score: Math.abs(i / route.length - 0.5) })).filter(o => o.i > route.length * 0.2 && o.i < route.length * 0.8).sort((a, b) => a.score - b.score);
    for (const { p } of order) {
        if (tried.has(`${p.x},${p.y}`) || (layers.drop && p.x === layers.drop.x && p.y === layers.drop.y)) continue;
        const from = { x: p.x + 1, y: p.y, z: G };
        if (m.spawns.enemy.some(e => sees(e, from) || sees(e, { x: p.x, y: p.y, z: G }))) continue;
        if (Math.hypot(p.x - layers.entrances[0].x, p.y - layers.entrances[0].y) < 5 || Math.hypot(p.x - layers.entrances[1].x, p.y - layers.entrances[1].y) < 5) continue;
        // Prefer an opening on clear ground: removing a prop could open the very sightline we are avoiding.
        if (op.layout.pieces.some(pc => pc.cells.some(([cx, cy]) => cx >= p.x - 1 && cx <= p.x + 2 && cy >= p.y - 1 && cy <= p.y + 1))) continue;
        if (m.store.isSolid(p.x, p.y, G + 1) || m.store.isSolid(p.x + 1, p.y, G + 1) || m.store.roomAt(p.x, p.y, G + 1) >= 0) continue;
        op.layout.repairs.push({ kind: 'move-drop', from: layers.drop ? { ...layers.drop } : null, to: { x: p.x, y: p.y } });
        layers.drop = { x: p.x, y: p.y };
        clearAround(op, p);
        return true;
    }
    return false;
}

/** Un-collapse the bays over an opening and keep them clear in every later re-solve. */
function clearAround(op, p) {
    const near = c => c[0] >= p.x - 1 && c[0] <= p.x + 2 && Math.abs(c[1] - p.y) <= 1;
    op.layout.pieces = op.layout.pieces.filter(pc => !pc.cells.some(near));
    if (!op.context) return;
    for (const bay of op.context.bayGrid.bays) if (bay.x + 1 >= p.x - 1 && bay.x <= p.x + 2 && bay.y + 1 >= p.y - 1 && bay.y <= p.y + 1) { bay.blocked = true; op.context.bays.set(`${bay.bx},${bay.by}`, 'open'); op.context.pins.delete(`${bay.bx},${bay.by}`); }
}

/** Screen the drop from the pods that see it: full cover pinned between them, two cells out (at most twice). */
function shieldDrop(op, m) {
    const layers = op.layout.layers; if (!layers?.drop || !op.context) return false;
    if ((op.layout.repairs || []).filter(r => r.kind === 'shield-drop').length >= 2) return false;
    const d = layers.drop, G = m.meta.streetDatum, from = { x: d.x + 1, y: d.y, z: G };
    const sees = e => Math.hypot(e.pos.x - from.x, e.pos.y - from.y) < 24 && !castRay(m.store, { x: e.pos.x + 0.5, y: e.pos.y + 0.5, h: e.pos.z + 2.5 }, { x: from.x + 0.5, y: from.y + 0.5, h: from.z + 2 }, { blocks: blocksSight }).hit;
    const pins = new Map();
    for (const e of m.spawns.enemy.filter(sees)) {
        const dx = e.pos.x - from.x, dy = e.pos.y - from.y, l = Math.hypot(dx, dy) || 1;
        const cell = { x: Math.round(from.x + dx / l * 3), y: Math.round(from.y + dy / l * 3) };
        const facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
        const bay = op.context.bayGrid.at(Math.floor(cell.x / BAY), Math.floor(cell.y / BAY));
        if (!bay || bay.blocked || bay.cls === 'carriageway' || bay.cls.startsWith('lane_') || bay.cls.startsWith('parking_')) continue;   // PLAN-10: nothing in the road
        for (const base of ['tall_planter', 'fence', 'jersey', 'low_wall']) {
            const id = `${base}_${facing}`, p = BAY_PIECES[id];
            const surf = bay.cls === 'lane_x' || bay.cls === 'lane_y' ? 'lane' : bay.cls;
            if (!p || p.cells.some(([x, y]) => bay.protected.some(([px, py]) => px === x && py === y)) || !(p.surfaces.includes(surf) || (surf === 'lane' && p.surfaces.includes('asphalt')))) continue;
            pins.set(`${bay.bx},${bay.by}`, id); break;
        }
    }
    if (!pins.size) return false;
    op.layout.repairs.push({ kind: 'shield-drop', at: { ...d }, pins: [...pins.keys()] });
    return resolveLots(op, pins, 'dropSafe');
}

/** No hidden drop point exists: close the street drop (the tunnel keeps its stairs and manhole). */
function closeDrop(op) {
    const layers = op.layout.layers; if (!layers?.drop) return false;
    op.layout.repairs.push({ kind: 'close-drop', at: { ...layers.drop } });
    layers.drop = null;
    return true;
}

/** Put the tunnel guard where it (and every pod) sees the least of the flank, still on the route's far half. */
function moveGuard(op, m) {
    const layers = op.layout.layers, u = m.meta.underground; if (!layers || !u) return false;
    if ((op.layout.repairs || []).some(r => r.kind === 'move-guard')) return false;
    const route = u.route, others = m.spawns.enemy.filter(e => e.group !== 99);
    const sees = (from, p) => Math.hypot(from.x - p.x, from.y - p.y) < 24 && !castRay(m.store, { x: from.x + 0.5, y: from.y + 0.5, h: from.z + 2.5 }, { x: p.x + 0.5, y: p.y + 0.5, h: p.z + 2 }, { blocks: blocksSight }).hit;
    const seenByOthers = route.map(p => others.some(e => sees(e.pos, p)));
    let best = null;
    for (let i = Math.floor(route.length * 0.55); i < route.length - 1; i++) {
        const g = route[i], hidden = route.filter((p, k) => !seenByOthers[k] && !sees(g, p)).length / route.length;
        if (!best || hidden > best.hidden) best = { i, hidden };
    }
    if (!best || best.hidden <= 0.5) return false;
    op.layout.repairs.push({ kind: 'move-guard', to: best.i, hidden: Math.round(best.hidden * 100) / 100 });
    layers.guardAt = best.i;
    return true;
}

/** One more staggered tunnel baffle between the guard and the open run (hides the flank from its guard). */
function addBaffle(op) {
    const layers = op.layout.layers; if (!layers) return false;
    const have = layers.baffles || [0.3, 0.6], next = [0.85, 0.45, 0.15].find(f => !have.some(h => Math.abs(h - f) < 0.08));
    if (next == null) return false;
    layers.baffles = [...have, next].sort((a, b) => a - b);
    op.layout.repairs.push({ kind: 'add-baffle', at: next });
    return true;
}

/**
 * The enemy that starts nearest the squad moves away: an outdoor pod to a later pocket (or it is dropped), a building
 * pod to the building farthest from the insertion that has no pod yet (or it is dropped).
 */
function movePod(op, m) {
    const ins = op.layout.insertion, spawn = m.spawns.player[0];
    const nearest = m.spawns.enemy.filter(e => e.group !== 99).sort((a, b) => Math.hypot(a.pos.x - spawn.x, a.pos.y - spawn.y) - Math.hypot(b.pos.x - spawn.x, b.pos.y - spawn.y))[0];
    const enc = nearest && op.design.encounters.find(e => e.group === nearest.group);
    if (!enc) return false;
    if (enc.pocket != null) {
        const used = new Set(op.design.encounters.filter(e => e.pocket != null).map(e => e.pocket)), d = Math.hypot(enc.at.x - ins.x, enc.at.y - ins.y);
        const later = (op.layout.pockets || []).filter(p => !used.has(p.id) && Math.hypot(p.x - ins.x, p.y - ins.y) > d + 4).sort((a, b) => a.along - b.along)[0];
        if (later) { op.layout.repairs.push({ kind: 'move-pod', from: enc.pocket, to: later.id }); enc.pocket = later.id; enc.at = { x: later.x, y: later.y }; return true; }
    } else if (enc.building === op.layout.objective.building) {
        // A pod in the objective moves to the room of that building farthest from the squad (same floor or above).
        const b = op.layout.buildings.find(x => x.id === enc.building);
        let best = null;
        for (const f of b.floors.filter(f => f.floor >= enc.floor)) for (const r of f.rooms.filter(r => r.gameplay !== false)) {
            const d = Math.min(...r.cells.map(([x, y]) => Math.hypot(b.x0 + x - ins.x, b.y0 + y - ins.y)));
            if (!best || d > best.d) best = { d, floor: f.floor, room: r.id };
        }
        if (best && (best.floor !== enc.floor || best.room !== enc.room)) { op.layout.repairs.push({ kind: 'move-pod', from: `${enc.floor}/${enc.room}`, to: `${best.floor}/${best.room}` }); enc.floor = best.floor; enc.room = best.room; return true; }
        return false;
    } else {
        const taken = new Set(op.design.encounters.map(e => e.building));
        const far = op.layout.buildings.filter(b => !taken.has(b.id)).sort((a, b) => Math.hypot(b.x0 - ins.x, b.y0 - ins.y) - Math.hypot(a.x0 - ins.x, a.y0 - ins.y))[0];
        if (far && Math.hypot(far.x0 - ins.x, far.y0 - ins.y) > Math.hypot(nearest.pos.x - ins.x, nearest.pos.y - ins.y)) {
            const room = far.floors[far.storeys - 1].rooms.find(r => r.gameplay !== false && r.id !== 'hall') || far.floors[far.storeys - 1].rooms[0];
            op.layout.repairs.push({ kind: 'move-pod', from: enc.building, to: far.id }); Object.assign(enc, { building: far.id, floor: far.storeys - 1, room: room.id }); return true;
        }
    }
    op.layout.repairs.push({ kind: 'drop-pod', group: enc.group }); op.design.encounters.splice(op.design.encounters.indexOf(enc), 1);
    return true;
}

/**
 * Compile an operation and repair it locally until every gate passes (bounded). Returns the mission; throws with the
 * remaining failures when the budget runs out, and the caller reseeds.
 */
export function buildWithRepair(op, { seed = 1, budget = Math.min(28,8*Math.ceil(Math.max(op.layout.width,op.layout.depth)/64)) } = {}) {
    let last = null;
    for (let i = 0; i <= budget; i++) {
        const { m, failures } = compileEvaluated(op, seed);
        if (!failures.length) { m.visual.slate = designSlate(m); m.visual.wear = wearOf(op.layout); op.layout.critic = m.meta.critic; return m; }
        last = failures;
        if (globalThis.MAPGEN_TRACE) console.log('repair', i, failures.join(','),JSON.stringify({gap:m.metrics.coverGap,worst:worstGapCells(m).slice(0,2)}));
        let fixed = false;
        if (failures.includes('flankHidden')) fixed = moveGuard(op, m) || addBaffle(op) || fixed;
        if (failures.includes('dropSafe') || (failures.includes('flankHidden') && !fixed)) fixed = moveDrop(op, m) || (failures.includes('dropSafe') && ((m.spawns.enemy.every(e => e.pos.z <= m.meta.streetDatum) && shieldDrop(op, m)) || closeDrop(op))) || fixed;
        if (failures.some(f => f === 'firstContact' || f === 'spawnSafe' || f === 'enemiesReachable')) fixed = movePod(op, m) || fixed;
        if (!fixed && failures.some(f => OUTDOOR_GATES.has(f))) {
            // Which way to push: too much clutter (density over the gate, sightlines too short) thins cover out;
            // gaps, open squares and long sightlines add it.
            const M = m.metrics, G = DEFAULT_GATES;
            const thin = (failures.includes('coverDensity') && M.coverDensity > G.coverDensity[1]) || (failures.includes('sightlineMedian') && M.sightlineMedian < G.sightlineMedian[0]) || (failures.includes('outdoorCover') && M.outdoorCover > G.outdoorCover[1]);
            if (thin) fixed = thinCover(op, m, failures.join('+'));
            else {
                let pins = null;
                if (failures.includes('sightlineMedian') && !failures.some(f => f === 'coverGap' || f === 'destructibleCover')) pins = sightlinePins(op);
                else {
                    // Up to three separate trouble spots per pass (the worst gap cells, or a spread for destructible cover).
                    const cells = worstGapCells(m), spots = [];
                    // PLAN-11: an open dash along the line of advance gets cover at its middle first.
                    if (failures.includes('advanceCover') && m.metrics.advanceExposureAt) spots.push({ ...m.metrics.advanceExposureAt, d: 9 });
                    const list = failures.includes('coverGap') || failures.includes('killingField') ? cells.filter(c => c.d >= 3) : cells.filter((_, k) => k % 11 === i % 11).slice(0, 30);
                    for (const c of list) if (spots.length < 3 && spots.every(o => Math.hypot(o.x - c.x, o.y - c.y) > 6)) spots.push(c);
                    for (const c of spots) { const p = pinCoverNear(op, c, { full: failures.includes('fullCoverShare'), destructible: failures.includes('destructibleCover') }); if (p) for (const [k, v] of p) (pins ||= new Map()).set(k, v); }
                }
                if (globalThis.MAPGEN_TRACE) console.log('  pins', JSON.stringify(pins && [...pins]));
                if (pins) fixed = resolveLots(op, pins, failures.filter(f => OUTDOOR_GATES.has(f)).join('+'));
            }
        }
        if (!fixed) break;
    }
    throw Error(`repair.exhausted: ${last?.join(', ')}`);
}

/** Re-solve the two most cluttered lots (pocket pins kept) with cover weights cut to a quarter. */
function thinCover(op, m, reason) {
    const ctx = op.context; if (!ctx) return false;
    const load = new Map();
    for (const p of op.layout.pieces) if (p.cover) { const k = `${Math.floor(p.x / 8)},${Math.floor(p.y / 8)}`; load.set(k, (load.get(k) || 0) + p.cells.length); }
    const tried = new Set((op.layout.repairs || []).filter(r => r.kind === 'local-recollapse' && r.reason?.includes('thin')).flatMap(r => r.lots));
    const lots = [...load].filter(([k]) => !tried.has(k)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([k]) => k.split(',').map(Number));
    if (!lots.length) return false;
    return resolveLots(op, new Map(), `thin:${reason}`, { lots, boost: (bx, by, p) => (p.cover ? 0.25 : p.id === 'open' ? 2 : 1) });
}

/** Full-cover pins in the open bays with the longest sightlines (sightline breakers). */
function sightlinePins(op) {
    const ctx = op.context; if (!ctx) return null;
    const bays = ctx.bayGrid.bays.filter(b => !b.blocked && !ctx.pins.has(`${b.bx},${b.by}`) && !b.protected.length).sort((a, b) => ctx.fields.sight(b.x + 1, b.y + 1) - ctx.fields.sight(a.x + 1, a.y + 1)).slice(0, 3);
    const pins = new Map();
    for (const b of bays) { const p = pinCoverNear(op, { x: b.x + 1, y: b.y + 1 }, { full: true }); if (p) for (const [k, v] of p) pins.set(k, v); }
    return pins.size ? pins : null;
}
