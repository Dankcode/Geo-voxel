// Live fetch: a selected box anywhere on Earth → an export with the same shape as the Blender stage's
// blender-export.json (so the same generator builds it), with no Blender, no API keys and no scraping:
//
//   1 Overpass request      buildings, streets, land use, tenants, 3D parts, furniture, signs, entrances, house numbers
//   ≤ 3 Wikidata requests   landmark facts (floors, height, style, year, architect, heritage) and brand colours/logos
//   AWS Terrain Tiles       terrain (USGS 3DEP in the US), 1–9 PNG tiles
//   ≤ 6 Wikipedia + 1 Commons  documentation: article leads and geotagged photos of the box, for review and detailing
//
// Every fetch goes through `fetch` (injectable: tests replay recorded responses); `decodeTile(bytes)` turns a PNG into
// RGBA (createImageBitmap in a browser, src/live/png.js in Node).
import { overpassQuery, parseOverpass, OVERPASS_SERVERS } from './overpass.js';
import { terrainSampler, TERRAIN_TILES, inUS } from './terrain.js';
import { wikidataFacts, wikipediaSummaries, commonsPhotos } from './wiki.js';
import { shopsFromContext } from '../details.js';

export const MAX_SIDE_M = 172;   // 192 cells at 0.9 m — the generator's largest map
export const MIN_SIDE_M = 30;
const K = 111320;

/** Local metres around (lat0, lon0): x east, y north (sub-metre over a few hundred metres). */
export function localProjection(lat0, lon0) {
    const kx = K * Math.cos(lat0 * Math.PI / 180);
    return { fwd: (lon, lat) => [+((lon - lon0) * kx).toFixed(2), +((lat - lat0) * K).toFixed(2)], inv: (x, y) => [lon0 + x / kx, lat0 + y / K] };
}
/** Centre + size (metres) → the lat/lon box (with `pad` metres around it). */
export function boxAround(lat, lon, widthM, depthM, pad = 0) {
    const { inv } = localProjection(lat, lon), [west, south] = inv(-widthM / 2 - pad, -depthM / 2 - pad), [east, north] = inv(widthM / 2 + pad, depthM / 2 + pad);
    return { south, west, north, east };
}

