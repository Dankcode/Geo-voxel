// Cover prop catalogue: the only things the cover pass may put on open ground. Every entry is a real object with
// a gameplay job (half / full cover, hazard, concealment) and a level-design context (street, field, any), and is
// built from voxels of its own material so ballistics, destruction and the elements treat it correctly. The client
// draws each material with its tile-set piece (client/public/assets/kit/tileset.json), so a sandbag voxel looks
// like sandbags, a cart voxel like a cart, and so on.
//
//   cover     'half' (1 voxel high) | 'full' (2 high) — what XCOM's shields will read
//   layout    'line' (cells along a row, perpendicular to the side it protects) | 'single'
//   len       [min, max] cells
//   stack(i, n, rng) → material keys bottom-up for cell i of n
//   context   where it belongs: 'street' (road, cobble, paving), 'field' (grass, soil, forest floor), 'any'
//   hazard    gameplay note shown in the debug inspector and docs
export const PROP_CATALOG = Object.freeze({
    sandbag_line: { name: 'Sandbag line', cover: 'half', layout: 'line', len: [2, 4], w: 3, context: 'any',
        stack: () => ['sandbag'], text: 'Half cover. Sandbags soak blasts (6 hp per voxel).' },
    field_wall: { name: 'Dry-stone field wall', cover: 'half', layout: 'line', len: [3, 5], w: 3, context: 'field',
        stack: () => ['drystone'], text: 'Half cover. Tough (8 hp per voxel); leaves rubble.' },
    plank_fence: { name: 'Plank fence', cover: 'half', layout: 'line', len: [2, 4], w: 2, context: 'field',
        stack: () => ['fence'], text: 'Half cover. Burns; a blunderbuss chews through it.' },
    hay_bales: { name: 'Hay bales', cover: 'half', layout: 'line', len: [1, 2], w: 2, context: 'field',
        stack: () => ['hay'], text: 'Half cover. Highly flammable.' },
    crate: { name: 'Crate', cover: 'half', layout: 'single', len: [1, 1], w: 2, context: 'street',
        stack: () => ['crate'], text: 'Half cover. Breaks easily.' },
    crate_stack: { name: 'Stacked crates', cover: 'full', layout: 'line', len: [1, 2], w: 2, context: 'street',
        stack: (i, n, rng) => (rng.next() < 0.8 || n === 1 ? ['crate', 'crate'] : ['crate']), text: 'Full cover until it is shot apart.' },
    barrels: { name: 'Barrels', cover: 'half', layout: 'line', len: [1, 2], w: 1.5, context: 'street',
        stack: (i, n, rng) => [rng.next() < 0.3 ? 'barrel_powder' : 'barrel_water'],
        text: 'Half cover. Powder kegs explode when hit; water barrels douse fire and soak units.' },
    cart: { name: 'Cart', cover: 'half', layout: 'line', len: [2, 2], w: 2, context: 'any',
        stack: () => ['cart'], text: 'Half cover. Wooden, burns.' },
    market_stall: { name: 'Market stall', cover: 'half', layout: 'line', len: [2, 2], w: 1.5, context: 'street',
        stack: () => ['stall'], text: 'Half cover behind the counter. Wooden, burns.' },
    boulder: { name: 'Boulder', cover: 'full', layout: 'line', len: [1, 2], w: 1.5, context: 'field',
        stack: (i) => (i === 0 ? ['rock', 'rock'] : ['rock']), text: 'Full cover. Very tough (14 hp per voxel).' }
});

export const GROUND_CONTEXT = Object.freeze({
    road: 'street', cobble: 'street', stone_floor: 'street', plank: 'street',
    grass: 'field', soil: 'field', forest_floor: 'field', sand: 'field', snow: 'field'
});

