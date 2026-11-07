"""building.json -> FreeCAD BIM model of the whole high-rise: every storey, the ground floor, refuge floors, roof.

    freecadcmd / FreeCAD's python:  python -m highrise.bim <building.json> <out_dir> [--no-ifc] [--style=STYLE]

STYLE is one of highrise.facade.STYLES (modern, neo_chinese, art_deco, public); a styled build gets the id
<id>-<style>, adds the facade's cladding, pilasters, fins and roof crown, and writes its own building.json with
the facade checks.

Writes <id>.FCStd, <id>.ifc (IFC4: one IfcBuildingStorey per storey, elements typed IfcWall, IfcSlab, IfcWindow,
IfcDoor, IfcStair, IfcRailing, IfcColumn, IfcRoof) and <id>.mesh.json (coloured triangles for the house viewer, in
the format architecture/pipeline/bim.py writes).

Each kind of floor (ground, typical, refuge) is modelled once at z = 0 and placed at every storey of that kind:
the typical floor repeats, so its walls, openings and stairs are identical on every level, as built.
Frame: FreeCAD X = plan x (east), Y = -plan y (north), Z up; mm.
"""
import base64
import json
import os
import sys

import FreeCAD
import Part
from FreeCAD import Vector as V

from highrise import facade as FA
from highrise.walls import THICK, floor_walls, diagonal_walls, diagonal_wall_ring

SLAB = 200
SHAFTS = ("stair", "lift", "fire lift", "shaft")         # core rooms with no floor slab on the storeys above ground
COL = {"ext_wall": "#e7e0d1", "int_wall": "#f2eee6", "core_wall": "#d8d1c3", "slab": "#b9b3a8", "window": "#b9d6df",
       "frame": "#5b6268", "door": "#8b6b4a", "fire_door": "#a3452f", "railing": "#5e6a72", "ac_platform": "#cfcac0",
       "stair": "#c7c0b2", "column": "#cdc6b8", "roof": "#99938a", "parapet": "#e3dccd", "paving": "#d6d1c4",
       "ramp": "#cbc5b7", "mailbox": "#8f9aa1", "lift_door": "#9aa3a8", "tower": "#ddd6c8",
       # facade styles (highrise.facade)
       "ext_wall_base": "#c9c3b5", "ext_wall_top": "#e7e0d1", "band": "#5b6268", "surround": "#5b6268",
       "pilaster": "#d8d1c3", "cornice": "#c9c3b5", "fin": "#c4c8cc", "spandrel": "#2e3a42", "ac_louver": "#8a8f93",
       "crown": "#5b6268", "roof_tile": "#4a4c4e", "finial": "#9c8155", "lift_car": "#aeb5ba"}
IFC = {"ext_wall": "Wall", "int_wall": "Wall", "core_wall": "Wall", "slab": "Slab", "window": "Window", "frame": "Window",
       "door": "Door", "fire_door": "Door", "railing": "Railing", "ac_platform": "Slab", "stair": "Stair",
       "column": "Column", "roof": "Roof", "parapet": "Wall", "paving": "Slab", "ramp": "Ramp",
       "mailbox": "Furniture", "lift_door": "Door", "tower": "Wall",
       "ext_wall_base": "Wall", "ext_wall_top": "Wall", "band": "Covering", "surround": "Covering",
       "pilaster": "Covering", "cornice": "Covering", "fin": "Covering", "spandrel": "Covering",
       "ac_louver": "Covering", "crown": "Covering", "roof_tile": "Roof", "finial": "Covering", "lift_car": "Transport Element"}


def box(x0, y0, x1, y1, z0, z1):
    """Plan rectangle (y south) -> solid in the FreeCAD frame (Y north)."""
    x0, x1 = min(x0, x1), max(x0, x1)
    Y0, Y1 = -max(y0, y1), -min(y0, y1)
    if x1 - x0 < 1 or Y1 - Y0 < 1 or z1 - z0 < 1:
        return None
    return Part.makeBox(x1 - x0, Y1 - Y0, z1 - z0, V(x0, Y0, z0))


class Floor:
    """Shapes of one kind of floor, at z = 0, grouped by role; furniture grouped by colour (furn)."""

    def __init__(self):
        self.parts = {}
        self.furn = {}
        self.furniture = []

    def add(self, role, shape):
        if shape is not None:
            self.parts.setdefault(role, []).append(shape)


