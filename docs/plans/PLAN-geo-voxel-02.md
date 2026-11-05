# PLAN-geo-voxel-02 — Geo-voxel becomes Map Interior Generator, a 3D-modelling world generator; voxels and the game go to voxel-tactics

Status: **approved by Leon, 2026-11-05 11:02** (revision 2 with every recommendation in §9; the project is renamed
**Map Interior Generator**, §0a). Not yet implemented: no code has been changed in either repository. Each phase
is implemented and reviewed separately, in the order A → B → D → C → E. Phase F is a backlog.

Supersedes [PLAN-geo-interiors-01](PLAN-geo-interiors-01.md) §5–§8. That plan's interior design was built as the
Python house pipeline in `architecture/`. Its §6 idea (feed a planned interior into the voxel `buildModern`) now lives
in voxel-tactics, as phase E.

## 0. Leon's decisions (2026-11-05)

| # | Decision |
|---|---|
| D1 | Remove the XCOM-style procedural town generators from Geo-voxel completely. They belong to voxel-tactics, which converts files downloaded from Geo-voxel with its converter. |
| D2 | Remove every game material from Geo-voxel (weapons, ballistics, cover, spawns, elements …); it belongs to voxel-tactics for conversion. |
| D3 | Remove the voxels from Geo-voxel. Geo-voxel creates generated buildings, interiors and their surroundings with 3D modelling tools. |
| D4 | Make the Python pipeline installable. |

## 0a. The new name (Leon, 2026-11-05)

| What | Name | Checked free (2026-11-05) |
|---|---|---|
| Project | **Map Interior Generator** | — |
| GitHub repository | `Dankcode/map-interior-generator` (renamed from `Dankcode/Geo-voxel`; GitHub redirects the old repository URLs and clones, but **not** the Pages site: `dankcode.github.io/Geo-voxel/` stops working and the site moves to `dankcode.github.io/map-interior-generator/`) | no repository of that name |
| Python distribution | `map-interior-generator` (`pip install map-interior-generator`) | not on PyPI |
| Import package and CLI | `mapinterior` (`import mapinterior`, `mapinterior area …`) | not on PyPI, no repository |
| Download package | `map-interior/area@1` | — |
| Building export | stays `geo-voxel/building-export@1` for v1 (voxel-tactics and published files read it); `map-interior/building-export@2` only with a real field change | — |

"map-interior" alone is avoided: it collides with *interior mapping*, a well-known game shader technique.

## 1. Goal

1. **Map Interior Generator** (formerly Geo-voxel) = real map data → 3D models: planned buildings with interiors (FreeCAD, IFC4), their street
   surroundings, and whole-area scenes (Blender, glTF), plus per-building game exports. No voxels, no game code.
2. **voxel-tactics** = everything voxel and everything game. It owns the conversion from Geo-voxel downloads into
   voxel maps.
3. **The Python pipeline** installs with `pip`.

## 2. Non-goals

- No change to the planner's cost, moves, gate or scores.
- No change to `building-export@1` fields (phase D only publishes its schema).
- No new building types, styles or regions; non-house buildings get massing models only (phase C).
- No hosted server: generation stays in GitHub Actions or on the user's machine.
- No changes to voxel-tactics outside `tools/places/` and the new converter module, and none to its gameplay,
  sprites or client. Its own uncommitted work (sprites, audio, `tileset.glb`) is left alone.
- No pushes. Leon pushes both repositories.

## 3. Current evidence (read-only, 2026-11-05)

### What Geo-voxel's voxel side is, and who uses it

