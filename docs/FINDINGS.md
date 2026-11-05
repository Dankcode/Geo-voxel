# What we learned generating interiors from map data

This page collects the new results of Geo-voxel's interior work (October–November 2026) and the mathematics behind
them. Each section names the problem, the formula or rule we settled on, and the evidence: a before/after count on the
same buildings and seeds. Code references point into `architecture/pipeline/` (houses) and `architecture/highrise/`
(Chinese high-rise apartments).

The starting point is Merrell, Schkufza & Koltun, *Computer-Generated Residential Building Layouts* (ACM TOG 29(6),
2010). A digest and audit of the paper is in [research/merrell-2010-building-layouts.md](research/merrell-2010-building-layouts.md).
Wherever we write "the paper", we mean that paper.

**Test sets.** Most numbers come from a fixed competition set: five real Baton Rouge houses (Ducros Dr, North Shore
Ave, Park Blvd, Quail Oak Dr, Stanford Ave), five seeds each, so 25 designs. Earlier rounds used a 32-building set
(15 archetypes plus 17 Riverbend houses), and the downtown tests used the Belisle and Capitol City Press buildings on
Third Street.

---

## 1. The problem is the paper's, turned inside out

The paper designs a house *and its outline*: it only asks the ground floor to fit inside the lot, and it charges for
ragged outlines (the $k_o$ term). On a real map the outline is given. It is the OpenStreetMap footprint, with party
walls against the neighbours and one or more street fronts. So the problem becomes:

> Given a rectilinear footprint $F$ on a lattice of cell size $c$, a set of party edges $P \subset \partial F$, and a
> street score on every exterior edge, find a labelling $L$ of the cells of every storey, into rooms and walls, that
> minimises a cost $C(L)$, with the ground floor equal to $F$.

Three things follow from fixing the outline.

- Terms that shape the outline in the paper go to (nearly) constant on the ground floor. $k_o$ only matters on upper
  floors, which can still be smaller than the footprint.
- Requirements that the paper satisfies by moving the outline have to be satisfied *inside* it. Daylight, the street
  entry and outside access for garages and porches become accessibility constraints tied to particular edges of
  $\partial F$, not to any exterior wall.
- The start state matters much more (§5). The paper starts from a deliberately bad grid and lets the outline move;
  with a fixed outline, some layouts are only reachable across large energy barriers.

## 2. The cost function we use, and why each piece is there

Plans live on a label grid of 0.4 m cells per storey (0.5–0.9 m for big buildings). Metropolis–Hastings annealing
minimises

$$C = k_a C_a + k_d C_d + k_s C_s + k_f C_f + k_o \sum_i \big(e(F_i) - 4\big)$$

with $k_a = 100$, $k_d = 1.5$, $k_s = 1$, $k_f = 1000$, $k_o = 0.6$. The paper gives none of its constants; ours were
calibrated so the annealing neither freezes early nor wanders.

**Accessibility $C_a$.** One unit per programme connection without a shared wall long enough for its door, plus one
per room that cannot be reached from the entry. A connection needs 1.25 m of shared wall for a door and 1.6 m for an
open passage. Daylight and street access are folded in here, in the same form as the paper's rule for entrances,
patios and garages (§1).

**Dimensions $C_d$.** For every room (halls, stairs and porches included, see §3):

$$C_d^{(i)} = \tfrac12\Big(\frac{A_i-\mu_A}{\sigma_A}\Big)^2
\;+\; \tfrac14\cdot\tfrac12\Big(\frac{\ln r_i-\ln\mu_r}{\sigma_r}\Big)^2
\;+\; \tfrac12\Big(\frac{\max(0,\,r_i-r_{\max})}{0.5}\Big)^2
\;+\; 4\,n^{\text{narrow}}_i$$

where $A_i$ is the area, $r_i \ge 1$ the bounding-box aspect ratio (long side over short side), and
$n^{\text{narrow}}_i$ the number of cells in strips too narrow for a person (§4). The aspect prior is log-normal:

| Room | $\mu_r$ | $\sigma_r$ | $r_{\max}$ |
|---|---|---|---|
| Ordinary rooms | 1.35 | 0.25 | 2.0 |
| Halls and corridors | 2.5 | 0.5 | — |

Area targets $\mu_A$ come from the programme (§7), $\sigma_A$ is a fixed share of $\mu_A$. A hall's target is
$\mu_A = 1.1\,\text{m}\times(0.9\,\text{m}\cdot n_{\text{served}} + 1.5\,\text{m})$, $\sigma_A = 0.35\,\mu_A$.