def wall_shapes(F, rooms, H, openings, core_role=True, role_fn=None):
    """Walls between spaces, cut by door/window openings. openings: list of (orient, at, lo, hi, z0, z1)."""
    walls = floor_walls(rooms)
    n = 0
    for o, c, lo, hi, kind, _sides in walls:
        t = THICK[kind]
        e = t / 2                                            # run walls past the corner so joints close
        if o == "v":
            sh = box(c - t / 2, lo - e, c + t / 2, hi + e, 0, H - SLAB)
        else:
            sh = box(lo - e, c - t / 2, hi + e, c + t / 2, 0, H - SLAB)
        cuts = []
        for oo, oc, olo, ohi, z0, z1 in openings:
            if oo == o and abs(oc - c) < 5 and min(ohi, hi) - max(olo, lo) > 0:
                if o == "v":
                    cuts.append(box(oc - t, olo, oc + t, ohi, z0, z1))
                else:
                    cuts.append(box(olo, oc - t, ohi, oc + t, z0, z1))
        cuts = [x for x in cuts if x is not None]
        if cuts:
            sh = sh.cut(Part.makeCompound(cuts))
        role = "ext_wall" if kind == "exterior" else ("core_wall" if kind in ("core", "party") and core_role else "int_wall")
        if role_fn:
            role = role_fn(kind, _sides, role)
        F.add(role, sh)
        n += 1
    for x0, y0, x1, y1, kind in diagonal_walls(rooms):     # 45-degree walls of diagonal corner cuts (walk.py)
        ring = [V(x, -y, 0) for x, y in diagonal_wall_ring(x0, y0, x1, y1, THICK[kind])]
        face = Part.Face(Part.makePolygon(ring + [ring[0]]))
        F.add("int_wall", face.extrude(V(0, 0, H - SLAB)))
        n += 1
    return n


def glazing(F, w, H):
    """Window pane and frame in the opening."""
    z0, z1 = 900, 2400
    if w["orient"] == "h":
        F.add("window", box(w["from"], w["y"] - 15, w["to"], w["y"] + 15, z0, z1))
        F.add("frame", box(w["from"], w["y"] - 60, w["to"], w["y"] + 60, z0 - 50, z0))
    else:
        F.add("window", box(w["x"] - 15, w["from"], w["x"] + 15, w["to"], z0, z1))
        F.add("frame", box(w["x"] - 60, w["from"], w["x"] + 60, w["to"], z0 - 50, z0))


def leaf(F, d, h=2100):
    """Door leaf, closed, in the opening (sliding doors: glass)."""
    role = "fire_door" if d.get("fire") else "door"
    if d["kind"] == "open":
        return
    if d["kind"] == "slide" or d.get("b") == "bl":
        role = "window"
        h = 2400
    if d["orient"] == "v":
        F.add(role, box(d["at"] - 25, d["from"], d["at"] + 25, d["to"], 0, h))
    else:
        F.add(role, box(d["from"], d["at"] - 25, d["to"], d["at"] + 25, 0, h))


def railing_edges(F, rect, sides, h, role="railing", t=60):
    x0, y0, x1, y1 = rect
    if "S" in sides:
        F.add(role, box(x0, y1 - t, x1, y1, 0, h))
    if "N" in sides:
        F.add(role, box(x0, y0, x1, y0 + t, 0, h))
    if "E" in sides:
        F.add(role, box(x1 - t, y0, x1, y1, 0, h))
    if "W" in sides:
        F.add(role, box(x0, y0, x0 + t, y1, 0, h))


def stairs(F, core, H, risers, ground=False):
    """Steps inside the stair box. Scissor: two straight runs per storey, crossing; switchback: two flights."""
    x0, y0, x1, y1 = core["rooms"]["stair"]["rects"][0]
    land, tread = 1300, 260
    rise = H / risers
    if core["stair_kind"] == "scissor":
        mid = (y0 + y1) / 2
        F.add("core_wall", box(x0 + land, mid - 50, x1 - land, mid + 50, 0, H - SLAB))       # 1.00 h wall between runs
        for k in range(risers - 1):                                                          # run A climbs east
            xa = x0 + land + k * tread
            F.add("stair", box(xa, y0 + 100, xa + tread, mid - 50, 0, (k + 1) * rise))
        for k in range(risers - 1):                                                          # run B climbs west
            xb = x1 - land - (k + 1) * tread
            F.add("stair", box(xb, mid + 50, xb + tread, y1 - 100, 0, (k + 1) * rise))
        for xs in ((x0 + 100, x0 + land), (x1 - land, x1 - 100)):
            F.add("slab", box(xs[0], y0 + 100, xs[1], y1 - 100, -SLAB, 0))
    else:
        mid = (y0 + y1) / 2
        n1 = risers // 2
        for k in range(n1):                                                                  # flight 1 east
            xa = x0 + land + k * tread
            F.add("stair", box(xa, y0 + 100, xa + tread, mid - 50, 0, (k + 1) * rise))
        for k in range(risers - n1 - 1):                                                     # flight 2 west
            xb = x0 + land + (n1 - 1 - k) * tread
            F.add("stair", box(xb, mid + 50, xb + tread, y1 - 100, n1 * rise, n1 * rise + (k + 1) * rise))
        F.add("stair", box(x0 + land + n1 * tread, y0 + 100, x1 - 100, y1 - 100, n1 * rise - SLAB, n1 * rise))  # half landing
        F.add("slab", box(x0 + 100, y0 + 100, x0 + land, y1 - 100, -SLAB, 0))


