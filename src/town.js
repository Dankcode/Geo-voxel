// geo-voxels town builder — one entry point for every generator in the town engine (engine/, synced from
// voxel-tactics by tools/sync-engine.mjs) and one engine-agnostic result shape.
//
//   generate({ generator: 'operation', theme: 'downtown', seed: 3 })
//   generate({ generator: 'district',  theme: 'suburb', seed: 2, params: { width: 112, remix: { maxStoreys: 2 } } })
//   generate({ generator: 'place',     geo: blenderExport, seed: 1, params: { name, objectiveName, maxStoreys } })
//
// → MapResult { format, id, name, generator, theme, seed, grid (VoxelGrid with the engine palette), palette,
//               layers { buildings, rooms, decor, roadPaint, hints, footprint }, meta, plugins }
//
// Plugins run on the finished engine map and add to the result. `tactics` (src/plugins/tactics.js) keeps the game
// rules — spawns, enemy pods, the objective, per-tile cover, the design-gate metrics — which plain map output drops.
import { generateOperation } from '../engine/mapgen/Generator.js';
import { compileV3Map } from '../engine/mapgen/ExteriorCompiler.js';
import { PLOT_FAMILIES } from '../engine/mapgen/PlotCatalogue.js';
import { buildLargeDistrict, buildTerraceHeights, DISTRICT_THEMES } from '../engine/mission/LargeDistricts.js';
import { buildSunkenBoulevard, buildFreightTerraces, buildSunkenJunction } from '../engine/mission/ConnectingDistricts.js';
import { buildGeoDistrict, GEO_GENERATOR_VERSION } from '../engine/mission/GeoDistrict.js';
import { remixParameters } from '../engine/mapgen/DistrictRemix.js';
import { MATERIALS } from '../engine/voxel/Materials.js';
import { VoxelGrid } from './grid.js';
import { applyDetails } from './details.js';

/** The engine's materials as a palette: { id, key, label, color [r, g, b], solid, opaque, glass, walkable, family, light }. */
export const ENGINE_PALETTE = Object.freeze(MATERIALS.map(m => Object.freeze({
    id: m.id, key: m.key, label: m.label, color: [(m.color >> 16) & 255, (m.color >> 8) & 255, m.color & 255],
    solid: m.solid, opaque: m.opaque, glass: m.shatters, walkable: m.walkable, family: m.family, light: m.light, liquid: m.liquid, render: m.render
})));

const SPLIT = {
    'sunken-junction': { name: 'Sunken Junction', build: buildSunkenJunction, text: 'Linked sunken boulevards with a T-junction, covered crossings, rounded retail and square industrial parcels.' },
    'sunken-boulevard': { name: 'Sunken Boulevard', build: buildSunkenBoulevard, text: 'A lower street passes beneath an upper boulevard, with road ramps and a covered crossing.' },
    'freight-terraces': { name: 'Freight Terraces', build: buildFreightTerraces, text: 'Low warehouses, raised loading decks, cargo lanes and a service catwalk.' }
};
const DISTRICT_TEXT = {
    park: 'Street-level shop rows, lots and yards solved as parcel mixes around a civic core.',
    mall: 'An L-shaped district: merged shopping interiors, retail parcels with their lots and service paths.',
    drainage: 'A T-shaped quarter cut by turning water channels, dry banks, stair entrances and ladders.',
    suburb: 'Houses with driveways and fenced yards on two avenues, semis, a fire station, a sports court and corner shops.',
    downtown: 'A dense grid of 2–3 storey shop rows, offices, plazas and a parking deck, joined by skybridges.',
    docks: 'A quay on deep water: warehouses with catwalks, container stacks, a scrapyard, a bus depot and loading aprons.',
    highway: 'A four-lane highway strip: motel, gas stations, a car dealership, a car wash, a drive-thru and a police compound.',
    terraces: 'Three levels — sunken yards, a street terrace and high ground — joined by ramps, stairs and split-level buildings.'
};

/** What can be generated: generator → { label, size, themes: [{ id, name, text }], params } (drives the app and the CLI). */
export const GENERATORS = Object.freeze({
    operation: {
        label: 'Operation', size: 'about 56 × 48 cells, with an underground level',
        text: 'XCOM-style plot: a road layout per theme, parcels (lots, alleys, yards) and buildings solved on it, with a subway or storm drain beneath.',
        themes: Object.entries(PLOT_FAMILIES).map(([id, f]) => ({ id, name: f.name, text: f.text })),
        params: { timeOfDay: ['dusk', 'night', 'night-ops', 'overcast', 'day', 'dawn'] }
    },
    district: {
        label: 'Large district', size: '96–128 × 72–96 cells',
        text: 'A road skeleton per theme with every block solved as parcel mixes (shop + lot, yards, alleys); buildings merge into shared walls.',
        themes: [...Object.keys(DISTRICT_THEMES).map(id => ({ id, name: DISTRICT_THEMES[id].name, text: DISTRICT_TEXT[id] })), { id: 'terraces', name: 'Hillside Terraces', text: DISTRICT_TEXT.terraces },
            ...Object.entries(SPLIT).map(([id, s]) => ({ id, name: s.name, text: s.text, fixedSize: true }))],
        params: {
            width: [96, 128], depth: [72, 96], shape: ['rectangle', 'L', 'T'],
            remix: { buildingCount: [3, 24], minStoreys: [1, 3], maxStoreys: [1, 3], traffic: ['none', 'light', 'normal', 'heavy'], pedestrian: ['none', 'light', 'normal'],
                wall: ['mixed', 'brick', 'stucco', 'concrete_wall', 'siding'], glazing: ['mixed', 'full', 'band', 'punched'], corners: ['mixed', 'rounded', 'square'],
                terrain: ['terraced', 'flat'], skybridges: [true, false], furnish: [true, false], merges: [true, false] }
        }
    },
    place: {
        label: 'Real place', size: 'the export window at 0.9 m per cell (≤ 192 a side)',
        text: 'A real map section (BlenderGIS export: OSM + USGS 3DEP + context) rebuilt 1:1 with straight streets, real outlines, real uses and landmarks.',
        themes: [{ id: 'place', name: 'From an export', text: 'Pass a blender-export.json (examples/ or `geo-voxels blender`).' }],
        params: { straighten: ['grid', 'none'], maxStoreys: [1, 3], timeOfDay: ['dusk', 'night', 'overcast', 'day', 'dawn'], coverRepair: [true, false] }
    }
});

