"""Shared plan model and measurements for reference and generated apartment plans.

A plan is a dict with keys: id, gfa (m2), rooms {rid: {type, rects}}, links [(a,b,kind)],
win {rid: "NSEW"}. Coordinates are mm, x east, y south (north at the top of a drawing).
Everything here is pure Python so it runs in the repo's micromamba env or plain python3.
"""
from collections import defaultdict, deque

CELL = 50  # raster step (mm) used for shared-wall lengths and outlines

HABITABLE = {"LR", "BRM", "BR", "ST"}          # habitable rooms
PRIVATE = {"BRM", "BR", "ST", "BAM", "CL"}
PUBLIC = {"LR", "DR", "EN", "KW"}
WET = {"KT", "KW", "BA", "BAM"}
OUTSIDE = {"BL", "BLN", "CORE", "AC"}         # not counted in the dwelling's usable area
NAMES = {"LR": "Living room", "DR": "Dining room", "KT": "Kitchen", "KW": "Open kitchen", "BRM": "Master bedroom",
         "BR": "Bedroom", "ST": "Study", "NA": "Maid's room", "BAM": "Master bath", "BA": "Bathroom",
         "EN": "Entry", "HL": "Hall", "CL": "Walk-in closet", "SR": "Storage", "BL": "Balcony",
         "BLN": "Service balcony", "CORE": "Core", "AC": "AC platform"}
WALL = 200  # typical shear / partition wall thickness in Chinese high-rise (mm)


def rect_area(r):
    return (r[2] - r[0]) * (r[3] - r[1])


def _tri_area(t):
    (ax, ay), (bx, by), (cx, cy) = t
    return abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2


def room_area(room):
    """Axis area, m2, with any diagonal corner cut (walk.py) given or taken."""
    return (sum(rect_area(r) for r in room["rects"]) + sum(_tri_area(t) for t in room.get("add", ()))
            - sum(_tri_area(t) for t in room.get("sub", ()))) / 1e6


def bbox(rects):
    return (min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects))


