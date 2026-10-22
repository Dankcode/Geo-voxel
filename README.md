# geo-voxels

**Any real place → a straight-street voxel map.** Type a latitude and longitude, drag a box over the map, and get that
piece of the world as a furnished voxel map: the real buildings in their real outlines (with interiors chosen by what
each building is), the real streets — **warped onto a straight grid** so no road runs as a ragged pixel staircase — the
terrain, the trees, and the details a visitor reads on the street: shop signs in their brand colours, street names,
house numbers, speed limits, stop signs. Everything comes from open data, fetched live, with no API keys and no scraping.

![Place Builder — Third Street, Baton Rouge](docs/img/place-builder-3d.jpg)

| Shop fascia and house number from OpenStreetMap | The Details tab: what every building is, and the sources |
|---|---|
| ![signs](docs/img/place-builder-signs.jpg) | ![details](docs/img/place-builder-details.jpg) |

## The Place Builder

```sh
git clone https://github.com/Dankcode/Geo-voxel && cd Geo-voxel
npm install
npm run app            # → http://localhost:5180
```

1. **Location** — a latitude and longitude (paste “30.4466, -91.1891” into either box), or one of the saved places.
2. **Area** — an OpenStreetMap map with a box: drag its centre to move it, a corner to resize it (30–172 m a side; the
   map is 0.9 m a cell, at most 192 cells). The dashed line is the 30 m margin fetched around it so the rotated map has
   real data in its corners.
3. **Build** — the place is fetched in the browser, then straightened and built in a web worker (a few seconds):
   - *Straighten streets* (on): rotate the map onto its street grid and snap every street to a straight grid line,
     carrying buildings and land use along — the warp is reported (rotation, how far streets moved).
   - *Gather details* (on): signs, building types and documentation (below).
   - *Game cover fill* (off): add trees and low walls to open land, as a tactics game wants; off keeps land as mapped.
   - *Tactics plugin* (off): spawns, half/full cover per tile and the design-gate metrics.

Then: **3D** (orbit, floor cutaway, signs / props / road paint / rooms layers, click a voxel for its building, use,
address, tenants and room), **Details** (below) and **Export** — `.vox` (MagicaVoxel; Blender, Godot, Unity, Unreal
importers), `.glb` (the mesh as shown, signs included), `map.json`, `grid.json`, `source.json` (the fetched data, to
rebuild later or offline — open it again with *Open a saved source.json*) and a screenshot. The URL keeps the area.

## Where the data comes from

| Request | What it gives |
|---|---|
| **1 Overpass request** (OpenStreetMap) | buildings, streets, land use, parking; tenants (shops, offices, amenities); OSM 3D building parts; trees, lamps, signals, hydrants, bus stops; traffic signs, entrances, house numbers, advertising |
| **AWS Terrain Tiles** (terrarium PNG, 1–9 tiles) | terrain — USGS 3DEP bare earth in the US, SRTM-class elsewhere |
| **≤ 3 Wikidata requests** | landmark facts (floors, height, architectural style, year, architect, heritage listing) and brand colours and logos for the shop signs |
| **≤ 6 Wikipedia + 1 Commons request** | the documentation: article leads for the landmarks, geotagged photos taken inside the box (references for facades, colours and signs, each with author and licence) |

All are open, keyless and CORS-enabled, so the app needs no server. Credit them when you ship a map: © OpenStreetMap
contributors (ODbL), USGS 3DEP (public domain), Wikidata (CC0), Wikipedia (CC BY-SA), Commons per photo. The
Details tab and `map.json → details.sources` list exactly what a map used.

## Details: signs, building types, documentation

- **Signs** (`layers.signs`): a fascia over each shop's door with its name in its brand colour (Wikidata P465 or OSM
  `brand:colour`, else a colour from the name); the two street names on each junction's blades; house numbers by the
  door; STOP / YIELD / speed / other traffic signs where OSM maps them; speed-limit signs from each street's `maxspeed`
  where it enters the map; billboards. Each sign has `kind, text, x, y, z, facing, w, h` and its OSM source.
- **Building types** (`details.buildings`): per building its name, the use the map built it as (shop, diner, office,
  hotel, civic, chapel, museum, school, clinic …), the OSM building type, storeys (and OSM levels), address, tenants,
  roof shape, material, colour and — for landmarks — style, year, architect, heritage and height from Wikidata.
- **Documentation** (`details.docs`): Wikipedia summaries and Commons photos, shown in the Details tab.

## CLI and library

```sh
node bin/geo-voxels.mjs place --lat 30.4466 --lon -91.1891 --width 160 --out out/capitol   # fetch + build
node bin/geo-voxels.mjs fetch --lat 39.9489 --lon -75.1500 --out out/ih                       # just source.json
node bin/geo-voxels.mjs generate --generator place --geo out/ih/source.json --out out/ih      # build a saved source
```

