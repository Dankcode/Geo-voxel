// buildPlace: a BlenderGIS export (OSM + DEM, metres around a projected origin) → a voxel map at 1:1 plus its layers.
//
//   1 frame       rotate by the street/wall weighted grid angle, crop to the export's window (padded fetch → no
//                 empty corners), one uniform scale (default 0.9 m a cell)
//   2 straighten  every street an exact grid line, buildings and land use carried along and squared (rectify.js)
//   3 footprints  outlines → cell masks → one party wall between touching buildings → wings (footprint.js)
//   4 streets     carriageway / kerb / sidewalk by box distance (square ends and corners), junction squares owned
//                 wholly by the longer street
//   5 lots        mapped parking, and strip-centre car parks implied from retail land use (minus a storefront walk)
//   6 terrain     DEM → whole-voxel heightfield; buildings, lots and every street segment are level plateaus, steps
//                 between touching plateaus ≤ 1 voxel, everything else relaxed to steps ≤ 1
//   7 voxels      ground, surfaces, stall stripes, building shells (storeys, floors, walls, glazing, doors, roof)
//   8 paint       a road-paint plan (centre/lane/edge lines, stop bars, crosswalks) as quads for any renderer
//
// Engine-agnostic: the result is a VoxelGrid (grid.js) plus plain-JSON layers an engine can furnish further.
import { geoFrame, groundModel, heightfield, plateauAndRelax, rasterPolygon, polygonArea, distToPolyline, METRES_PER_CELL } from './frame.js';
import { rectifyNetwork, weightedGridAngle } from './rectify.js';
import { cleanMask, resolveParty, decomposeFootprint, largestRectangle } from './footprint.js';
import { planGeoRoadPaint } from './roadPaint.js';
import { roadSpec, storeysFromTags, programFor } from './osm.js';
import { buildingContext, streetFurniture } from './context.js';
import { orthogonalizeRing, orthogonalizeLine } from './rectify.js';
import { VoxelGrid, M } from './grid.js';

