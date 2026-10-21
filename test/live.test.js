import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { fetchPlace, localProjection, boxAround, MAX_SIDE_M } from '../src/live/fetchPlace.js';
import { decodePNG } from '../src/live/png.js';
import { parseOverpass } from '../src/live/overpass.js';
import { generate } from '../src/town.js';

// a terrarium tile at a constant height: elevation = R·256 + G + B/256 − 32768
function terrariumPNG(metres) {
    const v = metres + 32768, R = Math.floor(v / 256), G = Math.floor(v) % 256, B = Math.round((v % 1) * 256);
    const row = Buffer.alloc(1 + 256 * 3); for (let i = 0; i < 256; i++) row.set([R, G, B], 1 + i * 3);
    row[0] = 0; const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
    const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const decodeTile = b => decodePNG(b, x => inflateSync(Buffer.from(x)));

test('png + projection: terrarium heights decode exactly; the local projection round-trips', async () => {
    const t = await decodeTile(terrariumPNG(16.5));
    assert.equal(t.width, 256);
    assert.equal(t.data[0] * 256 + t.data[1] + t.data[2] / 256 - 32768, 16.5);
    const { fwd, inv } = localProjection(30.45, -91.19), [x, y] = fwd(-91.189, 30.451), [lon, lat] = inv(x, y);
    assert.ok(Math.abs(lon + 91.189) < 1e-7 && Math.abs(lat - 30.451) < 1e-7);
    const b = boxAround(30.45, -91.19, 160, 160, 30);
    assert.ok(Math.abs((b.north - b.south) * 111320 - 220) < 0.5);
});

test('overpass parsing: buildings, multipolygon rings, streets, areas, context and details like the Blender stage', () => {
    const P = parseOverpass({ elements: [
        { type: 'way', id: 1, tags: { building: 'yes', name: 'Hall', 'addr:housenumber': '12', wikidata: 'Q1' }, geometry: [[0, 0], [0, 0.0002], [0.0002, 0.0002], [0.0002, 0], [0, 0]].map(([a, b]) => ({ lat: 30 + a, lon: -91 + b })) },
        { type: 'relation', id: 2, tags: { type: 'multipolygon', landuse: 'grass' }, members: [
            { type: 'way', role: 'outer', geometry: [{ lat: 30, lon: -91 }, { lat: 30.001, lon: -91 }] }, { type: 'way', role: 'outer', geometry: [{ lat: 30.001, lon: -91 }, { lat: 30.001, lon: -90.999 }, { lat: 30, lon: -91 }] }] },
        { type: 'way', id: 3, tags: { highway: 'residential', name: 'Main St', maxspeed: '25 mph' }, geometry: [{ lat: 30, lon: -91.001 }, null, { lat: 30, lon: -90.999 }] },
        { type: 'node', id: 4, lat: 30.0001, lon: -90.9999, tags: { shop: 'bakery', name: 'Crumbs', 'brand:wikidata': 'Q9' } },
        { type: 'node', id: 5, lat: 30.0003, lon: -91, tags: { highway: 'stop' } },
        { type: 'node', id: 6, lat: 30.0003, lon: -91, tags: { natural: 'tree' } }
    ] }, { fwd: localProjection(30, -91).fwd, ground: () => 5 });
    assert.equal(P.buildings.length, 1); assert.equal(P.buildings[0].ring.length, 4); assert.equal(P.buildings[0].base, 5); assert.equal(P.buildings[0].tags.id, '1');
    assert.equal(P.areas.length, 1); assert.equal(P.areas[0].ring.length, 3);
    assert.equal(P.highways[0].line.length, 2, 'clipped gaps dropped');
    assert.deepEqual(P.qids, ['Q1']); assert.deepEqual(P.brands, ['Q9']);
    assert.equal(P.context.pois.length, 1); assert.equal(P.context.furniture.length, 2); assert.equal(P.context.buildings.length, 1);
    assert.equal(P.details.signs[0].sign, 'stop'); assert.equal(P.details.addresses[0].number, '12');
});

test('fetchPlace offline: one Overpass request, terrain tiles, Wikidata — an export the generator builds', async () => {
    const calls = [];
    const lat = 30.4495, lon = -91.188, ring = (dx, dy, w, d) => [[dx, dy], [dx, dy + d], [dx + w, dy + d], [dx + w, dy], [dx, dy]].map(([a, b]) => ({ lat: lat + b * 1e-5, lon: lon + a * 1e-5 }));
    const overpass = { elements: [
        { type: 'way', id: 10, tags: { building: 'yes', name: 'Shop Row', 'building:levels': '2' }, geometry: ring(-20, 10, 40, 15) },
        { type: 'way', id: 11, tags: { highway: 'secondary', name: 'Main Street', maxspeed: '30 mph' }, geometry: [{ lat: lat, lon: lon - 0.001 }, { lat: lat, lon: lon + 0.001 }] },
        { type: 'way', id: 12, tags: { highway: 'residential', name: 'Cross Street' }, geometry: [{ lat: lat - 0.0008, lon: lon - 0.0003 }, { lat: lat + 0.0008, lon: lon - 0.0003 }] },
        { type: 'node', id: 13, lat: lat + 0.00016, lon: lon + 0.00001, tags: { shop: 'books', name: 'Page One', 'brand:wikidata': 'Q77' } }
    ] };
    const fetch = async (url, init) => {
        calls.push(url.split('?')[0]);
        const ok = body => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => body });
        if (url.includes('terrarium')) return ok(terrariumPNG(14));
        if (url.includes('interpreter')) { assert.match(new URLSearchParams(init.body).get('data'), /out tags geom/); return ok(overpass); }
        if (url.includes('wikidata')) return ok({ entities: { Q77: { labels: { en: { value: 'Page One' } }, claims: { P465: [{ mainsnak: { datavalue: { value: '1A5276' } } }] } } } });
        if (url.includes('commons')) return ok({ query: { pages: {} } });
        return { ok: false, status: 404 };
    };
    const geo = await fetchPlace({ lat, lon, widthM: 120, depthM: 120 }, { fetch, decodeTile });
    assert.equal(calls.filter(u => u.includes('interpreter')).length, 1);
    assert.equal(geo.dem.z[0][0], 14); assert.equal(geo.dem.kind, 'dtm');
    assert.equal(geo.details.shops[0].colour, '#1A5276');
    assert.deepEqual(geo.window, { x0: -60, x1: 60, y0: -60, y1: 60 });
    const r = generate({ generator: 'place', geo, seed: 1, params: { coverRepair: false } });
    assert.ok(r.layers.buildings.length >= 1);
    const shop = r.layers.signs.find(s => s.kind === 'shop');
    assert.equal(shop?.text, 'Page One'); assert.equal(shop.colour, '#1A5276');
    assert.ok(r.layers.signs.some(s => s.kind === 'speed' && s.text === '30'));
});

test('a live fetch (Third Street, Baton Rouge, fetched in a browser): straightened, signed, documented', () => {
    const geo = JSON.parse(readFileSync(new URL('../examples/live-third-street/source.json', import.meta.url), 'utf8'));
    const r = generate({ generator: 'place', geo, seed: 1, params: { coverRepair: false } });
    assert.equal(r.grid.width, Math.round(142 / 0.9)); assert.ok(r.details.warp.straighten.maxShift < 8);
    const names = r.layers.signs.filter(s => s.kind === 'shop').map(s => s.text);
    for (const n of ['13 Social', 'The Ambeau Law Firm']) assert.ok(names.includes(n), n);
    assert.ok(r.layers.signs.some(s => s.kind === 'street_name' && /3rd Street|Florida Street/.test(s.text)));
    const d = r.details.buildings.find(b => b.name === 'Capitol City Press Building');
    assert.ok(d && d.address === '340 Florida Street');
    assert.ok(MAX_SIDE_M >= 170);
});