| Part | Paths | Used by |
|---|---|---|
| Town engine (copy of `voxel-tactics/shared`) | `engine/` (~120 files) | Geo-voxel's Place Builder via `src/town.js` |
| Voxel map library | `src/` (build, frame, rectify, footprint, osm, context, uses, roadPaint, grid, export, vox, details, town, index, `live/`, `plugins/tactics.js`) | the Place Builder, the CLI, **and voxel-tactics' importer** |
| Place Builder app | `app/index.html`, `app/src/*`, `app/vite.config.js` | GitHub Pages (root of the site) |
| CLI | `bin/geo-voxels.mjs` | voxel-tactics `tools/places/places.mjs` runs its `build` |
| Blender fetch stage | `blender/blender_geo_import.py` | the voxel build, optionally |
| Tests | `test/geo-voxels.test.js`, `live.test.js`, `town.test.js` | `npm test` |
| Inputs | `examples/` (Blender exports, `live-third-street/source.json`) | tests, docs |
| Docs and tooling | `docs/METHOD.md`, `docs/ENGINE.md`, `docs/img/*`, `skill/voxel-map-builder/`, `tools/sync-engine.mjs`, `package.json`, `package-lock.json` | — |

**The engine needs no merge.** Hashing every `engine/` file against `engine/SOURCE.json` (sha256, first 16 hex
digits) shows **0 files edited in Geo-voxel since the sync** and **24 files changed in voxel-tactics since**.
voxel-tactics' `shared/` is strictly newer. Five files exist only in Geo-voxel: `mission/GeoDistrict.js`,
`mapgen/GeoSite.js`, `mapgen/geo/GeoContext.js`, `GeoFrame.js`, `GeoRectify.js`. voxel-tactics retired
`GeoDistrict` on purpose in its PLAN-16 (replaced by `shared/mission/PlaceImport.js`); the other four serve only
`GeoDistrict`.

**The XCOM generators and game materials are already in voxel-tactics** (`shared/mapgen/Generator.js`,
`shared/mission/LargeDistricts.js`, `shared/content/`, `shared/voxel/`), in newer versions. For D1 and D2, nothing has
to be carried over. Deleting Geo-voxel's copy is enough.

**voxel-tactics already has a converter, and it depends on Geo-voxel's voxel code.** `tools/places/places.mjs import`
takes either Geo-voxel's `layers.json` (`geo-voxels/layers@1`) or a `source.json`. For a source it runs
`geo-voxels build` from a Geo-voxel checkout next to it (`--geo-voxel ../Geo-voxel`). `PlaceImport.js` then builds the
voxel mission. So `src/` (framing, straightening, rasterising, terrain plateaus, road paint) is the first half of the
game's converter and **must move**, not just be deleted.

### What the 3D side already has

- Houses: the full planned-and-modelled pipeline (`architecture/pipeline/`): FreeCAD BIM, IFC4, game export, viewer.
- High-rises: `architecture/highrise/` (untracked), with IFC4 and facades.
- A street-scene prototype outside the repo, `out/architecture-test/pipeline/site.py` (88 lines): ground, lawns,
  roads with kerbs, driveways and water as triangulated meshes, written as viewer JSON.
- Blender: procedural materials and EEVEE views from the audit (`blender_materials.py`, prototype), and a Blender MCP
  on Leon's Mac.
- The house viewer (`architecture/viewer/`, prebuilt Three.js bundle) already runs without Vite or `src/`.

### What packaging has to deal with

- 16 modules use `sys.path.insert` and flat imports (`import planner`, `import spec`); names like `spec`, `theme` and
  `planner` would collide if installed as top-level modules.
- FreeCAD is imported only by `bim.py` and `furniture.py`. FreeCAD is not on PyPI (conda-forge only).
- The gate needs roofs: `blueprint.py` → `roofs.py` runs the CGAL executables `roofgen/roofgen_exact` by
  `subprocess`. CGAL ≥ 6.0 is needed; Ubuntu 24.04's `libcgal-dev` is 5.6, so conda-forge (or Homebrew) is the
  reliable source.
- `architecture/highrise/highrise/` is already a package (`__init__.py`).

## 4. Phase A — hand the voxel side to voxel-tactics (in voxel-tactics; Geo-voxel untouched)

### Design

- New `tools/places/geo/` in voxel-tactics with Geo-voxel's voxel front end: `src/build.js`, `frame.js`,
  `rectify.js`, `footprint.js`, `osm.js`, `context.js`, `uses.js`, `roadPaint.js`, `grid.js`, `export.js`, `vox.js`,
  `details.js`, `live/*`, plus the `build` and `fetch` commands of `bin/geo-voxels.mjs` as `tools/places/geo/cli.mjs`,
  and `blender/blender_geo_import.py`. Not moved: `src/town.js`, `src/index.js`, `src/plugins/tactics.js` (they wrap
  the engine copy that voxel-tactics already has).
