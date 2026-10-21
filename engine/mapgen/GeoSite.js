// Geo import (experiment) — a BlenderGIS scene export (OSM footprints + highways + parking + SRTM samples, in metres
// around a projected origin) becomes a recorded site read: the same contract a picture read produces (frame, buildings,
// roads, parking, insertion, flow, parcelPlan). Everything after that is the existing v3 pipeline: plotFromSite pins the
// real buildings and roads, the lot WFC fills the gaps with parcels, and the interior/facade/furnish solvers build the
// insides. Pure and deterministic: the same export always gives the same site.
/** One kit cell (KitMetric.CELL) is ≈ 0.9 m: the real block is played at 1:1. */
export const METRES_PER_CELL = 0.9;
const M = METRES_PER_CELL;

const MIN_CELLS = 11;                      // SiteSolver's minimum floor dimension
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const r4 = n => Math.round(n * 1e4) / 1e4;
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Shoelace area of a ring of [x, y] metres. */
export function ringArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; }
    return Math.abs(a) / 2;
}
const bbox = ring => ({ x0: Math.min(...ring.map(p => p[0])), y0: Math.min(...ring.map(p => p[1])), x1: Math.max(...ring.map(p => p[0])), y1: Math.max(...ring.map(p => p[1])) });
const area = r => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const intersect = (a, b) => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const gap = (a, b) => Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);   // < 0 overlap, ~0 touching
const sharedEdge = (a, b) => Math.max(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Liang–Barsky: the parts of a polyline inside a rectangle. */
export function clipPolyline(line, box) {
    const out = []; let cur = [];
    const flush = () => { if (cur.length >= 2) out.push(cur); cur = []; };
    for (let i = 0; i + 1 < line.length; i++) {
        const [x0, y0] = line[i], [x1, y1] = line[i + 1], dx = x1 - x0, dy = y1 - y0;
        let t0 = 0, t1 = 1, ok = true;
        for (const [p, q] of [[-dx, x0 - box.x0], [dx, box.x1 - x0], [-dy, y0 - box.y0], [dy, box.y1 - y0]]) {
            if (p === 0) { if (q < 0) ok = false; continue; }
            const t = q / p;
            if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
        }
        if (!ok || t0 > t1) { flush(); continue; }
        const a = [x0 + t0 * dx, y0 + t0 * dy], b = [x0 + t1 * dx, y0 + t1 * dy];
        if (!cur.length || Math.hypot(cur[cur.length - 1][0] - a[0], cur[cur.length - 1][1] - a[1]) > 1e-6) { flush(); cur.push(a); }
        cur.push(b);
        if (t1 < 1) flush();
    }
    flush();
    return out;
}
const polyLength = l => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);
function distToPolyline(p, line) {
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
        const t = clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / L, 0, 1);
        best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
    return best;
}

