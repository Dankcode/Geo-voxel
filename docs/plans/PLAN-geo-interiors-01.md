# PLAN-geo-interiors-01 — Map-driven building interiors (Merrell-style program + plan optimization)

Status: **superseded (2026-11-05)** by [PLAN-geo-voxel-02](PLAN-geo-voxel-02.md). Kept for the record.

What happened to it: the design in §5 (a program sampler, Metropolis on a fixed outline, a gate with restarts, doors
near corners, a stair room on every storey) was built and tested as the Python house pipeline in `architecture/`
rather than as JavaScript modules in `engine/`, and grew well beyond this plan (person-width rule, door swings, roofs,
IFC4, game export; see `docs/FINDINGS.md`). Findings F1–F5 below still describe the voxel map builder. The §6 hook
into `buildModern` survives as plan 02 phase C, which imports the Python pipeline's plans instead of re-implementing
the planner. §4's note on `engine/` ownership is carried further by plan 02 phase A, which removes the game code.

Original status: draft, awaiting Leon's approval. Planning only; no code had been changed.
Source method: `docs/research/merrell-2010-building-layouts.md` (digest and audit of Merrell, Schkufza & Koltun 2010).

## 1. Goal

Rebuild the interior of each real building the place generator makes, from that building's own map data: footprint,
use, area, storeys, tenants, street frontage, party walls and OSM entrances. Each building gets one coherent,
building-wide **program** (room list, sizes, adjacencies, privacy tiers, a different list per storey) and a **floor
plan per storey**, optimized on the voxel grid inside the real, fixed outline. The plans are compiled into the
engine's existing room/wall/door contract, so shells, glazing, stairs, furniture, `layers.rooms`, the app and the
exports all keep working.

## 2. Non-goals (v1)

- No change to the procedural `operation` / `district` generators, exteriors, landmark dressing, roofs or terrain.
- No trained Bayesian network and no external floor-plan dataset. v1 uses hand-authored conditional tables (a
  hand-specified network); learning from data is a later plan.
- No whole-footprint shell. Wing seams from `decomposeFootprint` stay as **fixed** walls in v1; making them movable
  needs a shell compiler for non-rectangular outlines (PLAN-geo-interiors-02).
- No non-rectilinear walls, no change to floor or ceiling heights, and the 3-storey cap in `buildModern` stays.
- No furniture-solver rewrite (rooms keep their existing kinds, so `ROOM_FURNITURE` furnishes them).
- Landmarks (`GEO_PROGRAMS` with a style grammar) keep today's plans in v1.
- The default stays the old behaviour. The new solver is behind a flag until a separate approval flips it.

## 3. Current evidence (read-only audit, 2026-10-29, HEAD `41f88a1`)

Pipeline today: `GeoDistrict.buildGeoDistrict` → per footprint `buildFootprint` (`engine/mapgen/geo/GeoBuildings.js`)
→ `decomposeFootprint` cuts the outline into ≤ 8 wing rectangles (≥ 5 cells) → **each wing** becomes `m.building(...)`
→ `buildModern` (`engine/mission/modern/ModernBuilder.js`) → `planRows(W-2, D-2, prog)` slices the wing into fixed
front-to-back rows of fractional rooms.

Findings, verified by running the code on the bundled examples (Node, seed 1, `straighten: 'grid'`):

| # | Finding | Evidence |
|---|---|---|
| F1 | **Every wing gets the full program on its own.** A multi-wing building repeats its entry room, kitchen and so on in each wing. | `buildFootprint` passes `program: b.program` to every wing record. Third Street: 3 of 4 multi-wing buildings have duplicate ground-floor entry rooms. Live Third Street: 2 of 3. |
| F2 | **Every storey repeats the ground-floor plan**, remapped only through `prog.upper`. Programs without `upper` (house, bungalow, shop, diner …) copy the ground floor upstairs. | A 2-storey `house` (13 × 15) produces `living, kitchen, bedroom, bathroom, study` on **both** storeys. |
| F3 | **The program ignores size.** Room lists are fixed; only the fractions scale. A 50 m² house and a 400 m² house get the same five rooms. | `PROGRAMS` / `GEO_PROGRAMS` rows; `planRows` `split()`. |
| F4 | **Doors sit at wall midpoints**, both partition doors (`addDoor` → `mid`) and wing-line doorways (`cands` sorted by distance to `mid`). Merrell §6 / Alexander: put them near corners. | `ModernBuilder.js` `addDoor`; `GeoBuildings.js` shared-line loop. |
| F5 | **OSM entrance nodes are fetched but never used** for doors. | `src/live/overpass.js:20,96` → `details.entrances`; no use in `GeoDistrict.js`. |
| F6 | The storey cap is documented as 4 but built as 3. | `storeysFromTags` clamps to 1–4 ("the kit cap"); `buildModern` and `maxStoreys` cap at 3; recorded in `report.storeys`. Docs mismatch only. |
| F7 | `engine/` is a verbatim copy of `voxel-tactics/shared`, and `engine/SOURCE.json` says `"dirty": true`. | `tools/sync-engine.mjs`, `docs/ENGINE.md` "Keeping it in sync". |