```js
import { fetchPlace, decodePNG, generate, tactics, toVoxBytes } from 'geo-voxels';

const source = await fetchPlace({ lat: 30.4466, lon: -91.1891, widthM: 160, depthM: 160 },
    { decodeTile: bytes => decodePNG(bytes, inflate) });            // inflate: zlib.inflateSync or DecompressionStream
const map = generate({ generator: 'place', geo: source, seed: 1, params: { straighten: 'grid', coverRepair: false } });
map.grid;               // VoxelGrid: width × depth × height, one byte per voxel (x east, y south, z up), .palette
map.layers.buildings;   // [{ id, name, program, x0, y0, w, d, baseZ, storeys, doors, windows, stairs, exits, rooms }]
map.layers.rooms;       // [{ id, buildingId, storey, kind, cells: [[x, y]], floorZ }]
map.layers.signs;       // shop fascias, street names, house numbers, traffic signs
map.layers.decor;       // street lights, signals, awnings, furniture … by `kind`, for your prop models
map.layers.roadPaint;   // { quads: [{ c: [[x, y] ×4], z, color }] }
map.details;            // buildings directory, docs, sources, warp
toVoxBytes(map.grid);   // .vox
```

`bakePlacePrefabs(generate({ …, engineMap: true }).engine, { place })` turns every real building into a prefab
(voxels, rooms, doors, stairs, decor) to stamp into other maps (`stampPrefab`, `placePrefabInLot`).

## The warp: straight streets

Real streets are a few degrees off north, bend slightly and meet at 79° rather than 90°. Rasterised as they are, they
become pixel staircases. The builder rotates the map by the length × class weighted mean direction of its streets and
walls, simplifies each centreline (junctions pinned), snaps every segment to an axis (true diagonals become an L),
solves shared coordinates as weighted least-squares means so parallel streets stay parallel, and rubber-sheets the
buildings and land use along; each outline is then squared to the grid. Streets are drawn by box distance (square
ends and corners) and each street segment is a level plateau, so height steps run straight across the road.

| Raw OSM geometry on a voxel grid | Straightened (the default) |
|---|---|
| ![raw](docs/img/baton-rouge-sherwood-florida-raw.png) | ![grid](docs/img/baton-rouge-sherwood-florida-grid.png) |
| ![raw](docs/img/baton-rouge-third-street-raw.png) | ![grid](docs/img/baton-rouge-third-street-grid.png) |

*Sherwood Forest Blvd × Florida Blvd and Third Street, Baton Rouge. Florida Blvd really meets Sherwood at about 79°; on
the straightened map it is 90° and the shopping centre slides with it.*

## The town engine

