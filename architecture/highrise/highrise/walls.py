"""Walls of a floor, derived from its rooms: one segment wherever two different spaces (or a space and the
outside) meet. Seams inside a room made of several rectangles get no wall.

kind      thickness  where
exterior  250 mm     a room against the outside (200 mm shear wall + insulation)
core      200 mm     any wall of the core (shear walls, fire-rated)
party     200 mm     between the two dwellings
interior  120 mm     partitions inside a dwelling
Balconies and AC platforms are outside: they get railings, not walls.
"""
STEP = 50
THICK = {"exterior": 250, "core": 200, "party": 200, "interior": 120}
OUTSIDE = {"BL", "BLN", "AC"}


def _in_tri(t, x, y):
    (ax, ay), (bx, by), (cx, cy) = t
    d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def _owner(rooms):
    """Point lookup: which room covers a point (None = outside). A diagonal cut's triangle belongs to the room it was
    given to (walk.py), though it lies in the giving room's rectangle."""
    rs = [(rid, rm["type"], q) for rid, rm in rooms.items() for q in rm["rects"]]
    tris = [(rid, t) for rid, rm in rooms.items() for t in rm.get("add", ())]

    def at(x, y):
        for rid, t in tris:
            if _in_tri(t, x, y):
                return rid
        for rid, t, q in rs:
            if q[0] < x < q[2] and q[1] < y < q[3]:
                return None if t in OUTSIDE else rid
        return None
    return at


def _dwelling(rid):
    return rid.split(".", 1)[0] if "." in rid else ""


def _kind(a, b, rooms):
    if a is None or b is None:
        return "exterior"
    ta, tb = rooms[a]["type"], rooms[b]["type"]
    if ta == "CORE" or tb == "CORE":
        return "core"
    if _dwelling(a) != _dwelling(b):
        return "party"
    return "interior"


def floor_walls(rooms):
    """[(orient, at, lo, hi, kind, (side_a, side_b))]: 'v' walls at x=at from y=lo..hi, 'h' at y=at."""
    at = _owner(rooms)
    lines = {"v": set(), "h": set()}
    for rm in rooms.values():
        if rm["type"] in OUTSIDE:
            continue
        for q in rm["rects"]:
            lines["v"].update((q[0], q[2]))
            lines["h"].update((q[1], q[3]))
    allr = [q for rm in rooms.values() if rm["type"] not in OUTSIDE for q in rm["rects"]]
    X0, Y0 = min(q[0] for q in allr), min(q[1] for q in allr)
    X1, Y1 = max(q[2] for q in allr), max(q[3] for q in allr)
    out = []
    for orient in ("v", "h"):
        for c in sorted(lines[orient]):
            lo_all, hi_all = (Y0, Y1) if orient == "v" else (X0, X1)
            cur = None
            t = lo_all
            while t < hi_all:
                m = t + STEP / 2
                a = at(c - 1, m) if orient == "v" else at(m, c - 1)
                b = at(c + 1, m) if orient == "v" else at(m, c + 1)
                key = None
                if a != b:
                    key = (_kind(a, b, rooms), a, b)
                if cur and key and key[:1] == cur[0][:1] and (key[1], key[2]) == (cur[0][1], cur[0][2]):
                    cur[2] = t + STEP
                else:
                    if cur:
                        out.append((orient, c, cur[1], cur[2], cur[0][0], (cur[0][1], cur[0][2])))
                    cur = [key, t, t + STEP] if key else None
                t += STEP
            if cur:
                out.append((orient, c, cur[1], cur[2], cur[0][0], (cur[0][1], cur[0][2])))
    return out


def diagonal_walls(rooms):
    """[(x0, y0, x1, y1, kind)]: the 45-degree interior walls of diagonal corner cuts (walk.py)."""
    out = []
    for rid, rm in rooms.items():
        for t in rm.get("add", ()):
            (_, _), (x1, y1), (x2, y2) = t
            out.append((x1, y1, x2, y2, "interior"))
    return out


def diagonal_wall_ring(x0, y0, x1, y1, t):
    """The wall's outline, t thick, run t/2 past both ends so it closes against the orthogonal walls it meets."""
    import math
    L = math.hypot(x1 - x0, y1 - y0)
    ux, uy = (x1 - x0) / L, (y1 - y0) / L
    nx, ny = -uy * t / 2, ux * t / 2
    ax, ay, bx, by = x0 - ux * t / 2, y0 - uy * t / 2, x1 + ux * t / 2, y1 + uy * t / 2
    return [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]