Baseline build times (Node, whole example): Sherwood–Florida 1.6 s (5 buildings), Third Street 1.9 s (15 buildings,
21 wing records), live Third Street 2.0 s (21 buildings, 25 wing records). Tests: `npm test` runs 3 files
(geo-voxels, live, town).

## 4. Decision: code lives in Geo-voxel (settled 2026-10-29)

Leon: Geo-voxel is a separate project focused on generating 3D worlds; maps reach voxel-tactics through a conversion
step, so the sync check and "voxel-identical to the game" no longer constrain this work. The interior modules and the
three hooks are implemented **in this repo** (`engine/` is now owned here). `engine:check` and
`tools/sync-engine.mjs` are out of scope for this plan; retiring them is a separate change. Read "upstream" below as
"in `engine/` here".

## 4a. Test run evidence (prototype, 2026-10-29)

A throwaway prototype of §5 (`out/interior-test/prototype/`, outside the source tree) was run on a random house in
Baton Rouge's Garden District: OSM way 1037426699 on Brice Street, `building=yes`, no levels or use, 18.0 × 8.1 m
footprint, street front west.

- The current generator builds it as a **shop** (sales, storeroom, office), the same plan on both floors. That's
  F2/F3, plus a new finding, **F8**: untagged `building=yes` inside `landuse=residential` falls through to the
  size rule in `programFor` (< 450 m² → shop).
- Prototype, 1 storey: living at the street front with the front door, then dining and kitchen (back door), a hall
  spine, 3 bedrooms and a bathroom. 2 storeys: hall with stair, living, kitchen, WC and study downstairs; landing,
  3 bedrooms, bathroom and an ensuite upstairs, with the bathroom stacked over the WC.
- Checks: missing connections 0, every room reachable from the front door through the voxels, 0 openings on party
  walls, same seed → byte-identical `.vox`.
- Gaps the run exposed: (1) planning took 3.4 s (1 storey) and 8.0 s (2 storeys) against the 150 ms target. It's a
  full re-evaluation per iteration, so incremental cost (§5.5) is required, not optional. (2) Bedrooms came out at
  7–10 m² against 12–17 m² targets: the 0.9 m voxel walls take ~25% of a narrow house, so targets must be sized from
  open (post-wall) area and the area weight raised. (3) Room-count repair (§5.3) matters: the first 1-storey program
  (3 bed + 2 bath + dining + laundry) didn't fit 102 m² of interior.

## 5. Design

### 5.1 Data flow

```
fp (GeoDistrict: cells, area, program, storeys, tags, info.tenants, facts, party, frontScore, entrances)
  → buildingBrief(fp)                    BuildingBrief.js   map parameters → brief            (pure)
  → sampleProgram(brief, rng)            ProgramSampler.js  brief → per-storey program graph  (pure)
  → optimizePlan(brief, program, seed)   PlanOptimizer.js   Metropolis on a label lattice     (pure)
  → compilePlan(state, wings)            PlanCompile.js     → one worldPlan per wing
  → buildFootprint(..., { worldPlans })  → buildModern(spec.worldPlan) → voxels, layers.rooms (unchanged contract)
```

On any failure (no feasible program, or $C_a > 0$ after every restart), fall back to today's `planRows` for that
building and record why.

### 5.2 Building brief: the map parameters (`interior/BuildingBrief.js`)

