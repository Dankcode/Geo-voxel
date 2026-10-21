// PLAN-06 §5.8 — terraced levels: a map that starts in a sunken band and climbs to high ground a couple of levels up,
// using the game's 3-voxel storey (L0 z1 → L1 z4 → L2 z7), the existing cut levels and the parcel-mix generator.
//
// The bands run across the map; their boundaries are snapped to the bay grid and jittered by noise, so every block
// (and every parcel in it) is flat on one level. Each boundary is a retaining wall with a railing along its upper
// edge (ledge cover above, a hard flank below) and at least four routes across it, ≥ 10 cells apart:
//   terrace-road-ramp       the main street climbs the wall (4 cells per storey, 1-voxel steps)
//   terrace-stairs          a 3-wide stair promenade
//   split-level-building    a 2-storey building against the wall: street door below, storey-2 door onto the terrace
//   terrace-ladder          a service ladder (a shortcut; never the only route)
import { districtPods } from './Pods.js';
import { MAT } from '../../voxel/Materials.js';
import { fbm } from '../Fields.js';
import { createMap } from '../../mission/modern/MapKit.js';
import { remixParameters } from '../DistrictRemix.js';
import { registerRoads } from '../StreetDressing.js';
import { reachable, nodeKey } from '../../world/PathSearch.js';
import { AGENT_PROFILES } from '../../world/TraversalRules.js';
import { initDistrict, tag, tagRect, put, registerSolids } from './Core.js';
import { snapshotGround, fillDistrict, finishDistrict } from './District.js';
import { STOREY } from '../../mission/modern/ModernBuilder.js';
import { interiorHoldZone, secureHoldSpawns } from './HoldZone.js';

export const TERRACE_LEVELS = Object.freeze([1, 4, 7]);

export function terraceBands(width, levels, seed) {
    const n = Math.max(2, Math.min(3, levels)), out = [];
    const cuts = n === 3 ? [0.36, 0.68] : [0.5];
    const xs = cuts.map((f, i) => Math.round((width * f + (fbm(`${seed}:terrace:${i}`, i * 7, 3, { frequency: 1 / 3 }) - 0.5) * 8) / 2) * 2);
    let x0 = 0;
    for (let i = 0; i < n; i++) { const x1 = i < xs.length ? xs[i] - 1 : width - 1; out.push({ z: TERRACE_LEVELS[i], x0, x1 }); x0 = x1 + 1; }
    return out;
}

