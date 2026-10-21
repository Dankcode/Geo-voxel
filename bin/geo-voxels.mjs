#!/usr/bin/env node
// geo-voxels — real places → straight-street voxel maps.
//
//   geo-voxels fetch --lat 30.4466 --lon -91.1891 [--width 160 --depth 160] [--no-details] --out dir
//       live fetch, no Blender or keys (Overpass + AWS Terrain Tiles + Wikidata + Wikipedia + Commons) → dir/source.json
//   geo-voxels place --lat 30.4466 --lon -91.1891 [--width 160 --depth 160] [--raw] [--tactics] [--cover] --out dir
//       fetch + build in one go → source.json, map.vox, grid.json, map.json (signs, details), slate.png
//   geo-voxels blender --lat 30.4583 --lon -91.0587 --window -100,71,-97,74 [--pad 30] [--dem USGS10m] --out dir
//       prints the Blender (BlenderGIS) Python that fetches OSM + DEM and writes dir/blender-export.json
//   geo-voxels build <blender-export.json> --out dir [--raw] [--cell 0.9] [--storey 3] [--tags overrides.json]
//       lite real-place build (shells): dir/map.vox, grid.json, layers.json, slate.png, report.json
//   geo-voxels generate --generator operation|district|place --theme <id> [--seed 1] [--geo export.json]
//                       [--params '{"remix":{"maxStoreys":2}}'] [--tactics] [--prefabs] --out dir
//       town engine (furnished interiors, props): dir/map.vox, grid.json, map.json (layers + meta), slate.png
//       --prefabs (place): every real building baked to dir/prefabs/<building>.json + index.json
//   geo-voxels list          generators, themes and parameters
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlace } from '../src/build.js';
import { toVox, toSlatePNG } from '../src/export.js';
import { generate, GENERATORS } from '../src/town.js';
import { tactics } from '../src/plugins/tactics.js';
import { bakePlacePrefabs } from '../engine/mapgen/geo/BuildingPrefab.js';
import { fetchPlace } from '../src/live/fetchPlace.js';
import { decodePNG } from '../src/live/png.js';
import { inflateSync } from 'node:zlib';

