"""Game export (2026-11-03): one JSON per building with everything a game needs to place it and its interior.

    schema: geo-voxel/building-export@1
    building  — OSM id, address, style, archetype, storeys, storey height, floor raise
    frame     — how local plan metres (u along the street front, v from the front to the back) map to the world:
                origin lat/lon of (u, v) = (0, 0), bearing of +u and of the front (−v), and a per-point helper
    street    — the street the front faces and its bearing
    rooms     — kind, storey, area, polygon in local metres and lat/lon
    doors     — every door and opening: which rooms it joins (or "outside"), centre, width, the bearing it faces
                (outward for exterior doors; from room A to room B for interior ones), kind (entry, back, garage,
                interior, cased, stair), swing side
    garage    — garage door bearing, whether it faces the street, and the turn that would make it face the street
    entry     — the front door's bearing and whether it faces the street
    windows   — position, width, sill, head, bearing (outward)
    stairs    — flight footprint, climbing direction, foot and head
    furniture — every placed item: room, name, centre, rotation (bearing of its front), footprint (for the furniture
                pass; empty rooms are listed with their kind so a later pass can fill them)

Bearings are degrees clockwise from north. Usage: python export_game.py <plan.json> <out.json>
"""
import json, math, sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mapctx as MC

SCHEMA = "geo-voxel/building-export@1"


def world_xy(T, u, v):
    return MC.to_world(T, u, v)


_ORIGIN = None          # the plan's projection origin (plan["geo_origin"]); set by export()


def latlon(T, u, v):
    X, Y = world_xy(T, u, v)
    la0, lo0 = _ORIGIN or (MC.LAT0, MC.LON0)
    return [round(la0 + Y / 111320.0, 7), round(lo0 + X / (111320 * math.cos(math.radians(la0))), 7)]


def bearing(T, du, dv):
    """Bearing (° clockwise from north) of a local direction (du along +u, dv along +v)."""
    x0, y0 = world_xy(T, 0, 0); x1, y1 = world_xy(T, du, dv)
    return round((math.degrees(math.atan2(x1 - x0, y1 - y0)) + 360) % 360, 1)


def angle_diff(a, b):
    return round((a - b + 540) % 360 - 180, 1)


def outward(sp):
    """Local unit normal pointing from the spec's inner room to its outer side."""
    s = 1 if sp["outward"] == 1 else -1
    return (0, s) if sp["axis"] == "x" else (s, 0)