class Raster:
    """Label grid at CELL resolution: lets us measure shared walls and outlines exactly."""

    def __init__(self, plan):
        self.plan = plan
        allr = [r for rm in plan["rooms"].values() for r in rm["rects"]]
        x0, y0, x1, y1 = bbox(allr)
        self.ox, self.oy = x0 - CELL, y0 - CELL
        self.w = (x1 - x0) // CELL + 3
        self.h = (y1 - y0) // CELL + 3
        self.g = {}
        for rid, rm in plan["rooms"].items():
            for r in rm["rects"]:
                for j in range((r[1] - self.oy) // CELL, (r[3] - self.oy) // CELL):
                    for i in range((r[0] - self.ox) // CELL, (r[2] - self.ox) // CELL):
                        self.g[(i, j)] = rid

    def shared(self):
        """{(a,b): length_mm} for rooms sharing a wall, plus {(a,'~N'): len} for exterior."""
        out = defaultdict(int)
        for (i, j), a in self.g.items():
            for di, dj, side in ((1, 0, "E"), (-1, 0, "W"), (0, 1, "S"), (0, -1, "N")):
                b = self.g.get((i + di, j + dj))
                if b is None:
                    out[(a, "~" + side)] += CELL
                elif b != a and a < b:
                    out[(a, b)] += CELL
        return out

    def perimeter(self, rid):
        n = 0
        for (i, j), a in self.g.items():
            if a != rid:
                continue
            for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if self.g.get((i + di, j + dj)) != rid:
                    n += 1
        return n * CELL


def net_area(plan, rid, ras=None):
    """Usable (net) area estimate: centre-line area minus half a wall on every edge."""
    ras = ras or Raster(plan)
    a = room_area(plan["rooms"][rid])
    return max(0.0, a - ras.perimeter(rid) * (WALL / 2) / 1e6)


def short_side_net(room):
    """Largest clear square side: min over the room's biggest rectangle, minus one wall."""
    big = max(room["rects"], key=rect_area)
    return (min(big[2] - big[0], big[3] - big[1]) - WALL) / 1000


def aspect(room):
    b = bbox(room["rects"])
    w, h = b[2] - b[0], b[3] - b[1]
    return max(w, h) / max(1, min(w, h))


def graph(plan, kinds=("door", "open", "slide")):
    G = defaultdict(set)
    for a, b, k in plan["links"]:
        if k in kinds:
            G[a].add(b)
            G[b].add(a)
    return G


def entry_room(plan):
    for a, b, k in plan["links"]:
        if b in ("OUT", "CORE"):
            return a
        if a in ("OUT", "CORE"):
            return b
    return None


def bfs_depth(plan, start):
    G = graph(plan)
    d = {start: 0}
    q = deque([start])
    while q:
        u = q.popleft()
        for v in G[u]:
            if v not in d and v not in ("OUT", "CORE"):
                d[v] = d[u] + 1
                q.append(v)
    return d


def public_group(plan):
    """Rooms joined to the living room by open (no-door) links: the living-dining space."""
    G = graph(plan, kinds=("open",))
    lr = [r for r, rm in plan["rooms"].items() if rm["type"] == "LR"]
    if not lr:
        return set()
    seen, q = {lr[0]}, deque([lr[0]])
    while q:
        u = q.popleft()
        for v in G[u]:
            if v not in seen and v in plan["rooms"]:
                seen.add(v)
                q.append(v)
    return seen


def measure(plan):
    """All the numbers the scorecard and the statistics use, for one plan."""
    rooms, win = plan["rooms"], plan.get("win", {})
    ras = Raster(plan)
    sh = ras.shared()
    T = {r: rm["type"] for r, rm in rooms.items()}
    inner = [r for r in rooms if T[r] not in OUTSIDE]
    m = {"id": plan["id"], "gfa": plan.get("gfa")}

    m["axis_area"] = round(sum(room_area(rooms[r]) for r in inner), 2)
    m["net_area"] = round(sum(net_area(plan, r, ras) for r in inner), 2)
    m["balcony_area"] = round(sum(room_area(rooms[r]) for r in rooms if T[r] in ("BL", "BLN")), 2)
    if plan.get("gfa"):
        # dwelling floor area ~ axis area + half of open balconies; efficiency = that / gross floor area (GFA)
        m["efficiency"] = round((m["axis_area"] + 0.5 * m["balcony_area"]) / plan["gfa"], 3)

    nb = sum(T[r] in ("BRM", "BR") for r in rooms)
    ns = sum(T[r] == "ST" for r in rooms)
    nba = sum(T[r] in ("BA", "BAM") for r in rooms)
    nt = 1 + (any(T[r] == "DR" for r in rooms) and any(T[r] == "LR" for r in rooms))
    m["layout"] = f"{nb + ns} bed · {nt} living · {nba} bath"
    m["bedrooms"], m["studies"], m["baths"] = nb, ns, nba

    body = [r for rr in inner for r in rooms[rr]["rects"]]
    bx = bbox(body)
    m["frontage_m"] = round((bx[2] - bx[0]) / 1000, 2)   # frontage (width along the facade)
    m["depth_m"] = round((bx[3] - bx[1]) / 1000, 2)      # depth

    south = [r for r in rooms if T[r] in HABITABLE and "S" in win.get(r, "")]
    m["south_rooms"] = len(south)                          # habitable rooms on the south front
    m["south_habitable"] = sorted(T[r] for r in south)
    m["living_south"] = any(T[r] == "LR" for r in south)
    m["master_south"] = any(T[r] == "BRM" for r in south)

    grp = public_group(plan)
    gw = "".join(win.get(r, "") for r in grp)
    m["through_strict"] = "N" in gw and "S" in gw      # north-south through ventilation via the open living space
    slide = {b if a in grp else a for a, b, k in plan["links"]
             if k == "slide" and (a in grp) != (b in grp)}
    gw2 = gw + "".join(win.get(r, "") for r in slide if r in rooms)
    m["through_loose"] = "N" in gw2 and "S" in gw2     # counting a kitchen behind a slider

    m["dining_joins_living"] = any(T[r] == "DR" for r in grp) or not any(T[r] == "DR" for r in rooms)
    kts = [r for r in rooms if T[r] == "KT"]
    m["kitchen_window"] = bool(kts) and all(win.get(r) for r in kts)        # naturally lit kitchen
    bas = [r for r in rooms if T[r] in ("BA", "BAM")]
    m["bath_window_share"] = round(sum(bool(win.get(r)) for r in bas) / max(1, len(bas)), 2)

    G = graph(plan)
    brm = [r for r in rooms if T[r] == "BRM"]
    ens = False
    for b in brm:
        nbrs = G[b] | {y for x in G[b] if T.get(x) == "CL" for y in G[x]}
        ens = ens or any(T.get(x) == "BAM" for x in nbrs)
    m["master_ensuite"] = ens                                                 # master suite

    e = entry_room(plan)
    m["entry"] = e
    d = bfs_depth(plan, e) if e else {}
    m["reachable"] = all(r in d for r in inner)
    m["bed_off_entry"] = sum(1 for r in rooms if T[r] in ("BRM", "BR") and e in G[r])
    # privacy gradient: no private room lies on the only path to a public room
    viol = 0
    for r in rooms:
        if T[r] in ("LR", "DR", "KT", "EN") and r in d:
            # every neighbour that is one step closer must not be private
            closer = [x for x in G[r] if x in d and d[x] == d[r] - 1]
            if closer and all(T[x] in PRIVATE for x in closer):
                viol += 1
    m["privacy_violations"] = viol

    # GB 55038 4.2.3: lift shafts must not adjoin bedrooms
    lifts = [r for r, rm in rooms.items() if rm["type"] == "CORE" and ("lift" in r or "lift" in rm.get("role", ""))]
    sleep = ("BRM", "BR", "ST") if any(T[r] in ("BRM", "BR", "ST") for r in rooms) else ("BRM", "BR", "ST", "LR")  # studio
    m["bed_next_to_lift"] = sorted({b for b in rooms if T[b] in sleep for l in lifts
                                    if sh.get((min(b, l), max(b, l)), 0) > 0})
    m["has_core"] = bool(lifts)
    circ = sum(room_area(rooms[r]) for r in rooms if T[r] in ("HL", "EN"))
    m["circulation_share"] = round(circ / max(1e-6, m["axis_area"]), 3)

    # per-room records (net area, aspect, short side, band)
    y0, y1 = bx[1], bx[3]
    recs = []
    for r in inner:
        rm = rooms[r]
        b = bbox(rm["rects"])
        cy = (b[1] + b[3]) / 2
        band = "N" if cy < y0 + (y1 - y0) / 3 else ("S" if cy > y0 + 2 * (y1 - y0) / 3 else "M")
        recs.append({"rid": r, "type": rm["type"], "axis": round(room_area(rm), 2),
                     "net": round(net_area(plan, r, ras), 2), "aspect": round(aspect(rm), 2),
                     "short": round(short_side_net(rm), 2), "band": band,
                     "win": win.get(r, ""), "ext": sorted(k[1][1] for k in sh if k[0] == r and k[1].startswith("~"))})
    m["rooms"] = recs
    m["links"] = [(T.get(a, a), T.get(b, b), k) for a, b, k in plan["links"]]

    # door feasibility: every link must have a shared wall long enough for its opening
    need = {"door": 900, "slide": 1200, "open": 1000}
    bad = []
    for a, b, k in plan["links"]:
        if b in ("OUT", "CORE") or a in ("OUT", "CORE"):
            continue
        L = sh.get((min(a, b), max(a, b)), 0)
        if L < need[k]:
            bad.append((a, b, k, L))
    m["infeasible_links"] = bad
    return m
