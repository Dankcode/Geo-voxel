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
from highrise.walls import THICK, floor_walls

SLAB = 200
COL = {"ext_wall": "#e7e0d1", "int_wall": "#f2eee6", "core_wall": "#d8d1c3", "slab": "#b9b3a8", "window": "#b9d6df",
       "frame": "#5b6268", "door": "#8b6b4a", "fire_door": "#a3452f", "railing": "#5e6a72", "ac_platform": "#cfcac0",
       "stair": "#c7c0b2", "column": "#cdc6b8", "roof": "#99938a", "parapet": "#e3dccd", "paving": "#d6d1c4",
       "ramp": "#cbc5b7", "mailbox": "#8f9aa1", "lift_door": "#9aa3a8", "tower": "#ddd6c8",
       # facade styles (highrise.facade)
       "ext_wall_base": "#c9c3b5", "ext_wall_top": "#e7e0d1", "band": "#5b6268", "surround": "#5b6268",
       "pilaster": "#d8d1c3", "cornice": "#c9c3b5", "fin": "#c4c8cc", "spandrel": "#2e3a42", "ac_louver": "#8a8f93",
       "crown": "#5b6268", "roof_tile": "#4a4c4e", "finial": "#9c8155"}
IFC = {"ext_wall": "Wall", "int_wall": "Wall", "core_wall": "Wall", "slab": "Slab", "window": "Window", "frame": "Window",
       "door": "Door", "fire_door": "Door", "railing": "Railing", "ac_platform": "Slab", "stair": "Stair",
       "column": "Column", "roof": "Roof", "parapet": "Wall", "paving": "Slab", "ramp": "Ramp",
       "mailbox": "Furniture", "lift_door": "Door", "tower": "Wall",
       "ext_wall_base": "Wall", "ext_wall_top": "Wall", "band": "Covering", "surround": "Covering",
       "pilaster": "Covering", "cornice": "Covering", "fin": "Covering", "spandrel": "Covering",
       "ac_louver": "Covering", "crown": "Covering", "roof_tile": "Roof", "finial": "Covering"}


def box(x0, y0, x1, y1, z0, z1):
    """Plan rectangle (y south) -> solid in the FreeCAD frame (Y north)."""
    x0, x1 = min(x0, x1), max(x0, x1)
    Y0, Y1 = -max(y0, y1), -min(y0, y1)
    if x1 - x0 < 1 or Y1 - Y0 < 1 or z1 - z0 < 1:
        return None
    return Part.makeBox(x1 - x0, Y1 - Y0, z1 - z0, V(x0, Y0, z0))


class Floor:
    """Shapes of one kind of floor, at z = 0, grouped by role."""

    def __init__(self):
        self.parts = {}

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
    ly1 = core["lobby_y"][1]
    for lr in core["lift_rects"]:
        cx = (lr[0] + lr[2]) / 2
        ops.append(("h", ly1, cx - 550, cx + 550, 0, 2100))
        leaves.append({"orient": "h", "at": ly1, "from": cx - 550, "to": cx + 550, "kind": "door", "lift": True})
    return ops, leaves


def typical_floor(b):
    H = b["requirements"]["storey_h"] * 1000
    fp = b["floor_plate"]
    F = Floor()
    rooms = fp["rooms"]
    for rid, rm in rooms.items():
        for q in rm["rects"]:
            if rm["type"] == "CORE" and rm.get("role") == "stair":
                continue                                    # stair box: landings only
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
            F.add("lift_door", box(d["from"], d["at"] - 30, d["to"], d["at"] + 30, 0, 2100))
        else:
            leaf(F, d)
    for rid, rm in rooms.items():
        if rm["type"] == "BL":
            railing_edges(F, rm["rects"][0], "SEW", 1200)
    stairs(F, b["core"], H, b["requirements"]["risers_per_storey"])
    F.counts = {"walls": nwalls, "windows": len(fp["windows"]), "doors": len([d for d in fp["doors"] if d["kind"] == "door"]) + len(cleaves)}
    return F


def core_only(b, F, H):
    core = b["core"]
    rooms = {"core." + k: v for k, v in core["rooms"].items()}
    for rid, rm in rooms.items():
        if rm.get("role") != "stair":
            for q in rm["rects"]:
                F.add("slab", box(*q, -SLAB, 0))
    return rooms


