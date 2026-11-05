# Audit: the training material, Chinese high-rise rules, and the generator (2026-11-05)

Scope: the 12 traced reference plans and their statistics, the code rules, the planner, the scorecard and the
drawings from the first version (2026-11-04). Every problem found is listed with its fix. All text, labels and
data are now in English.

## 1. What the training material is, and what it can teach

| | |
|---|---|
| Plans | 12 single-storey apartment plans traced from zuobang.net renderings: 8 from Huawang City, Xiong'an (2021–22, two of them labelled as 12-storey blocks), 4 from Lingxiu Lanpo Lake (2017) |
| Sizes | 87–170 m² gross floor area (GFA), 2–4 bedrooms |
| Cores | Only 2 of 12 drawings (Lingxiu E1, F2) show the core: one stair and one lift |
| Codes | All 12 predate GB 55038-2025 (in force 2025-05-01) |

The plans teach the dwelling: which rooms exist at which size, which band of the plan each room sits in (living
room and master bedroom south 12/12, kitchen north with a window 12/12), how rooms open off each other, and the
circulation share. They cannot teach the core or anything that depends on height: 10 of 12 have no core, and
none is a 24-storey block. So the core, the floor stack, refuge rules and sunlight come from the codes, not
from the data.

Findings in the material itself:

| # | Finding | Consequence |
|---|---|---|
| T1 | E1 (2017) puts a child's bedroom against the lift shaft. GB 55038 4.2.3 now forbids that | The scorecard flags it (E1 scores 8.96, still above 8); the generator never does it |
| T2 | Four plans (B1, B5, C1, C5) have corridors under 1.00 m clear as traced (about 0.85 m). Within the ±150 mm tracing error, but also typical before GB 55038 4.1.13 | Kept as traced; they lose points on "Passage widths" |
| T3 | The references' efficiency (0.75–0.89) reflects their small cores; a 24-storey core with a scissor stair, two lifts and a 16.8 m² fire lobby lowers it | Generated high-rises land at 0.74–0.83, which is what the core allows |
| T4 | Two developers, both in north China. South China plans differ (more four-dwelling floors, other sunlight rules) | Stated as a limit; priors would need southern plans |
| T5 | Strict north–south through ventilation (via the open living–dining space) in only 5 of 12; 10 of 12 via a kitchen slider | The generated plans reach it the same way, via the kitchen; the scorecard gives 0.75 for that |

## 2. How a Chinese residential high-rise works

### Height decides the core

Building height = ground floor above grade (0.30 m here) + storeys × storey height, to the roof surface
(GB 50016 Appendix A.0.1). GB 55038 4.1.2 sets the storey height at ≥ 3.00 m.

| Storeys (3.0 m) | Height | Fire class | Lifts | Fire lift | Stair | Exits / floor | Lobby | Refuge |
|---|---|---|---|---|---|---|---|---|
| 4–6 | 12.3–18.3 m | multi-storey | 1 | – | open allowed | 1 | – | – |
| 7–8 | 21.3–24.3 m | multi-storey | 1 | – | enclosed | 1 | – | – |
| 9–10 | 27.3–30.3 m | high-rise II | 1 | – | enclosed; stair to roof | 1 | – | – |
| 11 | 33.3 m | high-rise II | 1 | yes | smoke-proof | 1 | combined lobby ≥ 12 m² | – |
| 12–17 | 36.3–51.3 m | high-rise II | 2 | yes | smoke-proof; stair to roof | 1 | combined lobby ≥ 12 m² | – |
| 18–33 | 54.3–99.3 m | high-rise I | 2+ | yes | scissor stair allowed | 2 | ≥ 12 m², short side ≥ 2.4 m | a refuge room in every dwelling |
| 34+ | > 100 m | high-rise I | 2+ | yes | 2 exits | 2 | as above | refuge floors, first ≤ 50 m up, then every ≤ 50 m |