/** Weighted pick of a catalogue entry that fits the ground under the target tile. */
export function pickProp(rng, groundKey, catalog = PROP_CATALOG) {
    const ctx = GROUND_CONTEXT[groundKey] || MODERN_CONTEXT[groundKey] || 'any';
    let fits = Object.entries(catalog).filter(([, p]) => p.context === 'any' || p.context === ctx || (p.context === 'lot' && ctx !== 'yard'));
    if (!fits.length) fits = Object.entries(catalog);
    const total = fits.reduce((s, [, p]) => s + p.w, 0);
    let t = rng.next() * total;
    for (const [k, p] of fits) { t -= p.w; if (t <= 0) return k; }
    return fits[0][0];
}

// ------------------------------------------------------------------------------------------------ present-day themes
// Contexts: 'street' (asphalt, concrete, paving), 'yard' (lawn, gravel, deck), 'lot' (yards and docks), 'any'.
const one = key => () => [key];
export const MODERN_CONTEXT = Object.freeze({
    asphalt: 'street', road_mark: 'street', concrete: 'street', paving: 'street', tile_dark: 'street', ceramic: 'street',
    lawn: 'yard', gravel: 'lot', deck: 'yard', soil: 'yard', grass: 'yard', sand: 'yard'
});
export const SUBURB_PROPS = Object.freeze({
    planter: { name: 'Concrete planter', cover: 'half', layout: 'line', len: [2, 3], w: 3, context: 'any', stack: one('planter'), text: 'Half cover. Tough concrete (8 hp).' },
    garden_wall: { name: 'Low brick wall', cover: 'half', layout: 'line', len: [3, 4], w: 2, context: 'yard', stack: one('brick'), text: 'Half cover. Brick (9 hp).' },
    privacy_fence: { name: 'Cedar privacy fence', cover: 'full', layout: 'line', len: [2, 4], w: 1.5, context: 'yard', stack: () => ['privacy_fence', 'privacy_fence'], text: 'Full cover. Thin timber: shots and fire go through it fast.' },
    bins: { name: 'Wheelie bins', cover: 'half', layout: 'line', len: [1, 2], w: 1.5, context: 'street', stack: one('bin'), text: 'Half cover. Flimsy (2 hp).' },
    bench: { name: 'Bench', cover: 'half', layout: 'line', len: [2, 2], w: 1, context: 'any', stack: one('bench'), text: 'Half cover. Timber, burns.' }
});
export const DOWNTOWN_PROPS = Object.freeze({
    jersey: { name: 'Concrete barrier', cover: 'half', layout: 'line', len: [2, 3], w: 3, context: 'street', stack: one('jersey'), text: 'Half cover. Very tough (14 hp).' },
    planter: SUBURB_PROPS.planter,
    bench: SUBURB_PROPS.bench,
    bins: SUBURB_PROPS.bins,
    newsstand: { name: 'Vending machines', cover: 'full', layout: 'line', len: [1, 2], w: 1, context: 'street', stack: () => ['appliance', 'appliance'], text: 'Full cover. Metal (7 hp).' }
});
export const DOCKS_PROPS = Object.freeze({
    crate_stack: { name: 'Crate stack', cover: 'full', layout: 'line', len: [1, 2], w: 2, context: 'any', stack: () => ['crate', 'crate'], text: 'Full cover until it is shot apart.' },
    pallets: { name: 'Pallet stack', cover: 'half', layout: 'line', len: [1, 2], w: 2.5, context: 'any', stack: one('pallet'), text: 'Half cover. Burns.' },
    drums: { name: 'Fuel drums', cover: 'half', layout: 'line', len: [1, 2], w: 1.2, context: 'any', stack: (i, n, rng) => [rng.next() < 0.35 ? 'barrel_powder' : 'barrel_water'], text: 'Half cover. Fuel drums explode when hit.' },
    jersey: DOWNTOWN_PROPS.jersey,
    sandbags: { name: 'Sandbag line', cover: 'half', layout: 'line', len: [2, 3], w: 1, context: 'any', stack: one('sandbag'), text: 'Half cover. Soaks blasts.' }
});
export const FORECOURT_PROPS = Object.freeze({
    jersey: DOWNTOWN_PROPS.jersey,
    bins: SUBURB_PROPS.bins,
    pallets: DOCKS_PROPS.pallets,
    planter: SUBURB_PROPS.planter,
    drums: DOCKS_PROPS.drums
});
