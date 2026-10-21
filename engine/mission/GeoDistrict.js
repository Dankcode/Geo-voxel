// Geo import — a faithful (1:1) district from a BlenderGIS export: the real terrain, the real streets and the real
// building outlines of a map section, with the district generator filling only what the source leaves open.
//
//   frame      rotate the block onto the grid, one kit cell ≈ 0.9 m, one uniform scale        (GeoFrame)
//   straighten every street an exact grid line, buildings carried along and squared (GeoRectify;
//              straighten: 'grid', the default — null keeps the raw geometry)
//   terrain    DEM → bare ground → whole-voxel heightfield, plateaus under buildings/lots,
//              every neighbouring step ≤ 1 voxel                                              (GeoFrame)
//   streets    OSM centrelines buffered by their lane count: carriageway, kerb, sidewalk,
//              dashed centre lines, kerb parking stalls, lamps and trees on the local ground
//   lots       OSM parking polygons → striped stall rows (district parkingLot); a retail/commercial landuse
//              with no mapped parking is a US strip-centre car park: its open land becomes the lot
//   buildings  real outlines → wings → ModernBuilder rooms/stairs/glazing/furniture, party
//              walls shared, wings stitched with doorways                                      (GeoBuildings)
//   fill       fillDistrict on the remaining land with a building cap of zero: parcel mixes
//              make yards, plazas, strips and vehicles but never invent a building
//   gates      the district gates are evaluated and reported (not enforced: real places break
//              some gameplay rules, and that is information, not a reason to edit the place)
import { createMap } from './modern/MapKit.js';
import { MAT } from '../voxel/Materials.js';
import { reachable, nodeKey } from '../world/PathSearch.js';
import { AGENT_PROFILES } from '../world/TraversalRules.js';
import { initDistrict, tag, tagAt, setGround, groundAt, put, frame as parcelFrame } from '../mapgen/district/Core.js';
import { fillDistrict, finishDistrict } from '../mapgen/district/District.js';
import { addStall, parkingLot, plantTree } from '../mapgen/district/Props.js';
import { remixParameters } from '../mapgen/DistrictRemix.js';
import { repairCover, tryPiece, REPAIR_GAP } from '../mapgen/district/CoverRepair.js';
import { coverAt, COVER } from '../voxel/Cover.js';
import { districtPods } from '../mapgen/district/Pods.js';
import { STOREY } from './modern/ModernBuilder.js';
import { geoFrame, groundModel, heightfield, plateauAndRelax, rasterPolygon, polygonArea, distToPolyline } from '../mapgen/geo/GeoFrame.js';
import { buildFootprint, cleanMask, resolveParty, footprintIoU, largestRectangle, closeDeadExits } from '../mapgen/geo/GeoBuildings.js';
import { placeStreetVehicle } from '../mapgen/StreetDressing.js';
import { registerCells, landUseSnapshot } from '../mapgen/district/Core.js';
import { programFor, storeysFromTags, roadWidthMetres } from '../mapgen/GeoSite.js';
import { planGeoRoadPaint, lotStripesToPaint } from '../mapgen/geo/GeoRoadPaint.js';
import { placeGeoProps } from '../mapgen/geo/GeoStreetProps.js';
import { rectifyNetwork, weightedGridAngle, orthogonalizeLine, orthogonalizeRing } from '../mapgen/geo/GeoRectify.js';
import { buildingContext, streetFurniture } from '../mapgen/geo/GeoContext.js';
import { dressLandmark, landmarkHeadroom, styleFamily, LANDMARK_MAX_HEIGHT } from '../mapgen/geo/GeoLandmark.js';

export const GEO_GENERATOR_VERSION = 'geo-faithful-3';   // 2: street straightening (full grid) · 3: context (tenants, uses, landmarks), real open land, lot islands
const k2 = (x, y) => `${x},${y}`;
const ROAD_CLASS = { motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2, unclassified: 2, residential: 1, living_street: 1, service: 0 };
const WALLS = { shop: 'brick', supermarket: 'brick', office: 'concrete_wall', warehouse: 'brick', diner: 'stucco', garage: 'brick', house: 'siding', bank: 'stone', museum: 'stone', chapel: 'stone', civic: 'stone', school: 'brick', library: 'brick', clinic: 'concrete_wall', hotel: 'brick' };

/**
 * opts: { geo (BlenderGIS export), id, name, seed, objectiveName, maxRelief (voxels), rotate ('auto'|radians),
 *         maxStoreys (ModernBuilder supports 3), enforceGates (false),
 *         tagOverrides ({ [osm id]: tags } merged over the export's tags — names and uses OSM leaves blank) }
 */