export function buildTerraceDistrict({ seed = 1, width = 112, depth = 80, remix: remixIn = {}, ...rest } = {}) {
    const W = Math.max(96, Math.min(128, Math.round(Number(width) || 112))), D = Math.max(72, Math.min(96, Math.round(Number(depth) || 80)));
    const remix = remixParameters({ levels: 3, maxStoreys: 2, ...remixIn });
    const levels = remixIn.levels >= 2 ? remix.levels : 3;
    const p = { width: W, depth: D, shape: 'rectangle' };
    const m = createMap({ id: 'terrace-district', width: W, depth: D, height: 22, seed, datum: 1, ground: 'paving' }), s = m.store;
    initDistrict(m, { contains: (x, y) => x >= 0 && y >= 0 && x < W && y < D, family: remix.parts, seed });
    const bands = terraceBands(W, levels, seed);
    m.district.levels.push(...bands);
    // Terrain: each band is filled up to its level; the first column of a higher band is the retaining wall face.
    for (const b of bands) for (let x = b.x0; x <= b.x1; x++) for (let y = 0; y < D; y++) {
        for (let z = 1; z < b.z; z++) s.set(x, y, z, x === b.x0 ? MAT.concrete_wall : MAT.concrete);
        s.set(x, y, b.z, MAT.paving);
    }
    // Roads: the main street runs the length of the map on every band; cross streets and rear lanes per band.
    const roads = [], ML = 34, MH = 38;
    bands.forEach((b, i) => {
        const from = b.x0 + (i ? 1 : 0), to = i < bands.length - 1 ? b.x1 - 4 : b.x1;
        roads.push({ id: `main-${i}`, axis: 'x', lo: ML, hi: MH, from, to, z: b.z, kind: 'main', sidewalk: 2 });
        if (b.x1 - b.x0 >= 28) { const cx = Math.round((b.x0 + b.x1) / 2 / 2) * 2; roads.push({ id: `cross-${i}`, axis: 'y', lo: cx, hi: cx + 3, from: 0, to: ML - 1, z: b.z, kind: 'cross', sidewalk: 2 }); }
        roads.push({ id: `lane-${i}`, axis: 'x', lo: D - 9, hi: D - 5, from: b.x0 + (i ? 2 : 0), to: i < bands.length - 1 ? b.x1 - 2 : b.x1, z: b.z, kind: 'service', sidewalk: 1 });
    });
    for (const r of roads) {
        const g = (x0, y0, x1, y1, key) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (s.inBounds(x, y, r.z)) s.set(x, y, r.z, MAT[key]); };
        if (r.axis === 'x') { g(r.from, r.lo, r.to, r.hi, 'asphalt'); for (let x = r.from + 1; x <= r.to; x += 4) g(x, Math.floor((r.lo + r.hi) / 2), Math.min(r.to, x + 1), Math.floor((r.lo + r.hi) / 2), 'road_mark'); g(r.from, r.lo - 1, r.to, r.lo - 1, 'concrete'); g(r.from, r.hi + 1, r.to, r.hi + 1, 'concrete'); }
        else { g(r.lo, r.from, r.hi, r.to, 'asphalt'); g(r.lo - 1, r.from, r.lo - 1, r.to, 'concrete'); g(r.hi + 1, r.from, r.hi + 1, r.to, 'concrete'); }
    }
    const connectors = [];
    for (let i = 1; i < bands.length; i++) connectors.push(...boundaryRoutes(m, bands[i - 1], bands[i], { ML, MH, D, seed, remix }));
    m.district.connectors.push(...connectors);
    // Insertion in the sunken band.
    const L0 = bands[0].z;
    tagRect(m, { x0: 0, y0: 22, w: 7, d: 11 }, 'insertion');
    m.reserve(1, 23, 5, 32);
    registerRoads(m, roads);
    for (const c of connectors) for (const cell of c.cells || []) tag(m, cell.x, cell.y, c.template === 'terrace-road-ramp' ? 'road' : 'level', { force: c.template !== 'split-level-building' });
    snapshotGround(m);
    for (const c of connectors) c.dress?.();
    railings(m, bands, connectors);
    for (const [x, y] of [[6, 24], [6, 25], [6, 29], [6, 30]]) put(m, x, y, L0 + 1, 'jersey', 'story:insertion-cordon');
    const spawn = { x: 2, y: 25, z: L0 }, target = { x: W - 12, y: Math.floor(D / 2) };
    const report = fillDistrict(m, { seed, remix, family: remix.parts, roads, spawn, target, hold: remix.objective === 'hold' });
    if (remix.objective === 'hold' && !m.district.zones.length) interiorHoldZone(m, spawn);
    const zone = m.district.zones[0]; if (zone) zone.objective = true;
    const top = bands.at(-1);
    const far = [...m.buildings].filter(b => b.rooms.length && b.x0 >= top.x0 && (!zone || Math.hypot(b.x0 + b.w / 2 - (zone.x0 + zone.x1) / 2, b.y0 + b.d / 2 - (zone.y0 + zone.y1) / 2) >= 24)).sort((a, b) => b.x0 - a.x0);
    const enemy = districtPods(far, { fallback: [{ x: W - 8, y: 14, z: top.z }, { x: W - 14, y: D - 16, z: top.z }], street: { x: W - 10, y: Math.floor(D / 2), z: top.z } });
    const objective = zone ? { kind: 'hold', zone: { x0: zone.x0, y0: zone.y0, x1: zone.x1, y1: zone.y1, z: zone.z, dz: 1 }, rounds: 4, needed: 1, text: 'Climb to the marked ground and hold it for four rounds.' }
        : { kind: 'eliminate', text: 'Fight up from the sunken yards to the high terrace and clear the district.' };
    const all = [...connectors.filter(c => m.district.connectors.includes(c)).map(({ dress, ...c }) => c), ...m.district.connectors.filter(c => c.sockets?.length && !c.levels)];
    const result = m.finish({ name: 'Hillside Terraces', spawns: { player: [{ x: 2, y: 25, z: L0 }, { x: 2, y: 27, z: L0 }, { x: 3, y: 26, z: L0 }, { x: 4, y: 25, z: L0 }, { x: 4, y: 27, z: L0 }, { x: 3, y: 29, z: L0 }], enemy }, objective,
        meta: { generatorVersion: 'district-mix-v3', lanesGoal: zone ? 'objective' : (far[0] ? (() => { const e = far[0].exits.find(e => e.entry) || far[0].exits[0]; const [dx, dy] = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[e.side] || [0, 1]; return { x: e.x + dx * 2, y: e.y + dy * 2, z: far[0].baseZ }; })() : null), remix, theme: 'Large districts', lighting: 'overcast', streetDatum: L0, footprint: p, connectionParcels: all, terraces: bands, streetObjects: report.streetObjects, partAssignments: report.assignments,
            cutLevels: [4, 7, 10, 13, 16, Infinity], defaultCut: 7, floorNames: { 4: 'Sunken yards', 7: 'Street terrace', 10: 'High terrace', 13: 'Upper floors', 16: 'Roofs' },
            designDecisions: [`${bands.length} levels: ${bands.map(b => `z${b.z} x${b.x0}–${b.x1}`).join(', ')}.`, 'Every boundary is a retaining wall with a ledge railing, a road ramp, a stair promenade, a split-level building and a ladder shortcut.', 'Parcel mixes fill each band; nothing is scattered.'] } });
    const search = reachable(result.store, result.spawns.player[0], Infinity, AGENT_PROFILES.player);
    const failures = all.flatMap(c => c.sockets.filter(q => ![0, 1, -1].some(dz => search.costs.has(nodeKey({ ...q, z: q.z + dz })))).map(q => ({ connector: c.id, socket: q })));
    result.meta.connectorValidation = { pass: failures.length === 0, failures };
    if (failures.length) throw Error(`terrace-district: unreachable sockets ${JSON.stringify(failures)}`);
    result.meta.parcelGraph = all.filter(c => c.levels).map(c => [`z${c.levels[0]}`, `z${c.levels[1]}`]);
    result.meta.parcelAssignments = result.buildings.map(b => ({ id: b.id, program: b.program, bounds: { x: b.x0, y: b.y0, w: b.w, d: b.d }, mergedWith: b.mergedWith || [] }));
    if (zone) secureHoldSpawns(result, zone);
    finishDistrict(result, m, report);
    return result;
}

