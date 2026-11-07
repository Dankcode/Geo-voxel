# Chinese residential high-rises

Geo-voxel's generator for Chinese high-rise apartment buildings. It works from 12 real apartment plans traced into
data and the Chinese building codes, using the Merrell et al. (2010) method adapted to high-rise floors. For
each building it plans the dwelling, sizes the core from the storey count, stacks the floors (pilotis ground floor,
typical floors, refuge floors above 100 m, roof), checks winter sunlight against the next row of blocks, scores the
result on a 1–10 card (8 = pass), and builds the whole building in FreeCAD (IFC4) and for the house viewer.

`AUDIT.md` covers how these buildings work and every problem found and fixed in the 2026-11-05 audit.

```sh
cd architecture/highrise
python test_highrise.py                       # tracing, codes, refuge floors, sunlight, gate (pure Python)
python -m highrise.analyze reference          # statistics from the traced plans
python -m highrise.generate samples           # 5 buildings: drawings, building.json, scores (about 4 min)
# 3D, in the FreeCAD environment (architecture/environment.yml):
python -m highrise.bim samples/hr24-140/building.json buildings/hr24-140          # .FCStd, .ifc, .mesh.json, .plan2d.json
python -m highrise.bim samples/hr10-120/building.json buildings/hr10-120 --no-ifc
python -m highrise.bim buildings/hr24-140/building.json buildings/hr24-140-art-deco --no-ifc --style=art_deco
python -m highrise.preview buildings/hr24-140/hr24-140.mesh.json view.png [--cut 5]
python ../build_viewer.py                     # adds buildings/* to the house viewer under "High-rise apartments (China)"
```

## Pipeline

| Stage | Module | What it does |
|---|---|---|
| Reference data | `refplans.py`, `analyze.py` | 12 traced plans (rooms, links, windows); room-size priors, band positions, who-opens-off-whom counts |
| Codes | `codes.py` | GB 55038-2025, GB 50096, GB 50016 / GB 55037, GB 50180 rules with clause numbers; height → lifts, stair, exits, lobby, refuge |
| Core | `core.py` | stair box (scissor above 54 m), fire lobby, centred lift shafts, service shafts |
| Programme | `planner.sample_programme` | conditional tables calibrated on the references (paper §4) |
| Dwelling plan | `lattice.py` + `planner.cost` | the houses' search (paper §5, `pipeline/planner.py`): a label grid on the 300 mm module over the dwelling, Merrell wall slides and room swaps, Metropolis with geometric annealing, started from the banded layout; cost = `planner.cost` (C = k_a·C_a + k_d·C_d + k_s·C_s + typology terms) + Merrell's shape measure, rooms in one piece, the houses' clear-width test and the references' zones (living room and master bedroom south, kitchen and baths off the south face). `HR_SEARCH=banded` runs the earlier banded slicing search |
| Compile | `compile.py` | doors near corners at code widths (paper §6), windows sized for daylight and ventilation, AC platforms, refuge room, mirrored second dwelling |
| Furniture | `furnish.py` | every dwelling room furnished by the houses' solver (`pipeline/furnish2.solve_room`: Germer & Schwarz poses, Merrell 2011 cost, Metropolis, 6 restarts per room) against its real walls, door clearances and windows; balconies hold a washer; a required item left out is placed by a one-level repair |
| Building | `building.py` | storey stack, pilotis ground floor with entrance hall and ramp, refuge floors, roof; programme repair when restarts fail |
| Sunlight | `sun.py`, `facade.sun_study` | hours on the Major Cold day against a row of equal blocks to the south, modelled with their parapet, roof towers and crown; smallest spacing that gives the required hours |
| Score | `score.py` | the 1–10 card (code G, core C, paper M, typology T) |
| Walls | `walls.py` | walls from room boundaries (exterior, core, party, interior) for drawings, 3D and viewer |
| Drawings | `render.py` | typical floor, ground floor, roof (SVG/PNG) |
| Exterior styles | `facade.py` | four facades on the same plan (below), checked against fire, glass and sunlight rules |
| 3D | `bim.py`, `viewer_export.py`, `preview.py` | FreeCAD model of every storey with its furniture (IfcFurniture), IFC4, viewer mesh and blueprints with furniture outlines, shaded previews |

## Results