def core_openings(core):
    """Stair doors, lift doors and the lobby ends (where the dwelling doors sit) as wall openings."""
    ops, leaves = [], []
    for sx, sy in core["stair_doors"]:
        ops.append(("h", sy, sx - 500, sx + 500, 0, 2100))
        leaves.append({"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "fire": "B"})
    if core.get("lift_doors"):
        # whole-floor search core (floorplan.py): each lift's door where the template puts it (the fire lift into the
        # fire lobby, the others onto the corridor), and the fire lobby's own door onto the corridor
        for d in core["lift_doors"]:
            ops.append((d["orient"], d["at"], d["from"], d["to"], 0, 2100))
            leaves.append(dict(d, kind="door", lift=True))
        if core.get("lobby_door"):
            d = core["lobby_door"]
            ops.append((d["orient"], d["at"], d["from"], d["to"], 0, 2100))
            leaves.append(dict(d, kind="door", fire="B"))
        return ops, leaves
    ly1 = core["lobby_y"][1]
    for lr in core["lift_rects"]:
        cx = (lr[0] + lr[2]) / 2
        ops.append(("h", ly1, cx - 550, cx + 550, 0, 2100))
        leaves.append({"orient": "h", "at": ly1, "from": cx - 550, "to": cx + 550, "kind": "door", "lift": True})
    return ops, leaves


def lift_door(F, d):
    if d["orient"] == "v":
        F.add("lift_door", box(d["at"] - 30, d["from"], d["at"] + 30, d["to"], 0, 2100))
    else:
        F.add("lift_door", box(d["from"], d["at"] - 30, d["to"], d["at"] + 30, 0, 2100))


def typical_floor(b):
    H = b["requirements"]["storey_h"] * 1000
    fp = b["floor_plate"]
    F = Floor()
    rooms = fp["rooms"]
    for rid, rm in rooms.items():
        for q in rm["rects"]:
            if rm["type"] == "CORE" and rm.get("role") in SHAFTS:
                continue                                    # stair box: landings only; lift and service shafts: open
            F.add("slab", box(q[0], q[1], q[2], q[3], -SLAB, 0))
    for a in fp["ac"]:
        F.add("ac_platform", box(*a["rect"], -SLAB, 0))
        side = {"N": "NEW", "S": "SEW", "E": "NSE"}[a["side"]]
        railing_edges(F, a["rect"], side, 1200, role="ac_platform", t=40)
    ops = []
    for d in fp["doors"]:
        if d["kind"] == "open":
            ops.append((d["orient"], d["at"], d["from"], d["to"], 0, H - SLAB - 1))
        else:
            hgt = 2400 if (d["kind"] == "slide" or d.get("b") == "bl") else 2100
            ops.append((d["orient"], d["at"], d["from"], d["to"], 0, hgt))
    for w in fp["windows"]:
        ops.append((w["orient"], w.get("y", w.get("x")), w["from"], w["to"], 900, 2400))
    cops, cleaves = core_openings(b["core"])
    ops += cops
    nwalls = wall_shapes(F, rooms, H, ops)
    for w in fp["windows"]:
        glazing(F, w, H)
    for d in fp["doors"]:
        if d.get("role") != "stair":
            leaf(F, d)
    for d in cleaves:
        if d.get("lift"):
            lift_door(F, d)
        else:
            leaf(F, d)
    for rid, rm in rooms.items():
        if rm["type"] == "BL":
            railing_edges(F, rm["rects"][0], "SEW", 1200)
    stairs(F, b["core"], H, b["requirements"]["risers_per_storey"])
    F.counts = {"walls": nwalls, "windows": len(fp["windows"]), "doors": len([d for d in fp["doors"] if d["kind"] == "door"]) + len(cleaves)}
    furnish(F, b)
    return F


# The houses' plant is a sphere of foliage (about 8,500 triangles); 4 plants on each of 23 typical floors would be most
# of a tower's mesh, so a tower's plants are a pot and a cone of leaves on the same footprint.
def _ngon(cx, cy, r, z, n=8):
    import math
    pts = [V(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n), z) for k in range(n)]
    return Part.makePolygon(pts + [pts[0]])


def _low_poly_plant():
    pot = Part.Face(_ngon(200, 200, 160, 0)).extrude(V(0, 0, 360))
    crown = Part.makeLoft([_ngon(200, 200, 90, 360), _ngon(200, 200, 200, 650), _ngon(200, 200, 40, 1080)], True, True)
    return [(pot, "#a05a3c"), (crown, "#4f7a46")]


LOW_POLY = {"plant": _low_poly_plant}


def furnish(F, b):
    """Furniture for the dwellings (highrise.furnish: the houses' furnisher), built from the houses' furniture library
    (architecture/pipeline/furniture.py). The plan's furniture: a facade style keeps it (seeded by the plan, not the
    style)."""
    from highrise import furnish as HFN
    import furniture as FUR
    fp = b["floor_plate"]
    F.furniture, F.furnish_report = HFN.furnish_floor(fp["rooms"], fp["doors"], fp["windows"], FUR.ITEMS,
                                                      seed=b.get("style_of") or b["id"])
    for fi in F.furniture:
        for shp, col in LOW_POLY.get(fi["name"], FUR.ITEMS[fi["name"]][2])():
            sh = shp.copy()
            sh.rotate(V(0, 0, 0), V(0, 0, 1), fi["ang"])
            sh.translate(V(fi["x"], fi["y"], 0))
            F.furn.setdefault(col, []).append(sh)
    F.counts["furniture"] = len(F.furniture)


def core_only(b, F, H, pit=False):
    """The core's rooms and floor slabs. Shafts are open through the building; on the ground floor (pit=True) the
    lift and service shafts get their pit floor."""
    core = b["core"]
    rooms = {"core." + k: v for k, v in core["rooms"].items()}
    for rid, rm in rooms.items():
        if rm.get("role") == "stair" or (rm.get("role") in SHAFTS and not pit):
            continue
        for q in rm["rects"]:
            F.add("slab", box(*q, -SLAB, 0))
    return rooms


def lift_cars(F, core):
    """A lift car parked at the ground floor in every lift shaft, its open side on the door side of the shaft."""
    cw, cd = 1600, 1500                                     # 1.6 x 1.5 m car (GB 55038 4.2.4(3))
    sides = [d.get("side", "N") for d in core.get("lift_doors", [])] or ["N"] * len(core["lift_rects"])
    for (x0, y0, x1, y1), side in zip(core["lift_rects"], sides):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

        def put(u0, v0, u1, v1, z0, z1):
            # (u across the door, v inwards from the door side) -> plan rectangle
            if side == "N":
                q = (cx + u0, y0 + v0, cx + u1, y0 + v1)
            elif side == "S":
                q = (cx + u0, y1 - v1, cx + u1, y1 - v0)
            elif side == "W":
                q = (x0 + v0, cy + u0, x0 + v1, cy + u1)
            else:
                q = (x1 - v1, cy + u0, x1 - v0, cy + u1)
            F.add("lift_car", box(*q, z0, z1))
        h, c = cw / 2, 250
        put(-h, c + cd - 60, h, c + cd, 0, 2400)                                          # back wall
        put(-h, c, -h + 250, c + 60, 0, 2400)                                             # front jambs (door 1.1 m)
        put(h - 250, c, h, c + 60, 0, 2400)
        put(-h, c, h, c + 60, 2100, 2400)                                                 # front head
        put(-h, c, -h + 60, c + cd, 0, 2400)
        put(h - 60, c, h, c + cd, 0, 2400)
        put(-h, c, h, c + cd, -120, 0)                                                    # car floor
        put(-h, c, h, c + cd, 2400, 2520)                                                 # car roof


def ground_floor(b):
    H = b["requirements"]["storey_h"] * 1000
    g, core = b["ground"], b["core"]
    off = b["requirements"]["ground_offset"] * 1000
    F = Floor()
    ex = g["pilotis_extent"]
    F.add("paving", box(ex[0] - 1500, ex[1] - 1500, ex[2] + 1500, ex[3] + 3000, -off - 100, -off))   # grade
    hall = g["hall"]
    rooms = core_only(b, F, H, pit=True)
    lift_cars(F, core)
    rooms["hall"] = {"type": "HL", "rects": [hall] + list(g.get("hall_extra", []))}
    for q in rooms["hall"]["rects"]:
        F.add("slab", box(*q, -SLAB, 0))
    cops, cleaves = core_openings(core)
    e = g["entrance"]
    se = g["stair_exit"]
    ops = cops + [("h", e["at"], e["from"], e["to"], 0, 2400), ("h", se["at"], se["from"], se["to"], 0, 2100)]
    # the lobby opens to the hall at both ends (no dwelling doors on the ground floor)
    ly0, ly1 = core["lobby_y"]
    for x in ((-core["width"] / 2, core["width"] / 2) if not core.get("lift_doors") else ()):
        ops.append(("v", x, ly0 + 300, ly1 - 300, 0, 2400))
    # the hall's outside walls are glass: model them as walls (with openings), then swap in glazing
    hall_glass = lambda kind, sides, role: "hall_glass" if (kind == "exterior" and "hall" in sides) else role
    nwalls = wall_shapes(F, rooms, H, ops, role_fn=hall_glass)
    for sh in F.parts.pop("hall_glass", []):
        bb = sh.BoundBox
        F.add("frame", sh.common(Part.makeBox(bb.XLength, bb.YLength, 300, V(bb.XMin, bb.YMin, 0))))
        F.add("window", sh.common(Part.makeBox(bb.XLength, bb.YLength, H - SLAB - 300, V(bb.XMin, bb.YMin, 300))))
    for d in cleaves:
        if d.get("lift"):
            lift_door(F, d)
        else:
            leaf(F, d)
    leaf(F, dict(se, fire="B"))
    F.add("door", box(e["from"], e["at"] - 25, e["from"] + 120, e["at"] + 25, 0, 2400))           # open glass doors
    F.add("door", box(e["to"] - 120, e["at"] - 25, e["to"], e["at"] + 25, 0, 2400))
    r = g["ramp"]
    # ramp from grade up to the hall floor, 1:12
    L = r[3] - r[1]
    prof = Part.makePolygon([V(r[0], -r[1], 0), V(r[0], -r[3], -off), V(r[0], -r[1], -off), V(r[0], -r[1], 0)])
    F.add("ramp", Part.Face(prof).extrude(V(r[2] - r[0], 0, 0)))
    railing_edges(F, r, "EW", 900, t=50)
    m = g["mail"]
    F.add("mailbox", box(m[0] + 200, m[1] + 150, m[2] - 200, m[1] + 450, 300, 1800))
    for cx, cy in g["columns"]:
        F.add("column", box(cx - 200, cy - 200, cx + 200, cy + 200, -off, H - SLAB))
    stairs(F, core, H, b["requirements"]["risers_per_storey"])
    F.counts = {"walls": nwalls, "windows": 0, "doors": len(cleaves) + 2}
    return F


def refuge_floor(b):
    H = b["requirements"]["storey_h"] * 1000
    F = Floor()
    core = b["core"]
    rooms = core_only(b, F, H)
    body = [q for rm in b["floor_plate"]["rooms"].values() if rm["type"] not in ("CORE", "BL", "AC") for q in rm["rects"]]
    body += b["floor_plate"].get("corridor", [])                 # 4 or 6 flats a floor: the lobby corridor is refuge area too
    for q in body:
        F.add("slab", box(*q, -SLAB, 0))
    x0 = min(q[0] for q in body); x1 = max(q[2] for q in body); y0 = min(q[1] for q in body); y1 = max(q[3] for q in body)
    cops, cleaves = core_openings(core)
    ly0, ly1 = core["lobby_y"]
    ops = cops + [("v", x, ly0 + 300, ly1 - 300, 0, 2400)
                  for x in ((-core["width"] / 2, core["width"] / 2) if not core.get("lift_doors") else ())]
    wall_shapes(F, rooms, H, ops)
    railing_edges(F, [x0, y0, x1, y1], "NSEW", 1200, role="parapet", t=200)       # open refuge area, 1.2 m parapet
    for cx, cy in (b["ground"] or {}).get("columns", []):
        F.add("column", box(cx - 200, cy - 200, cx + 200, cy + 200, 0, H - SLAB))
    for d in cleaves:
        if d.get("lift"):
            lift_door(F, d)
        else:
            leaf(F, d)
    stairs(F, core, H, b["requirements"]["risers_per_storey"])
    F.counts = {"walls": 0, "windows": 0, "doors": len(cleaves)}
    return F


def tower_walls(F, rect, hh, gaps=(), t=200):
    """Walls of a roof-top room, with door gaps: gaps = [(side, lo, hi)] (2.1 m high, wall above)."""
    x0, y0, x1, y1 = rect
    sides = {"N": ("h", y0, y0 + t, x0, x1), "S": ("h", y1 - t, y1, x0, x1),
             "W": ("v", x0, x0 + t, y0, y1), "E": ("v", x1 - t, x1, y0, y1)}
    for side, (o, a, b_, lo, hi) in sides.items():
        cuts = sorted((g[1], g[2]) for g in gaps if g[0] == side)
        runs, cur = [], lo
        for c0, c1 in cuts:
            runs.append((cur, c0))
            F.add("tower", box(c0, a, c1, b_, 2100, hh) if o == "h" else box(a, c0, b_, c1, 2100, hh))
            cur = c1
        runs.append((cur, hi))
        for r0, r1 in runs:
            if r1 - r0 > 1:
                F.add("tower", box(r0, a, r1, b_, 0, hh) if o == "h" else box(a, r0, b_, r1, 0, hh))


def roof_exit(b):
    """The stair head's door onto the roof: in its east wall, at the lobby's middle (opens onto the roof over the
    east dwelling). The stored roof_door (its south wall) is the lift machine room's door."""
    core, r = b["core"], b["roof"]
    if r.get("roof_exit"):                                  # building.py records it (buildings made after 2026-11-05)
        return r["roof_exit"]
    x1 = r["stair_head"][2]
    ly0, ly1 = core["lobby_y"]
    m = (ly0 + ly1) / 2
    return {"orient": "v", "at": x1, "from": m - 500, "to": m + 500}


def roof_level(b):
    """Roof slab (open over the stair well, with the flights' landings), parapet, the stair head room with a door out
    onto the roof and a door into the lift machine room, which stands over the lift shafts."""
    F = Floor()
    r, core = b["roof"], b["core"]
    stair = core["rooms"]["stair"]["rects"][0]
    body = [q for rm in b["floor_plate"]["rooms"].values() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    for q in body:
        if list(q) != list(stair):
            F.add("roof", box(*q, -SLAB, 0))
    sx0, sy0, sx1, sy1 = stair
    land = 1300
    ends = ((sx0 + 100, sx0 + land), (sx1 - land, sx1 - 100)) if core["stair_kind"] == "scissor" else ((sx0 + 100, sx0 + land),)
    for a, c in ends:                                       # where the top flights arrive
        F.add("slab", box(a, sy0 + 100, c, sy1 - 100, -SLAB, 0))
    x0, x1 = min(q[0] for q in body), max(q[2] for q in body)
    y0, y1 = min(q[1] for q in body), max(q[3] for q in body)
    railing_edges(F, [x0, y0, x1, y1], "NSEW", r["parapet_h"] * 1000, role="parapet", t=200)
    hh = r["head_h"]
    ex, md = roof_exit(b), r["roof_door"]
    sd = r.get("sides", {"exit": "E", "head_door": "S", "machine_door": "N"})     # floorplan.py records its own
    tower_walls(F, r["stair_head"], hh, [(sd["exit"], ex["from"], ex["to"]), (sd["head_door"], md["from"], md["to"])])
    tower_walls(F, r["machine_room"], hh, [(sd["machine_door"], md["from"], md["to"])])
    for rect in (r["stair_head"], r["machine_room"]):
        F.add("roof", box(*rect, hh, hh + SLAB))
    leaf(F, dict(ex, at=ex["at"] - 100, kind="door", fire="B"))
    leaf(F, dict(md, at=md["at"] - 100, kind="door", fire="B"))
    return F


def to_ifc_and_mesh(b, floors, out_dir):
    import Arch
    key = b["id"]
    doc = FreeCAD.newDocument(key.replace("-", "_"))
    bld = Arch.makeBuilding([], name=key)
    site = Arch.makeSite([bld], name="Site")
    groups, n_obj = {}, 0
    H = b["requirements"]["storey_h"] * 1000
    off = b["requirements"]["ground_offset"] * 1000
    storeys = []
    for k, (label, F) in enumerate(floors):
        z = off + k * H if label != "roof" else off + (len(floors) - 1) * H
        lvl = Arch.makeFloor([], name=f"Storey {k + 1}" if label != "roof" else "Roof")
        lvl.Placement.Base = V(0, 0, z)
        bld.addObject(lvl)
        for role, shapes in F.parts.items():
            if not shapes:
                continue
            comp = Part.makeCompound(shapes)
            comp.translate(V(0, 0, z))
            obj = doc.addObject("Part::Feature", f"{role}_{k + 1}")
            obj.Shape = comp
            try:
                c = Arch.makeComponent(obj, name=f"{role} {k + 1}")
                c.IfcType = {"Wall": "Wall", "Slab": "Slab", "Window": "Window", "Door": "Door", "Stair": "Stair",
                             "Railing": "Railing", "Column": "Column", "Roof": "Roof", "Ramp": "Ramp",
                             "Furniture": "Furniture", "Covering": "Covering",
                             "Transport Element": "Transport Element"}[IFC[role]]
                lvl.addObject(c)
            except Exception:
                lvl.addObject(obj)
            n_obj += 1
        if F.furn:
            comp = Part.makeCompound([sh for shapes in F.furn.values() for sh in shapes])
            comp.translate(V(0, 0, z))
            obj = doc.addObject("Part::Feature", f"furniture_{k + 1}")
            obj.Shape = comp
            try:
                c = Arch.makeComponent(obj, name=f"furniture {k + 1}")
                c.IfcType = "Furniture"
                lvl.addObject(c)
            except Exception:
                lvl.addObject(obj)
            n_obj += 1
        storeys.append(lvl)
    doc.recompute()
    stem = os.path.join(out_dir, key)
    doc.saveAs(stem + ".FCStd")
    rep = {"objects": n_obj}
    try:
        from importers import exportIFC
        exportIFC.export([site, bld] + storeys, stem + ".ifc")
        rep["ifc_bytes"] = os.path.getsize(stem + ".ifc")
    except Exception as e:
        rep["ifc_error"] = repr(e)[:300]
    FreeCAD.closeDocument(doc.Name)
    return rep


def mesh_json(b, floors, out_dir, meta_extra, palette=None):
    """Tessellate each floor kind once, then place it at every storey (vertices offset in z)."""
    import numpy as np
    H = b["requirements"]["storey_h"] * 1000
    off = b["requirements"]["ground_offset"] * 1000
    cache = {}
    for label, F in set((l, f) for l, f in floors):
        out = {}
        groups = list(F.parts.items()) + [("furniture|" + col, shapes) for col, shapes in F.furn.items()]
        for role, shapes in groups:
            vs, fs, n = [], [], 0
            for sh in shapes:
                try:
                    v, f = sh.tessellate(25)
                except Exception:
                    continue
                vs += [(p.x, p.y, p.z) for p in v]
                fs += [(a + n, b_ + n, c + n) for a, b_, c in f]
                n += len(v)
            if fs:
                out[role] = (np.array(vs, np.float64), np.array(fs, np.uint32))
        cache[id(F)] = out
    mesh, tris = [], 0
    nst = sum(1 for l, _ in floors if l != "roof")
    for k, (label, F) in enumerate(floors):
        z = off + (k if label != "roof" else nst) * H
        s = k if label != "roof" else nst - 1
        for key, (v, f) in cache[id(F)].items():
            role, colour = (("furniture", key.split("|", 1)[1]) if key.startswith("furniture|")
                            else (key, (palette or {}).get(key, COL.get(key))))
            p = np.empty_like(v)
            p[:, 0] = v[:, 0] / 1000
            p[:, 1] = (v[:, 2] + z) / 1000          # viewer: y up
            p[:, 2] = -v[:, 1] / 1000               # viewer z = -FreeCAD Y = plan y (south)
            mesh.append({"role": role, "storey": int(s), "color": colour,
                         "pos": base64.b64encode(p.astype(np.float32).tobytes()).decode(),
                         "idx": base64.b64encode(f.astype(np.uint32).tobytes()).decode()})
            tris += len(f)
    meta = dict(meta_extra)
    with open(os.path.join(out_dir, b["id"] + ".mesh.json"), "w") as fo:
        json.dump({"meta": meta, "mesh": mesh}, fo, separators=(",", ":"))
    return tris


def prim_shape(p):
    """highrise.facade primitive -> solid."""
    if "box" in p:
        return box(*p["box"])
    (r0, z0, r1, z1) = p["frustum"]
    w = lambda r, z: Part.makePolygon([V(r[0], -r[1], z), V(r[2], -r[1], z), V(r[2], -r[3], z), V(r[0], -r[3], z),
                                      V(r[0], -r[1], z)])
    return Part.makeLoft([w(r0, z0), w(r1, z1)], True)


def styled(F, b, env, st, zone, kind):
    """A copy of floor F in a facade zone: envelope roles renamed, the style's elements added."""
    G = Floor()
    ren = FA.zone_roles(st, zone)
    for role, shapes in F.parts.items():
        G.parts.setdefault(ren.get(role, role), []).extend(shapes)
    prims = FA.storey_elements(b, env, st, zone, kind) if st.get("palette") else []
    for p in prims:
        G.add(p["role"], prim_shape(p))
    G.counts = F.counts
    G.prims = prims
    G.furn, G.furniture = F.furn, F.furniture
    return G


def _unit_parts(b, st):
    """All floor kinds of the building, styled, plus its roof."""
    env = FA.envelope(b)
    typ = typical_floor(b)
    kinds = {"typical": typ}
    if b.get("ground"):
        kinds["pilotis"] = ground_floor(b)
    if any(f["kind"] == "refuge" for f in b["floors"]):
        kinds["refuge"] = refuge_floor(b)
    zoned = {}
    for f in b["floors"]:
        key = (f["kind"], FA.zone_of(b, f["storey"], st))
        if key not in zoned:
            zoned[key] = styled(kinds[f["kind"]], b, env, st, key[1], f["kind"])
    roof = roof_level(b)
    roof.prims = FA.crown(b, env, st, b["requirements"]["storey_h"] * 1000) if st.get("palette") else []
    for p in roof.prims:
        roof.add(p["role"], prim_shape(p))
    return kinds, zoned, roof, typ


def build(b, out_dir, meta_extra=None, ifc=True, style="plain"):
    os.makedirs(out_dir, exist_ok=True)
    st = FA.STYLES[style]
    kinds, zoned, roof, typ = _unit_parts(b, st)
    floors = [(f["kind"], zoned[(f["kind"], FA.zone_of(b, f["storey"], st))]) for f in b["floors"]]
    floors.append(("roof", roof))
    rep = {"storeys": len(b["floors"]), "floor_kinds": ["/".join(k) for k in zoned], "style": style}
    from highrise import viewer_export as VE
    tot = {k: sum(kinds[f["kind"]].counts.get(k, 0) for f in b["floors"]) for k in ("walls", "windows", "doors", "furniture")}
    m = VE.meta(b, tot)
    if style != "plain":
        els = {"/".join(k): F.prims for k, F in zoned.items()}
        els["roof"] = roof.prims
        chk = FA.check(b, st, els)
        rep["facade_checks"] = chk
        m["theme"]["style"] = f"chinese_highrise_{style}"
        m["style_params"].update(walls=st["palette"].get("ext_wall", "#e7e0d1"),
                                 cladding=", ".join(sorted({v[0] for v in FA.materials(b, st).values()})))
        m["design"]["checks"] += [{"check": f"{c['id']} {c['rule']} (facade)", "ok": c["pass"], "detail": c["detail"]} for c in chk]
        m["style"] = {"id": style, "name": st["name"], "cn": st["cn"], "materials": FA.materials(b, st),
                      "checks": [{k: c[k] for k in ("id", "rule", "pass", "detail")} for c in chk]}
    m.update(meta_extra or {})
    rep["triangles"] = mesh_json(b, floors, out_dir, m, palette=st["palette"])
    with open(os.path.join(out_dir, b["id"] + ".plan2d.json"), "w") as fo:
        json.dump(VE.plan2d(b, furniture=typ.furniture), fo, separators=(",", ":"))
    if ifc:
        rep.update(to_ifc_and_mesh(b, floors, out_dir))
    rep["counts_per_typical_floor"] = typ.counts
    rep["furnish"] = [{k: r[k] for k in ("room", "kind", "placed", "missing")} for r in getattr(typ, "furnish_report", [])]
    return rep


def main(argv):
    b = json.load(open(argv[1]))
    style = next((a.split("=", 1)[1] for a in argv if a.startswith("--style=")), "plain")
    if style != "plain":
        b = dict(b, id=f"{b['id']}-{style.replace('_', '-')}", name=f"{b['name']} · {FA.STYLES[style]['name']} facade",
                 style=style, style_of=b["id"])
    rep = build(b, argv[2], ifc="--no-ifc" not in argv, style=style)
    if style != "plain":                     # the variant's building.json: the plan's, plus the style and its checks
        b["facade_checks"] = rep["facade_checks"]
        with open(os.path.join(argv[2], "building.json"), "w") as fo:
            json.dump(b, fo, separators=(",", ":"))
    print(json.dumps(rep, default=str))


if __name__ == "__main__":
    # FreeCAD's start-up scripts clear names from __main__ (json, base64, ...): run from a clean import of this module
    import importlib
    import sys as _sys
    importlib.import_module("highrise.bim").main(_sys.argv)