function buildEngineMap({ generator, theme, seed, params = {}, geo }) {
    if (generator === 'operation') {
        if (!PLOT_FAMILIES[theme]) throw Error(`operation: unknown theme ${theme} (${Object.keys(PLOT_FAMILIES).join(', ')})`);
        const op = generateOperation({ plot: theme, seed, timeOfDay: params.timeOfDay ?? null, objective: params.objective ?? null });
        return compileV3Map(structuredClone({ site: op.site, layout: op.layout, design: op.design }), { seed });
    }
    if (generator === 'district') {
        if (SPLIT[theme]) return SPLIT[theme].build({ seed });
        const options = { width: params.width, depth: params.depth, shape: params.shape, ...(params.remix ? { remix: params.remix } : {}) };
        if (theme === 'terraces') return buildTerraceHeights({ seed, ...options, shape: 'rectangle' });
        if (!DISTRICT_THEMES[theme]) throw Error(`district: unknown theme ${theme}`);
        return buildLargeDistrict({ seed, theme, ...options });
    }
    if (generator === 'place') {
        if (!geo?.buildings) throw Error('place: pass `geo`, a BlenderGIS export (blender-export.json)');
        return buildGeoDistrict({ geo, seed, id: params.id || 'place', name: params.name || 'Real place', objectiveName: params.objectiveName ?? null,
            tagOverrides: params.tagOverrides || {}, straighten: params.straighten === 'none' ? null : 'grid', maxStoreys: params.maxStoreys ?? 3, timeOfDay: params.timeOfDay || 'dusk', coverRepair: params.coverRepair !== false, audit: false });
    }
    throw Error(`generate: unknown generator ${generator} (operation, district, place)`);
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
/** Engine map (voxel-tactics mission shape) → engine-agnostic MapResult. */
export function toResult(map, { generator, theme, seed, params = {} } = {}) {
    const s = map.store, grid = new VoxelGrid(s.width, s.depth, s.height, ENGINE_PALETTE.map(p => [p.key, p.color]));
    grid.data.set(s.mat);
    const buildings = (map.buildings || []).map(b => ({
        ...pick(b, ['id', 'name', 'role', 'program', 'x0', 'y0', 'w', 'd', 'baseZ', 'storeys', 'top', 'front', 'wall', 'era', 'rounded', 'entry', 'landmark', 'osm', 'group', 'wing']),
        rooms: (b.rooms || []).map(r => (typeof r === 'object' ? r.id : r)),
        doors: b.doors || [], windows: b.windows || [], stairs: b.stairs || [],
        exits: b.exits || []
    }));
    const rooms = (map.rooms || []).map(r => pick(r, ['id', 'buildingId', 'storey', 'kind', 'cells', 'floorZ', 'lit', 'doors']));
    const meta = map.meta || {};
    return {
        format: 'geo-voxels/map@1', id: map.id, name: map.name || map.id, generator, theme, seed, params,
        grid, palette: ENGINE_PALETTE, datum: meta.streetDatum ?? 1,
        layers: { buildings, rooms, decor: map.visual?.decor || [], roadPaint: map.visual?.roadPaint || null, hints: map.visual?.hints || {}, footprint: meta.footprint || null,
            floors: { cuts: meta.cutLevels ? meta.cutLevels.map(c => (Number.isFinite(c) ? c : s.height)) : null, names: meta.floorNames || null, defaultCut: meta.defaultCut ?? null } },
        meta: pick(meta, ['generatorVersion', 'theme', 'lighting', 'timeOfDay', 'remix', 'designDecisions', 'context', 'landmarks', 'report', 'geo']),
        plugins: {}
    };
}

/**
 * Generate a map. `plugins`: [tactics(), …] — each is { name, apply(map, result) } and writes result.plugins[name].
 * Returns the MapResult; `engineMap: true` also returns the raw engine map as result.engine (for prefab baking).
 */
export function generate({ generator = 'district', theme = null, seed = 1, params = {}, geo = null, plugins = [], engineMap = false } = {}) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('generate: seed must be an integer 0–4294967295');
    theme ||= generator === 'operation' ? 'downtown' : generator === 'district' ? 'park' : 'place';
    if (generator === 'district' && params.remix) params = { ...params, remix: remixParameters(params.remix) };
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const map = buildEngineMap({ generator, theme, seed, params, geo });
    const result = toResult(map, { generator, theme, seed, params });
    if (generator === 'place') {   // signs, house numbers, street names and the building directory from the fetched details
        const d = applyDetails(map, result, geo);
        if (d) { result.layers.signs = d.signs; result.details = d.details; }
    }
    for (const p of plugins) result.plugins[p.name] = p.apply(map, result);
    result.ms = Math.round((globalThis.performance?.now?.() ?? Date.now()) - t0);
    if (engineMap) Object.defineProperty(result, 'engine', { value: map, enumerable: false });
    return result;
}
export { GEO_GENERATOR_VERSION };