The 12 professional reference plans score 8.96–9.88 on the card (E1 from 2017 loses points for a bedroom
against the lift, which GB 55038 4.2.3 now forbids). Generated buildings (12 restarts each, `samples/summary.json`):

| Design | Height | Core | Dwelling | GFA | Efficiency | Sun (Beijing, Major Cold day) | Score | Restarts passing |
|---|---|---|---|---|---|---|---|---|
| `hr10-120` | 10 storeys, 30.3 m | 1 lift, enclosed stair | 3 bed · 2 living · 2 bath | 117.8 m² | 82.3% | 2.7 h at 48 m spacing | **9.94** | 9/12 |
| `hr17-125` | 17 storeys, 51.3 m | 2 lifts (1 fire), smoke-proof stair | 3 bed · 2 living · 2 bath | 122.9 m² | 74.5% | 2.0 h at 60 m spacing | **9.85** | 7/12 (dropped br3) |
| `hr24-140` | 24 storeys, 72.3 m | 2 lifts (1 fire), scissor stair, refuge room per dwelling | 3 bed · 2 living · 2 bath | 137.3 m² | 76.8% | 2.0 h at 65 m spacing | **9.9** | 11/12 (dropped na, cl, st) |
| `hr33-125` | 33 storeys, 99.3 m | 2 lifts (1 fire), scissor stair, refuge room per dwelling | 3 bed · 2 living · 2 bath | 123.6 m² | 74.4% | 2.1 h at 60 m spacing | **9.8** | 6/12 |
| `hr34-125` | 34 storeys, 102.3 m | 2 lifts (1 fire), scissor stair, refuge floors 17, 33, refuge room per dwelling | 3 bed · 2 living · 2 bath | 123.6 m² | 74.4% | 2.1 h at 60 m spacing | **9.81** | 7/12 |

The test building, `hr24-140`, was built in full: 24 storeys, one pilotis ground floor and 23 typical floors (46
dwellings), plus the roof. See `buildings/hr24-140/` and the previews in `samples/hr24-140/`.

Every typical floor is furnished: 51–58 items per floor (beds, nightstands and wardrobes; sofa, armchair, coffee table
and TV unit; dining table and chairs; kitchen counter and fridge; vanity, WC and bath or shower; a washer and a plant on
each balcony), none missing. A facade style keeps its plan's furniture.

## Exterior styles

The plan fixes the rooms and windows; the facade is chosen separately. `facade.py` has the four exteriors most
common on Chinese residential high-rises. Each is built in three zones (base, body, top):

| Style | Base | Body | Top | Built examples |
|---|---|---|---|---|
| Modern minimalist (现代简约) | 2 storeys of grey stone | light render, a dark aluminium band at every slab edge, glass railings | open steel frame over the stair and lift towers | `hr24-140-modern` |
| Neo-Chinese (新中式) | 3 storeys of grey granite with a cornice | off-white walls, dark grey window surrounds and corner lines, wood-tone AC grilles | deep flat eave, hipped metal roofs on the towers | `hr24-140-neo-chinese`, `hr34-125-neo-chinese` |
| Art Deco / neo-classical (ArtDeco / 新古典) | 3 storeys of stone with a cornice | sand-coloured stone-paint, full-height pilasters, window surrounds, bronze railings | pilasters rising above the parapet in steps, a stepped crown over the core (lower on low blocks) | `hr24-140-art-deco`, `hr10-120-art-deco` |
| Commercial-style (公建化) | 2 storeys of dark granite | aluminium-panel walls, a dark enamelled panel band over every slab edge, fins beside every window, glass railings | fins carried 3.3 m above the roof with a panel screen | `hr24-140-public` |

A style never adds or removes openings, so plan scores, daylight and window-to-wall ratios are unchanged. Its own
checks (`facade.check`, stored in the variant's `building.json` and the viewer's check list):

- **F1** decorative layer class A above 50 m, at least B1 below (GB 50016 6.7.12): foam mouldings switch to GRC.
- **F2** no openings added. **F3** no fin, pilaster or surround in front of a window or door.
- **F4** sunlight re-traced with the crown on the block to the south; reports the spacing the style needs.
- **F5** the crown does not change the fire-code height (measured to the roof surface, GB 50016 A.0.1).
- **F6** no glass curtain wall on the dwelling floors (some cities ban it on new housing): dark bands are enamelled aluminium.