// ------------------------------------------------------------------------------------------------ OSM → kit
const ROAD_CLASS = { motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2, unclassified: 2, residential: 1, living_street: 1, service: 0 };
const ROLE = c => c >= 3 ? 'arterial' : c >= 1 ? 'collector' : 'service';
/** Carriageway width in metres: OSM lanes plus kerb parking, a lane minimum of two for through streets. */
export function roadWidthMetres(tags) {
    if (tags.width && Number.isFinite(parseFloat(tags.width))) return parseFloat(tags.width);
    const cls = ROAD_CLASS[tags.highway] ?? 1, lanes = parseInt(tags.lanes, 10) || (cls >= 1 ? 2 : 1);
    return cls === 0 ? 3.6 : Math.max(2, lanes) * 3.3 + 2;
}
/** Played storeys (1–4, the kit cap) from OSM levels / height; downtown default two. */
export function storeysFromTags(tags, fallback = 2) {
    const lv = parseFloat(tags['building:levels']), h = parseFloat(tags.height);
    const observed = Number.isFinite(lv) ? Math.round(lv) : Number.isFinite(h) ? Math.round(h / 3.5) : null;
    return { observed, storeys: clamp(observed ?? fallback, 1, 4) };
}
/** Game programme for an OSM building: explicit tags first, then names, then size + frontage. */
export function programFor(tags, areaM2) {
    const name = `${tags.name || ''} ${tags.brand || ''}`.toLowerCase(), b = tags.building;
    if (/restaurant|cafe|fast_food|bar|pub/.test(tags.amenity || '') || /diner|cafe|grill|restaurant/.test(name)) return 'diner';
    if (tags.shop || b === 'retail' || /store|shop|market|hardware|pharmacy/.test(name)) return 'shop';
    if (['warehouse', 'industrial', 'storage_tank'].includes(b) || /warehouse|depot|press/.test(name)) return areaM2 > 600 ? 'warehouse' : 'office';
    if (['garage', 'garages', 'carport', 'shed'].includes(b)) return 'garage';
    if (['house', 'detached', 'residential', 'semidetached_house', 'terrace', 'apartments'].includes(b)) return 'house';
    if (['school', 'office', 'commercial', 'hotel', 'civic', 'government', 'public'].includes(b) || tags.tourism || /academy|school|hotel|courtyard|bank|building/.test(name)) return 'office';
    return areaM2 < 450 ? 'shop' : areaM2 > 1800 ? 'warehouse' : 'office';
}
const PARCEL_PROGRAMS = { small: ['shop', 'garage'], medium: ['shop', 'garage', 'diner', 'office'], large: ['shop', 'warehouse'] };
function parcelSize(program, areaM2) {
    const want = areaM2 < 300 ? 'small' : areaM2 < 1100 ? 'medium' : 'large';
    return PARCEL_PROGRAMS[want].includes(program) ? want : PARCEL_PROGRAMS.medium.includes(program) ? 'medium' : 'large';
}

/**
 * Convert a BlenderGIS export to a site. opts:
 *   id, name, theme ('Downtown'), timeOfDay, objective ('recover'|…), objectiveName (OSM name or osm id),
 *   maxDimension (64–192), minInside (fraction of a footprint that must lie on the map to keep it)
 * Returns { site, report } — the report lists every merge, clip, drop and clamp so nothing changes silently.
 */