def ground_floor(b):
    H = b["requirements"]["storey_h"] * 1000
    g, core = b["ground"], b["core"]
    off = b["requirements"]["ground_offset"] * 1000
    F = Floor()
    ex = g["pilotis_extent"]
    F.add("paving", box(ex[0] - 1500, ex[1] - 1500, ex[2] + 1500, ex[3] + 3000, -off - 100, -off))   # grade
    hall = g["hall"]
    rooms = core_only(b, F, H)
    rooms["hall"] = {"type": "HL", "rects": [hall]}
    F.add("slab", box(*hall, -SLAB, 0))
    cops, cleaves = core_openings(core)
    e = g["entrance"]
    se = g["stair_exit"]
    ops = cops + [("h", e["at"], e["from"], e["to"], 0, 2400), ("h", se["at"], se["from"], se["to"], 0, 2100)]
    # the lobby opens to the hall at both ends (no dwelling doors on the ground floor)
    ly0, ly1 = core["lobby_y"]
    for x in (-core["width"] / 2, core["width"] / 2):
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
            F.add("lift_door", box(d["from"], d["at"] - 30, d["to"], d["at"] + 30, 0, 2100))
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
    for q in body:
        F.add("slab", box(*q, -SLAB, 0))
    x0 = min(q[0] for q in body); x1 = max(q[2] for q in body); y0 = min(q[1] for q in body); y1 = max(q[3] for q in body)
    cops, cleaves = core_openings(core)
    ly0, ly1 = core["lobby_y"]
    ops = cops + [("v", x, ly0 + 300, ly1 - 300, 0, 2400) for x in (-core["width"] / 2, core["width"] / 2)]
    wall_shapes(F, rooms, H, ops)
    railing_edges(F, [x0, y0, x1, y1], "NSEW", 1200, role="parapet", t=200)       # open refuge area, 1.2 m parapet
    for cx, cy in (b["ground"] or {}).get("columns", []):
        F.add("column", box(cx - 200, cy - 200, cx + 200, cy + 200, 0, H - SLAB))
    for d in cleaves:
        if d.get("lift"):
            F.add("lift_door", box(d["from"], d["at"] - 30, d["to"], d["at"] + 30, 0, 2100))
        else:
            leaf(F, d)
    stairs(F, core, H, b["requirements"]["risers_per_storey"])
    F.counts = {"walls": 0, "windows": 0, "doors": len(cleaves)}
    return F


def roof_level(b):
    F = Floor()
    r = b["roof"]
    body = [q for rm in b["floor_plate"]["rooms"].values() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    for q in body:
        F.add("roof", box(*q, -SLAB, 0))
    x0 = min(q[0] for q in body); x1 = max(q[2] for q in body); y0 = min(q[1] for q in body); y1 = max(q[3] for q in body)
    railing_edges(F, [x0, y0, x1, y1], "NSEW", r["parapet_h"] * 1000, role="parapet", t=200)
    hh = r["head_h"]
    for rect in (r["stair_head"], r["machine_room"]):
        railing_edges(F, rect, "NSEW", hh, role="tower", t=200)
        F.add("roof", box(*rect, hh, hh + SLAB))
    d = r["roof_door"]
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
                             "Furniture": "Furniture", "Covering": "Covering"}[IFC[role]]
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
        for role, shapes in F.parts.items():
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
        for role, (v, f) in cache[id(F)].items():
            p = np.empty_like(v)
            p[:, 0] = v[:, 0] / 1000
            p[:, 1] = (v[:, 2] + z) / 1000          # viewer: y up
            p[:, 2] = -v[:, 1] / 1000               # viewer z = -FreeCAD Y = plan y (south)
            mesh.append({"role": role, "storey": int(s), "color": (palette or {}).get(role, COL[role]),
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
    return G


def build(b, out_dir, meta_extra=None, ifc=True, style="plain"):
    os.makedirs(out_dir, exist_ok=True)
    st = FA.STYLES[style]
    env = FA.envelope(b)
    typ = typical_floor(b)
    kinds = {"typical": typ}
    if b.get("ground"):
        kinds["pilotis"] = ground_floor(b)
    if any(f["kind"] == "refuge" for f in b["floors"]):
        kinds["refuge"] = refuge_floor(b)
    zoned, floors = {}, []
    for f in b["floors"]:
        key = (f["kind"], FA.zone_of(b, f["storey"], st))
        if key not in zoned:
            zoned[key] = styled(kinds[f["kind"]], b, env, st, key[1], f["kind"])
        floors.append((f["kind"], zoned[key]))
    roof = roof_level(b)
    roof.prims = FA.crown(b, env, st, b["requirements"]["storey_h"] * 1000) if st.get("palette") else []
    for p in roof.prims:
        roof.add(p["role"], prim_shape(p))
    floors.append(("roof", roof))
    rep = {"storeys": len(b["floors"]), "floor_kinds": ["/".join(k) for k in zoned], "style": style}
    from highrise import viewer_export as VE
    tot = {k: sum(kinds[f["kind"]].counts.get(k, 0) for f in b["floors"]) for k in ("walls", "windows", "doors")}
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
        json.dump(VE.plan2d(b), fo, separators=(",", ":"))
    if ifc:
        rep.update(to_ifc_and_mesh(b, floors, out_dir))
    rep["counts_per_typical_floor"] = typ.counts
    return rep


if __name__ == "__main__":
    b = json.load(open(sys.argv[1]))
    style = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--style=")), "plain")
    if style != "plain":
        b = dict(b, id=f"{b['id']}-{style.replace('_', '-')}", name=f"{b['name']} · {FA.STYLES[style]['name']} facade",
                 style=style, style_of=b["id"])
    rep = build(b, sys.argv[2], ifc="--no-ifc" not in sys.argv, style=style)
    if style != "plain":                     # the variant's building.json: the plan's, plus the style and its checks
        b["facade_checks"] = rep["facade_checks"]
        with open(os.path.join(sys.argv[2], "building.json"), "w") as fo:
            json.dump(b, fo, separators=(",", ":"))
    print(json.dumps(rep, default=str))