- `places.mjs` builds sources with the local `tools/places/geo/` instead of a Geo-voxel checkout; `--geo-voxel` is
  removed.
- **New converter input (`map-interior/area@1`)**: the package Geo-voxel will let users download (phase C):
  `area.json` (manifest, origin, radius), `overpass.json` (the raw Overpass response), `terrain.json` (optional
  samples), `buildings/<key>.building.json`. `places.mjs import <area dir or zip>` turns `overpass.json` into a
  `source.json` with the moved `parseOverpass`, then continues as today. Building exports are read in phase E.
- Fixtures: `examples/` → `tools/places/geo/fixtures/`; the three tests → `tools/places/geo/*.test.js`, pointed at
  the moved code and at `shared/` (newer engine). `town.test.js` covers `GeoDistrict`, which voxel-tactics retired, so
  only its `build`/layers cases move.
- Docs: `docs/METHOD.md` → `tools/places/geo/METHOD.md`; the voxel images it shows go with it;
  `skill/voxel-map-builder/` is rewritten as a voxel-tactics place-import skill. `tools/places/README.md` describes
  the new input.
- The five Geo-only engine files are **not** moved (decision P1, §9).

### Steps (Codex, TDD, in voxel-tactics)

0. Preconditions: voxel-tactics' own uncommitted work is untouched (work on a branch; stage only `tools/places/`);
   its tests green; record `places.mjs audit` for every catalog place.
1. Copy the files (§ Design). Failing test first: `places.mjs import fixtures/live-third-street/source.json` without
   a Geo-voxel checkout next to the repo.
2. Rewire `places.mjs`; the test passes; `layers.json` of every fixture is byte-identical to what
   `geo-voxels build` gives today.
3. `area@1` reader: failing test with a fixture made from `architecture/data/riverbend` (raw Overpass) → source →
   layers → import → audit passes.
4. Move the tests; voxel-tactics' full test suite green; every catalog place's audit unchanged from step 0.

### Acceptance

| Check | Pass |
|---|---|
| No Geo-voxel needed | `places.mjs import` of a source works with no Geo-voxel checkout present |
| Same layers | fixture `layers.json` byte-identical to today's `geo-voxels build` output |
| `area@1` | a Riverbend package imports and audits |
| No regressions | voxel-tactics tests green; catalog audits unchanged |

## 5. Phase B — remove the voxel side and the game from Geo-voxel (after A is merged)

### Design

Delete from Geo-voxel: `engine/`, `src/`, `app/index.html`, `app/src/`, `app/vite.config.js`, `bin/`, `blender/`,
`test/`, `examples/`, `tools/`, `skill/voxel-map-builder/`, `docs/METHOD.md`, `docs/ENGINE.md`, the voxel images in
`docs/img/`, `package.json`, `package-lock.json`. Git history keeps all of it.

Keep: `architecture/`, `app/public/houses/` (renamed `site/`, see below), `.github/`, `docs/FINDINGS.md`,
`docs/INTEGRATE.md`, `docs/research/`, `docs/plans/`, `DATA.md`, `LICENSE`, `README.md`.

- **The site**: the published bundle moves from `app/public/houses/` to `site/` and becomes the root of GitHub Pages.
  `pages.yml` uploads `site/` directly (no Node, no Vite). `build_viewer.py` writes `site/`. The workflow
  `generate-houses.yml` commits `site/` instead of `app/public/houses/`. The old `/houses/` URL redirects with a small
  `site/houses/index.html`.
- **The viewer** loses its "opened from the Place Builder" entry (`?lat&lon&blocks` keeps working, as a plain link)
  and its "Geo-voxels" title.
