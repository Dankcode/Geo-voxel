"""Stage 4 (paper §6): turn an optimised dwelling state into a plan, then into a whole floor.

Doors go near corners (Merrell §6 / Alexander): of the two ends of a shared wall, the one with the smaller summed
distance to the nearest corner of both rooms. Door openings are the GB 55038 4.1.14 clear widths plus a 100 mm
frame. Every bedroom and the living room get a dedicated outdoor AC platform (GB 55038); windows go in the wall
length the platform leaves, sized to the 1/7 window-to-floor ratio (GB 50096 7.2.2) and the 5 % / 10 % openable
area of GB 55038 6.3.3. Above 54 m one bedroom per dwelling becomes the refuge room of GB 50016 5.5.32.
"""
from highrise import codes, walk
from highrise.planner import cost

BALCONY_D = 1400
AC_W, AC_D = 1000, 700        # AC platform: 1.0 m wide, 0.7 m deep
WIN_H = 1.5                   # m of glazing (sill 0.9 m, head 2.4 m); casements open on half of it


def door_width(t):
    return int(round((codes.DOOR_CLEAR.get(t, 0.80) + codes.DOOR_FRAME) * 1000))


def _segments(ra, rb):
    segs = []
    for a in ra:
        for b in rb:
            for xa, xb in ((a[2], b[0]), (b[2], a[0])):
                if xa == xb:
                    lo, hi = max(a[1], b[1]), min(a[3], b[3])
                    if hi > lo:
                        segs.append(("v", xa, lo, hi))
            for ya, yb in ((a[3], b[1]), (b[3], a[1])):
                if ya == yb:
                    lo, hi = max(a[0], b[0]), min(a[2], b[2])
                    if hi > lo:
                        segs.append(("h", ya, lo, hi))
    return segs


def _corner_dist(rects, p):
    xs = [q[0] for q in rects] + [q[2] for q in rects]
    ys = [q[1] for q in rects] + [q[3] for q in rects]
    cs = [(x, y) for x in (min(xs), max(xs)) for y in (min(ys), max(ys))]
    return min(abs(p[0] - x) + abs(p[1] - y) for x, y in cs)


def _minus(seg, forbid):
    """A shared wall segment less the spans a diagonal cut took (and 120 mm of reveal next to them)."""
    o, c, lo, hi = seg
    parts = [(lo, hi)]
    for fo, fc, flo, fhi in forbid:
        if fo != o or abs(fc - c) > 1:
            continue
        nxt = []
        for a, b in parts:
            for x, y in ((a, min(b, flo - 120)), (max(a, fhi + 120), b)):
                if y - x > 1:
                    nxt.append((x, y))
        parts = nxt
    return [(o, c, a, b) for a, b in parts]


def place_door(ra, rb, width, kind, forbid=()):
    segs = [p for s in _segments(ra, rb) for p in _minus(s, forbid)]
    if not segs:
        return None
    o, c, lo, hi = max(segs, key=lambda s: s[3] - s[2])
    if kind == "open":
        a, b = lo + 150, hi - 150
    else:
        width = min(width, hi - lo - 240)
        if width < 700:                                     # no room for a leaf (GB 55038 4.1.14: 0.70 m at least)
            return None
        best = None
        for a in (lo + 120, hi - 120 - width):
            mid = a + width / 2
            p = (c, mid) if o == "v" else (mid, c)
            d = _corner_dist(ra, p) + _corner_dist(rb, p)
            if best is None or d < best[0]:
                best = (d, a)
        a, b = best[1], best[1] + width
    return {"orient": o, "at": c, "from": a, "to": b, "kind": kind}


def _need_window(t, area):
    """Window width (mm) from daylight (1/7) and openable area (GB 55038 6.3.3)."""
    day = area * codes.WINDOW_FLOOR_RATIO / WIN_H if t in codes.DAYLIT else 0
    if t == "KT":
        vent = max(0.6, codes.VENT_RATIO["KT"] * area) / (WIN_H * 0.5)
    elif t in ("BR", "BRM", "ST", "LR"):
        vent = codes.VENT_RATIO["habitable"] * area / (WIN_H * 0.5)
    else:
        vent = 0.6 / (WIN_H * 0.5) * 0.5
    floor = 1200 if t in ("BR", "BRM", "ST", "KT") else 900
    return max(floor, int(max(day, vent) * 1000 / 100 + 1) * 100)


