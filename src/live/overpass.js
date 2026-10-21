// One Overpass request for a selected box: everything the Blender stage fetched (buildings, streets, land use — the
// BlenderGIS `osm_query` set), the context (tenants, 3D parts, furniture) and the details (traffic signs, entrances,
// house numbers, advertising) — parsed into the same export shape as blender/blender_geo_import.py writes.
export const OVERPASS_SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export function overpassQuery({ south, west, north, east }) {
    const b = [south, west, north, east].map(v => +v.toFixed(6)).join(',');
    return `[out:json][timeout:120][bbox:${b}];
(
  way["building"]; relation["building"]["type"="multipolygon"];
  way["highway"];
  way["landuse"]; relation["landuse"]["type"="multipolygon"];
  way["leisure"]; relation["leisure"]["type"="multipolygon"];
  way["amenity"]; relation["amenity"]["type"="multipolygon"];
  way["building:part"]; relation["type"="building"];
  node[~"^(shop|amenity|office|tourism|craft|leisure|historic|healthcare|club)$"~"."];
  node["highway"~"^(traffic_signals|bus_stop|street_lamp|crossing|stop|give_way|speed_camera|milestone)$"];
  node["traffic_sign"]; node["natural"="tree"]; node["emergency"="fire_hydrant"]; node["power"="pole"];
  node["man_made"~"^(flagpole|street_cabinet|monitoring_station)$"];
  node["entrance"]; node["addr:housenumber"]; node["advertising"];
);
out tags geom;`;
}

// --------------------------------------------------------------------------------------------- geometry helpers
const closedRing = pts => (pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1] ? pts.slice(0, -1) : null);
/** Join relation member ways (role outer) into closed rings. */
function outerRings(el) {
    const segs = (el.members || []).filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry?.length >= 2).map(m => m.geometry.map(p => [p.lon, p.lat]));
    const rings = [], same = (a, b) => a[0] === b[0] && a[1] === b[1];
    while (segs.length) {
        let ring = segs.shift();
        for (let guard = 0; !same(ring[0], ring.at(-1)) && guard < 1000; guard++) {
            const i = segs.findIndex(s => same(s[0], ring.at(-1)) || same(s.at(-1), ring.at(-1)));
            if (i < 0) break;
            const s = segs.splice(i, 1)[0];
            ring = ring.concat((same(s[0], ring.at(-1)) ? s : s.slice().reverse()).slice(1));
        }
        if (same(ring[0], ring.at(-1)) && ring.length > 3) rings.push(ring.slice(0, -1));
    }
    return rings;
}

const CONTEXT_NODE = /^(shop|amenity|office|tourism|craft|leisure|historic|healthcare|club|place_of_worship)$/;
const CONTEXT_WAY = /^(shop|amenity|office|tourism|craft|healthcare|historic)$/;
const FURN = new Set(['traffic_signals', 'bus_stop', 'street_lamp', 'crossing', 'stop', 'tree', 'fire_hydrant', 'pole', 'bench', 'waste_basket', 'bicycle_parking', 'post_box', 'vending_machine', 'flagpole', 'street_cabinet', 'monitoring_station']);
/** The elements blender_geo_import.py's CONTEXT_QUERY selects (so the parsed context is the same). */
function inContext(el) {
    const t = el.tags || {}, keys = Object.keys(t);
    if (el.type === 'node') return keys.some(k => CONTEXT_NODE.test(k)) || /^(traffic_signals|bus_stop|street_lamp|crossing|stop)$/.test(t.highway || '') || t.natural === 'tree'
        || t.emergency === 'fire_hydrant' || t.power === 'pole' || /^(flagpole|street_cabinet|monitoring_station)$/.test(t.man_made || '');
    if (el.type === 'way') return keys.some(k => CONTEXT_WAY.test(k)) || 'building:part' in t || ('building' in t && (t.wikidata || t.name || t['roof:shape'] || t['building:colour']));
    return el.type === 'relation' && t.type === 'building';
}

/**
 * Overpass JSON → { buildings, highways, areas, context (pois, parts, buildings, furniture), details (raw sign/entrance/
 * address/advertising nodes), qids, brands }. fwd(lon, lat) → [x, y] metres; ground(x, y) → metres.
 */