export function geoExportToSite(geo, opts = {}) {
    const { id = 'geo-site', name = 'Geo Site', theme = 'Downtown', timeOfDay = 'dusk', objective = 'recover', objectiveName = null,
        maxDimension = 192, minInside = 0.4, storeyFallback = 2 } = opts;
    const E = geo.extent, ext = { x0: E.x0, y0: E.y0, x1: E.x1, y1: E.y1 }, Wm = ext.x1 - ext.x0, Hm = ext.y1 - ext.y0;
    const report = { merged: [], clipped: [], dropped: [], storeys: [], roads: [], terrain: null };
    // frame in kit cells (≈ 0.9 m) so SiteSolver's uniform scale stays ≈ 1: the real block is the played block.
    const frame = { width: r4(Wm / M), height: r4(Hm / M) };
    const uv = ([x, y]) => [r4(clamp((x - ext.x0) / Wm, 0, 1)), r4(clamp((ext.y1 - y) / Hm, 0, 1))];   // north up → v = 0
    const bounds = r => { const [u0, v1] = uv([r.x0, r.y0]), [u1, v0] = uv([r.x1, r.y1]); return [u0, v0, u1, v1]; };

    // --- roads (clipped centrelines); building passages and footways are left to the generator's sidewalks
    const roadLines = [];
    for (const h of geo.highways || []) {
        const t = h.tags || {};
        if (!(t.highway in ROAD_CLASS) || t.tunnel || t.area === 'yes') continue;
        for (const piece of clipPolyline(h.line, ext)) {
            if (polyLength(piece) < 12) continue;
            const cls = ROAD_CLASS[t.highway], widthM = roadWidthMetres(t);
            roadLines.push({ id: `${slug(t.name || 'road')}-${h.osm}-${roadLines.length}`, cls, role: ROLE(cls), widthM, line: piece, name: t.name || null, osm: h.osm });
        }
    }
    // --- buildings: AABB footprints clipped to the map, merged where row buildings are too shallow to stand alone
    const inset = { x0: ext.x0 + 2 * M, y0: ext.y0 + 2 * M, x1: ext.x1 - 2 * M, y1: ext.y1 - 2 * M };
    let parts = [];
    for (const b of geo.buildings || []) {
        if (!b.ring || b.ring.length < 3) { report.dropped.push({ osm: b.osm, reason: 'no footprint ring' }); continue; }
        const box = bbox(b.ring), a = ringArea(b.ring), clip = intersect(box, inset), inside = area(clip) / area(box);
        if (inside < minInside) { report.dropped.push({ osm: b.osm, name: b.tags?.name || null, reason: `outside map (${Math.round(inside * 100)}% inside)` }); continue; }
        if (inside < 0.999) report.clipped.push({ osm: b.osm, inside: r4(inside) });
        parts.push({ members: [b], box: clip, area: a * inside, fill: a / area(box) });
    }
    // Shallow (< 11 cells) row buildings join the neighbour they share the longest wall with — one connected parcel
    // whose interior is solved as a single building, like XCOM's merged-wall buildings.
    const small = p => (p.box.x1 - p.box.x0) / M < MIN_CELLS || (p.box.y1 - p.box.y0) / M < MIN_CELLS;
    for (let guard = 0; guard < 64; guard++) {
        const p = parts.find(small); if (!p) break;
        const cands = parts.filter(q => q !== p && gap(p.box, q.box) < 1.6).sort((a, b) => sharedEdge(p.box, b.box) - sharedEdge(p.box, a.box));
        if (!cands.length) break;
        const q = cands[0];
        report.merged.push({ into: q.members.map(m => m.osm), add: p.members.map(m => m.osm) });
        q.members.push(...p.members); q.box = union(q.box, p.box); q.area += p.area; q.fill = q.area / area(q.box);
        parts = parts.filter(x => x !== p);
    }
    // Overlapping AABBs (an L-shaped footprint's box over a neighbour) also merge: the solver may not trim them apart.
    for (let changed = true, guard = 0; changed && guard < 64; guard++) {
        changed = false;
        outer: for (const p of parts) for (const q of parts) {
            if (p === q || gap(p.box, q.box) >= -1.5 * M) continue;
            const ov = area(intersect(p.box, q.box)), minA = Math.min(area(p.box), area(q.box));
            if (ov / minA < 0.12) continue;
            report.merged.push({ into: p.members.map(m => m.osm), add: q.members.map(m => m.osm), reason: 'overlapping footprint boxes' });
            p.members.push(...q.members); p.box = union(p.box, q.box); p.area += q.area; p.fill = p.area / area(p.box);
            parts = parts.filter(x => x !== q); changed = true; break outer;
        }
    }
    const nearestRoad = pt => roadLines.map(r => ({ r, d: distToPolyline(pt, r.line) - r.widthM / 2 - r.cls * 1.5 })).sort((a, b) => a.d - b.d)[0]?.r;
    const buildings = [], used = new Set();
    for (const p of parts.sort((a, b) => (b.box.y1 - a.box.y1) || (a.box.x0 - b.box.x0))) {
        const lead = p.members.slice().sort((a, b) => (!!b.tags?.name - !!a.tags?.name) || ringArea(b.ring) - ringArea(a.ring))[0], tags = lead.tags || {};
        let bid = slug(tags.name || `osm-${lead.osm}`); while (used.has(bid)) bid += '-b'; used.add(bid);
        const st = p.members.map(m => storeysFromTags(m.tags || {}, storeyFallback)), storeys = Math.max(...st.map(s => s.storeys));
        const observed = Math.max(...st.map(s => s.observed ?? 0)) || null;
        if (observed && observed !== storeys) report.storeys.push({ id: bid, observed, played: storeys });
        const program = programFor(tags, p.area);
        // front: the facade closest to a street, weighted towards the bigger street
        const mid = { n: [(p.box.x0 + p.box.x1) / 2, p.box.y1], s: [(p.box.x0 + p.box.x1) / 2, p.box.y0], w: [p.box.x0, (p.box.y0 + p.box.y1) / 2], e: [p.box.x1, (p.box.y0 + p.box.y1) / 2] };
        const front = Object.entries(mid).map(([side, pt]) => ({ side, d: Math.min(...roadLines.filter(r => r.cls > 0).map(r => distToPolyline(pt, r.line) - r.cls * 2), 1e9) })).sort((a, b) => a.d - b.d)[0].side;
        buildings.push({ id: bid, bounds: bounds(p.box), storeys, program, front, observedStoreys: observed,
            source: { osm: p.members.map(m => m.osm), names: p.members.map(m => m.tags?.name).filter(Boolean), footprintFill: r4(p.fill), areaM2: Math.round(p.area) } });
    }
    // --- parking + surfaces
    const parking = [], surfaces = [{ bounds: [0, 0, 1, 1], material: theme === 'Suburbs' ? 'lawn' : 'concrete' }];
    for (const a of geo.areas || []) {
        const t = a.tags || {}, box = intersect(bbox(a.ring), ext);
        if (area(box) < 80) continue;
        if (t.amenity === 'parking') {
            // keep parking off building footprints: shrink to the free part nearest its centroid
            let pb = box;
            for (const b of parts) { const ov = intersect(pb, b.box); if (area(ov) > 0) {
                const opts2 = [{ ...pb, x0: b.box.x1 }, { ...pb, x1: b.box.x0 }, { ...pb, y0: b.box.y1 }, { ...pb, y1: b.box.y0 }].filter(r => r.x1 > r.x0 && r.y1 > r.y0);
                pb = opts2.sort((x, y) => area(y) - area(x))[0] || pb; } }
            if (area(pb) >= 120) parking.push({ id: `parking-${a.osm}`, bounds: bounds(pb), axis: (pb.x1 - pb.x0) >= (pb.y1 - pb.y0) ? 'x' : 'y' });
        } else if (['grass', 'park', 'recreation_ground', 'garden'].includes(t.landuse || t.leisure)) surfaces.push({ bounds: bounds(box), material: 'lawn' });
    }
    const roads = roadLines.map(r => ({ id: r.id, role: r.role, width: r4(clamp(r.widthM / M, 3, 14)), points: r.line.map(uv), name: r.name }));
    for (const r of roadLines) report.roads.push({ id: r.id, name: r.name, widthM: r.widthM, lengthM: Math.round(polyLength(r.line)) });

    // --- objective, insertion and flow (the line of play): insertion on a street far from the objective, waypoints
    // threaded through open ground (never inside a footprint)
    const objectiveB = buildings.find(b => objectiveName && (b.source.names.includes(objectiveName) || b.source.osm.includes(String(objectiveName)) || b.id === slug(objectiveName)))
        || buildings.slice().sort((a, b) => b.storeys - a.storeys || b.source.areaM2 - a.source.areaM2)[0];
    // LevelDesigner's offline policy: one landmark keeps its observed height, fillers play at most two floors. Apply it
    // here (the objective is the landmark) so the recorded site and the offline design agree; every cap is reported.
    for (const b of buildings) if (b !== objectiveB && b.storeys > 2) { report.storeys.push({ id: b.id, observed: b.observedStoreys, played: 2, reason: 'filler height (LevelDesigner policy)' }); b.storeys = 2; }
    const inB = ([u, v], pad = 0.012) => buildings.some(b => u > b.bounds[0] - pad && u < b.bounds[2] + pad && v > b.bounds[1] - pad && v < b.bounds[3] + pad);
    const oc = [(objectiveB.bounds[0] + objectiveB.bounds[2]) / 2, (objectiveB.bounds[1] + objectiveB.bounds[3]) / 2];
    const streets = roads.some(r => r.role !== 'service') ? roads.filter(r => r.role !== 'service') : roads;   // insert from a real street
    const roadPts = streets.flatMap(r => r.points.flatMap((p, i) => i ? Array.from({ length: 8 }, (_, k) => [r.points[i - 1][0] + (p[0] - r.points[i - 1][0]) * k / 8, r.points[i - 1][1] + (p[1] - r.points[i - 1][1]) * k / 8]) : []))
        .filter(([u, v]) => u >= 0.1 && u <= 0.9 && v >= 0.1 && v <= 0.9 && !inB([u, v]));
    const insertion = roadPts.sort((a, b) => Math.hypot(b[0] - oc[0], b[1] - oc[1]) - Math.hypot(a[0] - oc[0], a[1] - oc[1]))[0] || [0.5, 0.9];
    const apron = { n: [oc[0], objectiveB.bounds[1] - 0.03], s: [oc[0], objectiveB.bounds[3] + 0.03], w: [objectiveB.bounds[0] - 0.03, oc[1]], e: [objectiveB.bounds[2] + 0.03, oc[1]] }[objectiveB.front];
    const free = (p) => {
        if (!inB(p)) return p;
        for (let r = 0.01; r < 0.3; r += 0.01) for (let a = 0; a < 16; a++) { const q = [p[0] + r * Math.cos(a * Math.PI / 8), p[1] + r * Math.sin(a * Math.PI / 8)]; if (q.every(n => n > 0.04 && n < 0.96) && !inB(q)) return q; }
        return p;
    };
    const lerp = t => [insertion[0] + (apron[0] - insertion[0]) * t, insertion[1] + (apron[1] - insertion[1]) * t];
    const flow = [lerp(1 / 3), lerp(2 / 3), apron].map(free).map(p => p.map(n => r4(clamp(n, 0.05, 0.95))));

    // --- terrain: SRTM is a surface model downtown (towers bleed in), so ground = local minimum, relief recorded only
    if (geo.dem?.z?.length) {
        const z = geo.dem.z, H = z.length, Wd = z[0].length, ground = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
            let m = Infinity; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = z[y + dy]?.[x + dx]; if (Number.isFinite(v)) m = Math.min(m, v); }
            if (Number.isFinite(m)) ground.push(m);
        }
        ground.sort((a, b) => a - b);
        const q = f => ground[Math.floor((ground.length - 1) * f)], relief = q(0.9) - q(0.1);
        report.terrain = { groundM: r4(q(0.5)), reliefM: r4(relief), storeysOfRelief: r4(relief / (3 * M)), surfaceMaxM: Math.max(...z.flat().filter(Number.isFinite)) };
    }
    const lead = objectiveB.source.names[0] || objectiveB.id;
    const site = {
        version: 2, id, name, theme, timeOfDay, frame, maxDimension, source: 'blender-export.json',
        geo: { crs: geo.crs, origin: geo.origin, extent: geo.extent, metresPerCell: M, source: geo.source, terrain: report.terrain },
        objective, objectiveBuilding: objectiveB.id,
        buildings, surfaces, roads, parking,
        // XCOM-style parcel slots (ParcelFormula): only when every programme has a game parcel (houses have none yet)
        parcelPlan: buildings.some(b => b.program === 'house') ? undefined : { plotType: 'SmallTown', source: 'geo-import', slots: buildings.map(b => ({ id: b.id, size: parcelSize(b.program, b.source.areaM2), zone: b.program === 'office' || b.program === 'house' ? 'Neighborhood' : 'Retail', entrances: ['street', 'service'], ...(b === objectiveB ? { objectiveTag: 'Recover' } : {}) })) },
        insertion: insertion.map(n => r4(clamp(n, 0.07, 0.93))), flow,
        storyHooks: [`Recover the records held inside the ${lead} before the cell moves them out.`],
        style: 'Present-day downtown Baton Rouge: historic brick storefronts, surface parking and wide one-way streets, rebuilt 1:1 from OpenStreetMap.',
    };
    return { site, report };
}