def compile_unit(st, U, prog, targets, want_south, core, plan_id, gfa_target, req):
    T = dict(prog)
    C, d = cost(st, U, T, targets, want_south, detail=True)
    R, ext, links = d["R"], d["ext"], d["links"]
    rooms = {rid: {"type": T[rid], "rects": [list(map(int, q)) for q in rs]} for rid, rs in R.items()}
    cuts = walk.repair(R, T)[0]                               # diagonal corner cuts where a room pinches
    walk.apply_cuts(rooms, cuts)
    forbid = walk.legs(cuts)
    lr = next(r for r in R if T[r] == "LR")
    # 2026-11-06: a balcony only where the living room has the south front for it (Leon: not every room needs a
    # balcony); otherwise the living room takes windows and an AC platform like a bedroom
    has_bal = ext[lr]["S"] >= 2400
    lrs = [q for q in R[lr] if q[3] == U.D] or R[lr]          # its south front (an L-shaped living room's other arm
    lx0 = min(q[0] for q in lrs); lx1 = max(q[2] for q in lrs)   # may reach past it inside the flat)
    # balcony across the living room; its far end is the living room's AC platform (keeps neighbours' walls free)
    ac_end = lx1 - AC_W if lx1 < U.X else lx0
    bl_x0, bl_x1 = (lx0, lx1 - AC_W) if ac_end == lx1 - AC_W else (lx0 + AC_W, lx1)
    if has_bal:
        rooms["bl"] = {"type": "BL", "rects": [[bl_x0, U.D, bl_x1, U.D + BALCONY_D]]}
        links = [(p, q, k) for p, q, k in links] + [(lr, "bl", "slide")]
    else:
        links = [(p, q, k) for p, q, k in links]
    en = next(r for r in R if T[r] == "EN")
    links.insert(0, (en, "CORE", "door"))

    # --- AC platforms first, then windows in what is left of each exterior wall -------------------------------
    taken = {"N": [], "S": [(lx0, lx1)] if has_bal else [], "E": []}   # spans along each facade already used
    ac = []

    def free(side, a, b):
        return all(b <= x or a >= y for x, y in taken[side])

    for rid in sorted(R, key=lambda r: (T[r] != "LR", r)):
        t = T[rid]
        if t not in ("LR", "BRM", "BR", "ST"):
            continue
        if t == "LR" and has_bal:                          # at the balcony's end, inside the living room's frontage
            ac.append({"room": rid, "side": "S", "rect": [ac_end, U.D, ac_end + AC_W, U.D + AC_D]})
            continue
        for side in "SNE":
            if ext[rid][side] < 1200:
                continue
            q = max(R[rid], key=lambda q: (q[2] - q[0]) * (q[3] - q[1]))
            if side in "NS":
                y = 0 if side == "N" else U.D
                segs = [q2 for q2 in R[rid] if (q2[1] == 0 and side == "N") or (q2[3] == U.D and side == "S")]
                x0, x1 = min(s[0] for s in segs), max(s[2] for s in segs)
                for a in (x1 - AC_W, x0):
                    if free(side, a, a + AC_W):
                        r = [a, y - AC_D, a + AC_W, y] if side == "N" else [a, y, a + AC_W, y + AC_D]
                        ac.append({"room": rid, "side": side, "rect": r})
                        taken[side].append((a, a + AC_W))
                        break
                else:
                    continue
                break
            else:
                y0, y1 = q[1], q[3]
                if free("E", y1 - AC_W, y1):
                    ac.append({"room": rid, "side": "E", "rect": [U.X, y1 - AC_W, U.X + AC_D, y1]})
                    taken["E"].append((y1 - AC_W, y1))
                    break

    win, windows = {}, []
    for rid, e in ext.items():
        t = T[rid]
        if t in ("EN", "HL", "DR", "CL", "SR"):
            continue
        fac = "".join(s for s in "NSE" if e[s] >= 1200)
        if t == "LR" and has_bal:
            fac = "S"                                      # glazed by the balcony's sliding door
        if not fac:
            continue
        win[rid] = fac
        if t == "LR" and fac == "S":   # its glazing is the full-width sliding door onto the balcony
            continue
        area = sum((q[2] - q[0] - 200) * (q[3] - q[1] - 200) for q in R[rid]) / 1e6
        need = _need_window(t, area)
        for i, side in enumerate(fac):
            for x0, y0, x1, y1 in R[rid]:
                if side in "NS" and ((side == "N" and y0 == 0) or (side == "S" and y1 == U.D)):
                    lo, hi = x0 + 300, x1 - 300
                    for a, b in taken[side]:                 # keep clear of AC platforms
                        if a <= lo < b:
                            lo = b + 150
                        if a < hi <= b:
                            hi = a - 150
                    w = min(hi - lo, need if i == 0 else 900)
                    if w < 600:
                        continue
                    cx = (lo + hi) / 2
                    windows.append({"room": rid, "side": side, "y": y0 if side == "N" else y1,
                                    "from": cx - w / 2, "to": cx + w / 2, "orient": "h"})
                if side == "E" and x1 == U.X:
                    lo, hi = y0 + 300, y1 - 300
                    for a, b in taken["E"]:
                        if a < hi <= b:
                            hi = a - 150
                    w = min(hi - lo, need if i == 0 else 900)
                    if w < 600:
                        continue
                    cy = (lo + hi) / 2
                    windows.append({"room": rid, "side": side, "x": x1, "from": cy - w / 2, "to": cy + w / 2, "orient": "v"})

    # --- refuge room above 54 m (GB 50016 5.5.32): a bedroom on an exterior wall with an openable window ---------
    refuge = None
    if req.get("refuge_room_per_dwelling"):
        cands = ([r for r in R if T[r] in ("BR", "ST") and win.get(r)] or [r for r in R if T[r] == "BRM"]
                 or [r for r in R if T[r] == "LR"])                # a studio: its living room is the bedroom
        refuge = min(cands, key=lambda r: (T[r] != "BR", r)) if cands else None

    doors, missing = [], []
    for p, q, k in links:
        if q == "CORE":
            r0 = max(R[p], key=U.door_overlap)                # the entry's side on the lobby (or the lobby corridor)
            o, at, dlo, dhi = U.door
            lo, hi = (max(r0[1], dlo), min(r0[3], dhi)) if o == "v" else (max(r0[0], dlo), min(r0[2], dhi))
            mid = (lo + hi) / 2
            w = door_width("unit")
            doors.append({"a": p, "b": "CORE", "orient": o, "at": at, "from": mid - w / 2, "to": mid + w / 2,
                          "kind": "door", "role": "unit", "swing": 1,
                          "fire": "B" if req.get("stair_type") == "smoke-proof" else None})
            continue
        ra = rooms[p]["rects"]; rb = rooms[q]["rects"]
        child = q if q in T else p
        w = 99999 if q == "bl" else (1500 if k == "slide" else door_width(T.get(child, "BR")))
        dd = place_door(ra, rb, w, k, forbid)
        if dd:
            # leaf swings into the room the door serves (the child of the access link)
            cr = rooms[child]["rects"]
            cx = sum((r_[0] + r_[2]) / 2 for r_ in cr) / len(cr); cy = sum((r_[1] + r_[3]) / 2 for r_ in cr) / len(cr)
            dd["swing"] = 1 if ((cx > dd["at"]) if dd["orient"] == "v" else (cy > dd["at"])) else -1
            dd.update({"a": p, "b": q})
            if refuge and child == refuge:
                dd["fire"] = "B"                              # Class B fire door on the refuge room
            doors.append(dd)
        else:
            missing.append(f"{p}-{q}")                        # no wall left long enough for this door: gate fails

    area_dom = sum((q[2] - q[0]) * (q[3] - q[1]) for rid, rm in rooms.items() if rm["type"] != "BL"
                   for q in rm["rects"]) / 1e6
    ext_len = U.X + U.D + (U.X - U.wn) + (U.D if U.end else 0)
    bal = (bl_x1 - bl_x0) * BALCONY_D / 1e6 if has_bal else 0.0
    gfa = area_dom + ext_len * 0.1 / 1000 + core["area_m2"] / 2 + 0.5 * bal
    return {"id": plan_id, "gfa": round(gfa, 1), "gfa_target": gfa_target, "rooms": rooms, "links": links, "win": win,
            "doors": doors, "windows": windows, "ac": ac, "refuge_room": refuge, "cuts": cuts,
            "unit": {"X": U.X, "D": U.D, "wn": U.wn, "dc": U.dc, "lobby_y": list(U.lobby_y), "lifts": [list(l) for l in U.lifts],
                     "x0": U.x0, "cuts": [list(c) for c in U.cuts], "door": list(U.door), "north": U.north, "end": U.end},
            "planner": dict({k: v for k, v in d.items() if k not in ("R", "ext", "links")}, Ca=d["Ca"] + len(missing),
                            missing_doors=missing), "cost": round(C, 2)}


