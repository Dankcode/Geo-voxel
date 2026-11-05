# Codex brief — PLAN-geo-voxel-02, phase A (voxel-tactics)

Approved by Leon on 2026-11-05. Implement **only** phase A of `PLAN-geo-voxel-02.md` (§4). Don't start phase B, and
don't change anything in Map Interior Generator (formerly Geo-voxel).

| | |
|---|---|
| **Owner** | Codex, in `~/Documents/GitHub/voxel-tactics`, on a new branch `places-geo-import` |
| **Goal** | voxel-tactics builds and imports real places without a Geo-voxel checkout. Geo-voxel's voxel front end moves into `tools/places/geo/`, and the importer also reads the new `map-interior/area@1` download package. |
| **Non-goals** | No gameplay, client, sprite or `shared/` engine changes (beyond what an import path needs). No change to `PlaceImport.js` behaviour. No reading of `building.json` exports (that is phase E). No deletion in Geo-voxel. No push. |
| **Inputs (copy from `../Geo-voxel`, read-only)** | `src/build.js frame.js rectify.js footprint.js osm.js context.js uses.js roadPaint.js grid.js export.js vox.js details.js live/*`; the `build` and `fetch` commands of `bin/geo-voxels.mjs` → `tools/places/geo/cli.mjs`; `blender/blender_geo_import.py`; `examples/` → `tools/places/geo/fixtures/`; the `build`/layers cases of `test/*.test.js`; `docs/METHOD.md` and its images → `tools/places/geo/`. Not `src/town.js`, `src/index.js` or `src/plugins/tactics.js`, and none of `engine/` (voxel-tactics' `shared/` is newer; 0 local edits in Geo-voxel's copy). |
| **Area package fixture** | South Baton Rouge (centre 30.4425, −91.1659, radius 165 m; 34 houses). The bundled `architecture/data/baton-rouge-south/` holds processed JSON, not a raw Overpass response, so fetch the raw response once (the moved `live/overpass.js` query, keyless) and commit it as `fixtures/area-south-br/overpass.json`, with an `area.json` manifest (`format: "map-interior/area@1"`, origin, radius). Tests read the fixture and never touch the network. |
| **Order (TDD)** | 0. Record test results and `places.mjs audit` for every catalog place. 1. Failing test: `places.mjs import tools/places/geo/fixtures/live-third-street/source.json` with no Geo-voxel checkout. 2. Copy the files, rewire `places.mjs`, remove `--geo-voxel`. 3. `layers.json` byte-identical to `node ../Geo-voxel/bin/geo-voxels.mjs build` for every fixture. 4. Failing test, then an `area@1` reader (`overpass.json` → `parseOverpass` → source → layers → import → audit). 5. Full voxel-tactics test suite. 6. Update `tools/places/README.md`. |
| **Acceptance** | Import works with Geo-voxel moved away (rename `../Geo-voxel` temporarily, or run in a clean clone). Fixture layers are byte-identical. The South Baton Rouge `area@1` fixture imports and audits. All tests are green. Every catalog audit matches step 0. |
| **Guard rails** | voxel-tactics has Leon's uncommitted sprite, audio and `tileset.glb` changes: never `git add -A`. Stage only `tools/places/**` and the new tests. No secrets; Overpass and terrain fetches are keyless. |
| **Report** | Changed files, commands run, the before/after audit table, the layers hash table, risks, rollback (delete the branch). |
| **Review** | Independent review of the diff and the audit table before merge (PLAN §13). |