Sources: GB 55038 4.2.4 (1 lift from 4 storeys or 9 m, 2 from 12 storeys or 33 m); GB 50016 5.1.1 (classes),
5.5.25 (two exits above 54 m), 5.5.26 (stair to the roof), 5.5.27 (stair type by height), 5.5.28 (scissor stair,
travel ≤ 10 m, lobbies), 5.5.31 and 5.5.23 (refuge floors), 5.5.32 (refuge room), 7.3.1 (fire lift above 33 m).

Because GB 55038 raised the storey height to 3.00 m, two familiar heights now cross a threshold once the ground
offset counts: 11 storeys come to 33.3 m (fire lift and smoke-proof stair), and 18 storeys to 54.3 m (two exits
and a refuge room in every dwelling). Under these rules the largest blocks below each threshold are 10, 17 and 33
storeys.

### The dwelling

| Rule | Source |
|---|---|
| Bedroom ≥ 5 m², double bedroom ≥ 9 m², living room ≥ 10 m², kitchen ≥ 4 m² (code floor 3.5 m²), bath with three fixtures ≥ 2.5 m² | GB 50096 5.2–5.4; GB 55038 4.1.1, 4.1.4, 4.1.6 |
| Bedroom short side ≥ 1.80 m clear | GB 55038 4.1.1(3) |
| Passages: entry ≥ 1.10 m, to bedrooms and living room ≥ 1.00 m, to kitchen and bath ≥ 0.90 m | GB 55038 4.1.13 |
| Door clear widths: dwelling 0.90 m, bedroom 0.80 m, kitchen and bath 0.70 m | GB 55038 4.1.14 |
| Balcony railings ≥ 1.20 m | GB 55038 4.1.15 |
| Bedrooms, living room and kitchen daylit; openable area ≥ 5 % of floor (kitchen 10 %, ≥ 0.6 m²) | GB 55038 6.2.2, 6.3.3 |
| One bedroom or living room per dwelling meets the sunlight standard (hours: GB 50180 Table 4.0.9) | GB 55038 6.2.1 |
| No bedroom next to a lift shaft, machine room or pump room | GB 55038 4.2.3 |
| Outdoor AC units on dedicated platforms | GB 55038 (MOHURD summary) |
| Barrier-free building entrance, door ≥ 1.10 m clear | GB 55038 4.2.7 |

### What buyers judge a dwelling by (from the references)

South-facing living room and master bedroom; three south-facing rooms from about 108 m²; a kitchen with a window;
north–south through ventilation; dining open to the living room; a master suite once there are two baths;
bedrooms reached from a corridor, not from the entry; circulation under about 12 %; net-to-gross efficiency.

## 3. Problems found in the generator, and their fixes