export function buildGeoDistrict({ geo, id = 'geo-district', name = 'Geo District', seed = 1, objectiveName = null, tagOverrides = {}, straighten = 'grid', maxRelief = 6, rotate = 'auto', maxStoreys = 3, enforceGates = false, timeOfDay = 'dusk', audit = true, coverRepair = true } = {}) {
    if (!geo?.extent) throw Error('geo: a BlenderGIS export is required');
    // frame angle: with straightening, the streets weigh in (length × class) so the smallest correction is left
    const angle = straighten === 'grid' && rotate === 'auto' ? weightedGridAngle([
        ...(geo.highways || []).map(h => ({ h, sp: roadSpec(h.tags || {}, 1) })).filter(o => o.sp && o.h.line?.length >= 2).map(o => ({ pts: o.h.line, w: 1 + o.sp.cls })),
        ...(geo.buildings || []).filter(b => b.ring?.length >= 3).map(b => ({ pts: b.ring, w: 1, closed: true }))]) : rotate;
    const F = geoFrame(geo, { rotate: angle }), { W, D } = F, report = { theta: F.theta, size: [W, D], buildings: [], dropped: [], storeys: [], roads: [], lots: [], terrain: null, straighten: null };
    // straighten: the whole source is taken to cells, rectified, and used from here on in cell coordinates
    let G = geo, toC = F.toCell, ptC = F.toCell;
    if (straighten === 'grid') {
        const hw = (geo.highways || []).map((h, i) => ({ h, i, sp: roadSpec(h.tags || {}, F.cell) })).filter(o => o.h.line?.length >= 2);
        const R = rectifyNetwork(hw.filter(o => o.sp).map(o => ({ id: o.i, line: o.h.line.map(F.toCell), cls: o.sp.cls, half: o.sp.half })), {
            buildings: (geo.buildings || []).map((b, i) => ({ id: i, ring: b.ring?.length >= 3 ? b.ring.map(F.toCell) : null })).filter(b => b.ring),
            areas: (geo.areas || []).map((a, i) => ({ id: i, ring: a.ring?.length >= 3 ? a.ring.map(F.toCell) : null })).filter(a => a.ring),
            lines: hw.filter(o => !o.sp).map(o => ({ id: o.i, line: o.h.line.map(F.toCell) }))
        });
        const rl = new Map([...R.roads.map(r => [r.id, r.line]), ...R.lines.map(l => [l.id, l.line])]), rb = new Map(R.buildings.map(b => [b.id, b.ring])), ra = new Map(R.areas.map(a => [a.id, a.ring]));
        G = { ...geo,
            highways: (geo.highways || []).map((h, i) => rl.has(i) ? { ...h, line: rl.get(i) } : h),
            buildings: (geo.buildings || []).map((b, i) => rb.has(i) ? { ...b, ring: rb.get(i) } : b),
            areas: (geo.areas || []).map((a, i) => ra.has(i) ? { ...a, ring: ra.get(i) } : a) };
        toC = p => p;
        report.straighten = R.report;
        ptC = p => { const c = F.toCell(p), d = R.displace(c); return [c[0] + d[0], c[1] + d[1]]; };
    }
    // context (tenants, uses, landmarks, street furniture) from the export's `context` fetch, keyed by OSM id
    const CTX = buildingContext(geo), FURNITURE = streetFurniture(geo).map(f => ({ ...f, at: ptC(f.at) }));
    report.context = geo.context ? { buildings: CTX.size, tenants: [...CTX.values()].reduce((a, c) => a + c.tenants.length, 0), landmarks: [...CTX.values()].filter(c => c.landmark).length, furniture: FURNITURE.length, wikidata: Object.keys(geo.context.wikidata || {}).length } : null;
    report.landmarks = [];
    const inMapC = (x, y) => x >= 0 && y >= 0 && x < W && y < D;

    // ------------------------------------------------------------------ buildings (footprints first: terrain and streets respect them)
    const fps = [];
    // retail / commercial land (shopping centres): an untagged building=yes inside one is a shop unit
    // (retail only: a downtown `landuse=commercial` block is not a strip centre with a car park)
    const RETAIL = a => a.tags?.landuse === 'retail' || a.tags?.amenity === 'marketplace' || a.tags?.shop === 'mall';
    const retailAreas = (G.areas || []).filter(a => RETAIL(a) && a.ring?.length >= 3).map(a => ({ a, poly: a.ring.map(toC) }));
    const insidePoly = ([px, py], poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; };
    for (const b of G.buildings || []) {
        if (!b.ring || b.ring.length < 3) continue;
        const info = CTX.get(String(b.osm)) || null, override = tagOverrides[b.osm] || null;
        b.tags = { ...(b.tags || {}), ...(info?.tags || {}), ...(override || {}) };
        // Wikidata floors when OSM has no levels
        if (info?.floors && !b.tags['building:levels'] && !b.tags.height) b.tags['building:levels'] = String(Math.round(info.floors));
        const poly = b.ring.map(toC), areaCells = polygonArea(poly);
        let cells = rasterPolygon(poly, W, D, { grow: 0.3 }).filter(([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < D - 1);
        if (cells.length < 0.4 * areaCells) { report.dropped.push({ osm: b.osm, reason: `outside map (${Math.round(100 * cells.length / Math.max(1, areaCells))}% inside)` }); continue; }
        cells = cleanMask(cells);
        const t = b.tags || {}, st = storeysFromTags(t, 2);
        const centre = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
        const inRetail = Object.keys(t).every(k => ['id', 'building'].includes(k) || k.startsWith('addr:')) && t.building === 'yes' && retailAreas.some(r => insidePoly(centre, r.poly));
        // use: a catalog override first, then the context (the building's own use, or its one tenant), then the old rules
        const use = !override && info?.use ? info.use : null;
        const program = use?.program || (inRetail ? 'shop' : programFor(t, areaCells * F.cell * F.cell));
        // a strip-centre unit with no height in OSM is one tall storey, not the downtown default of two
        const storeys = Math.min(maxStoreys, st.observed == null && (inRetail || t.shop || ['shop', 'supermarket', 'diner'].includes(program) && (inRetail || info?.tenants?.length)) ? 1 : st.storeys);
        if (st.observed && st.observed !== storeys) report.storeys.push({ osm: b.osm, observed: st.observed, played: storeys });
        const name = t.name || info?.name || null;
        const slug = String(name || `osm-${b.osm}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const exact = rasterPolygon(poly, W, D).filter(([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < D - 1);   // centre-inside, for the fidelity audit
        const mats = info?.materials || {}, def = use?.def || null;
        const fp = { id: slug, osm: b.osm, name, tags: t, program, def, storeys, observed: st.observed, cells, area: cells.length, poly, exact, info,
            wall: mats.wall || def?.wall || WALLS[program], floor: mats.floor || null, roof: mats.roof || def?.roof || null };
        // one building, several tenants (a strip of shop units): one unit per tenant, cut between their positions
        // along the building's long axis, each unit its own building with a party wall to the next
        const units = !override && info?.units?.length >= 2 ? splitUnits(fp, info.units.map(u => ({ ...u, at: ptC(u.at) }))) : null;
        if (units) { fps.push(...units); report.units = (report.units || []).concat({ osm: b.osm, units: units.map(u => u.name) }); }
        else fps.push(fp);
    }
    const usedIds = new Set(); for (const f of fps) { while (usedIds.has(f.id)) f.id += '-b'; usedIds.add(f.id); }
    const party = resolveParty(fps);
    for (const f of fps.slice()) { f.cells = cleanMask(f.cells); if (f.cells.length < 20) { report.dropped.push({ osm: f.osm, reason: 'footprint below one room' }); fps.splice(fps.indexOf(f), 1); } }
    const occupied = new Set(fps.flatMap(f => f.cells.map(([x, y]) => k2(x, y))));

    // ------------------------------------------------------------------ streets (centrelines in cells)
    const roads = [];
    for (const h of G.highways || []) {
        const t = h.tags || {};
        const sp = roadSpec(t, F.cell);
        if (!sp || !h.line || h.line.length < 2) continue;
        const { cls, half, link } = sp;
        // kerb parking: never on slip lanes, primaries or the carriageways of a divided boulevard (or where OSM says none)
        const kerbParking = !link && !['motorway', 'trunk', 'primary'].includes(t.highway) && !(cls >= 3 && ['yes', 'true', '1'].includes(t.oneway))
            && !['no', 'no_parking', 'no_stopping'].includes(t['parking:both'] || t['parking:lane:both']);
        roads.push({ kerbParking, hw: t.highway, id: `${String(t.name || (link ? 'link' : 'road')).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${h.osm}`, name: t.name || null, cls, link, kind: cls >= 3 ? 'main' : cls >= 1 ? 'cross' : 'service', half,
            sidewalk: cls >= 1 && !link ? 2 : 0, lanes: parseInt(t.lanes, 10) || (cls ? 2 : 1), line: h.line.map(toC), maxspeed: t.maxspeed || null,
            oneway: ['yes', 'true', '1'].includes(t.oneway) || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0 });
    }
    // OSM-mapped pedestrian crossings (footway=crossing ways): painted where they really are
    const crossings = (G.highways || []).filter(h => h.tags?.footway === 'crossing' || h.tags?.highway === 'crossing').map(h => h.line.map(toC)).filter(l => l.length >= 2).map(l => [l[0], l.at(-1)]);
    // per-cell street role: nearest road decides; buildings are never paved over
    const roadAt = new Map();
    for (const r of roads) {
        const xs = r.line.map(p => p[0]), ys = r.line.map(p => p[1]), pad = r.half + 1 + r.sidewalk + 1;
        for (let y = Math.max(0, Math.floor(Math.min(...ys) - pad)); y <= Math.min(D - 1, Math.ceil(Math.max(...ys) + pad)); y++)
            for (let x = Math.max(0, Math.floor(Math.min(...xs) - pad)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + pad)); x++) {
                if (occupied.has(k2(x, y))) continue;
                // straightened streets get square ends and corners (box distance), never a rounded pixel staircase
                const d = straighten === 'grid' ? distBox([x + 0.5, y + 0.5], r.line) : distToPolyline([x + 0.5, y + 0.5], r.line);
                const role = d <= r.half ? 'road' : d <= r.half + 1 ? 'kerb' : d <= r.half + 1 + r.sidewalk ? 'sidewalk' : null;
                if (!role) continue;
                const rank = { road: 3, kerb: 2, sidewalk: 1 }[role], cur = roadAt.get(k2(x, y));
                // (straightened: a cell inside two streets of one class belongs wholly to the longer one — nearest-wins
                // would split every junction square along its diagonal)
                const better = !cur || rank > cur.rank || rank === cur.rank && (r.cls > cur.road.cls || r.cls === cur.road.cls && (straighten === 'grid' ? roadLength(r) > roadLength(cur.road) || roadLength(r) === roadLength(cur.road) && r.id < cur.road.id : d < cur.d));
                if (better) roadAt.set(k2(x, y), { role, rank, road: r, d });
            }
    }
    if (globalThis.process?.env?.GEO_DEBUG) report.roadLines = roads.map(r => ({ id: r.id, cls: r.cls, line: r.line }));
    for (const r of roads) report.roads.push({ id: r.id, name: r.name, kind: r.kind, widthCells: +(2 * r.half).toFixed(1), cells: [...roadAt.values()].filter(v => v.road === r && v.role === 'road').length });

    // ------------------------------------------------------------------ parking lots (OSM amenity=parking)
    const lots = [];
    for (const a of G.areas || []) {
        if (a.tags?.amenity !== 'parking' || !a.ring || a.ring.length < 3) continue;
        const cells = rasterPolygon(a.ring.map(toC), W, D).filter(([x, y]) => !occupied.has(k2(x, y)) && !roadAt.has(k2(x, y)) && x >= 1 && y >= 1 && x < W - 1 && y < D - 1);
        if (cells.length >= 60) lots.push({ id: `lot-${a.osm}`, cells });
    }
    // shopping centres with no mapped parking: the open land of the centre is its car park (minus a storefront walk)
    const walk = new Set();
    for (const { a, poly } of retailAreas) {
        const mapped = lots.length && (G.areas || []).some(p => p.tags?.amenity === 'parking' && p.ring?.length >= 3 && insidePoly(toC(p.ring[0]), poly));
        if (mapped) continue;
        const inside = rasterPolygon(poly, W, D).filter(([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < D - 1 && !occupied.has(k2(x, y)));
        const raw = inside.filter(([x, y]) => !roadAt.has(k2(x, y)));
        // the centre's own drive aisles (service roads) are levelled with its car park, never sunk below it
        const level = inside.filter(([x, y]) => !roadAt.has(k2(x, y)) || roadAt.get(k2(x, y)).road.cls === 0);
        const nearB = (x, y, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (occupied.has(k2(x + dx, y + dy))) return true; return false; };
        const cells = [];
        for (const [x, y] of raw) (nearB(x, y, 3) ? walk.add(k2(x, y)) : cells.push([x, y]));
        if (cells.length >= 60) lots.push({ id: `lot-${a.osm}`, cells, level, levelSet: new Set(level.map(([x, y]) => k2(x, y))), implied: true, name: a.tags?.name || null });
    }

    // ------------------------------------------------------------------ open land from the real land use
    // parks, grass and gardens are lawn; named plazas/squares are paving; footpaths are straight paved walks; whatever
    // is left is a paved yard next to a building or lawn further out — the district filler invents nothing here
    const landAt = new Map();
    const FREE = (x, y) => x >= 0 && y >= 0 && x < W && y < D && !occupied.has(k2(x, y)) && !roadAt.has(k2(x, y)) && !lots.some(l => l.levelSet?.has?.(k2(x, y)) || false);
    const lotCells = new Set(lots.flatMap(l => l.cells.map(([x, y]) => k2(x, y))));
    const GREEN = a => /^(park|garden|pitch|playground|dog_park|common)$/.test(a.tags?.leisure || '') || /^(grass|recreation_ground|village_green|meadow|cemetery|flowerbed|forest)$/.test(a.tags?.landuse || '') || /^(grassland|wood|scrub)$/.test(a.tags?.natural || '');
    const areaRank = a => (a.tags?.leisure === 'park' ? 0 : 1);         // parks first, the grass inside them on top
    for (const a of (G.areas || []).filter(a => a.ring?.length >= 3 && GREEN(a)).sort((p, q) => areaRank(p) - areaRank(q))) {
        // (a US "square" is usually a green park: only plazas/piazzas or explicitly paved parks are paved)
        const plaza = a.tags?.leisure === 'park' && (/plaza|piazza/i.test(a.tags?.name || '') || /^(paving_stones|sett|concrete|paved|asphalt)$/.test(a.tags?.surface || ''));
        for (const [x, y] of rasterPolygon(a.ring.map(toC), W, D)) if (FREE(x, y) && !lotCells.has(k2(x, y))) landAt.set(k2(x, y), plaza ? 'plaza' : 'green');
    }
    const FOOT = /^(footway|path|pedestrian|cycleway|steps|bridleway)$/;
    let paths = 0;
    for (const h of G.highways || []) {
        if (!FOOT.test(h.tags?.highway || '') || h.tags?.footway === 'sidewalk' || h.tags?.footway === 'crossing' || !h.line || h.line.length < 2) continue;
        const line = straighten === 'grid' ? orthogonalizeLine(h.line.map(toC)) : h.line.map(toC), half = h.tags.highway === 'pedestrian' ? 1.5 : 0.75;
        const xs = line.map(p => p[0]), ys = line.map(p => p[1]);
        for (let y = Math.max(0, Math.floor(Math.min(...ys) - 2)); y <= Math.min(D - 1, Math.ceil(Math.max(...ys) + 2)); y++)
            for (let x = Math.max(0, Math.floor(Math.min(...xs) - 2)); x <= Math.min(W - 1, Math.ceil(Math.max(...xs) + 2)); x++)
                if (FREE(x, y) && !lotCells.has(k2(x, y)) && (straighten === 'grid' ? distBox([x + 0.5, y + 0.5], line) : distToPolyline([x + 0.5, y + 0.5], line)) <= half) { landAt.set(k2(x, y), 'path'); paths++; }
    }
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const k = k2(x, y); if (landAt.has(k) || !FREE(x, y) || lotCells.has(k) || walk.has(k)) continue;
        let near = false; for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (occupied.has(k2(x + dx, y + dy))) { near = true; break; }
        landAt.set(k, near ? 'yard' : 'green');
    }
    report.openLand = { green: [...landAt.values()].filter(v => v === 'green').length, plaza: [...landAt.values()].filter(v => v === 'plaza').length, paths, yard: [...landAt.values()].filter(v => v === 'yard').length };

    // ------------------------------------------------------------------ terrain
    const ground = groundModel(geo.dem, { kind: geo.dem?.kind || (/USGS|3DEP/i.test(geo.dem?.source || geo.source || '') ? 'dtm' : 'dsm') });
    const hf = heightfield(F, ground, { datum: 1, maxRelief });
    // straightened streets: each centreline segment is one level plateau (carriageway, kerb and sidewalk), so a height
    // step only ever runs straight across a street at a junction or bend — never a diagonal contour over the asphalt
    const streetLevels = [];
    if (straighten === 'grid') {
        const segOf = new Map();
        for (const [key, v] of roadAt) {
            if (lots.some(l => l.levelSet?.has(key))) continue;
            const [x, y] = key.split(',').map(Number), L = v.road.line;
            // the longest segment of its street that covers the cell (axis-aligned ownership, no diagonal split)
            const reach = v.road.half + 1 + v.road.sidewalk + 0.5;
            let best = 0, bd = Infinity, bl = -1;
            for (let i = 1; i < L.length; i++) {
                const d = distBox([x + 0.5, y + 0.5], [L[i - 1], L[i]]), sl = len2(L[i - 1], L[i]);
                if (d <= reach ? (bd > reach || sl > bl) : d < bd && bd > reach) { bd = d; best = i; bl = sl; }
            }
            const id = `street:${v.road.id}:${best}`;
            if (!segOf.has(id)) segOf.set(id, []);
            segOf.get(id).push([x, y]);
        }
        for (const [sid, cells] of segOf) if (cells.length >= 4) streetLevels.push({ id: sid, cells });
    }
    const plateaus = plateauAndRelax(hf, W, D, [...fps.map(f => ({ id: f.id, cells: f.cells })), ...lots.map(l => ({ id: l.id, cells: l.level || l.cells })), ...streetLevels], { apron: 2 });
    report.terrain = { source: ground.kind, reliefM: +hf.reliefM.toFixed(2), reliefVoxels: Math.max(...hf.z) - Math.min(...hf.z), compressed: hf.compressed, lowM: +hf.lowM.toFixed(2) };
    const headroom = Math.max(0, ...fps.map(f => f.info?.landmark || styleFamily(f.info) ? landmarkHeadroom(f.info, { storeys: f.storeys, cell: F.cell, storey: STOREY }) : 0));
    const gMax = Math.max(...hf.z), H = Math.min(LANDMARK_MAX_HEIGHT + 2, Math.max(18, gMax + STOREY * maxStoreys + 5, gMax + STOREY * maxStoreys + headroom + 4));

    // ------------------------------------------------------------------ voxels: ground, streets, lots
    const m = createMap({ id, width: W, depth: D, height: H, seed, datum: 1, ground: 'paving' }), s = m.store;
    initDistrict(m, { contains: () => true, family: 'urban', seed });
    m.district.notes.push(`geo: ${geo.source || 'BlenderGIS'} · rotated ${(F.theta * 180 / Math.PI).toFixed(1)}° · ${W}×${D} cells at ${F.cell} m`);
    const d = m.district;
    d.roadKind ||= new Map();
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const g = hf.z[x + y * W], r = roadAt.get(k2(x, y));
        for (let z = 1; z < g; z++) s.set(x, y, z, z === g - 1 ? MAT.soil : MAT.stone);
        const land = r ? null : landAt.get(k2(x, y));
        s.set(x, y, g, r ? (r.role === 'road' ? MAT.asphalt : r.role === 'kerb' ? MAT.concrete : MAT.paving) : land === 'green' ? MAT.lawn : MAT.paving);
        setGround(m, x, y, g);
        if (r) {
            tag(m, x, y, r.role, { force: true });
            d.roadOwnership.set(k2(x, y), [{ tag: r.role, z: g }]);
            d.roadKind.set(k2(x, y), r.road.kind);
        } else if (land) tag(m, x, y, land, { force: true });
    }
    // real trees (OSM natural=tree from the context fetch) where they stand: lawns, plazas, yards and sidewalks
    let realTrees = 0;
    for (const t of FURNITURE.filter(f => f.kind === 'tree')) {
        const x = Math.floor(t.at[0]), y = Math.floor(t.at[1]); if (!inMapC(x, y) || occupied.has(k2(x, y))) continue;
        const role = roadAt.get(k2(x, y))?.role, land = landAt.get(k2(x, y));
        if (role && role !== 'sidewalk' || !role && !['green', 'plaza', 'yard'].includes(land)) continue;
        if (role === 'sidewalk') tag(m, x, y, 'verge', { force: true });
        if (plantTree(m, x, y, 'geo:osm/tree')) realTrees++;
        if (role === 'sidewalk') tag(m, x, y, 'sidewalk', { force: true });
    }
    report.realTrees = realTrees;
    // the storefront walk belongs to the centre (a plaza strip), not the public sidewalk: planters may stand on it
    for (const k of walk) { const [x, y] = k.split(',').map(Number); if (!roadAt.has(k)) tag(m, x, y, 'plaza', { force: true }); }
    // (road paint — centre/lane/edge lines, crosswalks, stop bars — is planned from the road graph below, not painted into voxels)
    // parking lots: the largest rectangle of each lot gets district stall rows facing the nearest street; the rest is aisle
    for (const l of lots) {
        const set = new Set(l.cells.map(([x, y]) => k2(x, y)));
        const box = { x0: Math.min(...l.cells.map(c => c[0])), y0: Math.min(...l.cells.map(c => c[1])), x1: Math.max(...l.cells.map(c => c[0])), y1: Math.max(...l.cells.map(c => c[1])) };
        const z = plateaus.get(l.id);
        for (const [x, y] of l.cells) { s.set(x, y, z, MAT.asphalt); tag(m, x, y, 'aisle', { force: true }); }
        // every rectangular section between the lot's real drive aisles gets the district's two-row module, tiled
        // back from the street (14 cells per double row)
        let stalls = 0, sections = 0;
        for (let guard = 0; guard < (l.implied ? 24 : 6); guard++) {
            const r = largestRectangle(set, box);
            if (!r || r.w * r.d < 54) break;
            for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) set.delete(k2(x, y));
            // a strip too thin for a stall row stays aisle; smaller sections elsewhere may still take one
            if (Math.min(r.w, r.d) < 6 || Math.max(r.w, r.d) < 9) { if (l.implied) continue; break; }
            const near = side => { const c = { n: [r.x0 + r.w / 2, r.y0 - 3], s: [r.x0 + r.w / 2, r.y0 + r.d + 3], w: [r.x0 - 3, r.y0 + r.d / 2], e: [r.x0 + r.w + 3, r.y0 + r.d / 2] }[side]; return Math.min(...roads.map(q => distToPolyline(c, q.line) - q.cls)); };
            // rows run along the section's long side
            const fronts = r.w >= r.d ? ['n', 's'] : ['e', 'w'];
            const PF = parcelFrame({ ...r, front: fronts.sort((a, b) => near(a) - near(b))[0] });
            for (let v = 0; v + 9 <= PF.V; v += 14) {
                const lot = parkingLot(m, PF, { u0: 0, v0: v, uw: PF.U, vd: Math.min(14, PF.V - v) }, { origin: `geo:${l.id}/s${sections}-${v}`, z, islands: PF.U >= 18, frontage: v === 0 });
                stalls += lot.stalls.length;
            }
            sections++;
        }
        // a shopping-centre car park (implied from retail land) fills like one, and its stall rows end in raised,
        // curbed planting islands (real cover where a lot is otherwise open asphalt)
        if (l.implied) {
            for (const st of m.district.stalls) if (st.origin?.startsWith(`geo:${l.id}/`)) st.kind = 'retail';
            for (const [x, y] of l.cells) if (tagAt(m, x, y) === 'green' && s.topSolid(x, y) === z && !s.isSolid(x, y, z + 1) && !m.keep.has(k2(x, y))) put(m, x, y, z + 1, 'planter', `geo:${l.id}/island-planter`);
        }
        // real lots: a kerbed, planted island every 6th stall along each row (fewer cars; trees and planters for cover)
        let islands = 0;
        const mine = d.stalls.filter(st => st.origin?.startsWith(`geo:${l.id}/`));
        const rows = new Map();
        for (const st of mine) { const key = `${st.origin}|${st.axis}|${st.axis === 'y' ? st.y : st.x}`; if (!rows.has(key)) rows.set(key, []); rows.get(key).push(st); }
        for (const row of rows.values()) {
            row.sort((a, b) => (a.axis === 'y' ? a.x - b.x : a.y - b.y));
            row.forEach((st, i) => {
                if (i % 6 !== 3) return;
                d.stalls.splice(d.stalls.indexOf(st), 1);
                for (const [x, y] of st.cells) { d.stallCells.delete(k2(x, y)); tag(m, x, y, 'green', { force: true }); s.set(x, y, st.z, MAT.lawn); }
                const treeAt = st.cells[Math.floor(st.cells.length / 2)];
                for (const [x, y] of st.cells) if (x !== treeAt[0] || y !== treeAt[1]) put(m, x, y, st.z + 1, 'planter', `geo:${l.id}/row-island`);
                plantTree(m, treeAt[0], treeAt[1], `geo:${l.id}/row-island-tree`);
                islands++;
            });
        }
        stalls -= islands;
        report.lots.push({ id: l.id, name: l.name || null, implied: !!l.implied, cells: l.cells.length, sections, stalls, islands });
    }

    // ------------------------------------------------------------------ buildings
    const roadDist = (x, y) => { let best = Infinity; for (const r of roads) if (r.cls >= 1) best = Math.min(best, distToPolyline([x + 0.5, y + 0.5], r.line) - r.half - r.cls * 1.5); return best; };
    const built = [], lotSet = new Set(lots.flatMap(l => l.cells.map(([x, y]) => k2(x, y))));
    for (const f of fps.slice().sort((a, b) => a.storeys - b.storeys || b.area - a.area)) {
        const res = buildFootprint(m, {
            id: f.id, osm: f.osm, name: f.name, program: f.def ? f.program : f.program, programDef: f.def || null, storeys: f.storeys, baseZ: plateaus.get(f.id), cells: f.cells, wall: f.wall || WALLS[f.program], floor: f.floor, roof: f.roof,
            frontScore: (side, cells) => {
                const [dx, dy] = { n: [0, -2], s: [0, 2], e: [2, 0], w: [-2, 0] }[side], ux = Math.sign(dx), uy = Math.sign(dy);
                // the map edge is never a front (the real one is beyond it, or it is the building's back)
                if (cells.filter(([x, y]) => x + ux * 3 < 1 || y + uy * 3 < 1 || x + ux * 3 >= W - 1 || y + uy * 3 >= D - 1).length > 0.3 * cells.length) return -1e9;
                // shops face their car park or its drive aisle (strip centres front the lot, not the boulevard behind it)
                // (share of the 24-cell band in front that is car park or drive aisle)
                const lotFace = ['shop', 'supermarket', 'diner'].includes(f.program) ? cells.reduce((a, [x, y]) => { let n = 0; for (let t = 2; t < 26; t++) { const q = k2(x + ux * t, y + uy * t); if (lotSet.has(q) || roadAt.get(q)?.road.cls === 0) n++; } return a + n / 24; }, 0) / cells.length : 0;
                const road = -Math.min(...cells.map(([x, y]) => roadDist(x + dx, y + dy)));
                // the longest run of car-park frontage is the shopfront (a big box fronts its lot along its long side)
                // a unit cut from a strip fronts along the strip (n/s when the strip runs along x), never at its end
                const unitEnd = f.unitAxis != null && (f.unitAxis === 0 ? (side === 'e' || side === 'w') : (side === 'n' || side === 's')) ? -1000 : 0;
                return (lotFace >= 0.3 ? 100 + 2 * lotFace * cells.length + 0.1 * road : road) + unitEnd;
            }
        }, { occupied, party });
        for (const rec of res.records) for (let y = rec.y0; y < rec.y0 + rec.d; y++) for (let x = rec.x0; x < rec.x0 + rec.w; x++) tag(m, x, y, 'building', { force: true });
        for (const [x, y] of res.mass) tag(m, x, y, 'building', { force: true });
        for (const [x, y] of res.fringe || []) if (!roadAt.has(k2(x, y))) tag(m, x, y, 'plaza', { force: true });
        const iou = footprintIoU(f.cells, res);
        // fidelity against the source polygon (centre-inside raster): how close the built outline is to the real one
        const fr = new Set((res.fringe || []).map(([x, y]) => k2(x, y))), builtSet = new Set(f.cells.map(([x, y]) => k2(x, y)).filter(k => !fr.has(k))), exactSet = new Set(f.exact.map(([x, y]) => k2(x, y)));
        let inter = 0; for (const k of builtSet) if (exactSet.has(k)) inter++;
        const polygonIoU = inter / (builtSet.size + exactSet.size - inter), roomShare = 1 - res.mass.length / builtSet.size;
        built.push({ f, res, iou });
        report.buildings.push({ id: f.id, osm: f.osm, name: f.name, program: f.program, storeys: f.storeys, observed: f.observed, baseZ: plateaus.get(f.id), cells: f.cells.length, wings: res.wings.length, massCells: res.mass.length, fringeCells: fr.size, wingDoors: res.doors.length, iou: +iou.toFixed(3), polygonIoU: +polygonIoU.toFixed(3), roomShare: +roomShare.toFixed(3), rooms: res.records.reduce((a, r) => a + r.rooms.length, 0) });
    }
    report.closedExits = closeDeadExits(m, m.buildings);
    // landmarks: the real building's style and height as voxel architecture over the playable storeys
    for (const { f, res } of built) if (f.info?.landmark || styleFamily(f.info)) {
        // OSM 3D parts: their rings through the same transform as the buildings (frame + rubber sheet), squared
        const osmParts = (f.info?.parts || []).map(p => { const ring = straighten === 'grid' ? orthogonalizeRing(p.ring.map(ptC), { tol: 0.6 }) : p.ring.map(ptC); return { ...p, cells: rasterPolygon(ring, W, D, { grow: 0.3 }) }; }).filter(p => p.cells.length);
        const dress = dressLandmark(m, { group: f.id, records: res.records, cells: f.cells, info: f.info, wall: f.wall || 'stone', osmParts });
        for (const r of res.records) r.landmark = dress.style || true;          // no rooftop plant on a landmark
        report.landmarks.push({ id: f.id, name: f.name, program: f.program, style: dress.style, wikidata: f.info?.tags?.wikidata || null, facts: f.info?.facts ? { style: f.info.facts.style, heritage: f.info.facts.heritage, inception: f.info.facts.inception, heightM: f.info.heightM } : null, parts: dress.parts.map(p => p.part), voxels: dress.voxels });
    }
    // building cells now stand on their plateau: the district's ground is the plateau, not the roof
    for (const { f } of built) for (const [x, y] of f.cells) setGround(m, x, y, plateaus.get(f.id));

    // ------------------------------------------------------------------ objective, insertion and line of play
    const objB = built.find(b => objectiveName && (b.f.name === objectiveName || b.f.osm === String(objectiveName) || b.f.id === objectiveName))?.f
        || built.map(b => b.f).sort((a, b) => b.storeys - a.storeys || b.area - a.area)[0];
    const oc = objB ? [objB.cells.reduce((a, c) => a + c[0], 0) / objB.cells.length, objB.cells.reduce((a, c) => a + c[1], 0) / objB.cells.length] : [W / 2, D / 2];
    // insertion: a street cell (main or cross) near the map edge, farthest from the objective, with room for six
    const standable = (x, y) => inMapC(x, y) && !occupied.has(k2(x, y)) && s.topSolid(x, y) === groundAt(m, x, y);
    const cand = [...roadAt.entries()].filter(([, v]) => v.road.cls >= 1 && (v.role === 'road' || v.role === 'sidewalk')).map(([k]) => k.split(',').map(Number))
        .filter(([x, y]) => (x <= 6 || y <= 6 || x >= W - 7 || y >= D - 7) && x >= 3 && y >= 3 && x < W - 3 && y < D - 3);
    cand.sort((a, b) => Math.hypot(b[0] - oc[0], b[1] - oc[1]) - Math.hypot(a[0] - oc[0], a[1] - oc[1]) || a[0] - b[0] || a[1] - b[1]);
    const ins = cand[0] || [3, Math.floor(D / 2)];
    const spawnCells = [];
    for (let r = 0; r < 6 && spawnCells.length < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = ins[0] + dx, y = ins[1] + dy;
        if (spawnCells.length < 6 && Math.max(Math.abs(dx), Math.abs(dy)) === r && standable(x, y) && !spawnCells.some(c => c.x === x && c.y === y)) spawnCells.push({ x, y, z: groundAt(m, x, y) });
    }
    for (const c of spawnCells) m.reserve(c.x - 1, c.y - 1, c.x + 1, c.y + 1);
    tag(m, ins[0], ins[1], 'insertion', { force: false });
    const spawn = spawnCells[0], target = { x: Math.round(oc[0]), y: Math.round(oc[1]) };

    // ------------------------------------------------------------------ fill the open land (no invented buildings)
    const remix = remixParameters({ buildingCount: m.buildings.length, terrain: 'flat', skybridges: false, elevated: false, traffic: 'normal', pedestrian: 'normal', parts: 'urban', merges: false, objective: 'eliminate', timeOfDay });
    remix.buildingCount = m.buildings.length;   // cap = 0 new buildings
    // spawn: null keeps fillDistrict's own cover repair (one full path search per piece) off this large map; the
    // batched geo pass below applies the same land-use pieces, then the stock repair finishes what is left.
    const fill = fillDistrict(m, { seed, remix, family: 'urban', roads: [], spawn: null, target });

    // ------------------------------------------------------------------ street dressing on the local ground (fillDistrict's street rules are axis-aligned)
    let stallCount = 0;
    for (const r of roads) if (r.cls >= 1 && r.half >= 3 && r.kerbParking) {
        // kerb parking: the lane just inside the kerb, both sides, every ~7 cells along straight-ish runs
        for (let i = 1; i < r.line.length; i++) {
            const [ax, ay] = r.line[i - 1], [bx, by] = r.line[i], L = Math.hypot(bx - ax, by - ay); if (L < 12) continue;
            const ux = (bx - ax) / L, uy = (by - ay) / L, axis = Math.abs(ux) >= Math.abs(uy) ? 'x' : 'y';
            for (let t = 6, n = 0; t + 6 < L; t += 7, n++) {
                const side = n % 2 ? 1 : -1, off = r.half - 1.5;
                const x = Math.floor(ax + ux * t - uy * off * side), y = Math.floor(ay + uy * t + ux * off * side);
                const cells = Array.from({ length: 4 }, (_, k) => axis === 'x' ? [[x + k, y], [x + k, y + 1]] : [[x, y + k], [x + 1, y + k]]).flat();
                const zs = new Set(cells.map(([cx, cy]) => groundAt(m, cx, cy)));
                if (zs.size > 1 || !cells.every(([cx, cy]) => roadAt.get(k2(cx, cy))?.role === 'road' && roadAt.get(k2(cx, cy)).road === r)) continue;
                if (spawn && Math.hypot(x - spawn.x, y - spawn.y) < 10) continue;
                if (addStall(m, { x: Math.min(...cells.map(c => c[0])), y: Math.min(...cells.map(c => c[1])), axis, length: 4, width: 2, kind: 'kerb', types: ['car'], priority: 0.4, z: [...zs][0], origin: `road:${r.id}/kerb` })) stallCount++;
            }
        }
    }
    // street trees on the outer sidewalk row, every ~11 cells
    let trees = 0;
    for (const r of roads) if (r.sidewalk) {
        let acc = 0;
        for (let i = 1; i < r.line.length; i++) {
            const [ax, ay] = r.line[i - 1], [bx, by] = r.line[i], L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
            for (let t = 0; t < L; t += 1) {
                if ((acc + t) % 11 >= 1) continue;
                for (const side of [-1, 1]) {
                    const off = r.half + 1 + r.sidewalk - 0.5, x = Math.floor(ax + ux * t - uy * off * side), y = Math.floor(ay + uy * t + ux * off * side);
                    if (roadAt.get(k2(x, y))?.role !== 'sidewalk' || m.keep.has(k2(x, y))) continue;
                    // the district's own street-tree rule: a tree pit is a verge cell inside the sidewalk
                    tag(m, x, y, 'verge', { force: true });
                    const ok = plantTree(m, x, y, `road:${r.id}/street-tree`);
                    tag(m, x, y, 'sidewalk', { force: true });
                    if (ok) trees++;
                }
            }
            acc += L;
        }
    }
    // vehicles for the kerb stalls added after the fill
    const kerbVehicles = placeKerbVehicles(m, seed);
    // road paint from the road graph (+ car-park stripes as thin lines) and the real-street props it implies
    const isRoadCell = (x, y) => roadAt.get(k2(x, y))?.role === 'road' && [MAT.asphalt, MAT.road_mark].includes(s.get(x, y, s.topSolid(x, y)));
    const paint = planGeoRoadPaint(roads, { isRoadCell, zAt: (x, y) => groundAt(m, x, y), crossings });
    // stripes are on the ground (a parked car may stand on one), so look at ground level, not the top solid
    const marked = []; for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (s.get(x, y, groundAt(m, x, y)) === MAT.road_mark) marked.push([x, y]);
    paint.quads.push(...lotStripesToPaint(s, marked, MAT, (x, y) => groundAt(m, x, y)));
    report.paint = { quads: paint.quads.length, junctions: paint.junctions.length, crossings: crossings.length };
    report.props = placeGeoProps(m, { roads, roadAt, junctions: paint.junctions, lots, seed, furniture: FURNITURE });
    report.junctions = paint.junctions;
    // lane direction per carriageway cell: stopped cars sit along their lane, never across it
    const axisAt = (x, y) => { const r = roadAt.get(k2(x, y)); if (!r) return null; let best = null; const L = r.road.line;
        for (let i = 1; i < L.length; i++) { const [ax, ay] = L[i - 1], [bx, by] = L[i], vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * vx + (y + 0.5 - ay) * vy) / l2)), dd = Math.hypot(ax + vx * t - x - 0.5, ay + vy * t - y - 0.5); if (!best || dd < best.d) best = { d: dd, axis: Math.abs(vx) >= Math.abs(vy) ? 'x' : 'y' }; }
        return best?.axis || null; };
    // coverRepair: false leaves open land as the real place has it (a plain map, not a tactics battlefield)
    report.cover = coverRepair ? batchCoverRepair(m, spawn, { axisAt }) : null;

    // ------------------------------------------------------------------ enemies, objective, finish
    const far = m.buildings.filter(b => b.rooms.length && b.wing === 0).sort((a, b) => Math.hypot(b.x0 - spawn.x, b.y0 - spawn.y) - Math.hypot(a.x0 - spawn.x, a.y0 - spawn.y));
    const objRec = m.buildings.find(b => b.group === objB?.id && b.wing === 0);
    if (objRec) { far.splice(far.indexOf(objRec), 1); far.unshift(objRec); }
    const street = (() => { const c = [...roadAt.entries()].filter(([, v]) => v.role === 'road').map(([k]) => k.split(',').map(Number)).sort((a, b) => Math.hypot(a[0] - oc[0], a[1] - oc[1]) - Math.hypot(b[0] - oc[0], b[1] - oc[1]))[0]; return c ? { x: c[0], y: c[1], z: groundAt(m, c[0], c[1]) } : null; })();
    const enemy = districtPods(far, { fallback: [street, street].filter(Boolean), street });
    const objective = { kind: 'eliminate', text: objB ? `Clear the Syndicate out of ${objB.name || 'the block'} and the buildings around it.` : 'Clear the block.' };
    const lamps = [];
    for (const r of roads) if (r.cls >= 1) {
        let acc = 0;
        for (let i = 1; i < r.line.length; i++) {
            const [ax, ay] = r.line[i - 1], [bx, by] = r.line[i], L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
            for (let t = 0; t < L; t++) {
                if ((acc + t) % 14 >= 1) continue;
                const side = Math.floor((acc + t) / 14) % 2 ? 1 : -1, off = r.half + 1.5;
                const x = Math.floor(ax + ux * t - uy * off * side), y = Math.floor(ay + uy * t + ux * off * side);
                if (roadAt.get(k2(x, y))?.role !== 'sidewalk' || s.topSolid(x, y) !== groundAt(m, x, y)) continue;
                lamps.push({ kind: 'streetlight', x, y, z: groundAt(m, x, y) + 1, yaw: Math.atan2(uy * side, -ux * side), planned: true, route: r.id });
            }
            acc += L;
        }
    }
    m.lightRoutes = [];
    const result = m.finish({ name, spawns: { player: spawnCells, enemy }, objective, meta: {
        generatorVersion: GEO_GENERATOR_VERSION, theme: 'Geo import', lighting: timeOfDay, timeOfDay, remix,
        geo: { source: geo.source, crs: geo.crs, origin: geo.origin, extent: geo.extent, rotationDeg: +(F.theta * 180 / Math.PI).toFixed(2), metresPerCell: F.cell, dem: report.terrain },
        report, streetObjects: fill.streetObjects, cutLevels: [4, 7, 10, 13, Infinity], defaultCut: Math.max(...hf.z) + 3,
        designDecisions: ['Real terrain (DEM), streets and building outlines are pinned; the district generator only fills the land the source leaves open.',
            'Outlines are cut into wings at their reflex corners; every wing is planned by the shared interior system and wings join through doorways.',
            'No building is invented: the parcel fill runs with a building cap of zero.']
    } });
    result.visual.decor.push(...lamps);
    result.visual.roadPaint = { version: 1, quads: paint.quads };
    report.streets = { kerbStalls: stallCount, trees, lamps: lamps.length, kerbVehicles };
    report.fill = { blocks: fill.blocks, leaves: fill.leaves.length, assigned: fill.leaves.filter(l => l.mix).length };
    // audit (tools, tests): district gates + reachability of every building from the insertion. The game skips it on
    // load — the same seeds were audited when the export was installed — because the path searches dominate the build.
    let gates = null;
    result.meta.landUse = landUseSnapshot(m);
    if (audit) {
        gates = finishDistrict(result, m, fill, { enforce: enforceGates });
        const search = reachable(result.store, spawnCells[0], Infinity, AGENT_PROFILES.player);
        report.reach = m.buildings.map(b => ({ id: b.id, entered: b.rooms.some(r => r.cells.some(([x, y]) => search.costs.has(nodeKey({ x, y, z: r.floorZ })))) }));
    }
    result.meta.geoReport = report;
    // for tools, never serialised: the export-metres → cell transform and the street centrelines with their names
    Object.defineProperties(report, { project: { value: ptC }, toWorld: { value: F.toWorld }, streets: { value: roads.map(r => ({ name: r.name, kind: r.kind, line: r.line, half: r.half, oneway: r.oneway, maxspeed: r.maxspeed })) } });
    result.meta.geoGates = gates;
    return result;
}

const len2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const roadLength = r => r._len ??= r.line.slice(1).reduce((s, p, i) => s + len2(r.line[i], p), 0);

/** L∞ distance from p to a polyline of axis-aligned segments: square caps and corners on a grid. */
function distBox(p, line) {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i];
        const dx = Math.max(Math.min(ax, bx) - p[0], 0, p[0] - Math.max(ax, bx)), dy = Math.max(Math.min(ay, by) - p[1], 0, p[1] - Math.max(ay, by));
        best = Math.min(best, Math.max(dx, dy));
    }
    return best;
}

/**
 * Cut one footprint into tenant units along its long axis, a cut halfway between consecutive tenants. Each unit keeps
 * the building's outline cells on its side and gets the tenant's name and use. null when a unit would be too narrow.
 */
function splitUnits(fp, units) {
    const xs = fp.cells.map(c => c[0]), ys = fp.cells.map(c => c[1]), ax = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? 0 : 1;
    const sorted = units.filter(u => u.at).sort((a, b) => a.at[ax] - b.at[ax]);
    if (sorted.length < 2) return null;
    const cuts = sorted.slice(1).map((u, i) => Math.round((sorted[i].at[ax] + u.at[ax]) / 2));
    const out = sorted.map((u, i) => {
        const a = i ? cuts[i - 1] : -Infinity, b = i < cuts.length ? cuts[i] : Infinity, inUnit = c => c[ax] >= a && c[ax] < b;
        const cells = fp.cells.filter(inUnit), name = u.name || `${fp.name || fp.id} unit ${i + 1}`;
        return { ...fp, id: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40), name, program: u.use?.program || fp.program, def: u.use?.def || null,
            wall: fp.wall, cells, area: cells.length, exact: fp.exact.filter(inUnit), unitOf: fp.osm, unitAxis: ax, info: { ...fp.info, units: [], landmark: false, use: u.use, tenants: [u] } };
    });
    const span = c => { const v = c.cells.map(q => q[ax]); return v.length ? Math.max(...v) - Math.min(...v) + 1 : 0; };
    return out.every(u => span(u) >= 7 && u.cells.length >= 40) ? out : null;
}

/** A highway's role in the map, or null: { cls (0 service … 4 motorway), half (half width in cells), link (slip lane) }.
 *  Turn lanes / slip roads (*_link): one or two lanes, no sidewalk of their own, a class below their parent. */
function roadSpec(t, cell) {
    const link = /_link$/.test(t.highway || '') && t.highway.replace(/_link$/, '') in ROAD_CLASS;
    if (!(t.highway in ROAD_CLASS || link) || t.tunnel || t.area === 'yes') return null;
    const cls = link ? Math.max(1, ROAD_CLASS[t.highway.replace(/_link$/, '')] - 1) : ROAD_CLASS[t.highway];
    const half = link ? ((parseInt(t.lanes, 10) || 1) * 3.4 + 1) / cell / 2 : roadWidthMetres(t) / cell / 2;
    return { cls, half, link };
}

/** Fill the kerb stalls added after fillDistrict with parked cars (same noise model as the district fill). */
function placeKerbVehicles(m, seed) {
    const free = m.district.stalls.filter(st => st.kind === 'kerb' && !st.filled);
    let n = 0;
    free.forEach((st, i) => {
        if ((i * 7 + seed) % 5 > 1) return;   // ~40 % occupancy, deterministic
        const ok = m.car ? true : false;
        if (!ok) return;
        const [x, y] = [st.x, st.y];
        const before = Object.keys(m.hints).length;
        m.car(x, y, st.axis, i % 2 ? 1 : -1, null, st.z);
        if (Object.keys(m.hints).length > before) { st.filled = true; n++; for (const [cx, cy] of st.cells) for (let z = st.z + 1; z <= st.z + 2; z++) if (m.store.isSolid(cx, cy, z)) m.district.origins.set(`${cx},${cy},${z}`, `vehicle:${st.origin}`); }
    });
    return n;
}

/**
 * PLAN-06 cover repair, batched for large real maps: one path search, then a piece at every worst gap that is not
 * within 4 cells of a piece already placed this pass (the stock rule's land-use pieces, via tryPiece), then the stock
 * repairCover with a small budget for whatever gap is left.
 */
function batchCoverRepair(m, spawn, { maxGap = 6, rounds = 8, axisAt = () => null, minShare = 0.215 } = {}) {
    const s = m.store, key = n => `${n.x},${n.y},${n.z}`, placed = [];
    // round 0..rounds-1: the gap rule; then the share rule (MissionMetrics.outdoorCover ≥ 0.2, aimed at minShare for
    // margin across seeds): the same pieces at the most open uncovered tiles until enough outdoor tiles are in cover
    for (let round = 0, shareRounds = 0; round < rounds + 6; round++) {
        const search = reachable(s, spawn, Infinity, AGENT_PROFILES.player);
        const nodes = [...search.nodes.values()].filter(n => s.roomAt(n.x, n.y, n.z + 1) < 0 && m.district.contains(n.x, n.y));
        const map = new Map(nodes.map(n => [key(n), n])), d = new Map(), q = [];
        for (const n of nodes) { const c = coverAt(s, n.x, n.y, n.z); if (Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF) { d.set(key(n), 0); q.push(n); } }
        for (let i = 0; i < q.length; i++) { const n = q[i], v = d.get(key(n)); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dz of [0, 1, -1]) { const k = `${n.x + dx},${n.y + dy},${n.z + dz}`, o = map.get(k); if (o && !d.has(k)) { d.set(k, v + 1); q.push(o); } } }
        let far = nodes.map(n => ({ n, d: d.get(key(n)) ?? 99 })).filter(e => e.d > maxGap).sort((a, b) => b.d - a.d || a.n.x - b.n.x || a.n.y - b.n.y);
        let budget = Infinity;
        if (!far.length) {
            // gap closed: the outdoor share (all reachable outdoor tiles, as MissionMetrics counts them)
            const all = [...search.nodes.values()].filter(n => s.roomAt(n.x, n.y, n.z + 1) < 0), share = d.size ? [...all].filter(n => d.get(key(n)) === 0).length / all.length : 0;
            if (share >= minShare || ++shareRounds > 6) break;
            budget = Math.ceil((minShare - share) * all.length / 9);
            far = nodes.map(n => ({ n, d: d.get(key(n)) ?? 99 })).filter(e => e.d >= 3).sort((a, b) => b.d - a.d || a.n.x - b.n.x || a.n.y - b.n.y);
        } else if (round >= rounds) break;
        let added = 0;
        const thisRound = [];
        for (const { n } of far) {
            if (added >= budget) break;
            if (thisRound.some(p => Math.abs(p.x - n.x) <= 6 && Math.abs(p.y - n.y) <= 6)) continue;
            const cand = [];
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx || dy) cand.push([n.x + dx, n.y + dy, Math.max(Math.abs(dx), Math.abs(dy))]);
            cand.sort((a, b) => (m.district.tags[a[0] + a[1] * m.district.W] === 'road') - (m.district.tags[b[0] + b[1] * m.district.W] === 'road') || a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
            // on a carriageway: stopped traffic (an intact car in the lane) first; elsewhere the stock land-use piece
            // (vehicles off: the stock road piece is a wreck, which a real street does not have)
            // in a car park: a cart corral (the stock aisle piece is a bare concrete block, which a real lot does not have)
            const nt = m.district.tags[n.x + n.y * m.district.W];
            // on lawns a tree (real grounds are planted, not walled); in a car park a cart corral
            let done = nt === 'road' ? stalledCar(m, n, axisAt(n.x, n.y)) : nt === 'aisle' || nt === 'stall' ? cartCorral(m, n) : ['green', 'park', 'yard'].includes(nt) ? groundTree(m, n) : null;
            if (!done) for (const [cx, cy] of cand) { if (['aisle', 'stall'].includes(m.district.tags[cx + cy * m.district.W])) continue; done = tryPiece(m, cx, cy, n, false); if (done) break; }
            if (done) { thisRound.push(done); added++; }
        }
        placed.push(...thisRound);
        if (!added) break;
    }
    const finish = repairCover(m, { spawn, maxGap, budget: 12, traffic: 'none' });   // 'none': no wrecks from the stock road piece
    m.district.repairs = [...placed, ...finish];
    return { batched: placed.length, finished: finish.length };
}

/** A tree on lawn near node n (≤ 3 cells), never on a kept approach or right against another solid. */
function groundTree(m, n) {
    const s = m.store, d = m.district;
    for (let r = 1; r <= 3; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = n.x + dx, y = n.y + dy;
        if (x < 1 || y < 1 || x >= d.W - 1 || y >= d.D - 1 || !['green', 'park', 'yard'].includes(d.tags[x + y * d.W]) || m.keep.has(k2(x, y))) continue;
        const z = groundAt(m, x, y);
        if (s.topSolid(x, y) !== z || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => s.isSolid(x + a, y + b, z + 1))) continue;
        if (plantTree(m, x, y, 'repair:green/tree')) return { x: n.x, y: n.y, piece: 'tree', tag: 'green' };
    }
    return null;
}

/** A cart corral (3 pipe-rail voxels) on car-park aisle near node n, never sealing a lane (both sides stay aisle). */
function cartCorral(m, n) {
    const s = m.store, d = m.district, isAisle = (x, y) => x >= 1 && y >= 1 && x < d.W - 1 && y < d.D - 1 && d.tags[x + y * d.W] === 'aisle';
    for (let r = 0; r <= 3; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const [ax, ay] of [[1, 0], [0, 1]]) {
            const cells = [0, 1, 2].map(j => [n.x + dx + ax * j, n.y + dy + ay * j]);
            const z = groundAt(m, cells[0][0], cells[0][1]);
            if (!cells.every(([x, y]) => isAisle(x, y) && groundAt(m, x, y) === z && s.topSolid(x, y) === z && !s.isSolid(x, y, z + 1) && !d.stallCells.has(k2(x, y)) && !m.keep.has(k2(x, y))
                && isAisle(x + ay, y + ax) && isAisle(x - ay, y - ax) && !s.isSolid(x + ay, y + ax, z + 1) && !s.isSolid(x - ay, y - ax, z + 1))) continue;
            // the cells beyond both ends stay open too (a corral is walked around)
            if ([[cells[0][0] - ax, cells[0][1] - ay], [cells[2][0] + ax, cells[2][1] + ay]].some(([x, y]) => s.isSolid(x, y, z + 1))) continue;
            const vox = [];
            for (const [x, y] of cells) { put(m, x, y, z + 1, 'railing', 'repair:aisle/cart-corral'); vox.push([x, y, z + 1]); }
            m.object('cart_corral', vox, { axis: ax ? 'x' : 'y', dir: 1, size: [3, 1] });
            return { x: n.x, y: n.y, piece: 'cart_corral', tag: 'aisle' };
        }
    }
    return null;
}

/** PLAN-06's road repair piece (an abandoned car in a salvage slot) placed on the carriageway at a cover gap. */
function stalledCar(m, n, along = null) {
    const s = m.store, d = m.district;
    for (const axis of along ? [along] : ['x', 'y']) for (let o = -3; o <= 0; o++) for (let w = -1; w <= 0; w++) {
        const x0 = axis === 'x' ? n.x + o : n.x + w, y0 = axis === 'x' ? n.y + w : n.y + o;
        const cells = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cells.push(axis === 'x' ? [x0 + i, y0 + j] : [x0 + j, y0 + i]);
        if (!cells.every(([x, y]) => x >= 0 && y >= 0 && x < d.W && y < d.D && d.tags[x + y * d.W] === 'road' && groundAt(m, x, y) === n.z && s.topSolid(x, y) === n.z && !d.stallCells.has(k2(x, y)) && !m.keep.has(k2(x, y)))) continue;
        const st = addStall(m, { x: x0, y: y0, axis, length: 4, kind: 'salvage', types: ['car'], priority: 1, z: n.z, origin: 'repair:road/stalled-car' });
        if (!st) continue;
        // stopped traffic in the lane (an intact car in a traffic tint), not a burnt-out wreck
        const v = placeStreetVehicle(m, 'car', st.x, st.y, { axis, z: n.z });
        if (!v) continue;
        const vc = []; for (const [x, y] of cells) for (let z = n.z + 1; z <= n.z + 3; z++) if (s.isSolid(x, y, z)) vc.push([x, y, z]);
        registerCells(m, vc, 'vehicle:repair');
        d.vehicles.push({ ...v, kind: 'salvage', origin: 'repair:road' });
        return { x: n.x, y: n.y, piece: 'car', tag: 'road' };
    }
    return null;
}