const k2 = (x, y) => `${x},${y}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const len2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const WALL = { shop: 'wall', diner: 'wall_stucco', office: 'wall_concrete', warehouse: 'wall', garage: 'wall', house: 'wall_siding' };

/** L∞ distance to a polyline of axis-aligned segments (square caps and corners). */
export function distBox(p, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i];
        const dx = Math.max(Math.min(ax, bx) - p[0], 0, p[0] - Math.max(ax, bx)), dy = Math.max(Math.min(ay, by) - p[1], 0, p[1] - Math.max(ay, by));
        best = Math.min(best, Math.max(dx, dy));
    }
    return best;
}
const insidePoly = ([px, py], poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; };

/**
 * opts: { cell (m), straighten ('grid' | null), storeyHeight (voxels), maxStoreys, maxRelief (voxels), tagOverrides
 *         ({ [osm id]: tags }), maxCells (per side), datum (lowest ground voxel) }
 * Returns { grid, layers, report }.
 */
export function buildPlace(geo, { cell = METRES_PER_CELL, straighten = 'grid', storeyHeight = 3, maxStoreys = 10, maxRelief = 6, tagOverrides = {}, maxCells = 256, maxHeight = 96, datum = 1 } = {}) {
    if (!geo?.extent) throw Error('geo-voxels: a BlenderGIS export (with extent) is required');
    const grid = straighten === 'grid';
    // ---- 1 frame
    const angle = grid ? weightedGridAngle([
        ...(geo.highways || []).map(h => ({ h, sp: roadSpec(h.tags) })).filter(o => o.sp && o.h.line?.length >= 2).map(o => ({ pts: o.h.line, w: 1 + o.sp.cls })),
        ...(geo.buildings || []).filter(b => b.ring?.length >= 3).map(b => ({ pts: b.ring, w: 1, closed: true }))]) : 'auto';
    const F = geoFrame(geo, { cell, rotate: angle, maxCells }), { W, D } = F;
    const report = { theta: +(F.theta * 180 / Math.PI).toFixed(2), size: [W, D], straighten: null, buildings: [], dropped: [], lots: [], terrain: null };
    // ---- 2 straighten
    let G = geo, toC = F.toCell, ptC = F.toCell;
    if (grid) {
        const hw = (geo.highways || []).map((h, i) => ({ h, i, sp: roadSpec(h.tags) })).filter(o => o.h.line?.length >= 2);
        const R = rectifyNetwork(hw.filter(o => o.sp).map(o => ({ id: o.i, line: o.h.line.map(F.toCell), cls: o.sp.cls, half: o.sp.halfM / cell })), {
            buildings: (geo.buildings || []).map((b, i) => ({ id: i, ring: b.ring?.length >= 3 ? b.ring.map(F.toCell) : null })).filter(b => b.ring),
            areas: (geo.areas || []).map((a, i) => ({ id: i, ring: a.ring?.length >= 3 ? a.ring.map(F.toCell) : null })).filter(a => a.ring),
            lines: hw.filter(o => !o.sp).map(o => ({ id: o.i, line: o.h.line.map(F.toCell) })) });
        const rl = new Map([...R.roads.map(r => [r.id, r.line]), ...R.lines.map(l => [l.id, l.line])]), rb = new Map(R.buildings.map(b => [b.id, b.ring])), ra = new Map(R.areas.map(a => [a.id, a.ring]));
        G = { ...geo, highways: (geo.highways || []).map((h, i) => rl.has(i) ? { ...h, line: rl.get(i) } : h), buildings: (geo.buildings || []).map((b, i) => rb.has(i) ? { ...b, ring: rb.get(i) } : b), areas: (geo.areas || []).map((a, i) => ra.has(i) ? { ...a, ring: ra.get(i) } : a) };
        toC = p => p; report.straighten = R.report;
        ptC = p => { const c = F.toCell(p), d = R.displace(c); return [c[0] + d[0], c[1] + d[1]]; };
    }
    const inner = ([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < D - 1;
    // ---- 3 footprints
    // context (OSM tenants, 3D parts, street furniture, Wikidata) when the export carries it
    const CTX = buildingContext(geo), FURN = streetFurniture(geo).map(f => ({ ...f, at: ptC(f.at) }));
    // retail land only implies a car park (a downtown landuse=commercial block is not a strip centre)
    const retail = (G.areas || []).filter(a => (a.tags?.landuse === 'retail' || a.tags?.shop === 'mall') && a.ring?.length >= 3).map(a => ({ a, poly: a.ring.map(toC) }));
    const fps = [];
    for (const b of G.buildings || []) {
        if (!b.ring || b.ring.length < 3) continue;
        const info = CTX.get(String(b.osm)) || null;
        const t = { ...(b.tags || {}), ...(info?.tags || {}), ...(tagOverrides[b.osm] || {}) }, poly = b.ring.map(toC), area = polygonArea(poly);
        if (info?.floors && !t['building:levels'] && !t.height) t['building:levels'] = String(Math.round(info.floors));
        let cells = rasterPolygon(poly, W, D, { grow: 0.3 }).filter(inner);
        if (cells.length < 0.4 * area) { report.dropped.push({ osm: b.osm, reason: `outside the map (${Math.round(100 * cells.length / Math.max(1, area))}% inside)` }); continue; }
        cells = cleanMask(cells);
        const centre = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
        const plain = Object.keys(t).every(k => ['id', 'building'].includes(k) || k.startsWith('addr:')) && t.building === 'yes';
        const inRetail = plain && retail.some(r => insidePoly(centre, r.poly));
        const program = info?.use?.program || (inRetail ? 'shop' : programFor(t, area * cell * cell)), st = storeysFromTags(t, 2, maxStoreys);
        const storeys = st.observed == null && (inRetail || t.shop) ? 1 : st.storeys;
        const id = String(t.name || `osm-${b.osm}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        fps.push({ id, osm: b.osm, name: t.name || info?.name || null, tags: t, program, storeys, cells, area: cells.length, info });
    }
    const used = new Set(); for (const f of fps) { while (used.has(f.id)) f.id += '-b'; used.add(f.id); }
    const party = resolveParty(fps);
    for (const f of fps.slice()) { f.cells = cleanMask(f.cells); if (f.cells.length < 20) { report.dropped.push({ osm: f.osm, reason: 'below one room' }); fps.splice(fps.indexOf(f), 1); } }
    const occupied = new Set(fps.flatMap(f => f.cells.map(([x, y]) => k2(x, y))));
    // ---- 4 streets
    const roads = [];
    for (const h of G.highways || []) {
        const sp = roadSpec(h.tags); if (!sp || !h.line || h.line.length < 2) continue;
        roads.push({ id: `${String(h.tags?.name || (sp.link ? 'link' : 'road')).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${h.osm}`, name: h.tags?.name || null, cls: sp.cls, link: sp.link, oneway: sp.oneway,
            half: sp.halfM / cell, sidewalk: sp.sidewalk ? 2 : 0, lanes: parseInt(h.tags?.lanes, 10) || (sp.cls ? 2 : 1), line: h.line.map(toC) });
    }
    const roadLen = r => r._len ??= r.line.slice(1).reduce((s, p, i) => s + len2(r.line[i], p), 0);
    const roadAt = new Map();
    for (const r of roads) {
        const xs = r.line.map(p => p[0]), ys = r.line.map(p => p[1]), pad = r.half + 2 + r.sidewalk;
        for (let y = Math.max(0, Math.floor(Math.min(...ys) - pad)); y <= Math.min(D - 1, Math.ceil(Math.max(...ys) + pad)); y++)
            for (let x = Math.max(0, Math.floor(Math.min(...xs) - pad)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + pad)); x++) {
                if (occupied.has(k2(x, y))) continue;
                const d = grid ? distBox([x + 0.5, y + 0.5], r.line) : distToPolyline([x + 0.5, y + 0.5], r.line);
                const role = d <= r.half ? 'road' : d <= r.half + 1 ? 'kerb' : d <= r.half + 1 + r.sidewalk ? 'sidewalk' : null;
                if (!role) continue;
                const rank = { road: 3, kerb: 2, sidewalk: 1 }[role], cur = roadAt.get(k2(x, y));
                const better = !cur || rank > cur.rank || rank === cur.rank && (r.cls > cur.road.cls || r.cls === cur.road.cls && (grid ? roadLen(r) > roadLen(cur.road) || roadLen(r) === roadLen(cur.road) && r.id < cur.road.id : d < cur.d));
                if (better) roadAt.set(k2(x, y), { role, rank, road: r, d });
            }
    }
    // ---- 5 lots
    const lots = [];
    for (const a of G.areas || []) {
        if (a.tags?.amenity !== 'parking' || !a.ring || a.ring.length < 3) continue;
        const cells = rasterPolygon(a.ring.map(toC), W, D).filter(c => inner(c) && !occupied.has(k2(...c)) && !roadAt.has(k2(...c)));
        if (cells.length >= 60) lots.push({ id: `lot-${a.osm}`, cells, implied: false });
    }
    const walk = new Set();
    for (const { a, poly } of retail) {
        if ((G.areas || []).some(p => p.tags?.amenity === 'parking' && p.ring?.length >= 3 && insidePoly(toC(p.ring[0]), poly))) continue;
        const inside = rasterPolygon(poly, W, D).filter(c => inner(c) && !occupied.has(k2(...c)));
        const near = (x, y) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (occupied.has(k2(x + dx, y + dy))) return true; return false; };
        const cells = [];
        for (const [x, y] of inside.filter(([x, y]) => !roadAt.has(k2(x, y)))) (near(x, y) ? walk.add(k2(x, y)) : cells.push([x, y]));
        const level = inside.filter(([x, y]) => !roadAt.has(k2(x, y)) || roadAt.get(k2(x, y)).road.cls === 0);
        if (cells.length >= 60) lots.push({ id: `lot-${a.osm}`, name: a.tags?.name || null, cells, level, implied: true });
    }
    const lotSet = new Map(); for (const l of lots) for (const [x, y] of l.cells) lotSet.set(k2(x, y), l);
    // ---- 5b open land from the real land use: parks and grass are lawn, named plazas/squares paved, footpaths straight
    //      paved walks; the rest is a paved yard next to a building or lawn further out
    const landAt = new Map(), freeCell = (x, y) => x >= 0 && y >= 0 && x < W && y < D && !occupied.has(k2(x, y)) && !roadAt.has(k2(x, y)) && !lotSet.has(k2(x, y));
    const GREEN = a => /^(park|garden|pitch|playground|dog_park|common)$/.test(a.tags?.leisure || '') || /^(grass|recreation_ground|village_green|meadow|cemetery|flowerbed|forest)$/.test(a.tags?.landuse || '') || /^(grassland|wood|scrub)$/.test(a.tags?.natural || '');
    for (const a of (G.areas || []).filter(a => a.ring?.length >= 3 && GREEN(a)).sort((p, q) => (p.tags?.leisure === 'park' ? 0 : 1) - (q.tags?.leisure === 'park' ? 0 : 1))) {
        const plaza = /plaza|square|piazza/i.test(a.tags?.name || '') && a.tags?.leisure === 'park';
        for (const c of rasterPolygon(a.ring.map(toC), W, D)) if (freeCell(...c)) landAt.set(k2(...c), plaza ? 'plaza' : 'green');
    }
    for (const h of G.highways || []) {
        if (!/^(footway|path|pedestrian|cycleway|steps|bridleway)$/.test(h.tags?.highway || '') || ['sidewalk', 'crossing'].includes(h.tags?.footway) || !h.line || h.line.length < 2) continue;
        const line = grid ? orthogonalizeLine(h.line.map(toC)) : h.line.map(toC), half = h.tags.highway === 'pedestrian' ? 1.5 : 0.75;
        const xs = line.map(p => p[0]), ys = line.map(p => p[1]);
        for (let y = Math.max(0, Math.floor(Math.min(...ys) - 2)); y <= Math.min(D - 1, Math.ceil(Math.max(...ys) + 2)); y++) for (let x = Math.max(0, Math.floor(Math.min(...xs) - 2)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + 2)); x++)
            if (freeCell(x, y) && (grid ? distBox([x + 0.5, y + 0.5], line) : distToPolyline([x + 0.5, y + 0.5], line)) <= half) landAt.set(k2(x, y), 'path');
    }
    // ---- 6 terrain
    const ground = groundModel(geo.dem, { kind: geo.dem?.kind || (/USGS|3DEP/i.test(geo.dem?.source || '') ? 'dtm' : 'dsm') });
    const hf = heightfield(F, ground, { datum, maxRelief });
    const streets = [];
    if (grid) {
        const seg = new Map(), levelled = new Set(lots.flatMap(l => (l.level || []).map(([x, y]) => k2(x, y))));
        for (const [key, v] of roadAt) {
            if (levelled.has(key)) continue;
            const [x, y] = key.split(',').map(Number), L = v.road.line, reach = v.road.half + 1 + v.road.sidewalk + 0.5;
            let best = 0, bd = Infinity, bl = -1;
            for (let i = 1; i < L.length; i++) { const d = distBox([x + 0.5, y + 0.5], [L[i - 1], L[i]]), sl = len2(L[i - 1], L[i]); if (d <= reach ? (bd > reach || sl > bl) : d < bd && bd > reach) { bd = d; best = i; bl = sl; } }
            const id = `street:${v.road.id}:${best}`; if (!seg.has(id)) seg.set(id, []); seg.get(id).push([x, y]);
        }
        for (const [id, cells] of seg) if (cells.length >= 4) streets.push({ id, cells });
    }
    const plateaus = plateauAndRelax(hf, W, D, [...fps.map(f => ({ id: f.id, cells: f.cells })), ...lots.map(l => ({ id: l.id, cells: l.level || l.cells })), ...streets], { apron: 2 });
    report.terrain = { source: ground.kind, reliefM: +hf.reliefM.toFixed(2), reliefVoxels: Math.max(...hf.z) - Math.min(...hf.z), compressed: hf.compressed };
    // ---- 7 voxels
    const partTop = Math.max(0, ...fps.flatMap(f => (f.info?.parts || []).map(p => Math.round(p.maxM / cell))));
    const gMax = Math.max(...hf.z), H = Math.min(maxHeight, Math.max(16, gMax + storeyHeight * Math.max(1, ...fps.map(f => f.storeys)) + 4, gMax + partTop + 6));
    const g = new VoxelGrid(W, D, H), Z = (x, y) => hf.z[x + y * W];
    const nearBuilding = (x, y) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (occupied.has(k2(x + dx, y + dy))) return true; return false; };
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const z = Z(x, y), r = roadAt.get(k2(x, y)), lot = lotSet.get(k2(x, y));
        g.set(x, y, 0, M.bedrock);
        for (let h = 1; h < z; h++) g.set(x, y, h, h === z - 1 ? M.soil : M.stone);
        const land = landAt.get(k2(x, y));
        g.set(x, y, z, r ? (r.role === 'road' ? M.asphalt : r.role === 'kerb' ? M.kerb : M.sidewalk) : lot ? M.lot : walk.has(k2(x, y)) ? M.sidewalk : occupied.has(k2(x, y)) ? M.floor : land === 'green' ? M.grass : land ? M.sidewalk : nearBuilding(x, y) ? M.sidewalk : M.grass);
    }
    // stall stripes: every rectangular section between the lot's drive aisles gets double stall rows along its long
    // side (5 deep, 4-cell aisle, 5 deep = 14), a divider every 3 cells
    for (const l of lots) {
        const set = new Set(l.cells.map(([x, y]) => k2(x, y))), box = { x0: Math.min(...l.cells.map(c => c[0])), y0: Math.min(...l.cells.map(c => c[1])), x1: Math.max(...l.cells.map(c => c[0])), y1: Math.max(...l.cells.map(c => c[1])) };
        let sections = 0;
        for (let guard = 0; guard < 32; guard++) {
            const r = largestRectangle(set, box);
            if (!r || r.w * r.d < 54) break;
            for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) set.delete(k2(x, y));
            if (Math.min(r.w, r.d) < 9) continue;
            const horiz = r.w >= r.d; sections++;
            for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
                const u = horiz ? x - r.x0 : y - r.y0, v = (horiz ? y - r.y0 : x - r.x0) % 14, U = horiz ? r.w : r.d;
                if (u >= 1 && u < U - 1 && u % 3 === 1 && (v < 5 || v >= 9)) g.set(x, y, Z(x, y), M.stripe);
            }
        }
        report.lots.push({ id: l.id, name: l.name || null, implied: l.implied, cells: l.cells.length, sections });
    }
    // building shells
    const out = [];
    const nearStreet = (x, y) => { let best = Infinity; for (const r of roads) if (r.cls >= 1) best = Math.min(best, distToPolyline([x + 0.5, y + 0.5], r.line) - r.half); return best; };
    for (const f of fps) {
        const { wings, mass } = decomposeFootprint(f.cells), own = new Set(f.cells.map(([x, y]) => k2(x, y))), base = plateaus.get(f.id), wall = M[WALL[f.program] || 'wall'];
        const roofZ = base + storeyHeight * f.storeys, inWing = (r, x, y) => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d;
        for (const [x, y] of f.cells) { for (let z = 1; z <= base; z++) if (!g.get(x, y, z) || z === base) g.set(x, y, z, z === base ? M.floor : M.stone); }
        const doors = [];
        // the front: the side of the largest wing that faces the nearest street (or, for a shop, its car park)
        const main = wings.slice().sort((a, b) => b.w * b.d - a.w * a.d)[0];
        const sideCells = (r, s) => s === 'n' ? Array.from({ length: r.w }, (_, i) => [r.x0 + i, r.y0]) : s === 's' ? Array.from({ length: r.w }, (_, i) => [r.x0 + i, r.y0 + r.d - 1]) : s === 'w' ? Array.from({ length: r.d }, (_, i) => [r.x0, r.y0 + i]) : Array.from({ length: r.d }, (_, i) => [r.x0 + r.w - 1, r.y0 + i]);
        const OUT = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
        const score = s => { const [dx, dy] = OUT[s], cs = sideCells(main, s), exposed = cs.filter(([x, y]) => !own.has(k2(x + dx, y + dy)) && !occupied.has(k2(x + dx, y + dy))).length / cs.length;
            if (exposed < 0.6) return -Infinity; const lot = cs.filter(([x, y]) => [3, 4, 5, 6].some(t => lotSet.has(k2(x + dx * t, y + dy * t)))).length / cs.length;
            return (f.program === 'shop' && lot > 0.3 ? 100 + 2 * lot * cs.length : 0) - Math.min(...cs.map(([x, y]) => nearStreet(x + dx * 2, y + dy * 2))); };
        const front = main ? ['n', 'e', 's', 'w'].sort((a, b) => score(b) - score(a))[0] : 's';
        for (const r of wings) for (let st = 0; st < f.storeys; st++) {
            const fz = base + storeyHeight * st;
            for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
                g.set(x, y, fz, M.floor);
                const edge = x === r.x0 || y === r.y0 || x === r.x0 + r.w - 1 || y === r.y0 + r.d - 1;
                if (!edge) continue;
                // exterior: some 4-neighbour outside the building; a shared wing line is interior (doorway in it below)
                const outside = N4.some(([dx, dy]) => !own.has(k2(x + dx, y + dy)));
                const shared = !outside && N4.some(([dx, dy]) => !inWing(r, x + dx, y + dy) && own.has(k2(x + dx, y + dy)));
                for (let h = 1; h < storeyHeight; h++) g.set(x, y, fz + h, wall);
                const corner = (x === r.x0 || x === r.x0 + r.w - 1) && (y === r.y0 || y === r.y0 + r.d - 1);
                if (outside && !party.has(k2(x, y)) && !corner) {
                    const along = (y === r.y0 || y === r.y0 + r.d - 1) ? x - r.x0 : y - r.y0;
                    const storefront = f.program === 'shop' && st === 0 && r === main && sideCells(main, front).some(([a, b]) => a === x && b === y);
                    if (storefront ? along % 4 !== 0 : along % 3 === 1) for (let h = storefront ? 1 : 2; h < storeyHeight; h++) g.set(x, y, fz + h, M.glass);
                }
                if (shared && (x + y) % 9 === 0) for (let h = 1; h < storeyHeight; h++) g.set(x, y, fz + h, 0);   // doorways between wings
            }
        }
        if (main) { const cs = sideCells(main, front), [dx, dy] = cs[Math.floor(cs.length / 2)]; for (let h = 1; h < Math.min(3, storeyHeight); h++) g.set(dx, dy, base + h, M.door); doors.push({ x: dx, y: dy, z: base, side: front }); }
        for (const [x, y] of mass) for (let z = base + 1; z < roofZ; z++) g.set(x, y, z, wall);
        for (const [x, y] of f.cells) { g.set(x, y, roofZ, M.roof); if (N4.some(([dx, dy]) => !own.has(k2(x + dx, y + dy))) && !party.has(k2(x, y))) g.set(x, y, roofZ + 1, M.parapet); }
        // OSM 3D parts above the shell: real-height walls with window bands, capped by their roof shape
        let parts = 0;
        for (const p of (f.info?.parts || []).slice().sort((a, b) => a.maxM - b.maxM)) {
            const ring = grid ? orthogonalizeRing(p.ring.map(ptC), { tol: 0.6 }) : p.ring.map(ptC), pc = rasterPolygon(ring, W, D, { grow: 0.3 });
            const zTop = Math.min(H - 2, base + Math.round(p.maxM / cell)), roofV = Math.round((p.roofM || 0) / cell), zFrom = Math.max(base + Math.round(p.minM / cell), roofZ + 1), zEave = zTop - roofV;
            if (!pc.length || zTop <= roofZ + 1) continue;
            const pset = new Set(pc.map(([x, y]) => k2(x, y))), pm = /brick/.test(p.material || '') ? M.wall : /stone/.test(p.material || '') ? M.wall_concrete : wall;
            const rim = (x, y) => N4.some(([dx, dy]) => !pset.has(k2(x + dx, y + dy)));
            for (let z = zFrom; z <= Math.max(zFrom, zEave); z++) for (const [x, y] of pc) if (z === zFrom) g.set(x, y, z, M.floor); else if (rim(x, y)) g.set(x, y, z, (z - zFrom) % 4 === 2 && pc.length > 6 && (x + y) % 2 ? M.glass : pm);
            const xs = pc.map(c => c[0]), ys = pc.map(c => c[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), gable = /gabled|saltbox/.test(p.roofShape);
            const rise = roofV || (p.roofShape === 'flat' ? 0 : Math.max(1, Math.floor(Math.min(x1 - x0 + 1, y1 - y0 + 1) / 2)));
            for (const [x, y] of pc) {
                if (!rise) { g.set(x, y, Math.max(zFrom, zEave) + 1, M.roof); continue; }
                const inX = Math.min(x - x0, x1 - x), inY = Math.min(y - y0, y1 - y), step = gable ? (x1 - x0 >= y1 - y0 ? inY : inX) : Math.min(inX, inY);
                for (let z = 1; z <= Math.min(rise, step + 1); z++) g.set(x, y, Math.max(zFrom, zEave) + z, M.roof);
            }
            parts++;
        }
        out.push({ id: f.id, osm: f.osm, name: f.name, program: f.program, storeys: f.storeys, baseZ: base, roofZ, front, wings, mass: mass.length, doors, cells: f.cells.length, parts,
            tenants: (f.info?.tenants || []).map(t => ({ name: t.name, use: t.use?.program || null, tags: t.tags })), facts: f.info?.facts || null, landmark: !!f.info?.landmark });
        report.buildings.push({ id: f.id, osm: f.osm, name: f.name, program: f.program, storeys: f.storeys, wings: wings.length, cells: f.cells.length });
    }
    // real trees (OSM natural=tree) on lawns, plazas, paths and sidewalks: a 3-voxel trunk and a 3 × 3 × 2 crown
    let trees = 0;
    for (const t of FURN.filter(q => q.kind === 'tree')) {
        const x = Math.floor(t.at[0]), y = Math.floor(t.at[1]); if (x < 1 || y < 1 || x >= W - 1 || y >= D - 1 || occupied.has(k2(x, y)) || roadAt.get(k2(x, y))?.role === 'road') continue;
        const z = Z(x, y); if (g.get(x, y, z + 1)) continue;
        for (let h = 1; h <= 3; h++) g.set(x, y, z + h, M.trunk);
        for (let dz = 4; dz <= 5; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!g.get(x + dx, y + dy, z + dz)) g.set(x + dx, y + dy, z + dz, M.leaves);
        trees++;
    }
    report.trees = trees; report.context = geo.context ? { tenants: [...CTX.values()].reduce((a, c) => a + c.tenants.length, 0), landmarks: [...CTX.values()].filter(c => c.landmark).length, furniture: FURN.length } : null;
    // ---- 8 paint
    const paint = planGeoRoadPaint(roads, { isRoadCell: (x, y) => roadAt.get(k2(x, y))?.role === 'road', zAt: (x, y) => Z(x, y) });
    const codes = Array.from({ length: W * D }, (_, i) => { const x = i % W, y = Math.floor(i / W), r = roadAt.get(k2(x, y)); return r ? r.role[0].toUpperCase() : lotSet.has(k2(x, y)) ? 'L' : occupied.has(k2(x, y)) ? 'B' : walk.has(k2(x, y)) ? 'W' : '.'; }).join('');
    report.paint = { quads: paint.quads.length, junctions: paint.junctions.length };
    return {
        grid: g, report,
        layers: { format: 'geo-voxels/layers@1', frame: { cell, theta: F.theta, width: W, depth: D, window: geo.window || geo.extent, origin: geo.origin, crs: geo.crs },
            heightfield: Array.from(hf.z), landUse: { legend: { R: 'road', K: 'kerb', S: 'sidewalk', L: 'lot', B: 'building', W: 'storefront walk', '.': 'open' }, codes },
            roads: roads.map(r => ({ id: r.id, name: r.name, cls: r.cls, link: r.link, oneway: r.oneway, half: r.half, line: r.line })), lots: lots.map(l => ({ id: l.id, name: l.name || null, implied: l.implied, cells: l.cells })),
            buildings: out, paint }
    };
}
