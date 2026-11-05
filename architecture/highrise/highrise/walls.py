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


def _owner(rooms):
    """Point lookup: which room covers a point (None = outside)."""
    rs = [(rid, rm["type"], q) for rid, rm in rooms.items() for q in rm["rects"]]

    def at(x, y):
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