- **`.gitignore`**: drop the Node entries, add `__pycache__/`.
- **The rename (§0a)**: README, `DATA.md`, the architecture and high-rise READMEs, the viewer's title and header,
  `build_viewer.py` (`REPO_SLUG` default), `assets/worldmap.js` (`CFG.repo` default), `fetch_osm.py` (User-Agent),
  the issue templates and both workflows say Map Interior Generator / `Dankcode/map-interior-generator`.
  `voxel-tactics/tools/places/README.md` and `PlaceImport.js` comments point at the new name. Historical notes in
  `docs/plans/` and `docs/research/` keep the old name.
- **Leon, on GitHub (Codex can't)**: Settings → General → Repository name → `map-interior-generator`; then the About
  description and topics. Locally: `git remote set-url origin https://github.com/Dankcode/map-interior-generator.git`
  and, optionally, rename the folder `~/Documents/GitHub/Geo-voxel`.

### Steps (Codex)

0. Preconditions: phase A merged in voxel-tactics; Geo-voxel tree clean (commit the uncommitted high-rise work first,
   as its own commit); record the house and high-rise test results.
1. Move `app/public/houses/` → `site/`; update `build_viewer.py`, both workflows and links. `python
   architecture/build_viewer.py` rebuilds `site/` byte-identically (apart from paths).
2. Delete the voxel side (§ Design).
3. `grep -rniE "voxel|tactic|weapon|calib|spawn|objective|xcom|engine/|src/|vite"` over everything kept returns only
   intentional text (the repository name, history notes in `docs/plans/`, `FINDINGS.md` §8 on voxel resolution).
4. Run the Python tests and a local Pages build (`site/` served statically): the viewer loads, the world map opens a
   request issue, every model and blueprint opens.
5. Docs: README, INTEGRATE and the architecture README describe the 3D-only project; the converter is described as
   voxel-tactics' (with the link).

### Acceptance

| Check | Pass |
|---|---|
| Python tests | green, same results as step 0 |
| Site | `site/` served as-is: viewer, world map, models, blueprints, game export all work |
| Workflows | `pages.yml` deploys `site/`; `generate-houses.yml` commits to `site/` (dry run on a test issue) |
| Grep (step 3) | clean |
| Rename | `grep -rn "Geo-voxel\|geo-voxels\|Dankcode/Geo-voxel"` outside `docs/plans/`, `docs/research/` and the export schema id returns nothing; the published viewer opens request issues on the new repository |
| Size | file count and repository size before and after, reported |

## 6. Phase D — installable Python package (before C, so new code lands in the package layout)

### Design

- One distribution, **`map-interior-generator`** (import package `mapinterior`), from a `pyproject.toml` at the repository root:
  - `mapinterior.houses` ← `architecture/pipeline/*.py` (flat imports become package-relative imports; no
    `sys.path.insert`).
  - `mapinterior.highrise` ← `architecture/highrise/highrise/`.
  - `mapinterior.api`: `plan_footprint(polygon, *, crs="lonlat"|"local", tags={}, storeys=None, street_bearing=None,
    party_edges=(), record=None, style="auto", seed=1) -> Plan`, `gate(plan)`, `to_export(plan)`, `to_ifc(plan, path)`,
    `generate_area(lat, lon, blocks, ...)`.
  - Console script **`mapinterior`**: `fetch`, `area`, `restyle`, `plan` (GeoJSON footprints in, no OSM fetch),
    `export`, `viewer`, `doctor`.
  - Data paths: outputs go to a directory the caller gives (default `./mapinterior-out`), never inside the installed
    package. `ARCH_OUT` keeps working.
- **Dependencies.** Core: numpy, scipy, shapely ≥ 2. `pip install map-interior-generator` plans, gates, writes blueprints and game
  exports. Extras: `[ifc]` adds `ifcopenshell` (read-back checks). FreeCAD (models) and CGAL ≥ 6 (roofs) can't come
  from PyPI, so:
  - `mapinterior doctor` reports what is present, and how to get the rest.
  - `mapinterior build-roofgen` compiles the two roof tools into the user's cache (from the `.cpp` files shipped as
    package data) when CGAL, GMP and MPFR are present (conda-forge, or `brew install cgal`). `MAPINTERIOR_ROOFGEN` points
    to prebuilt binaries.
  - `environment.yml` keeps the full stack and ends with `pip install -e .`.
