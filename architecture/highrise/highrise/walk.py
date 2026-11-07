"""Can a person walk through the dwelling? Clear widths on the real room shapes, and diagonal corner cuts where an
orthogonal plan pinches (2026-11-06).

Widths (clear, between wall faces; an interior wall takes 60 mm off each side of its axis):
    any room           0.90 m: a person with something in hand (GB 50096 5.7.3: passages to kitchens and bathrooms)
    entry (EN)         1.10 m  (codes.PASSAGE_CLEAR["entry"], GB 55038 4.1.13 / GB 50096 5.7.1)
    hall (HL)          1.00 m  (codes.PASSAGE_CLEAR["rooms"])
A room passes when its clear floor, opened by a square of that width (erode, then dilate), stays one piece and loses
almost nothing: no sliver, no neck a person cannot pass. Closets and stores (CL, SR) are exempt.

Diagonal cut: where a room A fails at a convex corner of a neighbour B that juts into it (A wraps that corner), a
right-isosceles triangle with 0.6, 0.9 or 1.2 m legs is cut off B's corner and given to A, so the wall between them
runs at 45 degrees, as Chinese plans do at entries and hall turns. The cut is kept only when it fixes A and B still
passes on its own: walkable, its minimum net area (codes.MIN_NET_AREA), and the clear square of lattice.CLEAR_W.
Rooms stay rectangles in "rects"; a cut is stored as triangles: rooms[A]["add"] and rooms[B]["sub"].
"""
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

from highrise import codes

INT = 60                       # half an interior wall, mm
PERSON = 900
PASS = {"EN": int(codes.PASSAGE_CLEAR["entry"] * 1000), "HL": int(codes.PASSAGE_CLEAR["rooms"] * 1000)}
EXEMPT = {"CL", "SR", "BL", "BLN", "AC", "CORE", "NA"}
LEGS = (600, 900, 1200)
SLIVER = 0.05e6                # mm2 of floor narrower than the width a room may lose (mitre corners of a cut)
CLEAR_SQ = {"LR": 2400, "DR": 2600, "BRM": 2400, "BR": 2100, "ST": 1800, "KT": 1800}   # = lattice.CLEAR_W


def need(t):
    return PASS.get(t, PERSON)


def geom(rects, add=(), sub=()):
    g = unary_union([box(*q) for q in rects])
    for t in sub:
        g = g.difference(Polygon(t))
    for t in add:
        g = g.union(Polygon(t))
    return g


def room_geom(rm):
    """A plan room (rects plus any diagonal cuts) as a shapely shape, plan frame (y south), mm."""
    return geom(rm["rects"], rm.get("add", ()), rm.get("sub", ()))


def room_area(rm):
    return room_geom(rm).area / 1e6


def _parts(g):
    return [p for p in getattr(g, "geoms", [g]) if not p.is_empty and p.area > 1e4]


def narrow(g, w):
    """(clear floor, its part a w-wide person can stand in, area narrower than w in mm2, pieces a person cannot walk
    between: the places a w-wide person's centre can reach, eroded from the clear floor, must be one piece)."""
    clear = g.buffer(-INT, join_style=2)
    if clear.is_empty:
        return clear, clear, g.area, 0
    core = clear.buffer(-(w / 2 - 5), join_style=1)              # where a person's centre can be (a round body)
    op = core.buffer(w / 2 - 5, join_style=2)
    pieces = len([q for q in getattr(core, "geoms", [core]) if not q.is_empty])
    return clear, op, max(0.0, clear.area - op.area), pieces


def room_ok(g, t):
    if t in EXEMPT:
        return True
    _, _, lost, n = narrow(g, need(t))
    return n == 1 and lost <= SLIVER


def _fits(g, t):
    """The room that gives up a corner keeps its size and its clear square."""
    if not room_ok(g, t):
        return False
    mn = codes.MIN_NET_AREA.get(t)
    clear = g.buffer(-INT, join_style=2)
    if mn and clear.area / 1e6 < mn:
        return False
    sq = CLEAR_SQ.get(t)
    return not (sq and clear.buffer(-sq / 2, join_style=2).is_empty)


def _corners(g):
    """Convex right-angle corners of a room: (point, (sx, sy)) with the room in the quadrant p + (sx, sy)."""
    out = []
    for poly in _parts(g):
        for x, y in list(poly.exterior.coords)[:-1]:
            for sx in (1, -1):
                for sy in (1, -1):
                    e = 30
                    inside = g.contains(Point(x + sx * e, y + sy * e))
                    if inside and not g.contains(Point(x - sx * e, y + sy * e)) and not g.contains(Point(x + sx * e, y - sy * e)) \
                            and not g.contains(Point(x - sx * e, y - sy * e)):
                        out.append(((x, y), (sx, sy)))
    return out