**Shape $C_s$.** The paper's convexity measure, summed over rooms that are lived in (halls and stairs exempt) and over
groups of rooms joined by open walls:

$$M_c(S) = \frac{A(H(S)) - A(S)}{A(S)} + \big(e(S) - 4\big)$$

$H(S)$ is the convex hull and $e(S)$ the number of corners. A rectangle costs exactly 0; an L-shaped room costs 2 plus
its notch fraction. Shifting $e$ by 4 is free: moves never add or delete rooms, so a constant per room cancels in every
$\Delta C$ and the Metropolis chain is unchanged. Porches weigh $M_c$ four times, so their posts line up on straight
edges; garages six times, because a car hits a notch.

**Floors $C_f$.** The paper's support term, unchanged:

$$C_f = \frac{\sum_{i\ge1} A\big(F_i \setminus F_{i-1}\big)}{\sum_{i\ge1} A(F_i)}$$

With $k_f = 1000$ it acts as a hard constraint: an upper floor stands on the floor below.

**Acceptance.** A proposal $x^\star$ is kept with probability $\min\big(1, e^{-\beta\,\Delta C}\big)$, with $\beta$
rising geometrically from 0.03 to 6 over the run.

**Moves.** Slide a wall run (77% of steps with a stair, 82% without), swap two rooms (18%), move the stair on every
storey at once (5%). After a slide the wall snaps to a parallel wall within one cell on the same storey or the one
above or below (the paper's consistency across floors). Each house gets 5 restarts (one storey) or 7 (two storeys).

## 3. Finding: every departure from the paper cost us a failure mode

We first "improved" the paper in several places. Each change looked reasonable alone, and each produced a recognisable
defect. Restoring the paper's term fixed it. This is the clearest lesson of the project.

| Paper (§5.2, §6, §7) | Our departure | What it produced |
|---|---|---|
| $M_c$ uses the raw corner count $e(S)$ | $e(S)/4$, so an L-room cost 0.5 more than a rectangle, not 2 | irregular rooms |
| $k_o\sum e(F_i)$ on every floor outline | $(e-4)/4 \times 0.4$: a 20-corner upper floor cost 1.6, against 100 for one missing connection | patchwork upper floors, then cut-out roofs and walls and roofs that don't meet |
| $C_d$ (area *and* aspect) for **every** room | halls had no area target and no aspect term | a 70 m² "hall" (7.5 × 21 m) on Quail Oak; snake halls joined by 0.4 m necks |
| $C_f$ is the only floor coupling | an upper-floor coverage target, privacy, wet-room stacking and a daylight weight of 40 on top | upper floors stretched to hit an area target, outweighing $C_s$ |
| §6: test a window against lower roofs, shrink it, or drop it | tested at one point, 300 mm out, at the window's centre | window edges buried behind sloping lower roofs (5 of 13–17 upper windows per design) |
| §7, Fig. 13: optimisation can stop with the staircase blocked; detect and re-run | our $C_a$ accepted a hall reached through a 0.4 m neck | a stair that "goes nowhere" passed as connected |

Restoring the paper (`PAPER=1`, now the default; `PAPER=0` keeps the old cost for comparison) raised the paper-term
scores to $C_a$ 10.0, $C_d$ 9.1, $C_s$ 8.5, $C_f$ 9.4, §6 windows 9.7, §6 roofs 9.6, §6 stairs 10.0 on a 1–10 scale
(§10), with 14 designs passing on a stricter gate. Out-of-paper wishes (privacy, wet stacking, matching the public
record) moved out of the objective and into the score, where they are measured instead of optimised.

## 4. Finding: adjacency is not access — a person-width rule

The paper's $C_a$ asks two rooms to share a wall long enough for a door. That is a topological test, and it passes
plans no one can walk through: a hall joined to the stair by a single 0.4 m cell, or an S-jog whose two halves overlap
by one cell. On Stanford design 4 this is exactly what made the stair arrive in a dead-end wing.

We added a geometric test from morphology. Let $\Omega$ be a storey's free floor (the room cells minus the real wall
solids, with 300 mm exterior walls). A person of width $d$ can stand where a disc of diameter $d$ fits, so the walkable
set is the erosion

$$W_d = \Omega \ominus B_{d/2}.$$

A room is passable when all its doorways lie in one connected component of $W_d$. We use $d = 914$ mm (IRC R311.6),
and 762 mm beside bath fixtures (R307.1). Two consequences:

