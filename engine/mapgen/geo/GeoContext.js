// Geo import — the context of a place (blender_geo_import.py `context` stage: one Overpass request + ≤ 2 Wikidata
// requests, stored as `geo.context` in the export) turned into what each building IS:
//
//   tags      the building's full OSM tags (context.buildings) merged over the export's
//   facts     Wikidata (floors, height, architectural style, inception, heritage, instance of) for landmarks
//   tenants   shops / amenities / offices whose point lies inside the outline, in order along the building
//   use       the program each occupant gets (GeoPrograms.programForTags), and the material set (style, material)
//   landmark  true for heritage-listed, styled, historic or tall buildings: GeoLandmark dresses them
//
// Pure: works in the export's metres, before framing. Furniture (signals, bus stops, trees, lamps, hydrants) is passed
// through for the street props.
import { programForTags, materialsFor } from './GeoPrograms.js';

const inside = ([px, py], ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) c = !c; } return c; };
const centroidOf = r => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
const areaOf = r => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
/** OSM Simple 3D Buildings part → { ring, minM, maxM, roofM, roofShape, levels, colour, material } (metres above the base). */
export function partSpec(p) {
    const t = p.tags || {}, num = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
    const levels = num(t['building:levels']), roofM = num(t['roof:height']) ?? (t['roof:levels'] ? num(t['roof:levels']) * 3 : null);
    const maxM = num(t.height) ?? (levels != null ? levels * 3.5 + (roofM || 0) : null);
    const minM = num(t.min_height) ?? (t['building:min_level'] != null ? num(t['building:min_level']) * 3.5 : 0);
    return { id: p.id, ring: p.ring, minM: minM || 0, maxM, roofM, roofShape: t['roof:shape'] || 'flat', levels, colour: t['building:colour'] || t.colour || null, material: t['building:material'] || null };
}
const OCCUPANT = t => t.shop || t.amenity || t.office || t.tourism || t.craft || t.healthcare || (t.historic && t.historic !== 'district');
const NOT_TENANT = /^(parking|bench|waste_basket|bicycle_parking|post_box|vending_machine|events_venue|fountain|bus_station|shelter|toilets|atm|clock|drinking_water|charging_station|taxi)$/;

/**
 * geo: the export (with geo.context, or without — then everything is a no-op).
 * Returns Map(osm id → { tags, facts, tenants: [{ name, tags, at }], use: { program, def, label, rule } | null,
 *         units: [{ name, tags, at, use }] (≥ 2 when the building should be split per tenant), materials, landmark })
 */
export function buildingContext(geo) {
    const ctx = geo.context, out = new Map();
    if (!ctx) return out;
    const byId = new Map((ctx.buildings || []).map(b => [String(b.id), b]));
    const facts = ctx.wikidata || {};
    for (const b of geo.buildings || []) {
        if (!b.ring || b.ring.length < 3) continue;
        const cb = byId.get(String(b.osm));
        const tags = { ...(b.tags || {}), ...(cb?.tags || {}) };
        // the building way itself may carry the use (tourism=museum on the outline): it was fetched as a POI way
        const selfPoi = (ctx.pois || []).find(p => p.type === 'way' && String(p.id) === String(b.osm));
        if (selfPoi) Object.assign(tags, selfPoi.tags);
        const f = tags.wikidata ? facts[tags.wikidata] || null : null;
        const tenants = (ctx.pois || []).filter(p => p.type === 'node' && p.at && OCCUPANT(p.tags) && !NOT_TENANT.test(p.tags.amenity || '') && inside(p.at, b.ring))
            .map(p => ({ name: p.tags.name || p.tags.brand || null, tags: p.tags, at: p.at, use: programForTags(p.tags) }));
        // OSM 3D parts inside this outline (towers, steeples, wings with their own heights and roofs)
        const parts = (ctx.parts || []).filter(p => p.ring?.length >= 3 && inside(centroidOf(p.ring), b.ring)).map(partSpec).filter(p => p.maxM != null);
        const own = programForTags(tags, f);
        const materials = materialsFor(tags, f);
        const mainPart = parts.slice().sort((a, b) => areaOf(b.ring) - areaOf(a.ring))[0];
        const heightM = parseFloat(tags.height) || f?.heightM || null, floors = parseFloat(tags['building:levels']) || f?.floors || mainPart?.levels || null;
        const landmark = parts.some(p => p.maxM > 14) || !!(f && (f.heritage?.length || f.style?.length)) || /^(yes|monument|castle|church|cathedral)$/.test(tags.historic || '') || !!tags['heritage'] || (heightM && heightM > 20);
        // split per tenant: two or more independent tenants and no single institutional use for the whole outline
        const units = tenants.length >= 2 && !(own && ['civic', 'museum', 'chapel', 'school', 'library', 'clinic', 'hotel', 'bank'].includes(own.program)) ? tenants.slice(0, 6) : [];
        const use = own || (tenants.length === 1 ? tenants[0].use : null);
        out.set(String(b.osm), { tags, facts: f, tenants, use, units, materials, landmark, heightM, floors, parts, name: tags.name || f?.label || (tenants.length === 1 ? tenants[0].name : null) });
    }
    return out;
}

/** Real street furniture: [{ kind, at: [x, y] (metres) }] — traffic_signals, bus_stop, street_lamp, tree, fire_hydrant … */
export function streetFurniture(geo) { return (geo.context?.furniture || []).filter(f => f.at); }