![styles](samples/styles-hr24.png)

## Limits

Two dwellings per floor only (slab blocks); rectangular rooms; IFC elements grouped per storey and role;
sunlight against equal neighbouring blocks; 12 reference plans from north China. See `AUDIT.md` § 4.

## Walking through the plan, and diagonal corner cuts (2026-11-06)

`walk.py` checks every room on its real shape (walls taken off: 60 mm each side of an interior wall): a person 0.90 m
wide must be able to get through every room and from each of its doors to the others; the entry needs 1.10 m clear and
halls 1.00 m (GB 55038 4.1.13 / GB 50096 5.7). The test erodes the clear floor by half the width with a round body and
asks that what is left is one piece, and that almost nothing narrower than the width is left over (no slivers). Closets
and stores are exempt.

Where a room fails at a convex corner of a neighbour that juts into it, `walk.repair` cuts a right-isosceles triangle
(0.6, 0.9 or 1.2 m legs) off the neighbour's corner and gives it to the room, so the wall between them runs at 45°.
A cut is kept only if it fixes the room and the neighbour still passes on its own: walkable, its minimum net area, its
clear square (a bedroom 2.1 m, a kitchen 1.8 m), and 1.3 m of straight wall left between the two for a door. Rooms
stay rectangles in `rects`; a cut is stored as triangles in `add` (the room that gains) and `sub` (the room that gives).

The planner counts a room nobody can walk through, after cuts, as a hard failure (`planner.cost`, C_a); `compile`
applies the cuts and keeps doors off the cut wall; the gate's G5 runs the door-to-door check on the finished plan.
Walls (`walls.diagonal_walls`), the SVG drawings, the viewer's blueprints, furniture and the FreeCAD model all draw the
45° walls.

## Flats per floor and regenerating (2026-11-06)

A floor has 2, 4 or 6 flats (`dwellings` in a design) around **one** core, and the slab keeps the footprint of the
2-flats-a-floor slab of the same flat size and depth (`building.two_flat_width`): more flats a floor means smaller
flats, not a longer building. 6 flats need at least the footprint of the ~185 m² 2-flat slab, so every flat can have a
south-facing room; a smaller size is widened to that minimum and the building notes it (`envelope.widened`).

**The whole floor in one search (`floorplan.py`), as the houses are planned.** With 4 or 6 flats the houses' optimiser
(`pipeline/planner.py`: Merrell 2010 label lattice, wall slides, the stair move) plans the typical floor. The labels
are the public corridor, each flat and the core. The core is one block that the search moves among candidate spots
along the north facade, mirrored or not, and in one of two forms:

| Core form | Layout | Size (scissor stair, 2 lifts) |
|---|---|---|
| wide | stair over its fire lobby, the lifts beside them; the lobby's door and the passenger lifts face the corridor | 12.0 × 5.4 m |
| stacked | stair, fire lobby and lift row in rows; the lobby's door on its end; the fire lift opens into the lobby | 7.2 × 8.1 m |