| # | Problem | Effect | Fix |
|---|---|---|---|
| A1 | Height computed as storeys × 3.0 m, without the ground offset | The 11-storey sample was classed as ≤ 33 m and given no fire lift; it is really 33.3 m | `codes.building_height()` adds the offset; the 11-storey sample was replaced by a 10-storey one (30.3 m); test added |
| A2 | Bedrooms against lift shafts (GB 55038 4.2.3) | Both 2026-11-04 samples had a bedroom under the lifts | Lifts centred in the core; planner C_a counts any bedroom touching a lift shaft, mirrored side included; scorecard check G6 |
| A3 | No refuge room above 54 m (GB 50016 5.5.32) | The 24-storey sample lacked it | A bedroom on an exterior wall with an openable window becomes the refuge room, with a Class B fire door; check G10 |
| A4 | No refuge floors above 100 m (GB 50016 5.5.31) | Not modelled | The building stack places them (34 storeys: storeys 17 and 33); check C6 |
| A5 | No AC platforms | Not modelled | A 1.0 × 0.7 m platform for every bedroom and the living room; windows are placed clear of them; check G8 |
| A6 | Door openings not tied to code widths; the planner accepted 1.0 m of wall for any door | Doors came out 0.6–0.7 m clear | Openings are the GB 55038 4.1.14 clear width + 100 mm frame; the planner needs the opening + 2 × 120 mm jambs; check G7 |
| A7 | GB 55038 values marked "as reported" | Uncertain values | Confirmed against the Beijing planning commission's clause digest (June 2025): 4.1.1, 4.1.2, 4.1.4, 4.1.6, 4.1.13–4.1.15, 4.2.1–4.2.4, 4.2.7, 6.2.1–6.3.3 |
| A8 | Lift count from storeys only | GB 55038 4.2.4 also counts the top entry floor's height | Both conditions used |
| A9 | Openable window area not checked | – | Window widths sized for 1/7 daylight and the GB 55038 6.3.3 openable area; check G9 |
| A10 | Sunlight was only "a habitable room facing south" | Hours never computed | `sun.py` traces the sun minute by minute on the Major Cold day (8:00–16:00 true solar time) against the next row of slabs and finds the smallest spacing; check C7 |
| A11 | Only a typical floor | No ground floor, roof or stack | `building.py`: pilotis ground floor with an entrance hall (barrier-free door, 1:12 ramp, mailboxes), the stair's direct exit outside, typical floors, refuge floors, roof with 1.20 m parapet, stair head room and lift machine room |
| A12 | The scorecard missed a dining room cut off from the living room (24-storey draft) | Scored 9.85 with a poor plan | Check T12 (all 12 references join them) and a stronger planner term |
| A13 | Drawings put walls on the seams inside rooms made of two rectangles | A false wall in the living room | `walls.py` derives walls from room boundaries; drawings, the 3D model and the viewer all use it |
| A14 | The mirrored dwelling's door swing was drawn into the lobby, over the stair door | Wrong drawing | Swing direction stored per door and mirrored |
| A15 | Stair doors swung into the lobby | Against the escape direction | Stair doors open into the stair (GB 50016 6.4.11) |
| A16 | 17-storey, 110 m² dwelling: 0 of 4 restarts passed | The 7.2 m core of a 17-storey block leaves an 8.5 m dwelling, too narrow for three south rooms | That design is now 125 m²; small dwellings in tall blocks need four dwellings per floor (not built yet) |
| A17 | Chinese labels and terms throughout | Inconsistent with the rest of the repo | All labels, layout strings, drawings, docs and data in English |
| A18 | The sunlight check modelled the block to the south as a plain box, without its 1.2 m parapet or the stair and lift towers (found while adding facade crowns) | The 10-storey block's spacing was set to 46 m; with the parapet the window gets 1.7 h, not 3.1 h, and fails the 2 h rule | `facade.sun_study` models the parapet, towers and any crown; the 10-storey block now needs 48 m (2.7 h). The taller blocks were unaffected: their winter sun comes through the 13 m gaps between blocks, not over the roofs |
| A19 | One exterior only (plain render) | Every building looked the same | `facade.py`: four styles in three zones, with fire-class, glass and sunlight checks (README, "Exterior styles") |

## 4. Still open

- Slabs with two dwellings per floor only. Towers and four-dwelling floors (common for small dwellings and in south China) need other core templates and dwellings that wrap the core.
- Rooms are rectangles: no bay windows, angled walls or L-shaped rooms.
- The IFC groups elements per storey and role (one IfcWall object holds a storey's walls), not one object per wall.
- Sunlight assumes a row of equal slabs to the south; a real site needs the actual neighbours.
- The 1/7 window ratio is a rule of thumb; GB 50033's daylight factor needs a simulation.
- Fire-appliance access, structure and building services are not modelled.
- Facade styles are not costed: green-building practice asks for little decoration, which an Art Deco crown works against.
- Local colour and style controls (city colour plans, planning height limits that count crowns) are not modelled.
- Not yet connected to OpenStreetMap footprints (`building:levels` → storeys).