- **Grid area is not clear area.** A 1.2 m strip along an outside wall is only 840 mm clear once the 300 mm wall
  solid is subtracted. It looks wide on the lattice and fails the disc.
- **Cheap lattice proxy for the planner.** Rolling discs is too slow inside the annealing loop. The planner instead
  charges every cell of a strip narrower than $\lceil d / c\rceil$ cells, and every neck, at 4 per cell in $C_d$
  (`planner.person_narrow`). The exact disc test (`circulation.routes`) runs on the built walls in the gate.

A restart is accepted only when the whole gate passes on the built plan, with up to 3 extra restarts if none does.

## 5. Finding: on a fixed outline, the start state decides what is reachable

The slide move is local: it moves one wall by one cell. To get a 3.75 m² WC from a back corner to beside the foyer,
the chain has to grow and shrink every room in between, and every intermediate plan costs more. On Quail Oak the
treemap start put the WC in a back corner in 5 of 5 seeds, and the foyer–WC connection was never made. Swaps don't
help: a swap exchanges labels, not sizes, so a tiny room swapped into a big slot pays a large $C_d$ penalty.

What worked was a **rows start state**, borrowed from the voxel map builder's own `planRows`, used for 60% of
restarts:

1. porch, then a public row on the street front (foyer, living, kitchen, garage);
2. a hall spine across the full width;
3. a private row at the back (bedrooms, baths);
4. small rooms (WC, utility) cut from the far side of the room they open off (`attach_small`);
5. the stair at the front beside the foyer, along a side wall, or under a partial upper floor at the back.

Metropolis refines from there. Together with §6:

| Same 5 houses × 5 seeds | Treemap start | Rows start + access edges |
|---|---|---|
| Designs passing | 7 / 25 | **14 / 25** |
| Houses with at least one passing design | 2 / 5 | **5 / 5** |
| Missing programme connections | 20 | **5** |
| Rooms reached only through a private room | 12 | **0** |

The privacy gradient the paper asks for (public near the entrance, private far from it) is built into this start
state, so it no longer needs its own cost term.

## 6. Finding: programme edges should be classes, not fixed pairs

A programme that says "bedroom 2 opens off the hall" fails when the plan has two halls, or a landing, or the bedroom
sits next to the foyer instead. We relaxed each edge to an equivalence class:

- a bedroom, bath, WC, study or utility that opens off "the hall" may open off **any** circulation room on its floor
  (hall, foyer, landing, corridor);
- living, dining and kitchen form one public group: **any two** of the three links connect it (before, all three were
  required);
- a stair may rise from any circulation or living room; a garage may open into the kitchen, a utility room or a hall;
  a study may open off the living room.

Formally, $C_a$ counts an edge class as made if *any* edge in it is door-feasible. This removes many infeasible
programmes without allowing bad plans, because the gate separately forbids rooms reached only through a bedroom, bath
or garage (an en-suite off its own bedroom is allowed). An earlier repair pass that added such doors produced 12
walk-through rooms; it was removed.

## 7. Finding: a footprint is not a house size — calibrate on public records

OpenStreetMap footprints are gross building area: they include attached garages, covered patios and porches. Sizing
the programme from the footprint alone gave a 5-bedroom, 4,736 sq ft model for 2116 Quail Oak Dr, which is 1,838 sq ft
on record in a street of 3-bed, 3-bath homes.

We now take bedrooms, baths and garage bays from the public record where there is one (`house_facts.py`, sources
cited per house), and otherwise from living area, with thresholds calibrated on local listings:

| Living area | Bedrooms |
|---|---|
| ≤ 1,100 sq ft | 2 |
| ≤ 2,650 sq ft | 3 |
| ≤ 3,300 sq ft | 4 |
| larger | 5 |

The score (§10) has a real-house fidelity term: bedrooms, baths, garage bays, and living area within 15% of the
record. **Open:** two-storey houses still come out larger than their record (Quail Oak 2,704 vs 1,838 sq ft; Stanford
3,052 vs 2,184), because the ground floor stays congruent with the mapped outline. The likely cause is a garage or
patio inside the OSM outline that the record doesn't count.

## 8. Finding: design in vectors, voxelise last

We built the same blueprints at three voxel sizes and measured each room's area against the plan:

| Voxel size | Mean room-area error | Other losses |
|---|---|---|
| 0.9 m | 37–46% | 2–3 windows; 1–2 rooms unreachable |
| 0.3 m | 9–18% | none |
| 0.15 m | 4–7% | none |