export function parseOverpass(json, { fwd, ground }) {
    const P = p => fwd(p.lon, p.lat), tagsOf = el => Object.fromEntries(Object.entries({ ...(el.tags || {}), id: String(el.id) }).map(([k, v]) => [k, String(v)]));
    const out = { buildings: [], highways: [], areas: [] }, ctx = { pois: [], parts: [], buildings: [], furniture: [] };
    const details = { signs: [], entrances: [], addresses: [], advertising: [] };
    const heightOf = t => { const n = v => { const x = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(x) ? x : null; }; return n(t.height) ?? (n(t['building:levels']) != null ? n(t['building:levels']) * 3 : 6); };
    const addBuilding = (el, lonlat) => {
        const ring = lonlat.map(([lon, lat]) => fwd(lon, lat)), t = tagsOf(el), zs = ring.map(([x, y]) => ground(x, y)).filter(Number.isFinite);
        out.buildings.push({ osm: String(el.id), name: t.name || `building ${el.id}`, tags: t, ring, base: zs.length ? +Math.min(...zs).toFixed(2) : null, height: heightOf(t) });
    };
    for (const el of json.elements || []) {
        const t = el.tags || {};
        if (el.geometry) el.geometry = el.geometry.filter(p => p && Number.isFinite(p.lat));   // clipped to the box: drop gaps
        for (const m of el.members || []) if (m.geometry) m.geometry = m.geometry.filter(p => p && Number.isFinite(p.lat));
        const ll = el.geometry?.map(p => [p.lon, p.lat]);
        if (el.type === 'way' && t.building && !t['building:part']) { const r = closedRing(ll || []); if (r) addBuilding(el, r); }
        else if (el.type === 'relation' && t.building && t.type === 'multipolygon') for (const r of outerRings(el)) addBuilding(el, r);
        else if (el.type === 'way' && t.highway && ll?.length >= 2) out.highways.push({ osm: String(el.id), name: t.name || `highway ${el.id}`, tags: tagsOf(el), line: el.geometry.map(P) });
        else if ((el.type === 'way' || (el.type === 'relation' && t.type === 'multipolygon')) && (t.landuse || t.leisure || t.amenity) && !t.building) {
            const rings = el.type === 'way' ? [closedRing(ll || [])].filter(Boolean) : outerRings(el);
            for (const r of rings) out.areas.push({ osm: String(el.id), name: t.name || `area ${el.id}`, tags: tagsOf(el), ring: r.map(([lon, lat]) => fwd(lon, lat)) });
        }
        // context, classified exactly like the Blender stage
        if (inContext(el)) {
            const ring = (el.geometry || []).map(P);
            const at = 'lat' in el ? P(el) : ring.length ? [+(ring.reduce((a, p) => a + p[0], 0) / ring.length).toFixed(2), +(ring.reduce((a, p) => a + p[1], 0) / ring.length).toFixed(2)] : null;
            const rec = { type: el.type, id: String(el.id), tags: t, at };
            const kind = t.highway || t.natural || t.emergency || t.power || t.man_made || t.amenity;
            if ('building:part' in t) ctx.parts.push({ ...rec, ring });
            else if (el.type === 'way' && 'building' in t) ctx.buildings.push({ ...rec, ring });
            else if (el.type === 'node' && FURN.has(kind) && !t.name) ctx.furniture.push({ kind, id: rec.id, at, tags: t });
            else if (el.type !== 'relation') ctx.pois.push({ ...rec, ...(ring.length && el.type === 'way' ? { ring } : {}) });
        }
        // details: what the street shows (signs, entrances, numbers, adverts)
        if (el.type === 'node') {
            const at = P(el);
            if (t.traffic_sign || /^(stop|give_way|speed_camera)$/.test(t.highway || '')) details.signs.push({ id: String(el.id), at, sign: t.traffic_sign || (t.highway === 'give_way' ? 'yield' : t.highway), direction: t.direction || t['traffic_sign:direction'] || null, tags: t });
            if (t.entrance) details.entrances.push({ id: String(el.id), at, kind: t.entrance, tags: t });
            if (t['addr:housenumber']) details.addresses.push({ id: String(el.id), at, number: t['addr:housenumber'], street: t['addr:street'] || null });
            if (t.advertising) details.advertising.push({ id: String(el.id), at, kind: t.advertising, tags: t });
        }
    }
    for (const b of out.buildings) if (b.tags['addr:housenumber']) {
        const c = [b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length, b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length];
        details.addresses.push({ id: b.osm, at: c, number: b.tags['addr:housenumber'], street: b.tags['addr:street'] || null, building: b.osm });
    }
    const all = [...out.buildings, ...ctx.pois, ...ctx.parts];
    const qids = [...new Set(all.map(x => x.tags.wikidata).filter(q => /^Q\d+$/.test(q || '')))];
    const brands = [...new Set(ctx.pois.map(p => p.tags['brand:wikidata']).filter(q => /^Q\d+$/.test(q || '')))];
    return { ...out, context: ctx, details, qids, brands };
}
