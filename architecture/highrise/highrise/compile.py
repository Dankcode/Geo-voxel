"""Stage 4 (paper §6): turn an optimised dwelling state into a plan, then into a whole floor.

Doors go near corners (Merrell §6 / Alexander): of the two ends of a shared wall, the one with the smaller summed
distance to the nearest corner of both rooms. Door openings are the GB 55038 4.1.14 clear widths plus a 100 mm
frame. Every bedroom and the living room get a dedicated outdoor AC platform (GB 55038); windows go in the wall
length the platform leaves, sized to the 1/7 window-to-floor ratio (GB 50096 7.2.2) and the 5 % / 10 % openable
area of GB 55038 6.3.3. Above 54 m one bedroom per dwelling becomes the refuge room of GB 50016 5.5.32.
"""
from highrise import codes
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


def place_door(ra, rb, width, kind):
    segs = _segments(ra, rb)
    if not segs:
        return None
    o, c, lo, hi = max(segs, key=lambda s: s[3] - s[2])
    if kind == "open":
        a, b = lo + 150, hi - 150
    else:
        width = min(width, hi - lo - 240)
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
    lr = next(r for r in R if T[r] == "LR")
    lx0 = min(q[0] for q in R[lr]); lx1 = max(q[2] for q in R[lr])
    # balcony across the living room; its far end is the living room's AC platform (keeps neighbours' walls free)
    ac_end = lx1 - AC_W if lx1 < U.X else lx0
    bl_x0, bl_x1 = (lx0, lx1 - AC_W) if ac_end == lx1 - AC_W else (lx0 + AC_W, lx1)
    rooms["bl"] = {"type": "BL", "rects": [[bl_x0, U.D, bl_x1, U.D + BALCONY_D]]}
    links = [(p, q, k) for p, q, k in links] + [(lr, "bl", "slide")]
    en = next(r for r in R if T[r] == "EN")
    links.insert(0, (en, "CORE", "door"))

    # --- AC platforms first, then windows in what is left of each exterior wall -------------------------------
    taken = {"N": [], "S": [(lx0, lx1)], "E": []}           # spans along each facade already used
    ac = []

    def free(side, a, b):
        return all(b <= x or a >= y for x, y in taken[side])

    for rid in sorted(R, key=lambda r: (T[r] != "LR", r)):
        t = T[rid]
        if t not in ("LR", "BRM", "BR", "ST"):
            continue
        if t == "LR":                                      # at the balcony's end, inside the living room's frontage
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
        if t == "LR":
            fac = "S"
        if not fac:
            continue
        win[rid] = fac
        if t == "LR":          # its glazing is the full-width sliding door onto the balcony
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
        cands = [r for r in R if T[r] in ("BR", "ST") and win.get(r)] or [r for r in R if T[r] == "BRM"]
        refuge = min(cands, key=lambda r: (T[r] != "BR", r)) if cands else None

    doors = []
    for p, q, k in links:
        if q == "CORE":
            r0 = R[p][0]
            ly = U.lobby_y
            lo, hi = max(r0[1], ly[0]), min(r0[3], ly[1])
            mid = (lo + hi) / 2
            w = door_width("unit")
            doors.append({"a": p, "b": "CORE", "orient": "v", "at": U.wn, "from": mid - w / 2, "to": mid + w / 2,
                          "kind": "door", "role": "unit", "swing": 1, "fire": "B" if req.get("stair_type") == "smoke-proof" else None})
            continue
        ra = rooms[p]["rects"]; rb = rooms[q]["rects"]
        child = q if q in T else p
        w = 99999 if q == "bl" else (1500 if k == "slide" else door_width(T.get(child, "BR")))
        dd = place_door(ra, rb, w, k)
        if dd:
            # leaf swings into the room the door serves (the child of the access link)
            cr = rooms[child]["rects"]
            cx = sum((r_[0] + r_[2]) / 2 for r_ in cr) / len(cr); cy = sum((r_[1] + r_[3]) / 2 for r_ in cr) / len(cr)
            dd["swing"] = 1 if ((cx > dd["at"]) if dd["orient"] == "v" else (cy > dd["at"])) else -1
            dd.update({"a": p, "b": q})
            if refuge and child == refuge:
                dd["fire"] = "B"                              # Class B fire door on the refuge room
            doors.append(dd)

    area_dom = sum((q[2] - q[0]) * (q[3] - q[1]) for rid, rm in rooms.items() if rm["type"] != "BL"
                   for q in rm["rects"]) / 1e6
    ext_len = U.X + U.D + (U.X - U.wn) + (U.D if U.end else 0)
    bal = (bl_x1 - bl_x0) * BALCONY_D / 1e6
    gfa = area_dom + ext_len * 0.1 / 1000 + core["area_m2"] / 2 + 0.5 * bal
    return {"id": plan_id, "gfa": round(gfa, 1), "gfa_target": gfa_target, "rooms": rooms, "links": links, "win": win,
            "doors": doors, "windows": windows, "ac": ac, "refuge_room": refuge,
            "unit": {"X": U.X, "D": U.D, "wn": U.wn, "dc": U.dc, "lobby_y": list(U.lobby_y), "lifts": [list(l) for l in U.lifts]},
            "planner": {k: v for k, v in d.items() if k not in ("R", "ext", "links")}, "cost": round(C, 2)}


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


def floor_plate(plan, core):
    """Both dwellings of the typical floor: east as planned, west mirrored; plus the core."""
    rooms = {"core." + rid: rm for rid, rm in core["rooms"].items()}
    for side, f in (("E", lambda r: r), ("W", mirror_x)):
        for rid, rm in plan["rooms"].items():
            rooms[f"{side}.{rid}"] = {"type": rm["type"], "rects": [f(q) for q in rm["rects"]]}
    doors = [dict(d, side="E") for d in plan["doors"]] + [dict(mirror_item(d), side="W") for d in plan["doors"]]
    for sx, sy in core["stair_doors"]:
        doors.append({"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "role": "stair", "swing": -1,
                      "fire": "B" if core["stair_type"] != "open" else None})
    windows = [dict(w) for w in plan["windows"]] + [mirror_item(w) for w in plan["windows"]]
    ac = [dict(a) for a in plan["ac"]] + [mirror_item(a) for a in plan["ac"]]
    return {"rooms": rooms, "doors": doors, "windows": windows, "ac": ac}
