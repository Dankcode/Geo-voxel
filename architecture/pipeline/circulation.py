"""Person-width circulation check (2026-11-03).

Rule: a person must be able to walk, 914 mm wide (IRC R311.6, the hallway minimum; about one adult with arms at the
sides plus clearance), from every doorway of a room to every other doorway of that room, and up to each doorway from
the room it opens into. Measured on the built geometry, not the room grid: the storey's floor at 50 mm, minus every
wall at its real thickness (exterior walls are 300 mm and sit inside the cell they bound, so a three-cell hall on an
outside wall is only 840 mm clear), with the doorways cut through. A disc of 914 mm diameter is rolled through that
floor (distance transform ≥ 457 mm); each doorway's approach point, 500 mm into the room, must lie in the disc's
reachable area, and all approach points of one room must be in the same connected piece of it.

Stairs keep their own rules (flight width, landings); stair rooms are left out here. Door leaves must also clear a
person: every door opening ≥ 760 mm wide.

    routes(plan, bp) -> list of findings, each {storey, room, kind, why, width_mm}
"""
import numpy as np
from scipy import ndimage

RES = 50.0                     # mm per pixel
PERSON = 914.0                 # mm clear width a person needs to pass (IRC R311.6)
PERSON_WET = {"wc": 762.0, "bathroom": 762.0, "pantry": 762.0}     # a person stands at a fixture: 30 in (IRC R307.1)
APPROACH = 500.0               # mm into the room from the wall face
MIN_DOOR = 760.0
SKIP = {"stair", "closet", "porch"}      # the stair has its own rules; a closet is reached, not walked through
PASSABLE = ("door", "cased", "opening", "overhead", "pocket", "archway", "double", "french", "slider", "sliding")


def _free(plan, bp, s):
    L = np.array(plan["labels"][s]); c = plan["cell"] * 1000.0
    H, W = L.shape; f = int(round(c / RES))
    lab = np.kron(L, np.ones((f, f), dtype=L.dtype))          # label per 50 mm pixel
    free = lab > 0
    walls = np.zeros_like(free)
    doors = []
    for w in bp["specs"][s]:
        a0, a1, d0, d1 = (int(round(v / RES)) for v in (w["a0"], w["a1"], w["d0"], w["d1"]))
        if w["axis"] == "y": walls[max(0, a0):a1, max(0, d0):d1] = True        # axis "y": the wall runs along y at x = line
        else: walls[max(0, d0):d1, max(0, a0):a1] = True
    for w in bp["specs"][s]:
        for o in w["openings"]:
            if not any(o["kind"].startswith(k) for k in PASSABLE): continue
            p0, p1 = int(round((o["pos"] - o["w"] / 2) / RES)), int(round((o["pos"] + o["w"] / 2) / RES))
            d0, d1 = int(round(w["d0"] / RES)), int(round(w["d1"] / RES))
            if w["axis"] == "y": walls[max(0, p0):p1, max(0, d0):d1] = False
            else: walls[max(0, d0):d1, max(0, p0):p1] = False
            doors.append((w, o))
    return lab, free & ~walls, doors


def routes(plan, bp):
    rooms = plan["program"]["rooms"]
    out = []
    for s in range(len(plan["labels"])):
        lab, free, doors = _free(plan, bp, s)
        H, W = free.shape
        dist = ndimage.distance_transform_edt(free) * RES
        comps = {}
        for wd_ in {PERSON, *PERSON_WET.values()}:
            comps[wd_] = ndimage.label(dist >= wd_ / 2 - RES / 2)[0]
        need = {}                                             # room label -> [(comp id or 0, door desc)]
        for w, o in doors:
            if o["w"] < MIN_DOOR:
                rid = w["inner"] if w["inner"] and w["inner"] > 0 else w["outer"]
                out.append(dict(storey=s, room=rooms[rid - 1]["kind"] if rid and rid > 0 else "?", kind="door",
                                why=f"{o['kind']} only {o['w']:.0f} mm wide", width_mm=round(o["w"])))
            pts = []
            for sgn in (-1, 1):                               # the approach point APPROACH beyond each wall face
                t = (w["d0"] if sgn < 0 else w["d1"]) + sgn * APPROACH
                py, px = (o["pos"], t) if w["axis"] == "y" else (t, o["pos"])
                iy, ix = int(py // RES), int(px // RES)
                pts.append((iy, ix, int(lab[iy, ix]) if 0 <= iy < H and 0 <= ix < W else 0))
            for k, (iy, ix, rid) in enumerate(pts):
                if rid <= 0 or rooms[rid - 1]["kind"] in SKIP: continue
                orid = pts[1 - k][2]; other = rooms[orid - 1]["kind"] if orid > 0 else "outside"
                need_w = PERSON_WET.get(rooms[rid - 1]["kind"], PERSON); comp = comps[need_w]
                r_ = int(150 / RES); y0, y1, x0, x1 = max(0, iy - r_), min(H, iy + r_ + 1), max(0, ix - r_), min(W, ix + r_ + 1)
                win = comp[y0:y1, x0:x1] * (lab[y0:y1, x0:x1] == rid)
                ids = win[win > 0]
                cid = int(np.bincount(ids).argmax()) if ids.size else 0
                width = 2 * float(dist[y0:y1, x0:x1].max())
                need.setdefault(rid, []).append((cid, f"{o['kind']} to {other}", width))
        for rid, lst in need.items():
            R = rooms[rid - 1]; need_w = PERSON_WET.get(R["kind"], PERSON); comp = comps[need_w]
            blocked = [(d, wd) for c_, d, wd in lst if c_ == 0]
            for d, wd in blocked:
                out.append(dict(storey=s, room=R["kind"], kind="approach", why=f"{d}: under {need_w:.0f} mm to reach it ({wd:.0f} mm)", width_mm=round(wd)))
            cids = {c_ for c_, _, _ in lst if c_}
            if len(cids) > 1:
                # the narrowest point between the pieces: the largest disc that still joins them
                lo, hi = 0.0, need_w
                inside = lab == rid
                for _ in range(8):
                    mid = (lo + hi) / 2
                    cm, _n = ndimage.label((dist >= mid / 2) & inside)
                    pts = set()
                    for c_, d, wd in lst:
                        if c_:
                            yy, xx = np.argwhere((comp == c_) & inside)[0]; pts.add(cm[yy, xx])
                    if len(pts) == 1 and 0 not in pts: lo = mid
                    else: hi = mid
                out.append(dict(storey=s, room=R["kind"], kind="route",
                                why=f"its doorways are not joined by a {need_w:.0f} mm route (narrowest ≈ {lo:.0f} mm)", width_mm=round(lo)))
    return out


def summary(f): return f"L{f['storey'] + 1} {f['room']}: {f['why']}"