`{ id, program, family, areaM2, usableM2PerStorey, storeys, observedLevels, heightM, mask (footprint cells),
interior (mask minus perimeter ring), wings, seams (shared wing-line cells), party (Set), exteriorEdges: [{x, y,
side, street: frontScore, party: bool}], entrances: [{x, y, kind}] (OSM entrance nodes framed into cells, ≤ 2 cells
from the outline), tenants: [{x, y, use}], style, era }`

- `areaM2 = cells × METRES_PER_CELL²` (0.81 m² per cell). `usable` = interior cells minus the share expected to go to
  walls.
- `frontScore` is evaluated **per exterior edge cell** (today it is per wing side), reusing the closure `GeoDistrict`
  already builds.
- `entrances` needs a small `GeoDistrict` change: read `geo.details?.entrances` (live fetch) and run it through the
  same frame transform as the buildings. Blender exports without it give `[]`.

### 5.3 Program synthesis (paper §4, `interior/ProgramTables.js` + `ProgramSampler.js`)

A **hand-specified Bayesian network**: for each family, an ordered list of conditional choices sampled with the
engine's seeded `Rng`. Each choice may depend on the brief and on earlier choices, never on later ones.

- Families: `dwelling` (house, bungalow, townhouse), `apartments` (building = apartments/residential with ≥ 2
  storeys), `shop`, `diner`, `supermarket`, `office`, `hotel`, `clinic`, `school`, `library`, `bank`, `civic`,
  `warehouse`, `garage`, and `mixed` (ground-floor tenants plus upper storeys, when storeys > 1 and the ground program
  is shop, diner or office).
- Example (`dwelling`): usable area bucket → bedrooms (1–5) → bathrooms (from bedrooms and area) → dining room
  exists (more likely with ≥ 3 bedrooms, as in the paper) → study exists → laundry or utility → which storey sleeps
  (≥ 2 storeys: bedrooms upstairs, living downstairs, one bath per sleeping floor) → stair room on every storey.
- Each room: `{ id, kind (existing ROOM_FURNITURE kinds), storey, tier: public|semi|private|service|circulation,
  area: {mu, sigma} m², aspect: {mu, sigma}, needsExterior, needsDaylight, wet, gameplay }`. Area means scale with
  usable area so the sum fits; sigma is a fixed fraction of mu.
- **Edges are sampled from allowed-parent tables, not independently.** Each room attaches to one parent whose kind
  the table allows (bathroom → bedroom or hall, never kitchen–bath–bedroom chains); optional extra loops only among
  public rooms. Edge type: `open` between public rooms listed in the family's `open` pairs, otherwise `door`; a
  `stair` edge links the stair room across storeys.
- **Validator** (hard): graph connected per storey; entry room public and on storey 0; privacy gradient monotone along
  the BFS tree from the entry (tier rank never decreases, service rooms exempt); a stair room on every storey when
  storeys > 1; Σ area μ within 0.75–1.05 of usable area. **Repair** (the paper has none, audit gap 6): drop the
  lowest-priority optional room, or merge (study → bedroom), then resample, at most 8 times.
- `apartments` and `office` with ≥ 3 storeys: optimize one typical upper floor and copy it (the paper's own note that
  repeating floors need no coupling). Only the ground floor and the typical floor are optimized.
- Multi-tenant strips are already cut into one unit per tenant by `GeoDistrict`; each unit gets its own brief.

### 5.4 Plan representation and moves (paper §5.1, `interior/PlanState.js`)

- One label lattice per storey (`Int16Array` over the footprint bbox) on the 0.9 m cell grid. Labels are `OUT`,
  `SHELL` (perimeter ring, immutable), `SEAM` (wing lines, immutable in v1), `WALL` (movable partition) and room ids.