- `architecture/pipeline/*.py` entry scripts stay as thin wrappers for one release (the workflow and existing notes
  use them), then go.
- `building-export@1` gets a JSON Schema: `mapinterior/schemas/building-export-1.schema.json` (2020-12), written from
  the current files, with a validation test.
- Install sources: `pip install git+https://github.com/Dankcode/map-interior-generator` now; a PyPI release is decision P3.

### Steps (Codex, TDD)

0. Baseline: plan hash, gate result and time for the 5 example houses, the 9 Riverbend houses and the 5 high-rise
   samples, in the current layout.
1. Schema: test that every existing export validates (fails until the schema exists).
2. Create the package and move the modules; convert imports. The baseline is reproduced exactly (same plan hashes,
   same gate results).
3. `api.plan_footprint` on a 10 × 14 m rectangle: same seed → same hash; gate passes; export validates.
4. `mapinterior plan footprints.geojson`: a two-house fixture plans offline.
5. Clean-venv test (no FreeCAD, no CGAL): `pip install .` → `mapinterior doctor` explains what is missing;
   `plan_footprint` raises a clear error naming `build-roofgen` only when a roof is needed.
6. Conda test: `micromamba create -f environment.yml` → `mapinterior area …` builds models as today.
7. Workflow: `generate-houses.yml` calls `mapinterior area`; dry run on a test issue.
8. Docs: INTEGRATE §4–§5 use the package; README install section.

### Acceptance

| Check | Pass |
|---|---|
| Determinism | every baseline plan hash and gate result reproduced |
| Schema | all exports validate |
| pip, no FreeCAD | install works; `doctor` is accurate; plans and exports work with `roofgen` present |
| Conda | full build unchanged |
| Workflow | green on a test issue |

## 7. Phase C — areas as 3D scenes (Blender), and the download package

### Design

- `mapinterior.site` (from the `site.py` prototype): from `overpass.json` and terrain samples, build the area's
  surroundings as meshes in true metres: terrain (AWS Terrain Tiles, as the old fetch did, or flat), roads with
  carriageway, kerb and sidewalk widths from OSM classes, footpaths, lawns, car parks with stall lines, driveways to
  each planned garage, water, mapped trees.
- Buildings in the scene:
  - planned houses and high-rises: their models, converted from IFC to meshes (IfcOpenShell geometry);
  - every other building: a massing model (extruded footprint at its OSM height or storeys, flat or OSM
    `roof:shape` roof, OSM `building:part` pieces), marked "massing" in the viewer and the manifest.
- **Blender** (headless, `bpy` 4.2 on Python 3.11, the same interpreter as the conda env, or `blender -b --python`)
  assembles the scene, applies the procedural materials from the audit (brick, siding, shingles, membrane, asphalt,
  grass …) and writes `area.glb` and a preview image. FreeCAD stays the building modeller.
- **Download package `map-interior/area@1`** (zip, from the viewer and from `architecture/areas/<id>/`): `area.json`,
  `area.glb`, `overpass.json`, `terrain.json`, `buildings/<key>.{building.json,ifc,glb}`, `README.txt` with the
  credits. It's what the voxel-tactics converter reads (phase A step 3, phase E).
- Viewer: an **Area** view showing `area.glb` (orbit, click a building to open its plan, model and checks).

### Steps (Codex, TDD)

1. `site.roads`: a fixture street gives the carriageway, kerb and sidewalk polygons at the expected widths.
2. `site.terrain`: a flat fixture and a sampled fixture; buildings sit on their ground.
3. Massing for non-house buildings: height from tags, roof shape from tags, fallback rules reported.
4. Scene assembly in Blender: `area.glb` for Riverbend opens in Blender and three.js; every planned house is present
   and in place (centroid within 0.5 m of its OSM footprint).
5. Package writer and reader round trip; the voxel-tactics `area@1` import (phase A) accepts it.
6. Viewer Area view.

### Acceptance

| Check | Pass |
|---|---|
| Placement | every building within 0.5 m of its OSM footprint; ground under every door |
| Coverage | every building in the area is planned or massing; reasons listed |
| Package | validates; voxel-tactics imports it |
| Cost | Riverbend (≈ 40 buildings) assembles in ≤ 2 min on the Actions runner, on top of planning time |