/** The routes across one retaining wall (lower band a, upper band b). */
function boundaryRoutes(m, a, b, { ML, MH, D, seed, remix }) {
    const s = m.store, lo = a.z, hi = b.z, X = b.x0, out = [];
    const route = (id, template, cells, sockets, extra = {}) => { const c = { id, template, levels: [lo, hi], cells, sockets, ...extra }; out.push(c); return c; };
    // 1. Road ramp across the whole street corridor (carriageway, kerbs and sidewalks), 1-voxel steps.
    {
        const cells = [];
        for (let i = 1; i <= 3; i++) {
            const x = X - 4 + i, z = lo + i;
            for (let y = ML - 3; y <= MH + 3; y++) {
                for (let zz = lo + 1; zz < z; zz++) s.set(x, y, zz, MAT.concrete);
                s.set(x, y, z, y >= ML && y <= MH ? MAT.asphalt : y === ML - 1 || y === MH + 1 ? MAT.concrete : MAT.paving);
                for (let zz = z + 1; zz <= z + 3; zz++) s.set(x, y, zz, 0);
                tag(m, x, y, y >= ML && y <= MH ? 'road' : y === ML - 1 || y === MH + 1 ? 'kerb' : 'sidewalk', { force: true });
                if (y === Math.floor((ML + MH) / 2)) cells.push({ x, y, z });
            }
        }
        // The wall column at the ramp head becomes road surface at the upper level.
        for (let y = ML - 3; y <= MH + 3; y++) { s.set(X, y, hi, y >= ML && y <= MH ? MAT.asphalt : MAT.paving); tag(m, X, y, y >= ML && y <= MH ? 'road' : 'sidewalk', { force: true }); }
        const yc = Math.floor((ML + MH) / 2);
        route(`ramp-${lo}-${hi}`, 'terrace-road-ramp', cells, [{ x: X - 4, y: yc, z: lo }, { x: X + 1, y: yc, z: hi }]);
    }
    // 2. Stair promenade in the northern half.
    const ys = Math.max(6, Math.round(D * 0.18 + (fbm(`${seed}:stairs:${X}`, X, 1, { frequency: 1 / 3 }) - 0.5) * 6));
    {
        const cells = [];
        for (let i = 1; i <= 3; i++) for (let w = 0; w < 3; w++) {
            const x = X - 4 + i, y = ys + w, z = lo + i;
            for (let zz = lo + 1; zz < z; zz++) s.set(x, y, zz, MAT.concrete);
            s.set(x, y, z, MAT.stairs_stone);
            for (let zz = z + 1; zz <= z + 3; zz++) s.set(x, y, zz, 0);
            m.reserve(x - 1, y - 1, x + 1, y + 1); tag(m, x, y, 'level', { force: true });
            if (w === 1) cells.push({ x, y, z });
        }
        for (let w = 0; w < 3; w++) { s.set(X, ys + w, hi, MAT.paving); tag(m, X, ys + w, 'level', { force: true }); tag(m, X - 4, ys + w, 'level', { force: true }); m.reserve(X, ys + w, X + 1, ys + w); m.reserve(X - 5, ys + w, X - 4, ys + w); }
        route(`stairs-${lo}-${hi}`, 'terrace-stairs', cells, [{ x: X - 4, y: ys + 1, z: lo }, { x: X + 1, y: ys + 1, z: hi }]);
    }
    // 3. Split-level building against the wall in the southern half (street door below, storey-2 door above).
    const yb = Math.max(MH + 6, Math.round(D * 0.55));
    {
        const w = 12, d = 11, x0 = X - w, y0 = yb;
        const bld = m.building({ id: `split-level-${lo}-${hi}`, program: 'office', x0, y0, w, d, baseZ: lo, storeys: 2, front: 'w', rounded: false, furnish: remix.furnish, ...(remix.wall !== 'mixed' ? { wall: remix.wall } : {}) });
        tagRect(m, { x0, y0, w, d }, 'building', { force: true });
        const yc = y0 + Math.floor(d / 2), zf = lo + STOREY;
        // Door through the east wall at storey 2, onto the terrace; clear its landing on both sides.
        for (let h = 1; h <= 2; h++) { s.set(X - 1, yc, zf + h, 0); s.set(X - 1, yc + 1, zf + h, 0); }
        for (const yy of [yc, yc + 1]) for (let h = 1; h <= 2; h++) { const v = s.get(X - 2, yy, zf + h); if (v && v !== MAT.stairs_wood && v !== MAT.steel_stair) s.set(X - 2, yy, zf + h, 0); s.set(X, yy, zf + h, 0); }
        m.reserve(X, yc - 1, X + 2, yc + 2);
        bld.exits.push({ x: X - 1, y: yc, side: 'e', room: null, entry: false, roller: false, storey: 1 });
        const entry = bld.exits.find(e => e.entry) || bld.exits[0];
        route(`split-${lo}-${hi}`, 'split-level-building', [{ x: entry.x, y: entry.y, z: lo }, { x: X - 1, y: yc, z: zf }], [{ x: x0 - 2, y: entry.y, z: lo }, { x: X + 1, y: yc, z: hi }], { building: bld.id });
    }
    // 4. A ladder shortcut near the south edge (never the only route).
    const yl = Math.min(D - 12, yb + 14);
    const ladder = route(`ladder-${lo}-${hi}`, 'terrace-ladder', [{ x: X - 1, y: yl, z: lo }], [{ x: X - 1, y: yl, z: lo }, { x: X, y: yl, z: hi }]);
    ladder.dress = () => { try { const l = m.ladder(X - 1, yl, 1, 0); registerSolids(m, { x0: X - 1, y0: yl, w: 1, d: 1 }, `level:ladder-${lo}-${hi}`, { z0: l.foot + 1 }); } catch { const i = m.district.connectors.indexOf(ladder); if (i >= 0) m.district.connectors.splice(i, 1); } };
    return out;
}

/** Railings along each upper edge, except where a route lands. */
function railings(m, bands, connectors) {
    const s = m.store, gaps = new Set();
    for (const c of connectors) for (const q of c.sockets) for (let dy = -2; dy <= 2; dy++) gaps.add(`${q.x},${q.y + dy}`);
    for (const c of connectors.filter(c => c.template === 'terrace-road-ramp')) for (let y = 31; y <= 41; y++) gaps.add(`${c.sockets[1].x - 1},${y}`);
    for (let i = 1; i < bands.length; i++) {
        const b = bands[i], X = b.x0;
        for (let y = 0; y < s.depth; y++) {
            if (gaps.has(`${X + 1},${y}`) || gaps.has(`${X},${y}`) || m.keep.has(`${X},${y}`)) continue;
            if (s.topSolid(X, y) !== b.z || s.isSolid(X, y, b.z + 1)) continue;
            put(m, X, y, b.z + 1, 'railing', `level:retaining-wall-${b.z}/railing`);
            tag(m, X, y, 'level', { force: true });
        }
    }
}
