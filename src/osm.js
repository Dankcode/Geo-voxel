// OpenStreetMap tag rules: which ways are streets, how wide they are, how tall a building is, what it is used for.
export const ROAD_CLASS = { motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2, unclassified: 2, residential: 1, living_street: 1, service: 0 };
const truthy = v => ['yes', 'true', '1'].includes(v);

/** Carriageway width in metres: `width`, else 3.3 m per lane + 2 m (kerb/parking); service drives 3.6 m. */
export function roadWidthMetres(tags) {
    if (tags.width && Number.isFinite(parseFloat(tags.width))) return parseFloat(tags.width);
    const cls = ROAD_CLASS[tags.highway] ?? 1, lanes = parseInt(tags.lanes, 10) || (cls >= 1 ? 2 : 1);
    return cls === 0 ? 3.6 : Math.max(2, lanes) * 3.3 + 2;
}
/**
 * A way's role as a street, or null: { cls (0 service … 4 motorway), halfM (half width, metres), link, oneway, sidewalk }.
 * Slip roads (*_link) are one-lane turn lanes a class below their parent, with no sidewalk of their own.
 */
export function roadSpec(tags) {
    const t = tags || {}, base = (t.highway || '').replace(/_link$/, ''), link = /_link$/.test(t.highway || '') && base in ROAD_CLASS;
    if (!(t.highway in ROAD_CLASS || link) || t.tunnel || t.area === 'yes') return null;
    const cls = link ? Math.max(1, ROAD_CLASS[base] - 1) : ROAD_CLASS[t.highway];
    const halfM = link ? ((parseInt(t.lanes, 10) || 1) * 3.4 + 1) / 2 : roadWidthMetres(t) / 2;
    return { cls, halfM, link, oneway: truthy(t.oneway) || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0, sidewalk: cls >= 1 && !link };
}
/** Storeys from `building:levels` / `height` (3.5 m a storey); { observed, storeys }. */
export function storeysFromTags(tags, fallback = 2, max = 10) {
    const lv = parseFloat(tags['building:levels']), h = parseFloat(tags.height);
    const observed = Number.isFinite(lv) ? Math.round(lv) : Number.isFinite(h) ? Math.round(h / 3.5) : null;
    return { observed, storeys: Math.max(1, Math.min(max, observed ?? fallback)) };
}
/** Use of a building: explicit tags, then name, then size. 'shop' | 'diner' | 'office' | 'warehouse' | 'garage' | 'house'. */
export function programFor(tags, areaM2) {
    const name = `${tags.name || ''} ${tags.brand || ''}`.toLowerCase(), b = tags.building;
    if (/restaurant|cafe|fast_food|bar|pub/.test(tags.amenity || '') || /diner|cafe|grill|restaurant/.test(name)) return 'diner';
    if (tags.shop || b === 'retail' || /store|shop|market|hardware|pharmacy/.test(name)) return 'shop';
    if (['warehouse', 'industrial', 'storage_tank'].includes(b) || /warehouse|depot|press/.test(name)) return areaM2 > 600 ? 'warehouse' : 'office';
    if (['garage', 'garages', 'carport', 'shed'].includes(b)) return 'garage';
    if (['house', 'detached', 'residential', 'semidetached_house', 'terrace', 'apartments'].includes(b)) return 'house';
    if (['school', 'office', 'commercial', 'hotel', 'civic', 'government', 'public'].includes(b) || tags.tourism || /academy|school|hotel|bank/.test(name)) return 'office';
    return areaM2 < 450 ? 'shop' : areaM2 > 1800 ? 'warehouse' : 'office';
}
export const isRetailArea = a => ['retail', 'commercial'].includes(a.tags?.landuse) || a.tags?.amenity === 'marketplace' || a.tags?.shop === 'mall';