export async function fetchPlace({ lat, lon, widthM = 160, depthM = 160, pad = 30, demStep = 3, details = true }, { fetch = globalThis.fetch, decodeTile, onProgress = () => {} } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) throw Error('fetchPlace: latitude/longitude out of range');
    widthM = Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, widthM)); depthM = Math.max(MIN_SIDE_M, Math.min(MAX_SIDE_M, depthM));
    const { fwd, inv } = localProjection(lat, lon), bbox = boxAround(lat, lon, widthM, depthM, pad);
    const getJSON = async (url, init) => { const r = await fetch(url, init); if (!r.ok) throw Error(`${r.status} ${url.split('?')[0]}`); return r.json(); };
    const sources = [];

    onProgress({ step: 'terrain', text: 'Terrain tiles' });
    const T = await terrainSampler(bbox, async (z, x, y) => {
        const r = await fetch(TERRAIN_TILES.replace('{z}', z).replace('{x}', x).replace('{y}', y));
        if (!r.ok) throw Error(`terrain tile ${z}/${x}/${y}: ${r.status}`);
        return decodeTile(new Uint8Array(await r.arrayBuffer()));
    });
    const ground = (x, y) => T.sample(...inv(x, y));
    sources.push({ name: 'AWS Terrain Tiles (terrarium)', detail: `${T.tiles.length} tiles at zoom ${T.zoom}`, credit: inUS(lat, lon) ? 'USGS 3DEP (public domain)' : 'SRTM / national elevation models (see tilezen/joerd attribution)', url: 'https://registry.opendata.aws/terrain-tiles/' });

    onProgress({ step: 'osm', text: 'OpenStreetMap (one Overpass request)' });
    const body = new URLSearchParams({ data: overpassQuery(bbox) }).toString();
    let osm = null, last = null;
    for (const server of OVERPASS_SERVERS) {
        try { osm = await getJSON(server, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); sources.push({ name: 'OpenStreetMap via Overpass', detail: server, credit: '© OpenStreetMap contributors (ODbL)', url: 'https://www.openstreetmap.org/copyright' }); break; }
        catch (e) { last = e; onProgress({ step: 'osm', text: `Overpass busy (${e.message}), trying the next server` }); }
    }
    if (!osm) throw Error(`Overpass: ${last?.message || 'no answer'}`);
    const P = parseOverpass(osm, { fwd, ground });
    if (!P.buildings.length && !P.highways.length) throw Error('Nothing mapped here: OpenStreetMap has no buildings or streets in this box');

    onProgress({ step: 'wikidata', text: `Wikidata (${P.qids.length} landmarks, ${P.brands.length} brands)` });
    let facts = {};
    try { facts = await wikidataFacts([...P.qids, ...P.brands], getJSON); if (Object.keys(facts).length) sources.push({ name: 'Wikidata', detail: `${Object.keys(facts).length} items`, credit: 'CC0', url: 'https://www.wikidata.org' }); }
    catch (e) { onProgress({ step: 'wikidata', text: `Wikidata skipped: ${e.message}` }); }

    const X0 = -widthM / 2 - pad, X1 = widthM / 2 + pad, Y0 = -depthM / 2 - pad, Y1 = depthM / 2 + pad;
    const z = []; for (let y = Y0; y <= Y1 + 1e-6; y += demStep) { const row = []; for (let x = X0; x <= X1 + 1e-6; x += demStep) row.push(+ground(x, y).toFixed(2)); z.push(row); }

    const out = {
        source: 'geo-voxels live: Overpass + AWS Terrain Tiles + Wikidata', crs: 'local:equirectangular', origin: { lon, lat, x: 0, y: 0 }, units: 'm',
        extent: { x0: X0, x1: X1, y0: Y0, y1: Y1 }, window: { x0: -widthM / 2, x1: widthM / 2, y0: -depthM / 2, y1: depthM / 2 },
        dem: { step: demStep, x0: X0, y0: Y0, kind: inUS(lat, lon) ? 'dtm' : 'dsm', source: inUS(lat, lon) ? 'USGS 3DEP via AWS Terrain Tiles' : 'AWS Terrain Tiles', z },
        buildings: P.buildings, highways: P.highways, areas: P.areas,
        context: { source: 'overpass + wikidata', bbox: [bbox.west, bbox.south, bbox.east, bbox.north], ...P.context, wikidata: facts },
        selection: { lat, lon, widthM, depthM, pad, fetched: new Date().toISOString() }
    };

    if (details) {
        onProgress({ step: 'docs', text: 'Wikipedia and Commons' });
        const shops = shopsFromContext({ pois: P.context.pois, wikidata: facts });
        const titles = [...P.buildings.map(b => b.tags.wikipedia), ...P.context.pois.map(p => p.tags.wikipedia)].filter(Boolean).map(w => w.replace(/^en:/, ''))
            .concat(P.qids.map(q => facts[q]?.wikipedia).filter(Boolean));
        let wikipedia = [], commons = [];
        try { wikipedia = await wikipediaSummaries(titles, getJSON); if (wikipedia.length) sources.push({ name: 'Wikipedia', detail: `${wikipedia.length} articles`, credit: 'CC BY-SA 4.0', url: 'https://en.wikipedia.org' }); } catch { /* optional */ }
        try { commons = await commonsPhotos(lat, lon, Math.hypot(widthM, depthM) / 2, getJSON); if (commons.length) sources.push({ name: 'Wikimedia Commons', detail: `${commons.length} geotagged photos`, credit: 'per photo (author, licence)', url: 'https://commons.wikimedia.org' }); } catch { /* optional */ }
        out.details = { ...P.details, shops, docs: { wikipedia, commons } };
    }
    out.sources = sources;
    onProgress({ step: 'fetched', text: `${P.buildings.length} buildings · ${P.highways.length} streets · ${P.context.pois.length} places` });
    return out;
}
