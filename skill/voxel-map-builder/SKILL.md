---
name: voxel-map-builder
description: Turn any real place (latitude/longitude) into a straight-street, furnished voxel map with signs and building details using the Geo-voxels Place Builder, and bring it into a project as .vox, .glb, JSON layers or prefabs.
---

# Real-place voxel maps (Geo-voxels Place Builder)

Use this when a project needs a real location as a game map: the real buildings (interiors chosen by what each
building is), real streets warped onto a straight grid, terrain, trees, and street details — shop signs in brand
colours, street names, house numbers, speed limits, stop signs — from open data with no keys and no scraping.

## 1. Get the repo

- Local: `~/Documents/GitHub/Geo-voxels` (Mac). Remote: `https://github.com/Dankcode/Geo-voxels`.
- `npm install` once (the app needs Vite, three, Leaflet; the library and CLI have no dependencies, Node ≥ 20).

## 2. Pick the place

- **App** (best for choosing the area): `npm run app` → http://localhost:5180. Enter latitude and longitude, drag the
  box on the OpenStreetMap map (centre moves, corners resize; 30–172 m a side), tick the options, **Build this area**.
  The Map tab then shows the warp: real streets, the straightened streets and the rotated frame of the built map.
- **CLI**: `node bin/geo-voxels.mjs place --lat <lat> --lon <lon> --width 160 [--depth 160] --out <dir>` (fetch +
  build) or `fetch …` (just `source.json`). The CLI needs network access to overpass-api.de, s3.amazonaws.com,
  wikidata.org, wikipedia.org and commons.wikimedia.org — a sandbox that blocks them fails with ENOTFOUND/403; use
  the app in a normal browser instead, or a saved `source.json`.
- **Library**: `fetchPlace({ lat, lon, widthM, depthM }, { decodeTile: b => decodePNG(b, inflate) })` then
  `generate({ generator: 'place', geo: source, seed, params })`.

Keep the box on the part that matters: the map is 0.9 m a cell, at most 192 cells a side. Sparse OSM areas (suburbs)
may need a look at the Details tab — missing names or tenants mean OSM lacks them there.

## 3. Options that change the map

- `straighten: 'grid'` (default) warps streets onto a straight grid (rotation + snapping; buildings carried along);
  `'none'` keeps streets as mapped (pixel staircases on diagonal roads). `details.warp` reports how far streets moved.
- `coverRepair: false` (app default) keeps open land as mapped; `true` adds trees and low walls for a tactics game.
- `tactics()` plugin / `--tactics` adds spawns, the objective, half/full cover per tile and gate metrics.
- `maxStoreys` caps playable storeys (taller landmarks are dressed above them).

## 4. What you get

- `grid` (+ `.vox`): one byte per voxel, x east, y south, z up, index `(z * depth + y) * width + x`; a storey is 3 voxels.
- `layers.buildings / rooms` (doors, windows, stairs, exits, room kinds), `layers.decor` (props by `kind`),
  `layers.roadPaint`, `layers.signs` (`kind, text, x, y, z, facing, w, h`: shop, street_name, house_number, stop,
  yield, speed, traffic, billboard).
- `details.buildings` (name, use, OSM type, storeys, address, tenants, Wikidata style/year/architect/heritage),
  `details.docs` (Wikipedia summaries, Commons photos with author and licence), `details.sources`, `details.warp`.
- App exports: `.vox`, `.glb` (with signs), `map.json`, `grid.json`, `source.json` (re-open later, offline).
- Prefabs: `bakePlacePrefabs(generate({ …, engineMap: true }).engine, { place })`.

## 5. Credit the data

© OpenStreetMap contributors (ODbL); terrain: AWS Terrain Tiles (USGS 3DEP in the US, public domain); Wikidata (CC0);
Wikipedia (CC BY-SA); Commons photos per their own licence. `details.sources` lists what a map used.

## 6. Optional: the Blender pipeline

`node bin/geo-voxels.mjs blender --lat … --lon … --window x0,x1,y0,y1 --pad 30 --out <dir>` prints BlenderGIS Python
(OpenTopography DEM). The OpenTopography key lives only in the BlenderGIS add-on preferences — never in a script,
repo, report or chat. With a Blender MCP, call `blender_status` first and say what will change before running Python.

## 7. Changing how buildings are built

`engine/` is synced from the voxel-tactics game (`node tools/sync-engine.mjs <checkout>`; `--check` compares). Change
generation in the game, re-sync, run `npm test` in both repos. Don't edit `engine/` alone.

## Check before handing over

- `npm test` passes; look at the 3D view or `slate.png`; record lat/lon, size and seed (the app URL holds the area).
- Never commit or push the user's repos unless asked; the user pushes Geo-voxels and his game himself.