- **Invariants after every move:** two different room labels are never 4-adjacent (a `WALL`/`SEAM`/`SHELL` cell
  always separates them, which is exactly `planRows`' wall contract); each room is one 4-connected component; each
  room interior is ≥ 2 × 2 cells; the stair room has identical cells on every storey it spans. A move that cannot be
  repaired to satisfy these is rejected.
- **Start state:** not the paper's deliberately bad one. Each wing is pre-split by today's `planRows` rectangles, and
  labels are assigned in tier order from the street front (public rooms on the max-`frontScore` edge). This starts
  near the privacy gradient and cuts the iterations needed.
- **Moves:**
  1. *Slide wall* (p ≈ 0.75): pick a maximal straight run of `WALL` cells and a split point (an endpoint or an
     existing junction with p = 0.5, otherwise uniform); shift one part by `d = round(N(0, σ²))`, d ≠ 0, with
     **σ = 2 cells and ε = 1 cell** (the paper's σ = 2ε). Cells crossed take the label of the room behind; the jog
     gets perpendicular `WALL` cells, which creates the concave corner. Snap to a parallel wall within ε, and to the
     wall at the same line on the storey below.
  2. *Swap rooms* (p ≈ 0.2): exchange two labels on one storey (stair room excluded).
  3. *Stair shift* (p ≈ 0.05): slide the stair room's wall on every storey it spans at once (the multi-storey
     coupling the paper identifies as the main failure cause).

### 5.5 Cost function (paper §5.2, adapted, `interior/PlanCost.js`)

All terms are measured on cells. Every cost is computed in **integer fixed point (× 1000)** for determinism (see
§9, risk R2).

$$C = k_a C_a + k_d C_d + k_s C_s + k_f C_f + k_l C_l + k_p C_p$$

| Term | Definition on the lattice | Change vs. paper |
|---|---|---|
| $C_a$ accessibility | +1 per program edge without a door-feasible wall (≥ 3 collinear separating cells, room A directly across from room B, not a junction); +1 if the entry room has no exterior run ≥ 3 cells on a non-party edge with `frontScore` ≥ the building's best − tolerance; +1 per `needsExterior` room with no such edge; +1 per room unreachable from the entry through feasible edges; +1 if the stair room can't hold a `StairRun` (rise = `STOREY`) | adds reachability, street entry and stair fit |
| $C_d$ dimensions | $-\frac{1}{n}\sum_i [\log\mathcal N(A_i;\mu,\sigma) + \log\mathcal N(r_i;\mu_r,\sigma_r)]$ with $A_i$ in m² (cells × 0.81) and $r_i$ the bbox long/short ratio | Gaussian priors replace learned distributions |
| $C_s$ shape | $\sum (1-h_i)\big[\frac{A(\mathrm{bbox}(R_i)) - A(R_i)}{A(R_i)} + \lambda_e \frac{\max(0, e(R_i)-4)}{4}\big]$ plus the same over open-wall groups; halls and stairs exempt | bbox deficit (exact for orthoconvex rooms, cheap); the edge term is normalized (audit gap 5); the outline term $k_o$ is dropped because the outline is fixed |
| $C_f$ stacking | share of upper-storey `WALL` cells not above a lower `WALL`/`SEAM`; +1 per upper wet room with no wet room within 2 cells below | replaces the support term, which is always 0 on an extruded footprint |
| $C_l$ daylight (new, from the map) | per `needsDaylight` room, $\max(0, L_{min} - L_{ext})/L_{min}$ with $L_{ext}$ the non-party exterior wall length and $L_{min} = \max(2, 0.15\sqrt{A})$ cells | uses `party` and exposure; bedrooms and offices get windows, bathrooms may be interior |
| $C_p$ privacy | per private room adjacent (by edge) to the entry room: +1 | makes the gradient explicit |

Starting weights, all in one exported constant so they can be tuned without code changes: $k_a = 100, k_d = 1,
k_s = 4, k_f = 2, k_l = 6, k_p = 2, \lambda_e = 0.5$. Costs are cached per room and recomputed only for the rooms a
move touches.

### 5.6 Optimizer (`interior/PlanOptimizer.js`)

- Metropolis with geometric annealing from $\beta_0$ to $\beta_1$ over $N$ iterations, $N = \mathrm{clamp}(400 \cdot
  n_{rooms} \cdot n_{optimizedStoreys},\ 2000,\ 40000)$. **Iteration count only, never a wall-clock budget**, so
  every build is reproducible.
- Acceptance compares integer costs against a precomputed integer threshold table (`floor(−ln(u)·1000/β)` lookup
  driven by `Rng`), so no `Math.exp` sits on the decision path.
- Gate: $C_a = 0$ and the invariants hold. Otherwise restart with seed `${seed}:${id}:r${k}`, k ≤ 3, then fall back to
  `planRows`.
- Cache: key = hash(normalized mask, seams, program, seed). Identical row houses reuse one plan, transformed.

### 5.7 Compile (paper §6, `interior/PlanCompile.js`)

- Per wing, emit `worldPlan.storeys[s] = { rooms: [{kind, cells, gameplay, tier}], walls: Set<'x,y'>, doors:
  [{x, y, open, locked, a, b}] }` plus `worldPlan.exits = [{x, y, room, entry, roller}]`. Cells are in world
  coordinates, so `buildModern` needs no frame mapping for them.
- **Doors:** for each `door` edge choose the feasible separating cell that minimizes the summed distance to the
  nearest corner of both rooms (paper §6), never a junction. `open` edges become 2-wide openings (current convention).
  Non-gameplay rooms (bathroom, restroom, utility) keep locked doors (current game rule).
- **Seam doors:** edges that cross a wing seam choose their cell by the same rule, replacing the midpoint choice in
  `buildFootprint`.
- **Exits:** the entry goes on the street-front edge of the entry room, at the exterior cell nearest an OSM entrance
  node if one lies within 2 cells, otherwise the max-`frontScore` run. Back and side exits follow the family flags.
  Never on party cells; `closeDeadExits` still runs afterwards.
- **Stairs:** today's `placeStairRun`, restricted to the stair room's cells. The stair room is pinned on every
  storey, so runs line up by construction. (Straight runs only in v1; U and L runs are v2.)

## 6. Proposed files

New, upstream `shared/mapgen/interior/` (synced to `engine/mapgen/interior/`):

| File | Responsibility |
|---|---|
| `BuildingBrief.js` | fp + frame → brief (pure) |
| `ProgramTables.js` | conditional tables per family (data only) |
| `ProgramSampler.js` | sampling, validator, repair (pure) |
| `PlanState.js` | lattice, invariants, moves (pure) |
| `PlanCost.js` | cost terms, weights, incremental cache (pure) |
| `PlanOptimizer.js` | annealed Metropolis, restarts, cache (pure) |
| `PlanCompile.js` | lattice → `worldPlan` per wing; doors, exits (pure) |
| `index.js` | `planInteriors(fp, ctx, seed)` → `{ worldPlans, report }` |

Changed (hooks only):

| File | Change |
|---|---|
| `mission/modern/ModernBuilder.js` | `buildModern`: if `spec.worldPlan`, use its per-storey rooms, walls and doors and its exits instead of `planRows`; per-storey `roomOfCell` for glazing; stairs restricted to the stair room. Untouched when the field is absent. |
| `mapgen/geo/GeoBuildings.js` | `buildFootprint(m, b, { worldPlans })`: hand each wing its plan; seam doorways from the plan; no change without the option |
| `mission/GeoDistrict.js` | option `interiors: 'rows' \| 'merrell'` (default `'rows'`); frame `details.entrances`; call `planInteriors`; add `report.buildings[].interior = { solver, rooms, cost: {a, d, s, f, l, p}, iterations, restarts, fallback }` |
| Geo-voxel `src/town.js` | pass `params.interiors` through |
| Geo-voxel `tools/sync-engine.mjs` | add `shared/mapgen/interior/index.js` to `ENTRIES` |
| Geo-voxel `docs/METHOD.md`, `README.md` | interior stage; fix the storey-cap wording (F6) |

`layers.rooms` keeps its shape (`id, buildingId, storey, kind, cells, floorZ, lit, doors`); `tier` is not exported in v1.

## 7. Ordered steps (Codex, TDD: failing test first in every step)

0. **Preconditions.** Upstream clean (commit or stash), `npm run engine:check` passes, `npm test` green in both
   repos. Record a baseline: grid hash, room count, `roomShare` and build ms for every example in `examples/`, and
   the tactics gate metrics.
1. `BuildingBrief`: tests for area conversion, the interior ring, per-edge `frontScore`, party exclusion and entrance
   framing (fixture: Third Street).
2. `ProgramTables` + `ProgramSampler`: determinism (same seed → same program); conditioning (median bedrooms rise
   with area over 200 samples); the validator rejects a kitchen–bath–bedroom chain; repair converges; 2-storey
   dwellings have no kitchen upstairs (F2).
3. `PlanState`: property tests over 1,000 random moves on rectangle, L and T masks: invariants hold, `SHELL`/`SEAM`
   untouched, stair cells identical across storeys.
4. `PlanCost`: each term on hand-built grids with known values; integer fixed point; incremental cost equals the
   full recomputation after random moves.
5. `PlanOptimizer`: same seed → identical lattice; a 12 × 14 two-bedroom house reaches $C_a = 0$ in ≥ 95 of 100
   seeds; an L footprint with one seam ≥ 90; a 2-storey dwelling ≥ 90; p95 time per building ≤ 150 ms in Node.
6. `PlanCompile`: contract matches `planRows`' output; doors avoid junctions and sit within 2 cells of a corner where
   the wall allows it; no exit on party cells; an OSM entrance within 2 cells wins.
7. `buildModern` hook: a `worldPlan` in gives the same room cells out; existing tests unchanged; with no `worldPlan`
   the grid hash is identical to baseline.
8. `GeoBuildings` / `GeoDistrict` wiring behind `interiors: 'merrell'`; report fields; fallback path tested with a
   forced-infeasible footprint.
9. Sync into Geo-voxel; `npm test`; build every example in both modes; produce the acceptance table (§8).
10. Docs (METHOD, README, the research digest). **Stop.** Flipping the default is a separate approval.

## 8. Acceptance checks

| Check | Pass |
|---|---|
| `npm test` (both repos), `npm run engine:check` | green |
| `interiors: 'rows'` on every example | grid hash byte-identical to baseline |
| Determinism (`'merrell'`, same seed twice, Node and the app worker) | identical grid hash |
| Coverage | every building with ≥ 1 wing either gets a `'merrell'` plan or reports a `fallback` reason |
| Fallback rate | ≤ 10% for 1-storey, ≤ 20% for multi-storey (paper: ~0%, 1/20, 1/5) |
| F1 fixed | no building has more than one entry-room kind (lobby, sales, dining, living) per dwelling or tenant on storey 0 |
| F2 fixed | no kitchen above storey 0 in dwellings; upper floors follow the per-storey program |
| Reachability | 0 gameplay rooms unreachable from the entry (`world/PathSearch.js`) |
| Party walls | 0 doors or windows on party cells |
| Entry | the exterior entry is on the max-`frontScore` side, or within 2 cells of an OSM entrance |
| Stairs | every multi-storey building's stair runs lie inside its stair room on every storey |
| Fidelity | `roomShare` and `iou` per building no worse than baseline − 0.02 |
| Cost | whole-example build time ≤ 1.5 × baseline (today 1.6–2.0 s) |
| Tactics gates | plugin metrics reported side by side with baseline; regressions listed, not hidden |

## 9. Risks

- **R1 Performance** (browser worker, about 25 buildings per map). Mitigations: small lattices, incremental cost,
  plan cache, iteration caps. Measured at step 5 and step 9; if it misses, lower N before touching anything else.
- **R2 Cross-engine determinism.** A float `exp` on the accept path can differ in the last bit between V8 builds and
  flip a decision. Mitigation: integer costs and the threshold table (§5.6). Test in Node and in the worker.
- **R3 Gameplay drift.** Different rooms change cover and sightlines. Mitigation: flag off by default, gate metrics
  compared, Leon decides the flip.
- **R4 Narrow footprints** (row houses with a 3-cell interior). Programs may be infeasible. Mitigation: validator
  sizing, the `townhouse` family's single-room-wide plan, fallback.
- **R5 Subjective tables.** Plausibility rests on hand-tuned priors. Mitigation: tables are data-only and reviewed as
  data; a learned model is a later plan.
- **R6 Upstream sync** (F7). Mitigation: step 0 preconditions; `SOURCE.json` must record a clean commit.

## 10. Rollback

The option defaults to `'rows'`, so rollback is: leave it, or revert the upstream commit and re-run `engine:sync`.
There are no data migrations and no change to the export formats, and saved `source.json` files rebuild identically
in `'rows'` mode.

## 11. Review requirements

The upstream engine change is higher-risk under the delegation rules: it touches the game's builder. It needs an
independent review of the `buildModern` hook diff and the step 9 acceptance table before merge. No secrets or tokens
are involved.
