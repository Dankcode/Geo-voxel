// What a real building is used for, from OSM tags (its own and its tenants') and Wikidata "instance of": one of
// chapel, civic, museum, bank, library, school, clinic, hotel, motel, bunker (police), garage, station (fuel), diner,
// supermarket, shop, office, warehouse, house, townhouse — and the wall/floor/roof material set from OSM material,
// colour and the Wikidata architectural style. Engines map these labels to their own interiors.
const has = (t, k, re) => t[k] != null && re.test(String(t[k]));
/**
 * The program for one occupant (tags of the building or a tenant, plus optional Wikidata facts).
 * Returns { program, def (GEO_PROGRAMS entry or null), label, rule }.
 */
export function useForTags(t = {}, facts = null) {
    const wd = (facts?.instanceOf || []).join(' ').toLowerCase(), name = `${t.name || ''} ${facts?.label || ''}`.toLowerCase();
    const P = (program, rule, label = null) => ({ program, label: label || t.name || facts?.label || null, rule });
    if (has(t, 'amenity', /^(place_of_worship|monastery)$/) || has(t, 'building', /^(church|cathedral|chapel|mosque|synagogue|temple|shrine)$/) || /church|cathedral|chapel|basilica|mosque|synagogue/.test(wd)) return P('chapel', 'worship');
    if (has(t, 'amenity', /^(townhall|courthouse|embassy)$/) || has(t, 'office', /^(government|diplomatic)$/) || has(t, 'building', /^(government|civic|public)$/) || /capitol|parliament|city hall|town hall|courthouse|legislat|state house/.test(wd + ' ' + name)) return P('civic', 'civic');
    if (has(t, 'tourism', /^(museum|gallery)$/) || has(t, 'amenity', /^(arts_centre|exhibition_centre)$/) || /museum|gallery/.test(wd)) return P('museum', 'museum');
    if (has(t, 'amenity', /^(bank|bureau_de_change)$/) || /\bbank\b/.test(wd)) return P('bank', 'bank');
    if (has(t, 'amenity', /^(library)$/) || /library/.test(wd)) return P('library', 'library');
    if (has(t, 'amenity', /^(school|college|university|kindergarten)$/) || has(t, 'building', /^(school|university|college)$/) || /school|university|college/.test(wd)) return P('school', 'school');
    if (has(t, 'amenity', /^(clinic|hospital|doctors|dentist|veterinary)$/) || has(t, 'healthcare', /./) || /hospital|clinic/.test(wd)) return P('clinic', 'clinic');
    if (has(t, 'tourism', /^(hotel|hostel|guest_house)$/) || /hotel/.test(wd)) return P('hotel', 'hotel');
    if (has(t, 'tourism', /^motel$/)) return P('motel', 'motel');
    if (has(t, 'amenity', /^(police|fire_station|ranger_station)$/)) return P(t.amenity === 'fire_station' ? 'garage' : 'bunker', 'emergency');
    if (has(t, 'amenity', /^fuel$/)) return P('station', 'fuel');
    if (has(t, 'amenity', /^(restaurant|fast_food|cafe|bar|pub|ice_cream|food_court|biergarten)$/)) return P('diner', 'food');
    if (has(t, 'shop', /^(supermarket|wholesale|department_store|hardware|doityourself|furniture|variety_store|general)$/)) return P('supermarket', 'big shop');
    if (t.shop) return P('shop', 'shop');
    if (has(t, 'amenity', /^(pharmacy)$/)) return P('shop', 'pharmacy');
    if (t.office || t.craft) return P('office', 'office');
    if (has(t, 'building', /^(parking|garage|garages)$/) || has(t, 'amenity', /^(parking|car_wash|car_repair)$/) || t.shop === 'car_repair') return P('garage', 'garage');
    if (has(t, 'building', /^(warehouse|industrial|storage_tank)$/)) return P('warehouse', 'industrial');
    if (has(t, 'building', /^(hotel)$/)) return P('hotel', 'hotel');
    if (has(t, 'building', /^(house|detached|semidetached_house|terrace|residential|apartments|bungalow)$/)) return P(t.building === 'terrace' ? 'townhouse' : 'house', 'home');
    return null;
}

/** Material set from OSM building:material / building:colour and the Wikidata style. */
export function materialsFor(t = {}, facts = null) {
    const style = (facts?.style || []).join(' ').toLowerCase(), mat = String(t['building:material'] || t['building:facade:material'] || '').toLowerCase(), colour = String(t['building:colour'] || '').toLowerCase();
    let wall = null, floor = null, roof = null;
    if (/brick/.test(mat)) wall = 'brick';
    else if (/stone|sandstone|limestone|granite|marble/.test(mat)) wall = 'stone';
    else if (/plaster|stucco|render/.test(mat)) wall = 'stucco';
    else if (/wood|timber/.test(mat)) wall = 'timber';
    else if (/concrete/.test(mat)) wall = 'concrete_wall';
    else if (/glass/.test(mat)) wall = 'concrete_wall';
    if (!wall && /white|ivory|cream/.test(colour)) wall = 'stucco';
    if (!wall && /red|brown|maroon/.test(colour)) wall = 'brick';
    if (/gothic|castle|romanesque|tudor/.test(style)) { wall ||= 'stucco'; floor = 'stone_floor'; }
    if (/georgian|colonial|federal/.test(style)) { wall ||= 'brick'; floor = 'oak_floor'; roof = 'pitched'; }
    if (/neoclassic|beaux|greek revival|classical/.test(style)) { wall ||= 'stone'; floor = 'stone_floor'; }
    if (/art deco|moderne/.test(style)) { wall ||= 'stone'; floor = 'stone_floor'; }
    return { wall, floor, roof, style };
}