## 8. Phase E — the converter reads planned buildings (in voxel-tactics)

The old phase C, moved to where the voxels live. `shared/mapgen/interior/importPlan.js`: `building-export@1` → a
`worldPlan` per wing on the place's cell grid (rooms, walls, doors, exits); `buildModern` takes `spec.worldPlan`
(output byte-identical when absent); `PlaceImport` uses a building's export when the package has one and falls back to
the game's own planner otherwise, reporting why. Voxel size is the game's choice; FINDINGS §8 gives the expected
area loss. Steps and acceptance as in PLAN-geo-interiors-01 §7–§8, run in voxel-tactics, with an extra check that
door pairs and room kinds match the export. Planned in detail in a voxel-tactics PLAN after phases A–C.

## 9. Decisions (all resolved 2026-11-05: Leon took every recommendation; P4 = rename, §0a)

| # | Question | Options | Recommendation |
|---|---|---|---|
| P1 | The five Geo-only engine files (`GeoDistrict` and its helpers) | (a) drop, history keeps them; (b) copy into voxel-tactics as an archive | (a): voxel-tactics replaced them with `PlaceImport` on purpose |
| P2 | The Place Builder app (voxel viewer, area picker, signs, Details tab) | (a) retire; (b) move to voxel-tactics as a preview tool | (a): it runs on `GeoDistrict`, which voxel-tactics retired; the game's client previews imports. Its area picker, signs and Wikidata/Commons details are noted as ideas for the Area view (phase F) |
| P3 | Package publication | (a) install from GitHub only; (b) also PyPI | (a) now, (b) once the API has settled |
| P4 | Repository name | (a) keep `Geo-voxel`; (b) rename (GitHub redirects old URLs) | **Resolved: rename to Map Interior Generator** (§0a) |

## 10. Phase F — backlog (not approved)

1. Signs, shop fascias and house numbers as meshes in the Area view; Wikidata and Commons details per building.
2. Planned interiors for commercial buildings (storefront, office, big box, school, civic) instead of massing.
3. Two-storey houses larger than their record (FINDINGS §7); narrow lots; rear-load garages.
4. Infinigen furnish-only spike; planner experiments (grid-line count, access angle).
5. High-rise: wire storeys to OSM `building:levels`; towers and four-dwelling floors.
6. PyPI release with wheels that bundle `roofgen` (scikit-build-core + cibuildwheel, CGAL fetched at build time).
7. Manuscript (FINDINGS.md is its outline).

## 11. Risks

- **R1 The game loses its importer between phases.** voxel-tactics calls Geo-voxel's `build` today. Mitigation: A
  lands and is merged before B deletes anything; A's test runs with no Geo-voxel checkout present.
- **R2 Unrelated work in voxel-tactics.** It has uncommitted sprite, audio and tileset changes. Mitigation: work on a
  branch, stage only `tools/places/` and the new converter files, never `git add -A`.
- **R3 Packaging changes behaviour.** Mitigation: phase D reproduces every baseline plan hash before anything else.
- **R4 Heavy Actions runs.** Blender plus FreeCAD plus planning per area. Mitigation: phase C's cost check; massing
  for non-house buildings; cache conda and Blender in the workflow.
- **R5 Broken links.** `/houses/` and the README's voxel images. Mitigation: a redirect page; a link check in B4.

## 12. Rollback

- A: delete the branch in voxel-tactics; nothing in Geo-voxel changed.
- B: revert the commit (git keeps every deleted file); Pages redeploys the old app.
- D: revert; the old scripts are still there for one release anyway.
- C, E: additive; revert the commits.

## 13. Review requirements

- A and E change the game's import path: independent review of the diff and the catalog audit table before merge.
- B deletes most of Geo-voxel: review the delete list against §3 and the acceptance table before merge.
- D touches every pipeline module: review the import conversion and the baseline-hash table.
- No secrets or tokens are involved. The workflows change in B and D; check them on a test issue before merge.