const argv = process.argv.slice(2), cmd = argv[0], opt = (k, d = null) => argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const usage = () => { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(2); };
if (cmd === 'blender') {
    const lat = Number(opt('--lat')), lon = Number(opt('--lon')), win = (opt('--window') || '').split(',').map(Number), out = resolve(opt('--out', 'geo-out'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || win.length !== 4 || win.some(v => !Number.isFinite(v))) usage();
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../blender/blender_geo_import.py');
    console.log(`# Run in Blender (Scripting tab, or a Blender MCP run_blender_python call) with BlenderGIS installed and your
# OpenTopography key in the BlenderGIS add-on preferences. Returns at once; watch ${out}/geo-status.json.
ns = {}; exec(open(${JSON.stringify(script)}).read(), ns)
ns['start'](lat=${lat}, lon=${lon}, extent=(${win.join(', ')}), pad=${Number(opt('--pad', 30))}, out=${JSON.stringify(out)},
            scene='GeoVoxels', save_blend='geo-import.blend', dem_step=${Number(opt('--dem-step', 3))}, dem=${JSON.stringify(opt('--dem', 'USGS10m'))})
# If Overpass fails after the DEM stage: exec the script again, then ns['resume'](${JSON.stringify(out)}, 'osm')`);
} else if (cmd === 'build') {
    const file = argv[1]; if (!file || file.startsWith('--')) usage();
    const out = resolve(opt('--out', 'geo-out')); mkdirSync(out, { recursive: true });
    const tags = opt('--tags') ? JSON.parse(readFileSync(resolve(opt('--tags')), 'utf8')) : {};
    const t0 = performance.now();
    const r = buildPlace(JSON.parse(readFileSync(resolve(file), 'utf8')), { straighten: argv.includes('--raw') ? null : 'grid', cell: Number(opt('--cell', 0.9)), storeyHeight: Number(opt('--storey', 3)), tagOverrides: tags });
    const ms = Math.round(performance.now() - t0);
    writeFileSync(join(out, 'map.vox'), toVox(r.grid));
    writeFileSync(join(out, 'grid.json'), JSON.stringify(r.grid.toJSON()));
    writeFileSync(join(out, 'layers.json'), JSON.stringify(r.layers));
    writeFileSync(join(out, 'slate.png'), toSlatePNG(r.grid));
    writeFileSync(join(out, 'report.json'), JSON.stringify({ ms, ...r.report }, null, 1));
    console.log(`geo-voxels: ${r.grid.width}×${r.grid.depth}×${r.grid.height} in ${ms} ms · ${r.report.buildings.length} buildings · ${r.layers.roads.length} streets · rotated ${r.report.theta}° · ${r.report.straighten ? `straightened (max shift ${r.report.straighten.maxShift} cells)` : 'raw geometry'} → ${out}`);
} else if (cmd === 'fetch' || cmd === 'place') {
    const lat = Number(opt('--lat')), lon = Number(opt('--lon')), out = resolve(opt('--out', 'place-out'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) usage();
    mkdirSync(out, { recursive: true });
    const source = await fetchPlace({ lat, lon, widthM: Number(opt('--width', 160)), depthM: Number(opt('--depth', opt('--width', 160))), details: !argv.includes('--no-details') },
        { decodeTile: b => decodePNG(b, x => inflateSync(Buffer.from(x))), onProgress: p => console.log(`  ${p.text}`) })
        .catch(e => { console.error(`geo-voxels: fetch failed — ${e.cause?.code || e.cause?.message || e.message}`); process.exit(1); });
    writeFileSync(join(out, 'source.json'), JSON.stringify(source));
    if (cmd === 'place') {
        const r = generate({ generator: 'place', geo: source, seed: Number(opt('--seed', 1)), params: { name: opt('--name') || undefined, straighten: argv.includes('--raw') ? 'none' : 'grid', coverRepair: argv.includes('--cover') }, plugins: argv.includes('--tactics') ? [tactics()] : [] });
        const { grid, palette, ...rest } = r;
        writeFileSync(join(out, 'map.vox'), toVox(grid)); writeFileSync(join(out, 'grid.json'), JSON.stringify(grid.toJSON()));
        writeFileSync(join(out, 'map.json'), JSON.stringify({ ...rest, palette })); writeFileSync(join(out, 'slate.png'), toSlatePNG(grid));
        console.log(`geo-voxels: ${grid.width}×${grid.depth}×${grid.height} · ${r.layers.buildings.length} building parts · ${r.layers.signs?.length || 0} signs → ${out}`);
    } else console.log(`geo-voxels: ${source.buildings.length} buildings, ${source.highways.length} streets → ${join(out, 'source.json')}`);
} else if (cmd === 'list') {
    for (const [id, g] of Object.entries(GENERATORS)) {
        console.log(`\n${id} — ${g.label} (${g.size})\n  ${g.text}`);
        for (const t of g.themes) console.log(`  --theme ${t.id.padEnd(17)} ${t.name}: ${t.text}`);
        console.log(`  params: ${JSON.stringify(g.params)}`);
    }
} else if (cmd === 'generate') {
    const generator = opt('--generator', 'district'), out = resolve(opt('--out', 'map-out')); mkdirSync(out, { recursive: true });
    const geo = opt('--geo') ? JSON.parse(readFileSync(resolve(opt('--geo')), 'utf8')) : null;
    const r = generate({ generator, theme: opt('--theme'), seed: Number(opt('--seed', 1)), geo, params: opt('--params') ? JSON.parse(opt('--params')) : {}, plugins: argv.includes('--tactics') ? [tactics()] : [], engineMap: argv.includes('--prefabs') });
    const { grid, palette, ...rest } = r;
    writeFileSync(join(out, 'map.vox'), toVox(grid));
    writeFileSync(join(out, 'grid.json'), JSON.stringify(grid.toJSON()));
    writeFileSync(join(out, 'map.json'), JSON.stringify({ ...rest, palette }));
    writeFileSync(join(out, 'slate.png'), toSlatePNG(grid));
    if (argv.includes('--prefabs')) {
        if (generator !== 'place') { console.error('--prefabs: real places only (their buildings are grouped by OSM outline)'); process.exit(2); }
        const pfs = bakePlacePrefabs(r.engine, { place: opt('--name', 'place') }); mkdirSync(join(out, 'prefabs'), { recursive: true });
        for (const pf of pfs) writeFileSync(join(out, 'prefabs', `${pf.id}.json`), JSON.stringify(pf));
        writeFileSync(join(out, 'prefabs', 'index.json'), JSON.stringify(pfs.map(p => ({ id: p.id, name: p.name, program: p.program, size: p.size, storeys: p.storeys })), null, 1));
        console.log(`prefabs: ${pfs.length} buildings → ${join(out, 'prefabs')}`);
    }
    console.log(`geo-voxels: ${r.generator}/${r.theme} seed ${r.seed} → ${grid.width}×${grid.depth}×${grid.height} in ${r.ms} ms · ${r.layers.buildings.length} buildings · ${r.layers.rooms.length} rooms · ${r.layers.decor.length} props${r.plugins.tactics ? ' · tactics' : ''} → ${out}`);
} else usage();
