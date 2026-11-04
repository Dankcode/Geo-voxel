# Houses: real buildings planned room by room

Pick a spot anywhere in the world. For each house within 1–2 blocks of it, this pipeline does five things:
- plans every room with the layout optimisation of Merrell, Schkufza & Koltun (2010);
- furnishes the rooms (Germer & Schwarz 2009; Merrell et al. 2011);
- builds the house in FreeCAD, with real walls, stock-size doors and windows, stairs and straight-skeleton roofs;
- checks it against a design gate built from building-code rules;
- exports it for a game, including every door's facing and the garage's bearing against the street.

All of it is the planned algorithm. No AI model takes part in generation. The one AI tool, an MCP server for hand-editing furniture, stays off unless you turn it on (see the end of this page).

## Use it without a command line

1. Open the house viewer. It is published with the app at `https://dankcode.github.io/Geo-voxel/houses/`, and the Place Builder's **Design the houses here →** link opens it at the Place Builder's current spot.
2. Click **World map · generate an area**. Go to a place by typing an address, a place name or a latitude and longitude. Bundled Baton Rouge data draws at once; anywhere else the map loads OpenStreetMap live.
3. Click the map to centre the area. Set the radius between 1 and 2 blocks (default 1.5; one block is about 110 m). Choose a style for the area or per house, then press **Request generation**.
4. A pre-filled GitHub issue opens. Sign in and submit it.
5. The **Generate houses** workflow (`.github/workflows/generate-houses.yml`) handles the rest:
   - It plans, models and exports the houses.
   - It commits them to `architecture/areas/<id>/` and the viewer bundle `app/public/houses/`.
   - It redeploys the site and comments the result on the issue.

The workflow runs only when the repository owner (or a collaborator with write access) opens the request, or when the owner approves someone else's request by adding the `approved` label. So only the owner decides what changes the published designs.

To regenerate a building in another style, open it in the 3D view, pick a style and press **Regenerate**. The rooms and layout stay the same and only the style template changes, as in the paper's Fig. 9 (Cottage, Italianate, Tudor, Craftsman, and 16 more). This opens the restyle request.

## What is in here

| Path | What it is |
|---|---|
| `pipeline/` | The Python pipeline. The entry points are `run_request.py` (one request issue), `generate_area.py` (an area or a restyle), `fetch_osm.py` (OpenStreetMap for any place) and `export_game.py`. |
| `pipeline/roofgen/` | The roof tool: a CGAL 6 weighted straight skeleton, built with `build.sh`. |
| `pipeline/furnmcp/` | The furniture-editing MCP server. It is off by default. |
| `data/` | The bundled OpenStreetMap extracts: south Baton Rouge and Riverbend. Fetched places are added as `data/area-…`. |
| `areas/<id>/` | Each generated area: `area.json` (the manifest), `plans/` (room plans), `exports/` (game exports), `deliver/` (IFC models, blueprints, specs, gate reports) and `chk/` (gate specs). |
| `areas/examples/` | The example sample: the five competition houses, replanned under the current rules. |
| `viewer/` | The house viewer's source. `build_viewer.py` turns it, plus every area, into `app/public/houses/`. |
| `environment.yml` | The conda-forge environment: Python 3.11, FreeCAD 1.0, CGAL 6, numpy, scipy and shapely. |

To run it locally instead of through GitHub:
```sh
micromamba create -f architecture/environment.yml && micromamba activate houses
bash architecture/pipeline/roofgen/build.sh
python architecture/pipeline/generate_area.py --lat 30.3916 --lon -91.2061 --blocks 1.5 --id my-area
python architecture/build_viewer.py   # then: npm run app → http://localhost:5180/houses/
```

## How a house is planned (Merrell et al. 2010, §5)

The plan is a label grid of 0.4 m cells for each storey, over the building's mapped footprint.

**Cost.** Metropolis–Hastings annealing minimises

> C = k_a·C_a + k_d·C_d + k_f·C_f + k_s·C_s, with k_a = 100, k_d = 1.5, k_s = 1, k_f = 1000, and k_o = 0.6 on the storey outlines.

- **C_a, accessibility.** It counts each programme connection that has no shared wall long enough for its door, and each room you can't reach.
- **C_d, dimensions.** It covers each room's area and aspect ratio, plus the person-width rule below.
- **C_s, shape.** The sum of every room's M_c.
- **C_f, floors.** The share of each upper floor that does not stand on the floor below.

### Shape measure M_c

M_c(S) = (A(H(S)) − A(S)) / A(S) + e(S)

Here A(S) is the room's area, H(S) its convex hull and e(S) its number of corners. The first term is how much area the room is missing from its convex hull: a rectangle has none, while an L- or U-shaped room has a notch. The second term counts corners, so every extra jog in the outline costs a fixed amount.