The lifts open straight onto the corridor, which is the lift lobby (1.5 m clear in front of the doors, GB 55038
4.2.4), so no door stands between the lifts and the flat doors. Only the stair has a door: its fire lobby (combined
with the fire lift's, ≥ 12 m², short side ≥ 2.4 m, GB 50016 5.5.28) opens onto the corridor through a Class B fire
door. At 33 m and below (no smoke-proof stair) the stair opens straight onto the corridor.

The floor's costs: the corridor and every flat in one piece; the corridor touches the fire lobby's door and every lift
door, is 1.2 m clear everywhere and as small as it can be; every flat is on the corridor for 1.5 m (its door), has
enough south facade for its daylit rooms (5.4 m with no north facade, 3.6 m with one), is near an even share of the
floor and compact (Merrell M_c, no strip under 1.2 m); and the walk from each flat door to the stair's lobby stays
within the code (10 m above 27 m, 15 m below). The best of several restarts is kept; each flat's rooms are then planned
on the domain it got by the lattice search (`planner.Unit` with the flat's cut-outs and door; a flat on the west end is
planned mirrored), and every flat is scored ("Flat B: …" in the viewer).

**Rooms by the houses' planner (`houseplan.py`).** Each flat of a 4- or 6-flat floor gets its rooms from the houses'
planner (`pipeline/planner.py`, as the houses' apartment units are planned): the flat's cells on a 300 mm lattice, its
corridor door as the entry edge, its facades as the only light edges, and a programme of rooms with Merrell access
edges (entry–living open, living–kitchen door, bedrooms and bathroom off the hall or living room). Its cost keeps rooms
near a 1.35 : 1 aspect ratio and under 2 : 1, each room's minimum side and a clear square in the living room and
bedrooms, a door-wide shared wall for every access edge and halls sized by the doors they serve (≤ 2 m clear). For the
Chinese codes it also asks: target areas no smaller than the minimum net areas, one habitable room on the south facade
(GB 50096 7.1.1), no bedroom (nor a studio's living room) against a lift shaft (GB 55038 4.2.3), and facade enough for
each daylit room's window and AC platform. Proportions are hard for these flats, in the houses' planner and in the
gate: living room ≤ 2.2 : 1 and ≥ 3.0 m across, master bedroom ≤ 2 : 1 and ≥ 2.9 m, other bedrooms ≥ 2.4 m, the study
≥ 2.1 m, kitchen ≤ 3 : 1 and ≥ 1.8 m, bathroom ≤ 2.4 : 1 and ≥ 1.5 m, the entry ≥ 1.2 m. A square of the room's
minimum side has to sweep most of a living room (70 %, so an alcove may stay) and of a bedroom or study (80 %): a
2.4 m x 6 m living room with a small bump passed the bounding-box tests and now fails. Net areas count the union of a
room's rectangles less half a wall all round. A one-bedroom flat under 40 m² gets a single bedroom (2.4 m), as a
Chinese 一室一厅 of that size does; a studio or one-bedroom flat opens its bedroom and bath off the entry or the living
room, whichever they touch.

How the flats are searched (`houseplan.py`): the houses' annealer runs colder (β 0.3 → 6, `HR_HOUSE_BETA`) from a
start that already reads as a flat: in a flat through the block the bedrooms on the north, the living room on the
sunny south end (a bedroom there if the south end is narrower than a living room), the entry or hall on the door side
between them and the bath and kitchen on the far side; in a studio on the south face the living room across the full
depth at one end, the entry on the door with the bath past it, the kitchen behind them on the south face. Once the
houses' own hard checks pass, the high-rise gate's hard checks (walkability after diagonal cuts, the entry in front
of the door, net areas, proportions, sun, no bedroom on the lifts) are added to the search's hard term, so the search
ends on a plan that also passes the gate.

The floor search shapes the flats for this: a studio has at least ~26 m² of plan, no part of a flat is under 1.2 m
(hard) or 2.4 m (costly) across, 65 % of a flat is at least 3.6 m across, a flat through the block has 3.6 m of south
face for its living room, and steps in the walls between flats cost more. The public corridor is 1.5 m clear
(wheelchair turning circle) as a hard rule. A flat's door goes on its corridor edge nearest the stair's lobby, and a
floor whose measured walk to the stair exceeds the limit gives way to the next-best floor layout. A balcony only
where the living room has 2.4 m of south wall; elsewhere the living room gets a window and AC platform like a bedroom.
`HR_ROOMS=lattice` brings back the lattice planner for these flats.

The public corridor is at least 1.5 m clear (a wheelchair's turning circle, GB 55019 2.2.1; GB 50096's 1.2 m is the
floor) and 1.8 m deep in front of the lifts; the floor search also keeps each flat no longer than twice its width and
without strips under 2.1 m. A living room gets a balcony only where it has the south front for one; otherwise it takes
windows and an AC platform like a bedroom.

`HR_FLOOR=fixed` brings back the earlier fixed layout (centred core, lobby corridor behind a fire door).

Any building can be generated again with other counts, from the viewer's **Regenerate…** panel or directly:

```sh
python architecture/pipeline/run_request.py --highrise hr24-140 --storeys 24 --dwellings 4 --gfa 110 --bedrooms 3 --style modern
```

This writes `samples/<id>/` and `buildings/<id>/` (FreeCAD, IFC4, viewer mesh, blueprint), adds the facade variant
when `--style` is given, and rebuilds the viewer. `--bedrooms` and `--bathrooms` replace the counts the programme
would sample from the flat size.
