// Details for a real place: what a visitor reads on the street, placed on the voxel map, and what is known about each
// building — from the live fetch's `details` (Overpass signs / entrances / house numbers / adverts, shop names with
// brand colours from Wikidata) and `context` (tenants, Wikidata facts). Runs after the generator on the engine map:
//
//   layers.signs   [{ kind, text, lines?, colour?, x, y, z, facing: [dx, dy], w, h, source }]   cells; z in voxels; the face
//                  looks along `facing` (grid direction)
//     shop          a fascia over the shop's door in its brand colour (or a colour from its name)
//     street_name   the two street names on the blades the generator put at each junction
//     stop · yield · speed · traffic   real traffic signs where OSM maps them; speed-limit signs from `maxspeed`
//     house_number  the number by the door      billboard  mapped advertising
//   details        { buildings: directory, docs: { wikipedia, commons }, sources, warp, counts }
const hashHue = s => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); };
const SIDE = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const distSeg = ([px, py], [ax, ay], [bx, by]) => { const vx = bx - ax, vy = by - ay, l = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l)); return Math.hypot(ax + vx * t - px, ay + vy * t - py); };
const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
const distLine = (p, line) => { let d = Infinity; for (let i = 1; i < line.length; i++) d = Math.min(d, distSeg(p, line[i - 1], line[i])); return d; };

function signKind(raw = '', tags = {}) {
    const s = String(raw).toLowerCase();
    if (/stop|r1-1\b/.test(s)) return { kind: 'stop', text: 'STOP' };
    if (/yield|give_way|r1-2\b|:206/.test(s)) return { kind: 'yield', text: 'YIELD' };
    const speed = s.match(/(?:maxspeed|r2-1|:274)\D*(\d{2,3})/) || (tags.maxspeed && [0, parseInt(tags.maxspeed, 10)]);
    if (speed) return { kind: 'speed', text: String(speed[1]) };
    if (/speed_camera/.test(s)) return { kind: 'traffic', text: 'SPEED CAMERA' };
    return { kind: 'traffic', text: raw.replace(/^[A-Z]{2}:/, '').toUpperCase().slice(0, 18) || 'SIGN' };
}

const NOT_SHOP = /^(parking|parking_entrance|bench|waste_basket|bicycle_parking|post_box|vending_machine|fountain|bus_station|shelter|toilets|clock|drinking_water|charging_station|taxi|telephone|recycling|grit_bin)$/;
/** Named shops / amenities / offices from the context (with brand colours and logos from Wikidata when fetched). */
export function shopsFromContext(context = {}) {
    const facts = context.wikidata || {};
    const OCC = t => (t.shop || t.office || t.tourism || t.craft || t.healthcare || t.club || (t.amenity && !NOT_SHOP.test(t.amenity))) && !t.highway && !t.public_transport;
    return (context.pois || []).filter(p => p.at && (p.tags.name || p.tags.brand) && OCC(p.tags)).map(p => {
        const b = facts[p.tags['brand:wikidata']] || null;
        return { id: p.id, at: p.at, name: p.tags.name || p.tags.brand, brand: p.tags.brand || b?.label || null, kind: p.tags.shop || p.tags.amenity || p.tags.office || p.tags.tourism || p.tags.craft || p.tags.healthcare || 'place',
            colour: p.tags['brand:colour'] || p.tags.colour || b?.colour || null, logo: b?.logo || null, hours: p.tags.opening_hours || null, phone: p.tags.phone || null, website: p.tags.website || p.tags['contact:website'] || null };
    });
}
/** House numbers from building outlines (when the fetch had no address nodes). */
const addressesFromBuildings = geo => (geo.buildings || []).filter(b => b.tags?.['addr:housenumber'] && b.ring?.length).map(b => ({ id: b.osm, at: [b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length, b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length], number: b.tags['addr:housenumber'], street: b.tags['addr:street'] || null }));