def mirror_x(r):
    return [-r[2], r[1], -r[0], r[3]]


def mirror_item(d):
    d = dict(d)
    if d.get("orient") == "v":
        if "at" in d:
            d["at"] = -d["at"]
        if "x" in d:
            d["x"] = -d["x"]
    elif "from" in d:
        d["from"], d["to"] = -d["to"], -d["from"]
    if "rect" in d:
        d["rect"] = mirror_x(d["rect"])
    if d.get("orient") == "v" and "swing" in d:
        d["swing"] = -d["swing"]
    return d


def copy_room(rm, f):
    """A dwelling room on the floor plate: rects through f (as is or mirror_x), diagonal cuts with them."""
    out = {"type": rm["type"], "rects": [f(q) for q in rm["rects"]]}
    mir = f is mirror_x
    for k in ("add", "sub"):
        if rm.get(k):
            out[k] = [[[-x, y] if mir else [x, y] for x, y in t] for t in rm[k]]
    return out


def floor_plate(plan, core):
    """Both dwellings of the typical floor: east as planned, west mirrored; plus the core."""
    pw = plan
    rooms = {"core." + rid: rm for rid, rm in core["rooms"].items()}
    for side, pl, f in (("E", plan, lambda r: r), ("W", pw, mirror_x)):
        for rid, rm in pl["rooms"].items():
            rooms[f"{side}.{rid}"] = copy_room(rm, f)
    doors = [dict(d, side="E") for d in plan["doors"]] + [dict(mirror_item(d), side="W") for d in pw["doors"]]
    for sx, sy in core["stair_doors"]:
        doors.append({"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "role": "stair", "swing": -1,
                      "fire": "B" if core["stair_type"] != "open" else None})
    windows = [dict(w) for w in plan["windows"]] + [mirror_item(w) for w in pw["windows"]]
    ac = [dict(a) for a in plan["ac"]] + [mirror_item(a) for a in pw["ac"]]
    return {"rooms": rooms, "doors": doors, "windows": windows, "ac": ac}


