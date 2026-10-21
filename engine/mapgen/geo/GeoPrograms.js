// Geo import — what a real building is used for → the interior it gets. A hard-coded catalogue from OSM tags (the
// building's own and its tenants', from the context fetch) to a ModernBuilder program: an existing one (shop, diner,
// station, motel, office, garage, warehouse, house …) where it fits, or one of the civic/landmark plans below, passed
// to the builder as `programDef` (same shape as ModernBuilder.PROGRAMS entries; room kinds furnished through
// ROOM_FURNITURE, where the landmark kinds — vault, gallery, nave, vestry, chamber, classroom, reading, ward — live).
//
//   rule order: explicit amenity/tourism/shop/office/building values, then the Wikidata "instance of" labels, then
//   the name, then size (GeoSite.programFor). Every rule names the material set a style or OSM material overrides.

/** Landmark and civic plans (rows from the front to the back; w < 1 shares, w ≥ 1 fixed cells). */
export const GEO_PROGRAMS = {
    bank: { wall: 'stone', floor: 'stone_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.62, rooms: [{ kind: 'lobby', w: 1 }] }, { depth: 0.38, rooms: [{ kind: 'office', w: 0.45 }, { kind: 'vault', w: 0.55 }] }],
        upper: { lobby: 'open_office', office: 'office', vault: 'meeting' }, entry: 'lobby', back: ['vault'], side: ['office'], stairs: ['lobby'] },
    museum: { wall: 'stone', floor: 'stone_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.5, rooms: [{ kind: 'lobby', w: 0.4 }, { kind: 'gallery', w: 0.6 }] }, { depth: 0.5, rooms: [{ kind: 'gallery', w: 0.65 }, { kind: 'office', w: 0.35 }] }],
        upper: { lobby: 'gallery', gallery: 'gallery', office: 'storeroom' }, entry: 'lobby', back: ['gallery'], side: ['office'], stairs: ['lobby', 'gallery'] },
    chapel: { wall: 'stone', floor: 'stone_floor', wet: 'ceramic', roof: 'pitched',
        rows: [{ depth: 0.78, rooms: [{ kind: 'nave', w: 1 }] }, { depth: 0.22, rooms: [{ kind: 'vestry', w: 0.5 }, { kind: 'office', w: 0.5 }] }],
        upper: { nave: 'gallery', vestry: 'storeroom', office: 'office' }, entry: 'nave', back: ['vestry'], side: ['nave'], stairs: ['vestry'] },
    civic: { wall: 'stone', floor: 'stone_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.45, rooms: [{ kind: 'lobby', w: 0.5 }, { kind: 'office', w: 0.5 }] }, { depth: 0.55, rooms: [{ kind: 'chamber', w: 0.6 }, { kind: 'hall', w: 4 }, { kind: 'office', w: 0.4 }] }],
        upper: { lobby: 'gallery', office: 'office', chamber: 'chamber', hall: 'hall' }, entry: 'lobby', back: ['chamber'], side: ['office'], stairs: ['hall', 'lobby'] },
    school: { wall: 'brick', floor: 'tile_dark', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.55, rooms: [{ kind: 'classroom', w: 0.5 }, { kind: 'hall', w: 4 }, { kind: 'classroom', w: 0.5 }] }, { depth: 0.45, rooms: [{ kind: 'classroom', w: 0.5 }, { kind: 'office', w: 0.5 }] }],
        upper: { classroom: 'classroom', hall: 'hall', office: 'reading' }, entry: 'hall', back: ['classroom'], side: ['office'], stairs: ['hall'] },
    library: { wall: 'brick', floor: 'oak_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.5, rooms: [{ kind: 'lobby', w: 0.35 }, { kind: 'reading', w: 0.65 }] }, { depth: 0.5, rooms: [{ kind: 'reading', w: 0.7 }, { kind: 'office', w: 0.3 }] }],
        upper: { lobby: 'reading', reading: 'reading', office: 'study' }, entry: 'lobby', back: ['reading'], side: ['office'], stairs: ['lobby'] },
    clinic: { wall: 'concrete_wall', floor: 'tile_dark', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.45, rooms: [{ kind: 'lobby', w: 0.6 }, { kind: 'office', w: 0.4 }] }, { depth: 0.55, rooms: [{ kind: 'ward', w: 0.5 }, { kind: 'hall', w: 4 }, { kind: 'ward', w: 0.5 }] }],
        upper: { lobby: 'ward', office: 'office', ward: 'ward', hall: 'hall' }, entry: 'lobby', back: ['ward'], side: ['office'], stairs: ['hall'] },
    hotel: { wall: 'brick', floor: 'carpet', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.5, rooms: [{ kind: 'lobby', w: 0.6 }, { kind: 'dining', w: 0.4 }] }, { depth: 0.5, rooms: [{ kind: 'unit', w: 0.5 }, { kind: 'hall', w: 4 }, { kind: 'unit', w: 0.5 }] }],
        upper: { lobby: 'unit', dining: 'unit', unit: 'unit', hall: 'hall' }, entry: 'lobby', back: ['unit'], side: ['dining'], stairs: ['hall'] },
    supermarket: { wall: 'brick', floor: 'tile_dark', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.78, rooms: [{ kind: 'sales', w: 1 }] }, { depth: 0.22, rooms: [{ kind: 'storeroom', w: 0.7 }, { kind: 'office', w: 0.3 }] }],
        entry: 'sales', back: ['storeroom'], side: ['office'] }
};

const has = (t, k, re) => t[k] != null && re.test(String(t[k]));
/**
 * The program for one occupant (tags of the building or a tenant, plus optional Wikidata facts).
 * Returns { program, def (GEO_PROGRAMS entry or null), label, rule }.
 */
export function programForTags(t = {}, facts = null) {
    const wd = (facts?.instanceOf || []).join(' ').toLowerCase(), name = `${t.name || ''} ${facts?.label || ''}`.toLowerCase();
    const P = (program, rule, label = null) => ({ program, def: GEO_PROGRAMS[program] || null, label: label || t.name || facts?.label || null, rule });
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