/** map: the engine map (needs meta.geoReport.project / .streets); result: its MapResult; geo: the export. */
export function applyDetails(map, result, geo) {
    const rep = map.meta?.geoReport, project = rep?.project, streets = rep?.streets || [];
    const g = result.grid, W = g.width, D = g.depth, signs = [];
    if (!g.palette.length) return null;
    if (!project) return null;
    const inMap = ([x, y]) => x >= 0 && y >= 0 && x < W && y < D;
    const ground = (x, y) => { x = Math.max(0, Math.min(W - 1, Math.floor(x))); y = Math.max(0, Math.min(D - 1, Math.floor(y))); for (let z = g.height - 1; z >= 0; z--) { const m = g.data[(z * D + y) * W + x]; if (m && result.palette[m]?.solid) return z; } return 0; };
    const buildings = result.layers.buildings;
    const buildingAt = ([x, y]) => buildings.filter(b => x >= b.x0 - 1 && y >= b.y0 - 1 && x <= b.x0 + b.w && y <= b.y0 + b.d).sort((a, b) => a.w * a.d - b.w * b.d)[0] || null;
    const doorOf = (b, p) => {
        const exits = (b.exits || []).filter(e => SIDE[e.side]);
        if (exits.length) return exits.slice().sort((e1, e2) => (e2.entry ? 1 : 0) - (e1.entry ? 1 : 0) || Math.hypot(e1.x - p[0], e1.y - p[1]) - Math.hypot(e2.x - p[0], e2.y - p[1]))[0];
        const side = b.front && SIDE[b.front] ? b.front : 's', [dx, dy] = SIDE[side];
        return { x: Math.round(b.x0 + (b.w - 1) / 2 + dx * (b.w - 1) / 2), y: Math.round(b.y0 + (b.d - 1) / 2 + dy * (b.d - 1) / 2), side };
    };

    // shop fronts: one fascia per shop, over the door nearest the shop's mapped point
    const used = new Set();
    for (const s of geo.details?.shops || shopsFromContext(geo.context)) {
        const p = project(s.at); if (!inMap(p)) continue;
        const b = buildingAt(p); if (!b) continue;
        const key = `${b.id}:${s.name}`; if (used.has(key)) continue; used.add(key);
        const door = doorOf(b, p), [dx, dy] = SIDE[door.side], z = (b.baseZ ?? ground(door.x, door.y)) + 2.55;
        signs.push({ kind: 'shop', text: s.name, colour: s.colour || hsl(hashHue(s.brand || s.name), 55, 34), x: door.x + 0.5 + dx * 0.56, y: door.y + 0.5 + dy * 0.56, z, facing: SIDE[door.side],
            w: Math.max(2, Math.min(7, s.name.length * 0.42 + 1)), h: 0.8, building: b.id, source: `osm node ${s.id}` });
    }
    // house numbers by the door
    for (const a of geo.details?.addresses || addressesFromBuildings(geo)) {
        const p = project(a.at); if (!inMap(p)) continue;
        const b = buildingAt(p); if (!b || used.has(`${b.id}#`)) continue; used.add(`${b.id}#`);
        const door = doorOf(b, p), [dx, dy] = SIDE[door.side], ox = door.side === 'n' || door.side === 's' ? 1 : 0, oy = 1 - ox;
        signs.push({ kind: 'house_number', text: a.number, x: door.x + 0.5 + dx * 0.56 + ox * 0.9, y: door.y + 0.5 + dy * 0.56 + oy * 0.9, z: (b.baseZ ?? ground(door.x, door.y)) + 1.9, facing: SIDE[door.side], w: 0.6, h: 0.35, building: b.id, source: `osm ${a.id}` });
    }
    // street names on the junction blades the generator placed
    const named = streets.filter(s => s.name && s.line?.length >= 2);
    for (const d of result.layers.decor) {
        if (d.kind !== 'street_sign') continue;
        const near = named.map(s => ({ s, d: distLine([d.x + 0.5, d.y + 0.5], s.line) })).sort((a, b) => a.d - b.d);
        const names = [...new Set(near.filter(n => n.d < 14).map(n => n.s.name))].slice(0, 2);
        if (names.length) signs.push({ kind: 'street_name', text: names.join(' / '), lines: names, x: d.x + 0.5, y: d.y + 0.5, z: d.z, facing: [Math.cos(d.yaw || 0), Math.sin(d.yaw || 0)], w: 1.6, h: 0.3, source: 'osm street names' });
    }
    // real traffic signs
    for (const t of geo.details?.signs || []) {
        const p = project(t.at); if (!inMap(p)) continue;
        const { kind, text } = signKind(t.sign, t.tags);
        const near = streets.map(s => ({ s, d: distLine(p, s.line) })).sort((a, b) => a.d - b.d)[0];
        signs.push({ kind, text, x: p[0], y: p[1], z: ground(p[0], p[1]) + 1, facing: near ? unit(near.s.line[0], near.s.line.at(-1)) : [0, 1], w: kind === 'speed' ? 0.6 : 0.75, h: kind === 'speed' ? 0.75 : 0.75, source: `osm node ${t.id}` });
    }
    // speed limits from the streets' maxspeed: one by each end of a street that carries one
    for (const s of streets) {
        const v = parseInt(s.maxspeed, 10); if (!v || s.line.length < 2) continue;
        // walk in from each end of the street (which may run past the map) to 6 cells inside the map
        const pts = []; for (let k = 1; k < s.line.length; k++) { const [ax, ay] = s.line[k - 1], [bx, by] = s.line[k], L = Math.hypot(bx - ax, by - ay); for (let t = 0; t < L; t += 1) pts.push([ax + (bx - ax) * t / L, ay + (by - ay) * t / L]); }
        const inner = p => p[0] >= 6 && p[1] >= 6 && p[0] < W - 6 && p[1] < D - 6;
        for (const list of [pts, pts.slice().reverse()]) {
            const k = list.findIndex(inner); if (k < 0 || k + 1 >= list.length) continue;
            const a = list[k], b = list[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, off = s.half + 1.5;
            const p = [a[0] - uy * off, a[1] + ux * off];
            if (!inMap(p) || signs.some(q => q.kind === 'speed' && Math.hypot(q.x - p[0], q.y - p[1]) < 12)) continue;
            signs.push({ kind: 'speed', text: String(v), x: p[0], y: p[1], z: ground(p[0], p[1]) + 1, facing: [-ux, -uy], w: 0.6, h: 0.75, source: `maxspeed on ${s.name || 'street'}` });
        }
    }
    for (const a of geo.details?.advertising || []) {
        const p = project(a.at); if (!inMap(p)) continue;
        signs.push({ kind: 'billboard', text: a.tags.name || a.tags.brand || (a.kind === 'billboard' ? 'BILLBOARD' : 'AD'), x: p[0], y: p[1], z: ground(p[0], p[1]) + 1, facing: [0, 1], w: a.kind === 'billboard' ? 4 : 1, h: a.kind === 'billboard' ? 2 : 1.2, source: `osm node ${a.id}` });
    }

    // building directory: what each building is, from OSM and Wikidata
    const ctx = geo.context || {}, facts = ctx.wikidata || {}, byOsm = new Map((geo.buildings || []).map(b => [String(b.osm), b]));
    const seen = new Set(), directory = [];
    for (const b of map.buildings || []) {
        const key = b.group || b.id; if (seen.has(key)) continue; seen.add(key);
        const src = byOsm.get(String(b.osm)), t = src?.tags || {}, f = t.wikidata ? facts[t.wikidata] : null;
        const tenants = (ctx.pois || []).filter(p => p.type === 'node' && p.at && src?.ring && inside(p.at, src.ring) && (p.tags.name || p.tags.brand)).map(p => p.tags.name || p.tags.brand);
        directory.push({ id: key, osm: b.osm || null, name: t.name || f?.label || (b.name && !/^osm-\d+/.test(b.name) ? b.name : null), type: t.building && t.building !== 'yes' ? t.building : null, use: b.program || null,
            storeys: Math.max(...map.buildings.filter(r => (r.group || r.id) === key).map(r => r.storeys || 1)), levels: t['building:levels'] || null, height: t.height || null,
            address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null, tenants, landmark: !!b.landmark,
            wikidata: f ? { id: t.wikidata, style: f.style, inception: f.inception, architect: f.architect, heritage: f.heritage, floors: f.floors, heightM: f.heightM, description: f.description } : null,
            roof: t['roof:shape'] || null, material: t['building:material'] || null, colour: t['building:colour'] || null });
    }
    const counts = signs.reduce((a, s) => ((a[s.kind] = (a[s.kind] || 0) + 1), a), {});
    // the warp, for an overlay on the source map: the straightened street centrelines and the map's frame, in export metres
    const toWorld = rep.toWorld, R2 = v => +v.toFixed(2);
    const warp = toWorld ? { streets: streets.map(s => ({ name: s.name, line: s.line.map(p => toWorld(p).map(R2)) })), frame: [[0, 0], [W, 0], [W, D], [0, D]].map(p => toWorld(p).map(R2)) } : null;
    return { signs, details: { buildings: directory, docs: geo.details?.docs || null, sources: geo.sources || [], counts, warp: { rotationDeg: map.meta.geo?.rotationDeg ?? null, straighten: rep.straighten || null, ...warp }, selection: geo.selection || null } };
}
function inside([px, py], ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; }