def corridor_plate(flats, core, corridor):
    """The typical floor of 4 or 6 flats around one lobby corridor (2026-11-06): flats = [(tag, plan)] for the east
    side in the core frame (x >= 0), mirrored for the west; corridor = the east half of the lobby corridor (the west
    half is its mirror). The corridor ("core.corridor") opens off the lift lobby at both ends through the fire doors
    building.assemble adds, so it is one hallway from the lift doors to every flat door."""
    rooms = {"core." + rid: dict(rm) for rid, rm in core["rooms"].items()}
    rooms["core.corridor"] = {"type": "CORE", "role": "corridor", "rects": [list(q) for q in corridor] + [mirror_x(q) for q in corridor]}
    doors, windows, ac = [], [], []
    for tag, plan in flats:
        for side, f in (("E", lambda r: r), ("W", mirror_x)):
            key = side + tag
            for rid, rm in plan["rooms"].items():
                rooms[f"{key}.{rid}"] = copy_room(rm, f)
            mi = (lambda d: dict(d)) if side == "E" else mirror_item
            doors += [dict(mi(d), side=key) for d in plan["doors"]]
            windows += [mi(w) for w in plan["windows"]]
            ac += [mi(a) for a in plan["ac"]]
    for sx, sy in core["stair_doors"]:
        doors.append({"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "role": "stair", "swing": -1,
                      "fire": "B" if core["stair_type"] != "open" else None})
    return {"rooms": rooms, "doors": doors, "windows": windows, "ac": ac,
            "corridor": [list(q) for q in corridor] + [mirror_x(q) for q in corridor]}