The voxels are built by `engine/`, the map generation of [voxel-tactics](https://github.com/Dankcode/voxel-tactics)
(a turn-based tactics game in Three.js), copied verbatim by `tools/sync-engine.mjs` (`engine/SOURCE.json` records the
commit and file hashes; `--check` compares). Real outlines are cut into wings at reflex corners and each wing is planned
by the game's interior builder for its real use — rooms, doors, windows, stairs, furniture; landmarks rise to their OSM
3D parts at real heights or get a style grammar (gothic, Georgian, classical, deco) from Wikidata. A map built here is
voxel-identical to the same place in the game. [docs/ENGINE.md](docs/ENGINE.md) walks through it. (The engine's
procedural generators — `operation` and `district` — are still reachable through `generate()` but are not part of the
app.)

## Fetching through Blender instead (optional)

The original pipeline, still supported: BlenderGIS in Blender fetches OSM and an OpenTopography DEM (needs a free
OpenTopography key, kept in the add-on preferences) and writes a `blender-export.json` in the same format as
`source.json`. Use it when you want the DEM from OpenTopography or a scene in Blender.


1. Install Blender (4.x/5.x) and the BlenderGIS add-on; put your [OpenTopography](https://opentopography.org) API key in
   the add-on preferences (the key is read there — never put it in a script or repo).
2. Pick the map window in metres around a point (≤ ~230 m a side at 0.9 m cells for MagicaVoxel's 256 limit):
   ```sh
   node bin/geo-voxels.mjs blender --lat 30.4583 --lon -91.0587 --window -100,71,-97,74 --pad 30 --out ./out/place
   ```
   and run the printed Python in Blender (Scripting tab, or a Blender MCP `run_blender_python` call). It runs in the
   background (Blender stays responsive), fetches DEM and OSM for the window **plus `pad` metres on every side**, and
   writes `blender-export.json` (with a `context` block) + a top-down reference render. `context_only(out)` adds the
   context to an older export without re-fetching anything else. Overpass mirrors are retried; `resume(out, 'osm')`
   re-runs only the OSM stage.
3. `node bin/geo-voxels.mjs generate --generator place --geo out/place/blender-export.json --out out/place/map` (or open the
   export in the app; `build` for the light builder).

Use `dem='USGS10m'` (3DEP, US, bare earth) wherever it exists. `SRTMGL1` is a *surface* model — buildings bleed into it
(downtown Baton Rouge read 21–46 m on SRTM vs 14.5–16.1 m on 3DEP).

## The method

[docs/METHOD.md](docs/METHOD.md) explains every stage. In short:

1. **Frame** — rotate by the length × class weighted 4θ mean of street segments and building walls, crop to the window
   (the padded fetch means a rotated window has real data in its corners), one uniform scale.
2. **Straighten** — Douglas–Peucker the centrelines (junctions pinned), snap each segment to an axis (true diagonals
   become an L), tie shared coordinates by union-find and solve them as the weighted least-squares mean, keeping
   parallel carriageways in order; rubber-sheet buildings and land use along; square each outline to the grid.
3. **Footprints** — rasterise, one party wall between touching buildings, cut into wing rectangles at reflex corners.
4. **Streets** — box (L∞) distance gives square road ends and corners; junction squares belong wholly to the longer
   street (nearest-wins would split them diagonally).
5. **Lots and open land** — mapped parking, implied strip-centre car parks (retail land only) with a storefront walk and
   stall rows per section; parks and grass are lawn, named plazas paved, footpaths straight paved walks.
6. **Terrain** — DTM → whole-voxel heights; buildings, lots and *each street segment* are level plateaus, touching
   plateaus ≤ 1 step apart, the rest relaxed — so height steps run straight across streets.
7. **Voxels** — ground, surfaces, shells (storeys, glazing, doors facing the street or the car park, roof, parapet),
   OSM 3D parts above the shell at their real heights with their roof shapes, real trees.
8. **Paint** — a road-paint plan (centre/lane/edge lines, stop bars, crosswalks) as quads for the renderer.

## Layout

```
app/                            Place Builder (Vite + Three.js + Leaflet): selector.js (area picker), main.js, worker.js,
                                mesher.js, props.js, signs.js, details-view.js
src/live/                       live fetch: fetchPlace.js, overpass.js, terrain.js, wiki.js, png.js
src/details.js                  signs, building directory, docs on the built map
engine/                         the town engine (synced from voxel-tactics; SOURCE.json)
src/town.js                     generate(): engine map → MapResult (+ details for real places)
src/plugins/tactics.js          tactics plugin (spawns, cover, gate metrics)
src/vox.js                      .vox writer (browser + Node)
skill/voxel-map-builder/        Claude skill: real-place maps with this repo in any project
tools/sync-engine.mjs           copy / check the engine against a voxel-tactics checkout
blender/blender_geo_import.py   Blender stage (BlenderGIS OSM + DEM, padded window, status file, resume)
src/frame.js                    frame, rasterisation, DEM → heightfield, plateaus + relaxation
src/rectify.js                  street straightening, rubber sheet, outline squaring
src/footprint.js                outline → wings, party walls
src/osm.js                      OSM tag rules (street classes/widths, slip lanes, storeys, use)
src/context.js, src/uses.js     tenants, uses, 3D parts, Wikidata facts, street furniture per building
src/roadPaint.js                road-paint plan from the road graph
src/build.js                    buildPlace: every stage in order
src/grid.js, src/export.js      VoxelGrid, MagicaVoxel .vox, PNG slate
bin/geo-voxels.mjs              CLI
examples/                       Baton Rouge (Third Street, Sherwood & Florida, Old State Capitol) and Philadelphia
                                (Independence Hall) Blender exports; live-third-street/source.json (a live fetch)
```

## References

- D. Lysz, [BlenderGIS](https://github.com/domlysz/BlenderGIS) — OSM and DEM import into Blender.
- [OpenTopography API](https://portal.opentopography.org/apidocs/) — USGS 3DEP (`usgsdem`) and global DEMs.
- M. Sester, *Generalization based on least squares adjustment*, IAPRS XXXIII-B4 (2000) — least-squares map generalisation.
- S. Cabello, M. de Berg, M. van Kreveld, *Schematization of networks*, Comput. Geom. 30 (2005) — rectilinear schematisation.
- A. Saalfeld, *Conflation: automated map compilation*, IJGIS 2(3) (1988) — rubber-sheeting.
- D. Camozzato et al., *Procedural floor plan generation from building sketches* (2015) — outline → wings.
- M. Gumin, [WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse) (2016) — the constraint solver behind parcel and building choices.
- D. Douglas, T. Peucker, *Algorithms for the reduction of the number of points…* (1973).

## Licence

Code: MIT ([LICENSE](LICENSE)). Example data: © OpenStreetMap contributors (ODbL) and USGS 3DEP (public domain) — see
[DATA.md](DATA.md). BlenderGIS (GPL-3.0) is a separate install; this repo only calls it.