A first-order model explains the size of the error. Put a wall of real thickness $t$ on a grid of cell $c$: the wall
becomes one full cell, so each room loses $(c - t)/2$ on every side, and a square room of clear side $a$ keeps

$$\frac{A_{\text{vox}}}{A} \approx \Big(1 - \frac{c - t}{a}\Big)^2 .$$

For a typical 3.5 m bedroom with $t = 0.15$ m: $c = 0.9$ m keeps 62% (38% lost), $c = 0.3$ m keeps 92% (8% lost), and
at $c = 0.15$ m the wall term vanishes and only rasterisation error remains. That matches the measurements. Doors and
windows suffer more, because a 0.81 m door rounds to 0.9 m or 1.8 m, and a window narrower than two cells can vanish.

So every interior is designed on a fine lattice (0.4 m) with real wall solids, checked there, and only then turned
into voxels or meshes. A game that wants voxels should pick its cell size from this table.

## 9. Doors, windows, stairs and roofs: the §6 details that matter

**Doors near corners, then swings.** The paper (after Alexander) puts each door at the point of the shared wall that
minimises the summed distance to the nearest corner in each of the two rooms. We kept that and added a joint
per-storey optimisation by coordinate descent over run, position, width and swing (hinge side, pocket door), with
costs for hinge return, latch-side clearance (ICC A117.1), width loss, the free rectangle left after the door arcs,
approach discs and arc overlaps (`doors2.py`). Near-corner doors went from 85% to 96%, mid-wall doors from 21% to 8%,
and swings clear from 90% to 100%. Doors are stock US sizes by role: 32 in interior (30 in fallback), 36 in exterior,
5 ft French pairs, cased openings of 3–8 ft, garage doors of 9 or 16 ft.

**Windows that look out.** Besides the paper's lower-roof test (now across the window's full width at the wall face,
shrinking the window by raising its sill, dropping it below 600 mm of glass), L- and U-shaped houses produced windows
facing their own walls. Each window now probes outward at three points across its width (3 m for habitable rooms,
1.5 m otherwise) and slides along its wall to a clear spot, or is dropped.

**Stairs.** The paper shapes the stair from its space (straight, U or L). We also choose its climbing direction: the
flight climbs whichever way its foot and head both open onto a circulation or living room, and a plan where neither
direction works is charged, testing a full 0.9 m landing rather than one cell (IRC R311.7.6). The landing zone may
narrow only sideways, never along the direction of travel; the earlier all-round narrowing hid a wall across a stair
foot. Before these rules, 13 of 15 flights were blocked by a wall at one end; after, 1 of 15, in a design the gate
rejects.

**Roofs.** Hipped roofs come from a weighted straight skeleton (CGAL 6), 5–30 ms per roof. Inexact kernels produced a
515,000 km spike on one civic building and left 70 m² of a church unroofed, so we use the exact kernel and validate
every skeleton for coverage and height, with fallbacks. Rectilinear jogs in an outline make "fluted" roofs; removing
jogs shorter than the roof can resolve cut one main roof from 18 faces to 9. Lower roofs that meet an upper wall stop
150 mm below the upper sills.

## 10. Finding: an independent checker finds what self-checks miss

Every candidate plan goes through a design gate (21 checks for a two-storey house: street door on the entry room's
front wall, $C_a = 0$, every room reachable, a person fits, no room reached only through a private room, door jambs and
swings clear, stairs legal with landings at both ends, windows in habitable rooms and bedroom egress, no window behind
a lower roof or facing the house's own wall, upper floor on the floor below, garage fits a full-size sedan, one front
door, no major roof finding). The paper's own failure handling is "detect and run again"; ours is "accept a restart
only when the whole gate passes on the built walls".

We also rebuilt every design in a second, unrelated BIM modeller (BIMCraft, walls-first, Revit-style rooms) and read
back what it computes: enclosure, area, merged regions and a walk over the door graph. It caught walk-through bedrooms
and a hall merged with a stair that our own checks had passed. Since then, every passing design is BIMCraft-clean.

Designs are scored per algorithm with

$$S = 1 + 9\,(0.4\,F + 0.6\,Q)$$

where $F$ is the share of the paper's specified elements implemented for that algorithm (a checklist) and $Q$ the
measured outcome rate on built designs, independent of the module's own report. A design passes with a mean of at
least 8 over its applicable algorithms **and** a clean gate.

## 11. Finding: the map says what a building is, rarely what style it is

