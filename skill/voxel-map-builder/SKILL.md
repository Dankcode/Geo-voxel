---
name: voxel-map-builder
description: Generate voxel game maps with the Geo-voxels map builder — procedural towns (XCOM-style operations, large districts) or real places from any coordinates (OSM + USGS terrain via Blender/BlenderGIS) — and bring them into a project as .vox, .glb, JSON layers or building prefabs.
---

# Voxel map builder (Geo-voxels)

Use this when a project needs town or city maps: a procedural district from a theme and seed, or a real place rebuilt
1:1 with straight grid streets, furnished interiors, props and road paint. Output is engine-agnostic (voxel grid +
palette + JSON layers), so it works for Three.js, Godot, Unity, Unreal, Blender or MagicaVoxel.

## 1. Find or get the repo

- Local: `~/Documents/GitHub/Geo-voxels` (Mac). Remote: `https://github.com/Dankcode/Geo-voxels`.
- `npm install` once (only the app needs it; the library and CLI have no dependencies, Node ≥ 20).
- `node bin/geo-voxels.mjs list` prints every generator, theme and parameter — check it rather than guessing names.

## 2. Pick the generator

| Need | Generator | Example |
|---|---|---|
| A compact battle map with an underground level | `operation` (`downtown`, `industrial`, `suburb`) | `--generator operation --theme industrial --seed 4` |
| A large town district | `district` (`park`, `mall`, `drainage`, `suburb`, `downtown`, `docks`, `highway`, `terraces`, `sunken-junction`, `sunken-boulevard`, `freight-terraces`) | `--generator district --theme suburb --seed 2 --params '{"width":112,"remix":{"maxStoreys":2}}'` |
| A real location | `place` + a BlenderGIS export | `--generator place --geo path/blender-export.json --params '{"name":"…","coverRepair":false}'` |

Same seed → same map. Try several seeds (the app's dice button, or a loop) and keep the best; record the seed.

## 3. Generate

- **App** (to look before choosing): `npm run app` → http://localhost:5180. Floor cutaway, rooms, props, cover; click
  to inspect; export .vox / .glb / map.json / grid.json / .png. The URL holds generator, theme and seed.
- **CLI**: `node bin/geo-voxels.mjs generate --generator … --theme … --seed … [--tactics] [--prefabs --name id] --out dir`
  → `map.vox`, `grid.json`, `map.json`, `slate.png` (+ `prefabs/`). Look at `slate.png` (top-down) before handing over.
- **Library**: `import { generate, tactics, toVoxBytes } from '<repo>/src/index.js'`;
  `generate({ generator, theme, seed, params, geo, plugins: [tactics()] })` → `{ grid, palette, layers, meta, plugins }`.

Add `tactics()` / `--tactics` only for turn-based games: it adds spawns, the objective, per-tile half/full cover and the
design-gate metrics. Without it the map is plain. For real places, `coverRepair: false` keeps open land as mapped
(no added trees/walls); leave it on for a tactics battlefield.

## 4. A real place from coordinates

1. Blender with the BlenderGIS add-on; the OpenTopography API key lives only in the BlenderGIS add-on preferences —
   never put it in a script, repo, report or chat.
2. With a Blender MCP: call `blender_status` first and say what will change in the scene before running Python.
3. `node bin/geo-voxels.mjs blender --lat <lat> --lon <lon> --window -80,80,-80,80 --pad 30 --out <dir>` prints the
   Python; run it (it works in the background; poll `<dir>/geo-status.json`). Keep the window ≤ ~170 m a side
   (≤ 192 cells at 0.9 m). `resume(out, 'osm')` retries only OSM; `context_only(out)` adds the context stage
   (one Overpass + ≤ 2 Wikidata requests: tenants, uses, 3D parts, landmark facts, street furniture) to an old export.
4. Generate with `--generator place --geo <dir>/blender-export.json`. Use `dem='USGS10m'` (3DEP) in the US; SRTM is a
   surface model and towers bleed into it.
5. Credit the data: © OpenStreetMap contributors (ODbL), USGS 3DEP (public domain), Wikidata (CC0).

## 5. Bring it into the project

- **MagicaVoxel / Blender / Godot / Unity / Unreal**: `map.vox` (≤ 256 per axis) or the app's `.glb`.
- **Three.js or a custom engine**: `grid.json` (run-length: `runs = [count, paletteIndex, …]` in z, y, x order;
  `palette` names + `colors`) and `map.json` (`layers.buildings` with doors/windows/stairs/exits, `layers.rooms` with
  cells and `floorZ`, `layers.decor` props by `kind` for your own models, `layers.roadPaint.quads`). Index of a voxel:
  `(z * depth + y) * width + x`; x east, y south, z up; a storey is 3 voxels. `app/src/mesher.js` is a ready
  three.js mesher (face culling, AO, glass split, floor cut).
- **Building prefabs**: `--prefabs` (real places) or `bakePrefab(engineMap, groupId)`; place them with `stampPrefab`
  (rotate / mirror) or `placePrefabInLot` (front faces a chosen street).

## 6. Changing the generators

The engine in `engine/` is synced from the voxel-tactics game (`tools/sync-engine.mjs <checkout>`;
`--check` to compare). Make generator changes in the game, re-sync, run `npm test` in both repos. Don't edit
`engine/` directly unless the change is meant to go back to the game too.

## Check before handing over

- `npm test` passes; the slate or an app screenshot shows the map; the seed and parameters are recorded.
- Never commit or push the user's repos unless asked; the user pushes Geo-voxels and his game himself.
