"""Independent audit of built buildings: geometry checks on the generated model itself, not on the modules'
self-reports. Reads out/audit/spec/<name>.json (metres, the model both builders consume) and <name>.bp.pkl
(blueprint pieces, mm). Writes out/audit/findings.json and prints a summary.

Design checks (D*) and roof checks (R*) are listed in CHECKS with their pass rule.
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, glob, pickle, math, sys, os
import numpy as np
from shapely.geometry import Polygon, Point, LineString, box as sbox
from shapely.ops import unary_union
from shapely import affinity
sys.path.insert(0, _HERE)
import spec as SP, roofs as RF, doorlogic as DL

OUT = __import__("os").environ.get("AUDIT_OUT", _ARCH_OUT + "/audit")
LIB, ITEMS, ROOM_ITEMS = SP.furniture_library()
TALL = {"wardrobe", "bookshelf", "fridge", "wall_shelf", "rack", "kitchen_run", "kitchen_short", "whiteboard", "pallets"}
MIN_AREA = {"bedroom": 7.0, "kitchen": 5.0, "living": 11.0, "bathroom": 2.8, "dining": 7.0, "study": 5.0}   # m²
MIN_DIM = {"bedroom": 2.1, "living": 2.4, "kitchen": 1.8, "dining": 2.1, "study": 1.8}                       # m (IRC R304.2: 7 ft habitable)
EXPECT = {"bedroom": {"bed_double", "bed_single"}, "kitchen": {"kitchen_run", "kitchen_short", "kitchen_run_low", "kitchen_short_low"}, "bathroom": {"toilet"}, "living": {"sofa", "armchair"}}
HEADROOM = 2032   # mm, IRC R311.7.2 (6 ft 8 in)


def lib_footprint(name):
    """Local footprint (mm) of a library item: bounding box of its primitives in plan."""
    xs, ys, zs = [], [], []
    for d in LIB.get(name, []):
        off = d.get("off", (0, 0, 0))
        if d["t"] == "box":
            p, s = d["p"], d["s"]; xs += [p[0] + off[0], p[0] + off[0] + s[0]]; ys += [p[1] + off[1], p[1] + off[1] + s[1]]; zs += [p[2] + off[2] + s[2]]
        elif d["t"] == "cyl":
            p, r = d["p"], d["r"]; xs += [p[0] + off[0] - r, p[0] + off[0] + r]; ys += [p[1] + off[1] - r, p[1] + off[1] + r]; zs += [p[2] + d["h"]]
        elif d["t"] == "sph":
            p, r = d["p"], d["r"]; xs += [p[0] - r, p[0] + r]; ys += [p[1] - r, p[1] + r]; zs += [p[2] + r]
        elif d["t"] == "cut":
            A = d["a"]; p, s = A["p"], A["s"]; xs += [p[0], p[0] + s[0]]; ys += [p[1], p[1] + s[1]]; zs += [p[2] + s[2]]
    if not xs: return None, 0
    return sbox(min(xs), min(ys), max(xs), max(ys)), max(zs)


FP = {n: lib_footprint(n) for n in LIB}


def placed_fp(fi):
    poly, h = FP[fi["name"]]
    if poly is None: return None, 0
    P = affinity.rotate(poly, fi["ang"], origin=(0, 0))
    return affinity.translate(P, fi["x"] * 1000, fi["y"] * 1000), h


def tri_z(P, x, y):
    (x1, y1), (x2, y2), (x3, y3) = P[0, :2], P[1, :2], P[2, :2]
    det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    if abs(det) < 1e-9: return None
    l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det
    l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det
    l3 = 1 - l1 - l2
    if min(l1, l2, l3) < -1e-6: return None
    return l1 * P[0, 2] + l2 * P[1, 2] + l3 * P[2, 2]


def roof_faces(bp):
    """(region index, kind, programme, storey, sloped tris, vertical tris) in mm."""
    out = []
    for i, R in enumerate(bp["roofs"]):
        for role, V, F in R["pieces"]:
            flat_part = role == "roof_flat"
            V = np.asarray(V, float)
            sl, ve, bo = RF.split_faces(V, F)
            tri = [V[list(f)] for f in sl if len(f) == 3]
            deck = [P for P in tri if np.ptp(P[:, 2]) < 1] if not flat_part and R["programme"] != "flat" else []
            out.append(dict(i=i, flat_part=flat_part, kind=R["kind"], prog=R["programme"], storey=R["storey"], z_plate=R.get("z_plate"),
                            slope=[P for P in tri if not any(P is d for d in deck)], vert=[V[list(f)] for f in ve if len(f) == 3], V=V, F=F, classify=R.get("classify")))
            if deck: out.append(dict(i=i, flat_part=True, deck=True, kind=R["kind"], prog=R["programme"], storey=R["storey"], z_plate=R.get("z_plate"), slope=deck, vert=[], V=V, F=[], classify=None))
    return out


def surf_z(faces, x, y, region=None, exclude=None):
    best = None
    for fc in faces:
        if region is not None and fc["i"] != region: continue
        if exclude is not None and fc["i"] == exclude: continue
        for P in fc["slope"]:
            if not (min(P[:, 0]) - 1 <= x <= max(P[:, 0]) + 1 and min(P[:, 1]) - 1 <= y <= max(P[:, 1]) + 1): continue
            z = tri_z(P, x, y)
            if z is not None and (best is None or z > best): best = z
    return best


def audit_one(name):
    S = json.load(open(f"{OUT}/spec/{name}.json")); bp = pickle.load(open(f"{OUT}/spec/{name}.bp.pkl", "rb"))
    st = bp["style"]; rooms = bp["rooms"]; c = bp["cell"]; NS = bp["S"]
    Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000; SLAB = 200
    zf = lambda s: R0 + s * Hs
    labels = [np.array(L) for L in bp["labels"]]
    F = []          # findings: dict(check, severity, msg)
    def find(check, sev, msg, **kw): F.append(dict(check=check, sev=sev, msg=msg, **kw))

    indoor = [np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(L) for L in labels]
    env = [RF.cells_poly(m, c) for m in indoor]
    room_poly = {}
    for s in range(NS):
        for r in rooms:
            m = labels[s] == r["id"] + 1
            if m.any(): room_poly[(s, r["id"])] = RF.cells_poly(m, c)

    # ---------------------------------------------------------------- D1 room sizes (IRC R304)
    for (s, rid), P in room_poly.items():
        r = rooms[rid]; k = r["kind"]
        if r.get("subdivided") or r.get("open_air"): continue
        A = P.area / 1e6
        x0, y0, x1, y1 = P.bounds
        # least width: the smaller side of the minimum rotated rectangle is too generous for L-rooms; use erosion test
        w_ok = True
        if k in MIN_DIM:
            w_ok = not P.buffer(-MIN_DIM[k] * 500 + 1, join_style=2).is_empty
        if k in MIN_AREA and A < MIN_AREA[k]: find("D1 room size", "major" if A < 0.8 * MIN_AREA[k] else "minor", f"L{s+1} {k} {A:.1f} m² < {MIN_AREA[k]} m²")
        if not w_ok: find("D1 room size", "major", f"L{s+1} {k}: no {MIN_DIM[k]} m clear width anywhere")

    # ---------------------------------------------------------------- D2 exterior shell gaps
    walls = [(w["storey"], w["b"]) for w in S["walls"]]
    fill = walls + [(f["storey"], f["b"]) for f in S["frames"]] + [(g["storey"], g["b"]) for g in S["glass"]]
    open_regions = {s: [] for s in range(NS)}
    for s, specs in enumerate(bp["specs"]):
        for sp in specs:
            for o in sp["openings"]:
                p0, p1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
                if sp["axis"] == "x": open_regions[s].append(sbox(p0, sp["d0"] - 5, p1, sp["d1"] + 5))
                else: open_regions[s].append(sbox(sp["d0"] - 5, p0, sp["d1"] + 5, p1))
    gaps = 0; gap_where = []
    for s in range(NS):
        if env[s] is None: continue
        boxes = [b for ss, b in walls if ss == s]
        WB = unary_union([sbox(b[0] * 1000 - 3, b[1] * 1000 - 3, b[3] * 1000 + 3, b[4] * 1000 + 3) for b in boxes if b[2] * 1000 <= zf(s) + 1000 <= b[5] * 1000])
        OR = unary_union(open_regions[s]) if open_regions[s] else None
        polys = [env[s]] if env[s].geom_type == "Polygon" else list(env[s].geoms)
        for P in polys:
            for ring in [P.exterior] + list(P.interiors):
                L = ring.length; n = int(L // 100)
                for k in range(n):
                    pt = ring.interpolate(k * 100)
                    # sample just inside the outline (walls are inside the cells)
                    q = Point(pt.x, pt.y)
                    near = q.buffer(60)
                    if WB.intersects(q) or WB.intersects(near.centroid): continue
                    if OR is not None and OR.buffer(10).intersects(q): continue
                    # inside or outside? sample inward by 80 mm
                    if WB.distance(q) > 90:
                        gaps += 1
                        if len(gap_where) < 6: gap_where.append((s, round(pt.x), round(pt.y)))
    if gaps: find("D2 shell gaps", "major", f"{gaps} wall sample points (every 100 mm along the outline, 1 m above floor) not covered by wall or opening", where=gap_where)

    # ---------------------------------------------------------------- D3 furniture
    furn = []
    for fi in S["furniture"]:
        P, h = placed_fp(fi)
        if P is not None: furn.append((fi, P, h))
    by_storey = {}
    for t in furn: by_storey.setdefault(t[0]["storey"], []).append(t)
    for s, L in by_storey.items():
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                a = L[i][1].intersection(L[j][1]).area / 1e6
                if a > 0.02: find("D3 furniture overlap", "major", f"L{s+1} {L[i][0]['name']} × {L[j][0]['name']}: {a:.2f} m²")
    # outside its room / into walls
    for fi, P, h in furn:
        s = fi["storey"]; inside = None
        for (ss, rid), RP in room_poly.items():
            if ss == s and RP.contains(Point(fi["x"] * 1000, fi["y"] * 1000)): inside = (rid, RP)
        if inside is None: find("D3 furniture outside rooms", "major", f"L{s+1} {fi['name']} centre outside every room"); continue
        rid, RP = inside
        out = P.difference(RP.buffer(0 if rooms[rid].get("open_air") else -60, join_style=2)).area / 1e6     # an open-air porch has no wall of its own
        if out > 0.03: find("D3 furniture into walls", "major" if out > 0.1 else "minor", f"L{s+1} {fi['name']} in {rooms[rid]['kind']}: {out:.2f} m² beyond the wall face")
    # door approach zones and swings
    for s, specs in enumerate(bp["specs"]):
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] not in ("door", "overhead") or o.get("ptype") == "cased" and False: continue
                p = o["pos"]
                if sp["axis"] == "x": Z = sbox(p - o["w"] / 2, sp["d0"] - 700, p + o["w"] / 2, sp["d1"] + 700)
                else: Z = sbox(sp["d0"] - 700, p - o["w"] / 2, sp["d1"] + 700, p + o["w"] / 2)
                arcs = [Polygon(a) for a in (o.get("swing") or {}).get("arcs", []) if len(a) > 2]
                for fi, P, h in by_storey.get(s, []):
                    if fi["name"] == "car" and o["kind"] == "overhead": continue      # a car parks just inside its own garage door
                    if P.intersection(Z).area > 0.02e6: find("D3 furniture blocks door", "major", f"L{s+1} {fi['name']} in the 0.7 m approach of a door")
                    for A in arcs:
                        if A.is_valid and P.intersection(A).area > 0.02e6: find("D3 furniture in door swing", "major", f"L{s+1} {fi['name']} inside a door swing")
                if o["kind"] == "window": pass
            for o in sp["openings"]:
                if o["kind"] != "window" or not sp["ext"]: continue
                p = o["pos"]; sill = o["win"]["sill"]
                if sp["axis"] == "x": Z = sbox(p - o["w"] / 2 + 100, sp["d0"] - 500, p + o["w"] / 2 - 100, sp["d1"] + 500)
                else: Z = sbox(sp["d0"] - 500, p - o["w"] / 2 + 100, sp["d1"] + 500, p + o["w"] / 2 - 100)
                for fi, P, h in by_storey.get(s, []):
                    if h > max(sill + 300, 1200) and P.intersection(Z).area > 0.01e6: find("D3 furniture blocks window", "major", f"L{s+1} {fi['name']} ({h:.0f} mm tall) in front of a window with sill {sill:.0f} mm")
    # stair zone
    for s, D in bp["stairs"].items():
        for hx0, hy0, hx1, hy1 in D["hole"]:
            H = sbox(hx0, hy0, hx1, hy1)
            for fi, P, h in by_storey.get(s, []) + by_storey.get(s + 1, []):
                if P.intersects(H.buffer(-10)): find("D3 furniture on stair", "major", f"L{fi['storey']+1} {fi['name']} over the stair flights")
    # expected items
    have = {}
    for fi, P, h in furn:
        for (ss, rid), RP in room_poly.items():
            if ss == fi["storey"] and RP.contains(Point(fi["x"] * 1000, fi["y"] * 1000)): have.setdefault(rid, set()).add(fi["name"])
    for r in rooms:
        if r.get("subdivided") or r["kind"] not in EXPECT: continue
        if not (EXPECT[r["kind"]] & have.get(r["id"], set())):
            find("D3 room unfurnished", "minor", f"{r['kind']} (room {r['id']}) has none of {sorted(EXPECT[r['kind']])}")

    # ---------------------------------------------------------------- D4 stairs: headroom, arrival, containment
    for s, D in bp["stairs"].items():
        steps = [p for p in S["stairs"] if p["role"] in ("step", "landing")]
        steps = [p for p in steps if abs(p["b"][2] * 1000 - zf(s)) < Hs + 50 and p["b"][2] * 1000 >= zf(s) - 50]
        above = env[s + 1] if s + 1 < NS else None
        holes = unary_union([sbox(*h) for h in D["hole"]]) if D["hole"] else None
        worst = None
        for p in steps:
            x0, y0, z0, x1, y1, z1 = [v * 1000 for v in p["b"]]
            for x, y in ((x0 + 50, y0 + 50), (x1 - 50, y0 + 50), (x0 + 50, y1 - 50), (x1 - 50, y1 - 50), ((x0 + x1) / 2, (y0 + y1) / 2)):
                q = Point(x, y)
                if above is not None and above.contains(q) and not (holes is not None and holes.buffer(5).contains(q)):
                    head = (zf(s + 1) - SLAB) - z1
                    if worst is None or head < worst: worst = head
        if worst is not None and worst < HEADROOM:
            find("D4 stair headroom", "major" if worst < 1900 else "minor", f"L{s+1}→L{s+2}: {worst:.0f} mm under the slab above (need {HEADROOM})")
        top = max((p["b"][5] * 1000 for p in steps), default=None)
        if top is not None and abs((zf(s + 1)) - top) > D["R"] + 30:
            find("D4 stair arrival", "major", f"L{s+1}→L{s+2}: highest tread at {top:.0f} mm, floor above at {zf(s+1):.0f} mm (riser {D['R']})")
        sr = [r for r in rooms if r.get("stair")]
        if D.get("too_small"): find("D4 stair too small", "major", f"L{s+1}: {D['form']} stair W={D['W']} mm")

    # ---------------------------------------------------------------- D5 doors: leaves against walls, raised entries
    for lf in S["leaves"]:
        hx, hy, hz = lf["hinge"]; tx, ty = lf["tip"]
        seg = LineString([(hx * 1000, hy * 1000), (tx * 1000, ty * 1000)])
        s = lf["storey"]
        for w in S["walls"]:
            if w["storey"] != s: continue
            b = [v * 1000 for v in w["b"]]
            if b[5] <= hz * 1000 + 100 or b[2] >= hz * 1000 + lf["h"] * 1000 - 100: continue      # no overlap in height
            B = sbox(b[0] + 15, b[1] + 15, b[3] - 15, b[4] - 15)
            if B.is_valid and not B.is_empty and seg.intersection(B).length > 60:
                find("D5 door leaf through wall", "major", f"L{s+1} leaf at ({hx:.2f}, {hy:.2f}) passes {seg.intersection(B).length:.0f} mm through a wall"); break
    if R0 >= 250:
        steps_ext = [e for e in S["ext"] if e.get("role") in ("steps", "step", "stair", "landing")]
        decks = [e for e in S["ext"] if e.get("role") == "deck"]
        for s, specs in enumerate(bp["specs"][:1]):
            for sp in specs:
                if not sp["ext"] or sp["outer"] > 0: continue
                for o in sp["openings"]:
                    if o["kind"] != "door": continue
                    p = o["pos"]; out = sp["outward"]
                    q = (p, (sp["d1"] if out == 1 else sp["d0"]) + out * 500) if sp["axis"] == "x" else ((sp["d1"] if out == 1 else sp["d0"]) + out * 500, p)
                    Q = Point(q).buffer(400)
                    ok = False
                    for e in steps_ext + decks:
                        if "b" in e: G = sbox(e["b"][0] * 1000, e["b"][1] * 1000, e["b"][3] * 1000, e["b"][4] * 1000)
                        else: G = Polygon([(x * 1000, y * 1000) for x, y in e["ring"]])
                        if G.intersects(Q): ok = True
                    if not ok: find("D5 raised door without steps", "major", f"exterior door at {q[0]/1000:.1f}, {q[1]/1000:.1f} m: floor {R0:.0f} mm above grade, no steps or deck outside")

    # ---------------------------------------------------------------- roofs
    faces = roof_faces(bp)
    # R1 coverage of every storey top not covered by the storey above
    allproj = []
    for fc in faces:
        for P in fc["slope"]:
            T = Polygon(P[:, :2])
            if T.is_valid and T.area > 1: allproj.append(T)
    proj = unary_union(allproj) if allproj else None
    for s in range(NS):
        if env[s] is None: continue
        top = env[s] if s + 1 >= NS or env[s + 1] is None else env[s].difference(env[s + 1].buffer(-1))
        top = top.buffer(-30, join_style=2)
        if top.is_empty: continue
        leak = top if proj is None else top.difference(proj)
        if leak.area > 0.05e6: find("R1 roof leak", "critical", f"L{s+1}: {leak.area/1e6:.2f} m² of ceiling with no roof over it", where=[round(v) for v in leak.representative_point().coords[0]])
    # porch / open-air storey parts: covered?
    # R2 roof surfaces inside the storey above
    for fc in faces:
        s = fc["storey"]
        if s + 1 >= NS or env[s + 1] is None: continue
        A = env[s + 1].buffer(-250, join_style=2)
        if A.is_empty: continue
        hit = 0
        for P in fc["slope"] + fc["vert"]:
            for w in ((1/3, 1/3, 1/3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)):
                x, y, z = np.dot(w, P)
                if A.contains(Point(x, y)) and z > zf(s + 1) + 50: hit += 1
        if hit: find("R2 roof inside rooms above", "critical", f"{fc['kind']} roof (storey {s+1}, {fc['prog']}): {hit} sample points inside the storey above")
    # R3 gap between wall top and roof (open eave/gable not closed)
    for s in range(NS):
        if env[s] is None: continue
        above = env[s + 1] if s + 1 < NS else None
        z_top = zf(s) + Hs - SLAB
        polys = [env[s]] if env[s].geom_type == "Polygon" else list(env[s].geoms)
        bad = 0; worst = 0; n = 0; attic = 0; attic_w = []; bad_w = []
        for P in polys:
            ring = P.exterior; L = ring.length
            for k in range(int(L // 300)):
                pt = ring.interpolate(k * 300 + 150)
                if above is not None and above.buffer(50).contains(pt): continue
                n += 1
                z = surf_z([f for f in faces if f["storey"] == s], pt.x, pt.y)
                if z is None: continue
                if z - z_top > 80:
                    covered = False
                    for fc in faces:
                        if fc["storey"] != s: continue
                        for T in fc["vert"]:
                            seg = LineString(T[:, :2]) if len({tuple(np.round(v[:2])) for v in T}) > 1 else None
                            if seg is not None and seg.distance(pt) < 300 and T[:, 2].max() >= z - 60 and T[:, 2].min() <= z_top + 60: covered = True; break
                        if covered: break
                    if not covered and any(Polygon([(x * 1000, y * 1000) for x, y in e["ring"]]).distance(pt) < 300 for e in S["ext"] if e.get("role") in ("porch_ceiling", "soffit")):
                        covered = True
                    if not covered:
                        # a wall line with roof on both sides is an attic edge (porch / ceiling side), not an eave
                        nx_ = [surf_z([f for f in faces if f["storey"] == s], pt.x + dx, pt.y + dy) for dx, dy in ((900, 0), (-900, 0), (0, 900), (0, -900))]
                        if sum(v is not None for v in nx_) >= 3:
                            if not any(Polygon([(x * 1000, y * 1000) for x, y in e["ring"]]).distance(pt) < 300 for e in S["ext"] if e.get("role") in ("porch_ceiling", "soffit")):
                                attic += 1; attic_w.append((round(pt.x), round(pt.y)))
                        else: bad += 1; worst = max(worst, z - z_top); bad_w.append((round(pt.x), round(pt.y), round(z - z_top)))
                if z < z_top - 150:
                    find("R3 roof below wall top", "major", f"L{s+1}: roof surface {z_top - z:.0f} mm below the wall plate at ({pt.x/1000:.1f}, {pt.y/1000:.1f})"); break
        if bad: find("R3 open gap under roof", "major", f"L{s+1}: {bad}/{n} wall-top samples have an open gap (up to {worst:.0f} mm) between wall top and roof with no gable infill", where=bad_w[:8])
        if attic: find("R3 attic open to porch", "minor", f"L{s+1}: {attic} wall-top samples under the roof's interior (porch side) leave the attic open: no ceiling or attic infill", where=attic_w[:4])
    # R4 slope vs covering, per region and per area
    for i, R in enumerate(bp["roofs"]):
        fcs = [f for f in faces if f["i"] == i and not f["flat_part"]]
        for fc in [f for f in faces if f["i"] == i and f["flat_part"]]:
            for P in fc["slope"]:
                n = np.cross(P[1] - P[0], P[2] - P[0])
                if fc.get("deck"): find("R4 capped wing deck", "info", f"{R['kind']}: flat deck where the wing meets the upper wall (membrane, tapered insulation assumed)", region=i); break
                if np.linalg.norm(n) > 1 and 12 * math.tan(math.acos(min(1, abs(n[2]) / np.linalg.norm(n)))) < 0.25 - 0.01:
                    find("R4 flat part below ¼:12", "major", f"{R['kind']}: membrane part below ¼:12", region=i); break
        area = {}
        for fc in fcs:
            for P in fc["slope"]:
                n = np.cross(P[1] - P[0], P[2] - P[0]); A = np.linalg.norm(n) / 2
                if A < 1: continue
                ang = math.degrees(math.acos(min(1, abs(n[2]) / np.linalg.norm(n))))
                area[round(ang, 2)] = area.get(round(ang, 2), 0) + A / 1e6
        if not area: continue
        mat = st.get("roofmat", "shingle") if R["programme"] != "flat" else "membrane"
        mat = "membrane" if R["programme"] == "flat" else ("metal" if mat == "metal" else "tile" if mat == "tile" else "slate" if mat == "slate" else "shingle")
        MIN = {"membrane": 0.25, "metal": 0.5, "shingle": 2, "tile": 2.5, "slate": 4}[mat]
        low = sum(a for g, a in area.items() if 12 * math.tan(math.radians(g)) < MIN - 0.01)
        tot = sum(area.values())
        if low > 0.05:
            find("R4 slope below covering minimum", "major", f"{R['kind']} {R['programme']}: {low:.1f} of {tot:.1f} m² of {mat} below {MIN}:12", region=i)
        cls = R.get("classify", {})
        main_ang = max(area, key=area.get)
        if cls.get("family", "").startswith("flat") and main_ang > 5:
            find("R4 region misclassified", "minor", f"{R['kind']} {R['programme']}: classified '{cls.get('family')}' from its shallowest plane though {area[main_ang]:.1f} m² slopes at {main_ang:.0f}°", region=i)
    # R5 mesh quality
    for fc in faces:
        V, Fs = fc["V"], fc["F"]
        deg = 0; down = 0; edges = {}
        for f in Fs:
            P = V[list(f)]
            n = np.cross(P[1] - P[0], P[2] - P[0]) if len(f) >= 3 else np.zeros(3)
            if np.linalg.norm(n) / 2 < 100: deg += 1          # < 1 cm²
            for k in range(len(f)):
                e = tuple(sorted((int(f[k]), int(f[(k + 1) % len(f)])))); edges[e] = edges.get(e, 0) + 1
        nonman = sum(1 for v in edges.values() if v > 2)
        for P in fc["slope"]:
            n = np.cross(P[1] - P[0], P[2] - P[0])
            if n[2] < 0: down += 1
        if deg > 0: find("R5 degenerate roof faces", "minor", f"{fc['kind']} {fc['prog']}: {deg} faces under 1 cm²")
        if nonman: find("R5 non-manifold roof edges", "major", f"{fc['kind']} {fc['prog']}: {nonman} edges shared by 3+ faces")
        if down: find("R5 inverted roof faces", "major", f"{fc['kind']} {fc['prog']}: {down} sloped faces face downward")
    # R6 height and spikes
    for i, R in enumerate(bp["roofs"]):
        fcs = [f for f in faces if f["i"] == i]
        if not fcs: continue
        zmax = max(f["V"][:, 2].max() for f in fcs); zp = R.get("z_plate") or 0
        h = zmax - zp
        if h > 1.6 * Hs: find("R6 roof too tall", "major", f"{R['kind']} {R['programme']}: {h/1000:.1f} m above the plate (> 1.6 storeys)", region=i)
    # R7 one roof poking through another
    for fa in faces:
        for P in fa["slope"]:
            x, y, z = P.mean(axis=0)
            zo = surf_z(faces, x, y, exclude=fa["i"])
            if zo is not None and z > zo + 150:
                other = [f for f in faces if f["i"] != fa["i"] and surf_z([f], x, y) is not None]
                # only a conflict when the other roof is the higher-level one (a lower roof should sit under)
                if other and other[0]["storey"] >= fa["storey"]:
                    find("R7 roof through roof", "major", f"{fa['kind']} roof surface {z - zo:.0f} mm above the {other[0]['kind']} roof at ({x/1000:.1f}, {y/1000:.1f})"); break
    # R8 vertical (gable) faces away from walls
    porch_polys = [RF.cells_poly(np.vectorize(lambda v: v > 0 and bool(rooms[v - 1].get("open_air")))(L), c) for L in labels]
    lines = unary_union([g.boundary for g in env + porch_polys if g is not None])
    if not lines.is_empty:
        for fc in faces:
            bad = 0
            for T in fc["vert"]:
                cxy = T[:, :2].mean(axis=0)
                if lines.distance(Point(*cxy)) > 600: bad += 1
            if bad: find("R8 gable face off the wall line", "major", f"{fc['kind']} {fc['prog']}: {bad} vertical faces more than 0.6 m from any outer wall")
    # R9 flat roofs: parapet
    for i, R in enumerate(bp["roofs"]):
        if R["programme"] == "flat" and R["kind"] != "porch":
            if not any(e.get("role") == "parapet" for e in S["ext"]): find("R9 flat roof without parapet", "minor", f"{R['kind']} flat roof has no parapet/edge upstand")
    # R10 window obstructed by a lower roof
    for s, specs in enumerate(bp["specs"]):
        if s == 0: continue
        for sp in specs:
            if not sp["ext"]: continue
            for o in sp["openings"]:
                if o["kind"] != "window": continue
                p = o["pos"]; out = sp["outward"]
                d = (sp["d1"] if out == 1 else sp["d0"]) + out * 300
                x, y = (p, d) if sp["axis"] == "x" else (d, p)
                z = surf_z([f for f in faces if f["storey"] < s], x, y)
                if z is not None and z > zf(s) + o["win"]["sill"] - 100:
                    find("R10 window behind lower roof", "major", f"L{s+1} window at ({x/1000:.1f}, {y/1000:.1f}): lower roof at {z - zf(s):.0f} mm, sill {o['win']['sill']:.0f} mm")
    return F


if __name__ == "__main__":
    names = sorted(os.path.basename(f)[:-5] for f in glob.glob(f"{OUT}/spec/*.json"))
    if len(sys.argv) > 1: names = [n for n in names if any(a in n for a in sys.argv[1:])]
    res = {}
    for n in names:
        try: res[n] = audit_one(n)
        except Exception as e:
            import traceback; res[n] = [dict(check="AUDIT ERROR", sev="critical", msg=traceback.format_exc()[-400:])]
        cnt = {}
        for f in res[n]: cnt[f["check"]] = cnt.get(f["check"], 0) + 1
        print(n, cnt, flush=True)
    tag = os.environ.get("TAG", "findings")
    json.dump(res, open(f"{OUT}/{tag}.json", "w"), indent=1)