def export(plan, bp=None, furniture=None):
    global _ORIGIN
    _ORIGIN = plan.get("geo_origin")
    import blueprint as BP
    if bp is None: bp = BP.build(plan)
    T = plan["frame"]; rooms = plan["program"]["rooms"]; c = plan["cell"]
    st = bp["style"]; Hs = st["storey"]; R0 = st["raise_"]
    from planner import pair_runs  # noqa (keeps the planner importable from here)
    # rooms
    R = []
    for s, polys in enumerate(bp["polys"]):
        for lab, P in polys.items():
            r = rooms[lab - 1]
            if P is None or P.is_empty: continue
            geoms = list(P.geoms) if P.geom_type == "MultiPolygon" else [P]
            ring = [(x / 1000, y / 1000) for x, y in geoms[0].exterior.coords]
            R.append(dict(id=r["id"], kind=r["kind"], storey=s, area_m2=round(P.area / 1e6, 2), open_air=bool(r.get("open_air")),
                          polygon_local=[[round(u, 3), round(v, 3)] for u, v in ring], polygon_latlon=[latlon(T, u, v) for u, v in ring],
                          centroid_local=[round(P.centroid.x / 1000, 3), round(P.centroid.y / 1000, 3)]))
    def rname(lab):
        if lab <= 0: return "outside"
        r = rooms[lab - 1]; return f"{r['kind']}#{r['id']}"
    front_bearing = bearing(T, 0, -1)
    D, Wn = [], []
    for s, specs in enumerate(bp["specs"]):
        for sp in specs:
            n = outward(sp)
            for o in sp["openings"]:
                pos = o["pos"] / 1000; line = ((sp["d0"] + sp["d1"]) / 2) / 1000
                u, v = (pos, line) if sp["axis"] == "x" else (line, pos)
                outer_open = sp["outer"] <= 0 or rooms[sp["outer"] - 1].get("open_air")
                if o["kind"] in ("door", "overhead"):
                    kind = ("garage" if o["kind"] == "overhead" else "entry" if (o.get("entry") or o.get("street")) else
                            "stair" if o.get("stair_mouth") else "back" if (o.get("back") or (outer_open and sp["outer"] <= 0)) else
                            "porch" if outer_open else "cased" if o.get("ptype") == "cased" else "interior")
                    sw = o.get("swing") or {}
                    D.append(dict(storey=s, kind=kind, rooms=[rname(sp["inner"]), rname(sp["outer"] if sp["outer"] > 0 else 0)],
                                  exterior=bool(outer_open), center_local=[round(u, 3), round(v, 3)], center_latlon=latlon(T, u, v),
                                  width_m=round(o["w"] / 1000, 3), facing_bearing_deg=bearing(T, *n),
                                  faces_street=bool(outer_open and abs(angle_diff(bearing(T, *n), front_bearing)) <= 45),
                                  leaf=o.get("ptype") or ("overhead" if o["kind"] == "overhead" else "hinged"),
                                  swing=({k: sw[k] for k in ("hand", "into", "kind") if k in sw} or None)))
                elif o["kind"] in ("window", "bay"):
                    w = o.get("win", {})
                    Wn.append(dict(storey=s, room=rname(sp["inner"]), kind=o["kind"], center_local=[round(u, 3), round(v, 3)],
                                   width_m=round(o["w"] / 1000, 3), sill_m=round(w.get("sill", 450) / 1000, 3),
                                   head_m=round((w.get("sill", 450) + w.get("h", 1800)) / 1000, 3), facing_bearing_deg=bearing(T, *n)))
    garage = None
    gd = [d for d in D if d["kind"] == "garage"]
    if gd:
        g = gd[0]; turn = angle_diff(front_bearing, g["facing_bearing_deg"])
        garage = dict(door_bearing_deg=g["facing_bearing_deg"], street_side_bearing_deg=front_bearing, faces_street=abs(turn) <= 45,
                      turn_to_face_street_deg=turn, door_center_latlon=g["center_latlon"], door_width_m=g["width_m"],
                      load=("front" if abs(turn) <= 45 else "rear" if abs(turn) >= 135 else "side"),
                      note="turn_to_face_street_deg rotates the whole building (clockwise +) so the garage door faces the street; "
                           "a side-load garage is normally kept as built, with the driveway curving in from the street")
    ent = [d for d in D if d["kind"] == "entry"]
    entry = dict(door_bearing_deg=ent[0]["facing_bearing_deg"], faces_street=ent[0]["faces_street"], center_latlon=ent[0]["center_latlon"]) if ent else None
    stairs = []
    if plan.get("stair") and len(plan["labels"]) > 1:
        x0, y0, w, h = plan["stair"]; rev = bool(plan.get("stair_rev"))
        D0 = bp["stairs"].get(0, (None,))[0] if bp.get("stairs") else None
        ay = (D0 or {}).get("along_y", h >= w)
        up = (0, -1 if rev else 1) if ay else (-1 if rev else 1, 0)
        stairs.append(dict(from_storey=0, to_storey=1, rect_local=[x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c],
                           climbs_bearing_deg=bearing(T, *up), form=(D0 or {}).get("form", "straight"), risers=(D0 or {}).get("N")))
    F = []
    for f in (furniture or []):
        cxy = f["fp"].centroid if hasattr(f["fp"], "centroid") else None
        if cxy is None: continue
        a = math.radians(f["ang"]); front = (-math.sin(a), math.cos(a))   # item local +y is its front
        F.append(dict(storey=f["storey"], room=rname(f["room"] + 1), name=f["name"], center_local=[round(cxy.x / 1000, 3), round(cxy.y / 1000, 3)],
                      center_latlon=latlon(T, cxy.x / 1000, cxy.y / 1000), rotation_bearing_deg=bearing(T, *front),
                      footprint_local=[round(v / 1000, 3) for v in f["fp"].bounds], edited=bool(f.get("edited"))))
    furnished = {(f["storey"], f["room"]) for f in F}
    empty = [dict(storey=r["storey"], room=f"{r['kind']}#{r['id']}") for r in R if (r["storey"], f"{r['kind']}#{r['id']}") not in furnished and not r["open_air"]]
    o_ll = latlon(T, 0, 0)
    return dict(
        schema=SCHEMA, key=plan.get("key"),
        building=dict(osm_id=plan["id"], address=" ".join(str(plan["tags"].get(k, "")) for k in ("addr:housenumber", "addr:street")).strip() or None,
                      archetype=plan["theme"]["archetype"], style=plan["theme"]["style"], storeys=len(plan["labels"]),
                      storey_height_m=Hs, floor_raise_m=R0, footprint_local=plan.get("local_outline")),
        frame=dict(origin_latlon=o_ll, u_axis_bearing_deg=bearing(T, 1, 0), front_bearing_deg=front_bearing, units="m",
                   note="local (u, v): u along the street front, v from the front (v = 0) to the back; plan grid = local metres"),
        street=dict(name=(plan.get("front") or {}).get("street"), highway=(plan.get("front") or {}).get("highway"), front_faces_bearing_deg=front_bearing),
        rooms=R, doors=D, windows=Wn, garage=garage, entry=entry, stairs=stairs,
        furniture=F, furniture_pending=empty)


if __name__ == "__main__":
    import layout as LAY, spec as SP, blueprint as BP
    p = json.load(open(sys.argv[1])); p.setdefault("key", os.path.basename(sys.argv[1])[5:-5])
    bp = BP.build(p); lib, ITEMS, RI = SP.furniture_library()
    Fu = LAY.furnish(p, bp["style"], bp["specs"], ITEMS, RI)
    json.dump(export(p, bp, Fu), open(sys.argv[2], "w"), indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    print("wrote", sys.argv[2])
