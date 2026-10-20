#!/usr/bin/env node
// geo-voxels — real places → straight-street voxel maps.
//
//   geo-voxels blender --lat 30.4583 --lon -91.0587 --window -100,71,-97,74 [--pad 30] [--dem USGS10m] --out dir
//       prints the Blender (BlenderGIS) Python that fetches OSM + DEM and writes dir/blender-export.json
//   geo-voxels build <blender-export.json> --out dir [--raw] [--cell 0.9] [--storey 3] [--tags overrides.json]
//       writes dir/map.vox (MagicaVoxel), dir/grid.json, dir/layers.json, dir/slate.png, dir/report.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlace } from '../src/build.js';
import { toVox, toSlatePNG } from '../src/export.js';

const argv = process.argv.slice(2), cmd = argv[0], opt = (k, d = null) => argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const usage = () => { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(2); };
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
} else usage();
