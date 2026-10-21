# The geo-voxels method

A real map section becomes a voxel map in eight fixed stages. Coordinates: metres around the export's projected origin
(UTM) until stage 1; afterwards cells, x east, y south, z up. Every stage is deterministic.

## 0 · Fetch (Blender + BlenderGIS)

`blender/blender_geo_import.py` builds a georeferenced scene (UTM zone from the longitude, origin at the point), and
runs on Blender timers (the UI stays live, a Blender MCP call returns at once):

| step | what | notes |
|---|---|---|
| setup | scene CRS, extent plane | the extent is the **window + `pad` metres** on every side |
| dem | BlenderGIS *Get elevation* via OpenTopography | `USGS10m` (3DEP 1/3″ bare earth) — a DTM. `SRTMGL1` is a DSM: towers bleed in |
| osm | BlenderGIS *Get OSM* via Overpass | User-Agent patch (Overpass answers 406 without one), mirror retries on 502/504 |
| export | `blender-export.json` | building rings (bottom ring of each extrusion), highway lines, areas, DEM samples (`kind: dtm/dsm`), `extent` (fetched) and `window` (the map) |
| render | top-down Workbench image | for review |

Status goes to `<out>/geo-status.json`; poll for a *change*. `resume(out, 'osm')` re-runs only OSM.

**Context** (one Overpass request + ≤ 2 Wikidata requests, keyless): shops/amenities/offices/tourism/historic POIs,
`building:part` ways (Simple 3D Buildings: `height`, `min_height`, `building:levels`, `roof:shape`, `roof:height`,
material, colour), named or Wikidata-tagged building outlines with all their tags, and street furniture (signals, bus
stops, lamps, trees, hydrants, benches, flagpoles). Wikidata gives floors (P1101), height (P2048), architectural style
(P149), inception (P571), architect (P84), heritage designation (P1435) and "instance of" (P31). Each building then
gets its tenants (POIs inside the outline), a use (src/uses.js), a material set and its 3D parts.

## 1 · Frame and crop

Grid angle θ = ¼·atan2(Σ w L sin 4α, Σ w L cos 4α) over every street segment (w = 1 + class) and building wall (w = 1):
the 4θ mean treats directions 90° apart as one, so a street grid votes as one direction. The window is rotated by −θ
about its centre and sampled at one cell (0.9 m default) per cell. Because the fetch was padded, the rotated window's
corners hold real DEM and OSM.

## 2 · Straighten (full grid)

1. **Simplify** each centreline with Douglas–Peucker (1.5 cells), pinning every vertex shared with another way — OSM
   junctions are shared nodes.
2. **Snap** each segment to its nearest axis. A segment 30–60° off both axes is a true diagonal: it becomes an L
   (longer component first). 
3. **Tie** coordinates: a horizontal segment joins its endpoints' y-classes, a vertical one their x-classes
   (union-find, most important and longest segments first). A short connector whose tie would collapse two classes
   that are really apart (a crossover between carriageways) bends instead.
4. **Solve**: each class takes the weighted mean of its members' real coordinates — the least-squares solution of
   "keep every vertex where it was" under the equal-coordinate constraints. Parallel classes that overlap along the
   other axis keep their real order and at least half their real gap (≥ 2 cells).
5. **Rubber sheet** everything else: every point of a building ring, area or footpath moves by the inverse-distance
   (power 3) weighted displacement of street samples taken every 3 cells along the original segments.
6. **Square** each building: turn it about its centroid by its own residual grid angle, orthogonalise the ring
   (simplify, snap edges, merge runs, intersect consecutive H/V edges), and push it off any carriageway it overlaps.
   Land-use rings are orthogonalised too.

The report gives the distortion budget: maximum and mean vertex shift (cells), mean building move, largest turn.

## 3 · Footprints

Rings rasterise centre-inside plus 0.3 cell (closes digitising slivers); a building less than 40 % on the map is
dropped (and reported). Touching buildings: the larger claims the boundary, so there is **one** party-wall line. The
mask is decomposed largest-rectangle-first into wings ≥ 5 cells (histogram method); wings share their wall lines.

## 4 · Streets

Each cell's role — carriageway (≤ half width), kerb (+1), sidewalk (+2 for streets, none for service drives and slip
lanes) — comes from the **L∞ distance** to the axis-aligned centreline: square ends, square corners. A cell inside two
streets of one class belongs to the longer one, so junction squares are owned whole, never split along a diagonal.

## 5 · Lots

`amenity=parking` polygons become lots. A `landuse=retail/commercial` polygon with no mapped parking is a US strip
centre: its open land minus a 3-cell storefront walk becomes the car park, and its service roads are levelled with it.
Stall rows: every rectangular section between the drive aisles (largest rectangle first) gets double rows along its
long side — 5 deep, a 4-cell aisle, 5 deep — with a divider every 3 cells.

Open land: `leisure=park/garden`, `landuse=grass/…` are lawn (named plazas and squares paved), `footway/path/
pedestrian/cycleway/steps` are 1.5–3-cell paved walks orthogonalised like the streets; what remains is a paved yard
within 3 cells of a building, otherwise lawn.

## 6 · Terrain

The DEM (a DSM is first opened morphologically, 40 m) is sampled per cell and quantised to whole voxels (relief over
`maxRelief` is compressed and reported). Plateaus: every building, every lot, and **every street segment** (its
carriageway, kerb and sidewalk) is one level; a plateau is clamped to within one voxel of any plateau it touches; the
remaining cells relax until every neighbouring step is ≤ 1. Height changes therefore run straight across a street at
a junction or bend.

## 7 · Voxels

Bedrock, stone and soil up to the surface; surface material by role (asphalt, kerb, sidewalk, lot, stripe, paved
yard, grass). Buildings: a floor slab per storey (`storeyHeight` voxels), perimeter walls by use (brick, concrete,
stucco, siding), glazing on exposed non-party walls (a storefront on a shop's front), a door on the front — the side of
the largest wing facing its car park (shops) or the nearest street — doorways through shared wing lines, a roof slab
and a parapet on outer edges. Storeys from `building:levels`/`height` (or Wikidata floors, or the largest 3D part); a
strip-centre unit with no height is one storey. Every OSM 3D part that rises above the shell is extruded from its
`min_height` to its `height` (walls with window bands, a floor where it starts), and capped by its `roof:shape`: flat
slab, or a voxel stair toward the middle — along the long axis for gabled, all round for hipped/pyramidal/dome —
`roof:height` tall or half the narrow side. Mapped trees get a trunk and crown.

## 8 · Road paint

From the road graph, not the voxels: junctions from segment intersections; double yellow on two-way arterials, dashed
yellow on smaller two-way streets, white lane separators and edge lines; at each junction mouth a stop bar on the
inbound lanes and one continental crosswalk per crossing (none across slip lanes, none within 6 cells of another);
OSM `footway=crossing` ways as zebras. Output: quads `{ c: [[x, y] × 4], z, color }`.
