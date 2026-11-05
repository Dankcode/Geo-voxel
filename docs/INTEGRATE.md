# Using Geo-voxel in your project

Geo-voxel produces open files, so most projects never need to run its code. Pick the row that matches what you are
building, then read its section.

| You are building | Take | Start at |
|---|---|---|
| A game or simulation with real places and enterable buildings | `building-export@1` JSON per building, plus a mesh (IFC → glTF) | [§1](#1-games-and-simulations-the-building-export) |
| A voxel game or a voxel art scene | `.vox`, `.glb` and `map.json` of a whole street | [§2](#2-voxel-maps-of-whole-streets) |
| A BIM, digital-twin or city model | IFC4 per building, with typed walls, doors, windows, slabs, stairs and roofs | [§3](#3-bim-and-digital-twins-ifc4) |
| Houses for your own place, on your own machine | the Python pipeline | [§4](#4-generating-your-own-area) |
| Research on layout generation, or your own planner | the cost, the gate and the score | [§5](#5-porting-the-method) |

You don't need an account or a command line to get files for the bundled areas: open the house viewer
(`https://dankcode.github.io/Geo-voxel/houses/`), pick a building and press **Game export**, or download its IFC from
`architecture/areas/<area>/deliver/bim/`.

## 1. Games and simulations: the building export

One file per building, `architecture/areas/<area>/exports/<key>.building.json`, schema `geo-voxel/building-export@1`.
It holds everything a game needs to place a building and use its interior, and nothing engine-specific.

```text
schema, key
building   osm_id, address, archetype, style, storeys, storey_height_m, floor_raise_m, footprint_local
frame      origin_latlon, u_axis_bearing_deg, front_bearing_deg, units = "m"
street     name, highway, front_faces_bearing_deg
rooms[]    id, kind, storey, area_m2, open_air, polygon_local, polygon_latlon, centroid_local
doors[]    storey, kind (entry | back | garage | porch | stair | cased | interior), rooms: ["kitchen#2", "outside"],
           exterior, center_local, center_latlon, width_m, facing_bearing_deg, faces_street, leaf, swing
windows[]  storey, room, center_local, width_m, sill_m, head_m, facing_bearing_deg
garage     door_bearing_deg, street_side_bearing_deg, faces_street, load (front | side | rear), turn_to_face_street_deg
entry      door_bearing_deg, faces_street, center_latlon
stairs[]   from_storey, to_storey, rect_local, climbs_bearing_deg, form (straight | U | L), risers
furniture[]          storey, room, name, center_local, center_latlon, rotation_bearing_deg, footprint_local
furniture_pending[]  rooms with nothing placed yet, by kind
```

### Coordinates

Every point is given twice: in latitude and longitude, and in **local metres** $(u, v)$. $u$ runs along the street
front; $v$ runs from the front ($v = 0$) to the back. Bearings are degrees clockwise from north. To turn local metres
into metres east and north of `frame.origin_latlon`:

```js
const rad = d => d * Math.PI / 180;
// local (u, v) → [east, north] metres from frame.origin_latlon
function localToEN(frame, [u, v]) {
  const a = rad(frame.u_axis_bearing_deg);          // direction of +u
  const b = rad(frame.front_bearing_deg + 180);     // direction of +v (toward the back)
  return [u * Math.sin(a) + v * Math.sin(b), u * Math.cos(a) + v * Math.cos(b)];
}
```

Then map east and north onto your engine's axes. For example, Unity (+X east, +Z north): `new Vector3(e, y, n)`, and
a bearing $\varphi$ is a yaw of $\varphi$ about +Y. Three.js (+X east, −Z north): `new Vector3(e, y, -n)`, and an
object whose front faces −Z turns to bearing $\varphi$ with `rotation.y = -φ` (radians). Place several buildings
through their `origin_latlon` and your own map projection.

### Building a navigation graph

Rooms are nodes; doors are edges. Room references are `"<kind>#<id>"`, and `"outside"` is the street.

```js
const graph = new Map(exp.rooms.map(r => [`${r.kind}#${r.id}`, []]));
graph.set('outside', []);
for (const d of exp.doors) {
  const [a, b] = d.rooms;
  graph.get(a).push({ to: b, door: d });
  graph.get(b).push({ to: a, door: d });
}
```

Every room is reachable from `outside` through the street door, no room is reached only through a bedroom or bath,
and every door and hall is at least 914 mm clear, so an agent of human width can follow any path. The generator
checks all of this before it publishes a design.

### Meshes

The export carries geometry as polygons, which is enough to extrude simple walls. For the modelled building, convert
its IFC to glTF with IfcOpenShell's `IfcConvert` (`IfcConvert house.ifc house.glb`), or open the IFC in Blender with
the Bonsai add-on. `furniture_pending` lists empty rooms, so your own furnishing pass can fill them.

### Garages and turning a building

`garage.turn_to_face_street_deg` is the clockwise rotation that would make the garage door face the street. Side-load
garages are the norm in many US suburbs, so keep those as built; the field exists for games that want every garage on
the street.

## 2. Voxel maps of whole streets

The Place Builder (`npm run app`) and the JavaScript library turn any place into a voxel map at 0.9 m per cell: real
outlines, straightened streets, terrain, trees, signs and furnished rooms.

```js
import { fetchPlace, decodePNG, generate, toVoxBytes } from 'geo-voxels';

const source = await fetchPlace({ lat: 30.4466, lon: -91.1891, widthM: 160, depthM: 160 },
    { decodeTile: bytes => decodePNG(bytes, inflate) });     // inflate: zlib.inflateSync or DecompressionStream
const map = generate({ generator: 'place', geo: source, seed: 1, params: { straighten: 'grid', coverRepair: false } });
map.grid;              // width × depth × height, one byte per voxel (x east, y south, z up), with .palette
map.layers.buildings;  // outlines, storeys, doors, windows, stairs, rooms
map.layers.rooms;      // [{ id, buildingId, storey, kind, cells: [[x, y]], floorZ }]
map.layers.signs;      // shop fascias, street names, house numbers, traffic signs
toVoxBytes(map.grid);  // MagicaVoxel .vox (Blender, Godot, Unity and Unreal importers exist)
```

The app also exports `.glb`, `map.json`, `grid.json` and `source.json` (the fetched data, to rebuild offline).

**Pick your cell size knowingly.** At 0.9 m a typical room loses about 40% of its floor area to one-cell walls; at
0.3 m about 10% (see [FINDINGS.md §8](FINDINGS.md#8-finding-design-in-vectors-voxelise-last)). The voxel map's
interiors currently come from a simpler row planner; the planned houses of §1 will replace it
([PLAN-geo-voxel-02](plans/PLAN-geo-voxel-02.md), phase C). For accurate interiors today, voxelise the building
export at your own resolution.

## 3. BIM and digital twins: IFC4

Every published building has an IFC4 file (`deliver/bim/<key>.ifc`) with typed walls (openings cut), doors, windows,
slabs, stairs, roofs, columns and furniture on one level per storey, plus a `.rep.json` report of its gate checks. The
files read back cleanly with IfcOpenShell and open in FreeCAD's BIM workbench, Blender (Bonsai) and other IFC tools.

Things to know before you rely on them:

- Plans are generated, not surveyed. They are plausible and code-checked, not the real interior of the real building.
  Say so wherever you show them.
- The ground floor is congruent with the OpenStreetMap outline; upper floors are as large as their rooms.
- Materials and styles are inferred for 99.7% of buildings ([FINDINGS.md §11](FINDINGS.md#11-finding-the-map-says-what-a-building-is-rarely-what-style-it-is)).
- Chinese high-rise apartments (`architecture/highrise/`) come with IFC4 storeys, code checks and a sunlight study.

## 4. Generating your own area

**Without a command line.** In the house viewer's world map, go to a place, set a radius of 1–2 blocks, choose a style
and press **Request generation**. That opens a pre-filled GitHub issue on this repository; the owner's workflow
generates the houses and publishes them. To run requests yourself, fork the repository and turn on Issues, Actions
and Pages (Settings → Pages → Source: GitHub Actions) in the fork. The workflow
(`.github/workflows/generate-houses.yml`) then runs for you as the owner of your fork, and the viewer it publishes
sends its requests to your fork (`build_viewer.py` reads `GITHUB_REPOSITORY`).

**On your machine** (Linux or macOS):

```sh
micromamba create -f architecture/environment.yml && micromamba activate houses   # Python 3.11, FreeCAD 1.0, CGAL 6
bash architecture/pipeline/roofgen/build.sh
python architecture/pipeline/generate_area.py --lat 30.4425 --lon -91.1659 --blocks 1.5 --max 12 --id my-area
python architecture/build_viewer.py      # then: npm run app → http://localhost:5180/houses/
```

`generate_area.py` fetches OpenStreetMap for the place (`fetch_osm.py`), keeps the houses (shotgun, cottage,
bungalow, ranch, two-storey house, townhouse) and lists the rest as skipped with a reason, plans the nearest `--max`,
gates them, builds FreeCAD and IFC models and writes the game exports to `architecture/areas/my-area/`.
`--restyle <area-dir> <key> <style>` rebuilds one building in another style on the same plan.

**Your own footprints** (not from OpenStreetMap) are not a stable entry point yet. The planner's internal functions
(`planner.site_from_polygon`, `programs.program_for`, `planner.optimize`) work, but they will move.
A supported `plan_footprint()` call and GeoJSON input are [PLAN-geo-voxel-02](plans/PLAN-geo-voxel-02.md) phase B.

## 5. Porting the method

To build your own planner on these results, port in this order. Each step is testable on its own.

1. **Programme** — rooms with area and aspect priors, tiers (public, private, service, circulation) and edge classes
   ([FINDINGS.md §6–7](FINDINGS.md#6-finding-programme-edges-should-be-classes-not-fixed-pairs)).
2. **Lattice and moves** — slide wall runs, swap rooms, move the stair on every storey, snap across floors; start from
   rows, not a treemap ([§5](FINDINGS.md#5-finding-on-a-fixed-outline-the-start-state-decides-what-is-reachable)).
3. **Cost** — $C = k_a C_a + k_d C_d + k_s C_s + k_f C_f + k_o \sum e(F_i)$, with every room in $C_d$ and the raw
   corner count in $M_c$ ([§2–3](FINDINGS.md#2-the-cost-function-we-use-and-why-each-piece-is-there)).
4. **Person width** — the lattice proxy in the cost, the disc test in the gate ([§4](FINDINGS.md#4-finding-adjacency-is-not-access--a-person-width-rule)).
5. **Gate and restart** — accept a restart only when the full gate passes on built walls ([§10](FINDINGS.md#10-finding-an-independent-checker-finds-what-self-checks-miss)).
6. **Compile** — doors near corners, swings, windows, stairs, roofs ([§9](FINDINGS.md#9-doors-windows-stairs-and-roofs-the-6-details-that-matter)).
7. **Voxelise last**, at a cell size chosen from [§8](FINDINGS.md#8-finding-design-in-vectors-voxelise-last).

The competition set (five houses × five seeds) and the scorecard are in `architecture/pipeline/compete.py` and
`score.py`; reporting your planner's numbers on the same set makes results comparable.

## Licences and credit

Code is MIT. Map data is © OpenStreetMap contributors under the ODbL: anything you ship that was built from it (maps,
models, exports) must credit "© OpenStreetMap contributors", and changes to the data itself must be shared under the
ODbL. Wikidata is CC0; Wikipedia text is CC BY-SA. [DATA.md](../DATA.md) lists every source. This is a summary, not
legal advice.
