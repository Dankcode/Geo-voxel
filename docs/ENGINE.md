# The town engine

`engine/` builds the voxels: terrain, streets, building shells, rooms, doors, stairs and furniture. It began as the
map generation of the voxel-tactics game (forked at voxel-tactics `4ab3623`, 2026-10-21) and is now Geo-voxel's own
code; the game converts Geo-voxel maps for its own use. Parts that exist only for the game (weapons, ballistic
material fields, cover and line-of-sight rules, spawns and objectives, the procedural `operation` and `district`
generators) are still here and are being removed: [PLAN-geo-voxel-02](plans/PLAN-geo-voxel-02.md), phase A. They are
marked *(game, to be removed)* below.

Cells are 1 voxel wide; a storey is a floor slab plus two voxels of headroom (3 voxels); x runs east, y south, z up.

## Operation — an XCOM-style plot (`mapgen/Generator.js`) *(game, to be removed)*

`generateOperation({ plot, seed })` → `compileV3Map(layout)`:

1. **Plot** (`PlotCatalogue.js`) — the theme picks a road layout on a grid of 8 × 8 lots (downtown: a main road and a
   cross street over a subway; industrial: access + service road over a storm drain; suburb: a close with a turning
   circle).
2. **Guide fields** (`Fields.js`) — the line of play from the insertion to the objective, its flanks, sightlines, a
   height intent and fBm noise; every later choice is weighted by them.
3. **Districts → lots → bays** (`ExteriorSolver.js`) — a hierarchical wave-function collapse: a district type per
   16 × 16 quad (commercial, residential, industrial, park, plaza, yard), a parcel template per lot (`LotCatalogue.js`,
   `ParcelTemplates.js`; multi-lot parcels must assemble, frontage faces a road), then 2 × 2 bays of cover, vehicles,
   trees and street furniture with sockets (cars along lanes, benches along sidewalks, nothing seals a street).
4. **Buildings** — programmes (`OperationDesigner.js`), interiors (`InteriorPlanSolver.js`: a core, rooms on a bay
   grid), facades (`FacadeSolver.js`), fire escapes and ladders (`AccessModules.js`), storeys (`StoreyCompiler.js`), the
   underground (`UndergroundCompiler.js`), street dressing and lighting.
5. **Gates and repair** (`Gates.js`, `Critic.js`, `Repair.js`) — measure cover gaps, sightlines, reachability, spawn
   safety; a failure un-collapses only the region around it and re-solves it with pins toward the fix (after Merrell's
   model synthesis). Every repair is recorded, so the same seed rebuilds byte-identically.

## Large districts (`mission/LargeDistricts.js`, `mapgen/district/`) *(game, to be removed)*

A skeleton per theme — footprint (rectangle, L, T), levels, roads, landmark features (the merged arcade, drainage
channels, terraces, sunken boulevards) — then `District.js` fills everything between the roads:

1. **Blocks** (`MixSolver.js`) — maximal rectangles of free land on a 2-cell bay grid, one level each.
2. **Partition** — frontage-aware split of each block into parcel leaves sized for the mixes.
3. **Mix WFC** — each leaf takes a mix from `MixCatalogue.js` (shop + lot, house + drive + yard, warehouse yard,
   motel, gas station, car dealership, scrapyard, bus depot …): hard fit (size, frontage, level), no identical
   neighbours unless repeatable, zoning (no warehouse yard beside a house plot), caps and landmark counts.
4. **Build, then dress** — every parcel builds first (door approaches reserved), then every parcel dresses; vehicles
   stand in slots chosen by a noise model (`VehicleNoise.js`: occupancy by slot kind, traffic and time of day).
5. **Strips** — leftover land becomes alleys, verges, boundary paths, greens or world-edge strips; touching buildings
   merge through shared walls; skybridges join buildings across streets (`Skybridge.js`).
6. **Cover repair** (`CoverRepair.js`) — open ground beyond the gap limit gets a real object from the land use there.

`params.remix` (`DistrictRemix.js`) steers it: building count, storeys, traffic, pedestrians, walls, glazing, corners,
terrain, skybridges, furnishing.

## Real places (`mission/GeoDistrict.js`, `mapgen/geo/`)

The BlenderGIS export → frame and crop (`GeoFrame.js`) → straighten every street to the grid (`GeoRectify.js`) →
terrain plateaus → streets by box distance, car parks and real open land → real outlines cut into wings and built per
real use (`GeoBuildings.js`, `GeoContext.js`, `GeoPrograms.js`) → landmarks (`GeoLandmark.js`) → road paint and street
props (`GeoRoadPaint.js`, `GeoStreetProps.js`) → the district fill with a building cap of zero → cover repair (skip it
with `coverRepair: false`). `../docs/METHOD.md` has the method in full.

## The building builder (`mission/modern/ModernBuilder.js`, `MapKit.js`)

Every generator ends here. A building is a programme laid out as rows of rooms from the street front to the back,
1-voxel partitions, a door per room, windows by glazing style, stairs, and furniture per room kind (`ROOM_FURNITURE`).
Voxels are the truth; `hints` (how a renderer should draw a furniture voxel) and `decor` (rugs, plants, lamps, street
lights …) are visual extras. A building may bring its own plan as `programDef` (the landmark plans do).

## Materials and voxels (`voxel/`)

`Materials.js` defines every material (colour, solid, opaque, glass, walkable, family; hit points and bullet
resistance are game fields, to be removed); `VoxelStore.js` holds the grid. `world/PathSearch.js` (reachability) and
`world/StairRun.js` stay: the interior checks use them. The game's rules beside them (`Cover.js`, `Destruction.js`,
`Raycast.js`) are to be removed.

## Interiors

The engine's interiors come from `planRows` (rows of rooms from the street front to the back). The planned houses in
`architecture/` (Merrell et al. 2010 on the real footprint, a 21-check gate, IFC4 models) are a separate, more
accurate pipeline; importing their plans into the voxel maps is [PLAN-geo-voxel-02](plans/PLAN-geo-voxel-02.md),
phase C. See [FINDINGS.md](FINDINGS.md) for why interiors are designed in vectors and voxelised last.

## Provenance

`engine/SOURCE.json` records the voxel-tactics files and commit the engine was forked from. `tools/sync-engine.mjs`
(`npm run engine:sync` / `engine:check`) compares against a game checkout; it no longer applies, because the engine
is maintained here, and it will be replaced by a short `engine/PROVENANCE.md` (plan 02, phase A).