- We shift e by 4, so a plain rectangle costs exactly 0. A constant per room changes nothing in the optimisation.
- An L-shaped room has 6 corners, so it costs 2 plus its notch fraction.
- Porches weigh M_c four times, so their posts line up on straight edges.
- A garage weighs it six times, because a car hits a notch.

Together, M_c keeps rooms rectangular unless the footprint forces otherwise.

### Aspect ratio in C_d

Each room's aspect ratio r (long side over short side) has a log-normal prior. Its negative log-likelihood is added to C_d:

> ½ · ((ln r − ln μ_r) / σ_r)² · 0.25

| Room | μ_r | σ_r |
|---|---|---|
| Ordinary rooms | 1.35 | 0.25 |
| Halls and corridors | 2.5 | 0.5 |

Ordinary rooms sit near 4:3; halls are meant to be long. On top of the prior, a hard term (½ · ((r − max) / 0.5)², max 2.0 for ordinary rooms) stops rooms becoming strips.

The area works the same way, ½ · ((A − μ_A) / σ_A)². The programme sets μ_A from the public record of the real house (its square footage, beds and baths) where one exists.

### Moves

Each annealing step proposes one change. The new plan is kept if it costs less, or otherwise with probability exp(−β·ΔC), while β rises from 0.03 to 6 over the run.

- **Slide** (77 % of steps in a house with a stair, 82 % without): pick a wall between two rooms, or between a room and the outside. Take the straight run of that wall through a random cell. Optionally split it at a point; the v2 move set prefers points where a perpendicular wall already meets it. Then push that part one cell sideways, so one room grows and the other shrinks.
  - After the move, the wall snaps to a parallel wall within one cell on the same storey or the one above or below. This is the paper's "consistency across floors".
  - Pushing the outer wall in carves the outline back from the mapped footprint (single-storey houses only).
- **Swap** (18 %): two rooms on a storey trade places.
- **Stair move** (5 %): the stair moves to another legal position on every storey at once. The cells it leaves go to the neighbouring rooms.

A move may shrink a room but never delete it. Each run restarts from fresh seeds: 5 restarts for a one-storey house, 7 for two storeys. A restart is accepted only when its plan passes the whole design gate on the built walls. If none does, the planner gets 3 more restarts and then keeps the cheapest plan.

## Rules added on top of the paper

- **A person fits everywhere.** The rule is 914 mm clear, from IRC R311.6; at bath fixtures 762 mm is enough (R307.1).
  - The gate rolls a 914 mm disc through each floor's real walls. Exterior walls are 300 mm thick, so a 1.2 m strip along an outside wall is only 840 mm clear. The disc must get from every doorway of a room to the others.
  - The planner charges every cell of a strip narrower than a person, and every neck (an S-jog overlapping by one cell), in C_d.
- **Doors are stock US sizes, by role.**
  - 32 in interior passage doors (30 in only where 32 in can't fit).
  - 36 in exterior doors.
  - 5 ft French pairs.
  - Cased openings of 3, 4, 5, 6 or 8 ft.
  - Garage doors of 9 ft for one car or 16 ft for two.
- **Windows** must look out (3 m clear of the house's own walls) and sit above any lower roof (paper §6).
- **Porch posts** are evenly spaced, with none in the steps or the walk to the door. **Halls** have landings at both ends of the stair (IRC R311.7.6). **Garages** park full-size sedans.

## Game export (`exports/<key>.building.json`, schema `geo-voxel/building-export@1`)

- **Rooms:** kind, storey, area and polygon, in local metres and in latitude/longitude.
- **Every door:** the two rooms it joins (or `outside`), its width, the bearing it faces, whether it faces the street, and its leaf and swing.
- **Windows:** sill and head heights, and the bearing each faces.
- **Stairs:** their box and the bearing they climb.
- **Furniture:** position, rotation and footprint, plus `furniture_pending` (rooms not yet furnished).
- **Garage:** `garage.load` (front, side or rear) and `garage.turn_to_face_street_deg`, the clockwise rotation that would turn the whole building so its garage door faces the street.

## The furniture MCP (off by default)

`pipeline/furnmcp/server.py` lets an AI agent move, add or remove furniture in one design, for new or special designs only.
- It does nothing until you register it with an MCP client and call `activate`.
- Saved edits reach a build only when that build runs with `FURN_EDIT=1`.
- The generation workflow never sets `FURN_EDIT`, so published designs are always the algorithm's own.

## Sources and licences

- Map data: © OpenStreetMap contributors (ODbL).
- Public-record facts for the five example houses: the sources each design lists.
- The papers are cited, not included:
  - P. Merrell, E. Schkufza, V. Koltun, *Computer-Generated Residential Building Layouts*, ACM TOG 29(6), 2010;
  - T. Germer, M. Schwarz, *Procedural Arrangement of Furniture for Real-Time Walkthroughs*, CGF 28(8), 2009;
  - P. Merrell et al., *Interactive Furniture Layout Using Interior Design Guidelines*, ACM TOG 30(4), 2011.