def _try_cut(G, T, a, cut_log):
    """One diagonal cut that makes room a walkable, or None."""
    ga = G[a]
    clear, op, _, _ = narrow(ga, need(T[a]))
    bad = clear.difference(op) if not op.is_empty else clear
    if bad.is_empty:
        bad = clear
    for b, gb in G.items():
        if b == a or T[b] in EXEMPT or gb.distance(ga) > 1:
            continue
        for (x, y), (sx, sy) in _corners(gb):
            p = Point(x, y)
            e = 30
            # a wraps b's corner: outside the corner and along both legs is room a
            if not (ga.contains(Point(x - sx * e, y - sy * e)) and ga.contains(Point(x + sx * e, y - sy * e))
                    and ga.contains(Point(x - sx * e, y + sy * e))):
                continue
            if p.distance(bad) > need(T[a]):
                continue
            for c in LEGS:
                tri = [(x, y), (x + sx * c, y), (x, y + sy * c)]
                tp = Polygon(tri)
                if tp.difference(gb).area > 1:
                    break
                # both legs must border room a, so the diagonal wall stands between a and b only
                if not (ga.contains(Point(x + sx * c / 2, y - sy * e)) and ga.contains(Point(x - sx * e, y + sy * c / 2))):
                    break
                na, nb = ga.union(tp), gb.difference(tp)
                # the two rooms keep 1.3 m of straight wall between them for a door (0.9 m leaf, frame, reveals)
                shared = na.boundary.intersection(nb.boundary).length - c * 2 ** 0.5
                if shared < 1300:
                    continue
                if room_ok(na, T[a]) and _fits(nb, T[b]):
                    cut_log.append({"from": b, "to": a, "tri": [list(map(int, q)) for q in tri], "leg": c})
                    G[a], G[b] = na, nb
                    return True
    return False


def repair(R, T, max_cuts=3):
    """R: {rid: rects}, T: {rid: type}. Returns (cuts, rooms still failing)."""
    G = {r: geom(rs) for r, rs in R.items() if rs}
    cuts = []
    bad = [r for r in G if not room_ok(G[r], T[r])]
    for r in list(bad):
        while not room_ok(G[r], T[r]) and len(cuts) < max_cuts:
            if not _try_cut(G, T, r, cuts):
                break
    still = [r for r in G if not room_ok(G[r], T[r])]
    return cuts, still


_cache = {}


def defects(R, T):
    """Number of rooms nobody can walk through, after diagonal cuts (search cost; cached on the rooms' shapes)."""
    key = tuple(sorted((r, T[r], tuple(map(tuple, rs))) for r, rs in R.items()))
    hit = _cache.get(key)
    if hit is not None:
        return hit
    ok = all(room_ok(geom(rs), T[r]) for r, rs in R.items() if rs)
    n = 0 if ok else len(repair(R, T)[1])
    if len(_cache) > 200000:
        _cache.clear()
    _cache[key] = n
    return n


def apply_cuts(rooms, cuts):
    for c in cuts:
        rooms[c["to"]].setdefault("add", []).append(c["tri"])
        rooms[c["from"]].setdefault("sub", []).append(c["tri"])


def legs(cuts):
    """Wall spans the cuts removed, as door-placement exclusions: [(orient, at, lo, hi)]."""
    out = []
    for c in cuts:
        (x, y), (x1, _), (_, y1) = c["tri"]
        out.append(("h", y, min(x, x1), max(x, x1)))
        out.append(("v", x, min(y, y1), max(y, y1)))
    return out


def door_routes(plan):
    """Gate check: from every door of a room to its other doors at the width the code asks for. [problems]."""
    rooms = {r: rm for r, rm in plan["rooms"].items() if rm["type"] not in ("BL", "BLN", "AC")}
    T = {r: rm["type"] for r, rm in rooms.items()}
    G = {r: room_geom(rm) for r, rm in rooms.items()}
    out = []
    for r, g in G.items():
        if T[r] in EXEMPT:
            continue
        pts = []
        for d in plan.get("doors", []):
            if r not in (d.get("a"), d.get("b")) or "bl" in (d.get("a"), d.get("b")):
                continue
            m = (d["from"] + d["to"]) / 2
            for s in (1, -1):
                p = Point(d["at"] + s * 400, m) if d["orient"] == "v" else Point(m, d["at"] + s * 400)
                if g.contains(p):
                    pts.append(p)
                    break
            else:
                out.append(f"{r}: no room in front of its door")
        w = need(T[r])
        clear, op, lost, n = narrow(g, w)
        if n != 1 or lost > SLIVER:
            out.append(f"{r} ({T[r]}): {lost / 1e6:.2f} m2 narrower than {w / 1000:.2f} m" + (f", {n} pieces" if n != 1 else ""))
            continue
        for p in pts:
            if op.distance(p) > w / 2 + 50:
                out.append(f"{r} ({T[r]}): a door opens onto a part narrower than {w / 1000:.2f} m")
    return out


def diagonal_walls(rooms):
    """[(x0, y0, x1, y1, kind, (a, b))]: the 45-degree walls the cuts made (always inside one dwelling)."""
    out = []
    for rid, rm in rooms.items():
        for t in rm.get("add", ()):
            giver = next((r for r, o in rooms.items() if t in o.get("sub", ())), None)
            (x, y), (x1, y0_), (x0_, y1) = t
            out.append((x1, y0_, x0_, y1, "interior", (rid, giver)))
    return out