Across central Baton Rouge (5,463 buildings), only 0.2% carry `building:architecture` and 0.2% link a Wikidata
architectural style (P149). 99.7% of styles are therefore **inferred**: archetype (from `building`, `amenity`, `shop`,
land use and footprint geometry: a shotgun house is ≤ 6.5 m wide) plus era (from historic-district polygons and their
Wikipedia leads, neighbourhood `historic=*` tags, and the street pattern; a curvilinear drive among cul-de-sacs reads
as a subdivision of about 1972) gives a style through a table. The viewer lists the source of every choice. Style is
applied last, as in the paper's Fig. 9: a restyle keeps the plan and changes only the template.

## 12. Finding: for high-rises, height decides the plan

The same method extends to Chinese residential high-rises (`architecture/highrise/`), trained on 12 traced plans from
Xiong'an and checked against GB 55038-2025, GB 50096 and GB 50016. Here the building code, not the programme, fixes
the core. With 3.0 m storeys and a 0.3 m ground offset, the code height of an $n$-storey block is
$H(n) = 0.3 + 3.0\,n$ m, and each code threshold $H^\ast$ caps the storey count at

$$n_{\max} = \Big\lfloor \frac{H^\ast - 0.3}{3.0} \Big\rfloor :$$

| Threshold | Requirement above it | Tallest block below it |
|---|---|---|
| 33 m | fire lift, smoke-proof stair | 10 storeys (30.3 m) |
| 54 m | two exits per floor (scissor stair), shared fire lobby, refuge room in every dwelling | 17 storeys (51.3 m) |
| 100 m | refuge floors, the first ≤ 50 m up and then every ≤ 50 m | 33 storeys (99.3 m) |

This is why Chinese blocks cluster at 10, 17 and 33 storeys. Winter sunlight (hours on the Major Cold day against a
row of equal blocks to the south) sets the row spacing; leaving the neighbour's parapet and roof towers out of the
shadow model understated the spacing of a 10-storey row by 2 m (46 m gave 1.7 h of sun, a fail; 48 m gives 2.7 h).
All five generated designs pass the scorecard (9.80–9.94), against 8.96–9.88 for the professional references.

## 13. Furniture: fast proposals, paper cost to choose

The Merrell et al. (2011) furniture sampler takes 30–44 s per room on a CPU, and its lower-cost layouts were still
implausible (a nightstand inside the bed). What works is a split: Germer & Schwarz (2009) agents propose only legal
poses (each item has a parent, sides, collisions except with its parent), and the 2011 cost picks among them by
Metropolis, with the real wall solids so backs sit flush. A review of Infinigen Indoors (CVPR 2024) suggests two planner
experiments we have not yet run — a house-wide count of distinct grid lines, and an "access angle" privacy term — and
its relation vocabulary (against-wall, on-top, front-accessibility cuboids) for furniture.

## 14. Reproducibility

Everything is seeded: the same footprint, programme and seed give the same plan. Restart seeds are derived from the
building key (`stable_seed`). No AI model takes part in generation. The optional furniture-editing MCP server is off
unless a build sets `FURN_EDIT=1`, and the published designs never set it.

## Open questions

- Two-storey houses larger than their record (§7): detect garages and patios inside the OSM outline.
- Narrow lots (frontage under 10 m) and outlines with several reflex corners still pass less often.
- Big non-residential plans (school, civic, big box, apartments) take 4–5 minutes per seed in Python and some fail.
- The voxel map builder still uses its own row planner; bringing these plans into it is
  [PLAN-geo-voxel-02](plans/PLAN-geo-voxel-02.md) phase C.

## References

- P. Merrell, E. Schkufza, V. Koltun. *Computer-Generated Residential Building Layouts.* ACM TOG 29(6), 2010.
- P. Merrell, E. Schkufza, Z. Li, M. Agrawala, V. Koltun. *Interactive Furniture Layout Using Interior Design
  Guidelines.* ACM TOG 30(4), 2011.
- T. Germer, M. Schwarz. *Procedural Arrangement of Furniture for Real-Time Walkthroughs.* CGF 28(8), 2009.
- A. Raistrick, L. Mei, K. Kayan et al. *Infinigen Indoors.* CVPR 2024.
- C. Alexander et al. *A Pattern Language.* Oxford University Press, 1977.
- International Residential Code (IRC) R304, R307, R311; ICC A117.1.
- GB 55038-2025, GB 50096, GB 50016 / GB 55037, GB 50180.
