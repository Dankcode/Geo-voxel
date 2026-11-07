"""Merrell et al. (2010) adapted to a Chinese high-rise typical floor.

Stage 1  programme  (paper §4): conditional tables calibrated on the traced reference plans; each choice
         depends on dwelling size and earlier choices.
Stage 2  core       (new): codes + core.py lay out the stair, lifts and lobby the height requires. The typical
         floor repeats, so the paper's floor coupling C_f holds by construction and wet rooms stack.
Stage 3  unit plan  (paper §5): Metropolis over a banded slicing layout of one dwelling: a north band, a middle
         band whose columns may stack two rooms, and a south band that runs under the core's half. Moves: slide a
         wall (x cut, band line, stack split; d ~ N(0, sigma^2), sigma = 2 * epsilon, epsilon = 300 mm module),
         swap two rooms, relocate a room (room count kept, as in the paper).
         Cost C = k_a C_a + k_d C_d + k_s C_s + C_t. C_a counts missing connections, unreachable rooms, the
         dwelling door off the lobby, daylight, code minimum areas, master-suite access and bedrooms against a lift
         shaft (GB 55038 4.2.3). C_t holds the Chinese typology terms: south-facing rooms, north-south through
         ventilation, windowed bathrooms, bedrooms kept off the entry, circulation share, dining open to living.
         Default search since 2026-11-05: lattice.py, the houses' label grid and moves with this cost (HR_SEARCH=banded
         runs the banded search below).
Stage 4  compile    (paper §6): doors near corners, windows and AC platforms on exterior walls, the second
         dwelling mirrored about the core axis.
Coordinates: mm, dwelling frame with x = 0 on the core's centre line, y = 0 at the north face, y growing south.
"""
import math
import random

from highrise.codes import MIN_NET_AREA as MIN_NET, DOOR_CLEAR, DOOR_FRAME
from highrise import walk


def door_open(t):
    return int(round((DOOR_CLEAR.get(t, 0.80) + DOOR_FRAME) * 1000))

GRID = 100
EPS = 300                 # 3M modulus (GB/T 50002): walls snap to 300 mm, moves in 100 mm
SIGMA = 2 * EPS
PROPORTION = {"LR": (2.2, 3000), "DR": (2.0, 2400), "KT": (3.0, 1800), "BRM": (2.0, 2900), "BR": (2.2, 2400),
              "ST": (2.2, 2100)}           # (max aspect of the bounding box, min side mm) for compact flats' rooms
BAND_OK = {               # which band each room type may sit in (from the references)
    "LR": "S", "BRM": "S", "BR": "NS", "ST": "NS", "KT": "N", "NA": "N",
    "BA": "NM", "BAM": "M", "CL": "M", "DR": "M", "EN": "M", "HL": "M", "SR": "M",
}
ACCESS = {                # who a room may open off, in order of preference (ref link counts)
    "DR": ["EN", "LR", "HL"], "LR": ["DR", "EN", "HL"], "HL": ["DR", "EN", "LR", "HL"],
    "KT": ["DR", "LR", "EN"], "BR": ["HL", "LR", "DR", "EN"], "ST": ["HL", "LR", "DR", "EN"],
    "BRM": ["HL", "LR", "DR", "EN"], "BA": ["HL", "DR", "EN", "LR"], "BAM": ["BRM", "CL"],
    "CL": ["BRM"], "SR": ["HL", "EN", "DR"], "NA": ["KT", "DR", "HL"],
}
CIRC = {"EN", "DR", "LR", "HL"}
MIN_SIDE = {"LR": 3600, "BRM": 3100, "BR": 2700, "ST": 2400, "KT": 2100, "DR": 2400,
            "BA": 1500, "BAM": 1700, "EN": 1400, "HL": 1200, "CL": 1300, "SR": 900, "NA": 1600}
K = {"a": 100.0, "d": 1.0, "s": 1.0, "sun": 6.0, "through": 8.0, "mingwei": 1.5,
     "dongjing": 6.0, "circ": 30.0, "pref": 1.0, "kdl": 30.0}


# ----------------------------------------------------------------------------- stage 1
def sample_programme(gfa, rng, priors, beds=None, baths=None, compact=None):
    """Room list for a dwelling of the given gross floor area, conditioned like a small Bayes net. beds / baths: counts
    set in the viewer's Regenerate panel (2026-11-06), which replace the sampled ones. compact: the axis area (m2) of a
    flat on a 4- or 6-flat floor; beds 0 = a studio (living room that is also the bedroom, GB 50096 5.1.1 smallest
    dwelling type, >= 22 m2 usable), else 1 bedroom under 55 m2, 2 above; no dining room or second bathroom."""
    if compact is not None:
        nb = (0 if compact < 34 else 1 if compact < 55 else 2) if beds is None else max(0, min(3, int(beds)))
        # 2026-11-07: a one-bedroom flat under 40 m2 has a single bedroom (BR: 2.4 m wide, 5 m2 net), as in Chinese
        # 一室一厅 of that size; a double bedroom (BRM, 2.9 m) and a 13 m2 living room do not both fit squarely
        first = "BR" if nb == 1 and compact < 40 else "BRM"
        rooms = ["EN", "LR", "KT"] + (["HL"] if nb >= 2 else []) + ([first] + ["BR"] * (nb - 1) if nb else []) + ["BA"]
        ids, cnt = [], {}
        for t in rooms:
            cnt[t] = cnt.get(t, 0) + 1
            ids.append((f"{t.lower()}{cnt[t]}" if rooms.count(t) > 1 else t.lower(), t))
        return ids
    if beds:
        beds = max(1, min(5, int(beds)))
    elif gfa < 95:
        beds = 2
    elif gfa < 125:
        beds = 3
    elif gfa < 155:
        beds = 3 if rng.random() < 0.6 else 4
    else:
        beds = 4
    study = beds == 3 and gfa >= 125 and rng.random() < 0.5
    baths = max(1, min(3, int(baths))) if baths else (1 if gfa < 100 else (2 if gfa < 165 else 3))
    rooms = ["EN", "DR", "LR", "KT", "HL", "BRM"] + ["BR"] * (beds - 1)
    if study:
        rooms.append("ST")
    if baths >= 2:
        rooms += ["BAM"] + ["BA"] * (baths - 1)
    else:
        rooms.append("BA")
    if gfa >= 140 and baths >= 2 and rng.random() < 0.7:
        rooms.append("CL")
    if gfa >= 130 and rng.random() < 0.35:
        rooms.append("NA")
    ids, cnt = [], {}
    for t in rooms:
        cnt[t] = cnt.get(t, 0) + 1
        ids.append((f"{t.lower()}{cnt[t]}" if rooms.count(t) > 1 else t.lower(), t))
    return ids


def area_targets(prog, area_axis, priors):
    """Axis-area targets per room: reference net means -> axis, flexible rooms scaled."""
    fixed = {"BA", "BAM", "CL", "SR", "EN", "NA", "HL"}
    base = {}
    for rid, t in prog:
        p = priors[t]["net"]["mean"]
        if t == "HL":
            p = 3.0
        base[rid] = p * 1.18 + 0.6            # net -> axis (half walls on ~4 sides)
    fx = sum(v for (rid, t), v in zip(prog, base.values()) if t in fixed)
    fl = sum(v for (rid, t), v in zip(prog, base.values()) if t not in fixed)
    s = max(0.6, (area_axis / 1e6 - fx) / fl)
    out = {}
    for rid, t in prog:
        mu = base[rid] * (s if t not in fixed else 1.0)
        out[rid] = (mu, max(priors[t]["net"]["sd"] * 1.18, 0.2 * mu))
    return out, s


# ----------------------------------------------------------------------------- geometry
class Unit:
    """Domain [x0, X] x [0, D] minus the cut rectangles (default: the core notch [0, wn] x [0, dc]).

    door: where the dwelling door opens onto the lobby: ("v", x, y_lo, y_hi) on a wall at x, or ("h", y, x_lo, x_hi)
    on a wall at y (default: the lobby end, ("v", wn, *lobby_y)). north: the dwelling has a north facade (a flat behind
    the floor's lobby corridor has none). 2026-11-06: floors of 4 and 6 flats around one lobby corridor."""

    def __init__(self, X, D, wn, dc, lobby_y, end_unit=True, lifts=(), x0=0, cuts=None, door=None, north=True):
        self.X, self.D, self.wn, self.dc, self.lobby_y, self.end = X, D, wn, dc, lobby_y, end_unit
        self.lifts = [tuple(l) for l in lifts]
        self.x0, self.north = x0, north
        self.cuts = [tuple(c) for c in (cuts if cuts is not None else [(0, 0, wn, dc)])]
        self.door = tuple(door) if door else ("v", wn, lobby_y[0], lobby_y[1])
        self.standard = cuts is None and x0 == 0 and door is None

    def area(self):
        return (self.X - self.x0) * self.D - sum((c[2] - c[0]) * (c[3] - c[1]) for c in self.cuts)

    def door_overlap(self, q):
        """Length of rectangle q's side that lies on the door line, within the door's span (either side of it)."""
        o, at, lo, hi = self.door
        if o == "v":
            return min(q[3], hi) - max(q[1], lo) if at in (q[0], q[2]) else 0
        return min(q[2], hi) - max(q[0], lo) if at in (q[1], q[3]) else 0

    def door_depth(self, q):
        """How far rectangle q reaches into the flat from the door line."""
        return (q[2] - q[0]) if self.door[0] == "v" else (q[3] - q[1])


def rects_of(st, U):
    R = {}
    y1, y2 = st["y1"], st["y2"]
    x = U.wn
    for rid, w in st["N"]:
        R[rid] = [(x, 0, x + w, y1)]
        x += w
    x = U.wn
    for col in st["M"]:
        w = col["w"]
        if len(col["rooms"]) == 1:
            R[col["rooms"][0]] = [(x, y1, x + w, y2)]
        else:
            ys = y1 + int(round((y2 - y1) * col["split"] / GRID)) * GRID
            R[col["rooms"][0]] = [(x, y1, x + w, ys)]
            R[col["rooms"][1]] = [(x, ys, x + w, y2)]
        x += w
    x = 0
    for rid, w in st["S"]:
        x1 = x + w
        if x < U.wn < x1 and y2 < U.dc:
            R[rid] = [(x, U.dc, U.wn, U.D), (U.wn, y2, x1, U.D)]
        elif x1 <= U.wn:
            R[rid] = [(x, max(y2, U.dc), x1, U.D)]
        else:
            R[rid] = [(x, y2, x1, U.D)]
        x = x1
    return R


def _shared(ra, rb):
    L = 0
    for a in ra:
        for b in rb:
            if a[2] == b[0] or b[2] == a[0]:
                L += max(0, min(a[3], b[3]) - max(a[1], b[1]))
            elif a[3] == b[1] or b[3] == a[1]:
                L += max(0, min(a[2], b[2]) - max(a[0], b[0]))
    return L


def _touch(a, b):
    """Rectangles share a wall segment of positive length."""
    if a[2] == b[0] or b[2] == a[0]:
        return min(a[3], b[3]) - max(a[1], b[1]) > 0
    if a[3] == b[1] or b[3] == a[1]:
        return min(a[2], b[2]) - max(a[0], b[0]) > 0
    return False


def exterior(R, U):
    """Exterior wall length per room per facing (no windows on the core or the party axis)."""
    ext = {}
    for rid, rs in R.items():
        e = {"N": 0, "S": 0, "E": 0, "W": 0}
        for x0, y0, x1, y1 in rs:
            if y0 == 0:
                e["N"] += x1 - x0
            if y1 == U.D:
                e["S"] += x1 - x0
            if x1 == U.X and U.end:
                e["E"] += y1 - y0
        ext[rid] = e
    return ext


# ----------------------------------------------------------------------------- cost
def realise(R, T, U):
    """Pick an access link for every room (Prim from the entrance) -> links, unreached."""
    ids = list(R)
    sh = {}
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            L = _shared(R[a], R[b])
            if L:
                sh[(a, b)] = sh[(b, a)] = L
    en = next(r for r in ids if T[r] == "EN")
    tree, links, pen = {en}, [], 0.0
    while True:
        best = None
        for r in ids:
            if r in tree:
                continue
            for rank, pt in enumerate(ACCESS.get(T[r], [])):
                for p in tree:
                    if T[p] != pt:
                        continue
                    L = sh.get((r, p), 0)
                    kind = "open" if (T[r] in CIRC and T[p] in CIRC) else (
                        "slide" if {T[r], T[p]} == {"KT", "DR"} and L >= 1500 else "door")
                    # opening = GB 55038 4.1.14 clear width + 100 mm frame, plus 120 mm jambs either side
                    need = {"open": 1000, "slide": 1500, "door": door_open(T[r]) + 240}[kind]
                    if L < need:
                        continue
                    c = rank + (3 if (T[r] in ("BR", "BRM", "ST") and pt == "EN") else 0) + \
                        (1.5 if (T[r] == "BA" and pt == "LR") else 0)
                    if best is None or c < best[0]:
                        best = (c, r, p, kind)
            # keep scanning all rooms; cheapest edge wins
        if best is None:
            break
        c, r, p, kind = best
        tree.add(r)
        links.append((p, r, kind))
        pen += c
    # extra open links inside the public group (living, dining, entry and hall read as one space)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if T[a] in CIRC and T[b] in CIRC and sh.get((a, b), 0) >= 1000:
                if not any({a, b} == {x, y} for x, y, _ in links):
                    links.append((a, b, "open"))
    unreached = [r for r in ids if r not in tree]
    return links, unreached, pen, sh


def _square_share(rs, side):
    """Share of a room's area that a side x side square can sweep (morphological opening of the plan shape)."""
    from shapely.geometry import box
    from shapely.ops import unary_union
    g = unary_union([box(*q) for q in rs])
    if g.area <= 0:
        return 0.0
    h = side / 2 - 1
    return g.buffer(-h, join_style=2, mitre_limit=10).buffer(h, join_style=2, mitre_limit=10).area / g.area


def _net_area(rs):
    """Net floor area (m2) of a room made of rectangles: the union less half a 200 mm wall all round."""
    from shapely.geometry import box
    from shapely.ops import unary_union
    return unary_union([box(*q) for q in rs]).buffer(-100, join_style=2).area / 1e6


def cost(st, U, T, targets, want_south, detail=False):
    R = st["R"] if "R" in st else rects_of(st, U)        # lattice.optimise hands over the rooms' rectangles
    links, unreached, pen, sh = realise(R, T, U)
    ext = exterior(R, U)
    Ca = len(unreached)
    why = [f"unreached {r}" for r in unreached]
    Ca += walk.defects(R, T)
    if walk.defects(R, T): why.append("walk")                                      # a room nobody can walk through, after diagonal cuts
    # rooms people sleep in: in a studio the living room is the bedroom (GB 50096 5.1.1 "兼起居的卧室")
    SLEEP = ("BR", "BRM", "ST") if any(t in ("BR", "BRM", "ST") for t in T.values()) else ("BR", "BRM", "ST", "LR")
    en = next(r for r in R if T[r] == "EN")
    ex0 = max(R[en], key=U.door_overlap) if R[en] else (0, 0, 0, 0)   # the entry's rectangle on the flat door
    ov = U.door_overlap(ex0)
    Ca += 0 if ov >= 1200 else 1                                  # unit door onto the lobby
    if ov < 1200: why.append("door overlap")
    if U.door_depth(ex0) < 1200: why.append("door depth")
    Ca += 0 if U.door_depth(ex0) >= 1200 else 1                   # and 1.2 m of entry in front of it to step into
    for r, t in T.items():                                       # GB 55038 6.2.2 daylight
        if t in ("LR", "BRM", "BR", "ST", "KT") and max(ext[r].values()) < 1200:
            Ca += 1; why.append(f"daylight {t}")
        # (2026-11-06: the living room no longer has to face south: a balcony only where it does, compile.py)
    if not any(ext[r]["S"] >= 2400 for r, t in T.items() if t in ("LR", "BRM", "BR", "ST")):
        Ca += 1; why.append("sun")                                 # GB 50096 7.1.1: one habitable room in the sun
    if getattr(U, "compact", False):
        # 2026-11-06 (Leon: rooms were elongated): proportions of a 4/6-flat floor's rooms, as houseplan.KIND asks
        for r, rs in R.items():
            lim = PROPORTION.get(T[r])
            if not lim or not rs:
                continue
            bw = max(q[2] for q in rs) - min(q[0] for q in rs); bh = max(q[3] for q in rs) - min(q[1] for q in rs)
            area = sum((q[2] - q[0]) * (q[3] - q[1]) for q in rs)
            if max(bw, bh) / max(1, min(bw, bh)) > lim[0] + 1e-6 or min(bw, bh) < lim[1] - 1e-6:
                Ca += 1; why.append(f"proportion {T[r]} {bw}x{bh}")
            elif T[r] in ("LR", "BRM", "BR", "ST") and area < 0.8 * bw * bh:
                Ca += 1; why.append(f"fill {T[r]}")
            elif T[r] in ("LR", "BRM", "BR", "ST") and _square_share(rs, lim[1]) < (0.7 if T[r] == "LR" else 0.8):
                # 2026-11-07: most of the room is reached by a square of its minimum side (a 2.4 m x 6 m living room
                # with a 0.6 m bump passed the bounding-box tests above); a living room may keep a 30 % alcove
                Ca += 1; why.append(f"square {T[r]}")                                            # mostly a rectangle, not an L with a long arm
    for r, rs in R.items():                                       # GB 50096 5.2-5.4 / GB 55038 4.1 areas
        mn = MIN_NET.get(T[r])
        # compact flats: the union less half a wall (the gate's G1 measure); else each rectangle less a wall, which
        # also keeps the lattice's rooms from growing thin arms
        net = _net_area(rs) if getattr(U, "compact", False) else sum((q[2] - q[0] - 200) * (q[3] - q[1] - 200) for q in rs) / 1e6
        if mn and net < mn:
            Ca += 1; why.append(f"area {T[r]}")
    for r, rs in R.items():                                       # GB 55038 4.2.3 no bedroom on a lift shaft
        if T[r] in SLEEP and any(_touch(q, l) for q in rs for l in U.lifts):
            Ca += 1; why.append(f"lift {T[r]}")
    bam = [r for r in R if T[r] == "BAM"]
    for b in bam:                                                 # master suite
        if not any((T[p] in ("BRM", "CL")) and q == b for p, q, _ in links):
            Ca += 1; why.append("suite")
    # C_d: Gaussian log-likelihood of axis area and aspect against the priors
    Cd, shapes = 0.0, 0.0
    for r, rs in R.items():
        t = T[r]
        a = sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rs) / 1e6
        mu, sd = targets[r]
        Cd += 0.5 * ((a - mu) / sd) ** 2
        xs = [p for q in rs for p in (q[0], q[2])]
        ys = [p for q in rs for p in (q[1], q[3])]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        asp = max(w, h) / max(1, min(w, h))
        if t != "HL":
            Cd += 0.5 * max(0.0, (asp - 1.5) / 0.35) ** 2
        short = min((q[2] - q[0]) if (q[2] - q[0]) < (q[3] - q[1]) else (q[3] - q[1]) for q in rs[:1])
        if short < MIN_SIDE[t]:
            Cd += 4 * ((MIN_SIDE[t] - short) / 300.0) ** 2
        fill = a * 1e6 / max(1, w * h)
        shapes += (1 - fill) * 4                                  # bbox deficit (C_s)
    # C_t: typology
    south = sum(1 for r in R if T[r] in ("LR", "BRM", "BR", "ST") and ext[r]["S"] >= 2000)
    Csun = max(0, want_south - south)
    grp = {r for r in R if T[r] in CIRC}
    gw = {s for r in grp for s, L in ext[r].items() if L >= 1200}
    for p, q, k in links:
        if k == "slide":
            for x in (p, q):
                gw |= {s for s, L in ext[x].items() if L >= 1200}
    Cthrough = 0 if ("N" in gw and "S" in gw) else 1
    Cmw = sum(1 for r in R if T[r] in ("BA", "BAM") and max(ext[r].values()) < 900)
    Cdj = sum(1 for p, q, k in links if T[p] == "EN" and T[q] in ("BR", "BRM", "ST"))
    circ = sum(sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in R[r]) for r in R if T[r] in ("HL", "EN"))
    tot = sum(sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rs) for rs in R.values())
    Ccirc = max(0.0, circ / tot - 0.10)
    # dining opens straight into the living room (8 of 12 references; the rest
    # join them through an open hall) and the kitchen sits against the dining room
    dr = [r for r in R if T[r] == "DR"]; lr = [r for r in R if T[r] == "LR"]
    kt = [r for r in R if T[r] == "KT"]
    Cdl = 0 if (dr and lr and sh.get((dr[0], lr[0]), 0) >= 1200) else 1
    Cdl += 0 if (dr and kt and sh.get((dr[0], kt[0]), 0) >= 1200) else 0.5
    C = (K["kdl"] * Cdl + K["a"] * Ca + K["d"] * Cd + K["s"] * shapes + K["sun"] * Csun + K["through"] * Cthrough +
         K["mingwei"] * Cmw + K["dongjing"] * Cdj + K["circ"] * Ccirc + K["pref"] * pen)
    if detail:
        return C, {"Ca": Ca, "Ca_why": why, "dining_living": Cdl == 0, "bed_on_lift": [r for r, rs in R.items() if T[r] in SLEEP and any(_touch(q, l) for q in rs for l in U.lifts)], "Cd": round(Cd, 3), "Cs": round(shapes, 3), "south": south,
                   "through": not Cthrough, "dark_baths": Cmw, "bed_off_entry": Cdj,
                   "circ_share": round(circ / tot, 3), "unreached": unreached,
                   "links": links, "R": R, "ext": ext}
    return C


# ----------------------------------------------------------------------------- moves
def initial(prog, U, rng, targets):
    T = dict(prog)
    st = {"y1": 3300, "y2": min(U.dc, U.D - 4500), "N": [], "M": [], "S": []}
    bands = {"N": [], "M": [], "S": []}
    for rid, t in prog:
        if t == "EN":
            continue
        ok = BAND_OK[t]
        b = ok[0] if len(ok) == 1 else rng.choice(ok)
        bands[b].append(rid)
    rng.shuffle(bands["N"]); rng.shuffle(bands["S"]); rng.shuffle(bands["M"])
    en = next(r for r, t in prog if t == "EN")
    cols = [{"rooms": [en], "w": 0, "split": 0.5}]
    for rid in bands["M"]:
        if T[rid] in ("BA", "BAM", "CL", "SR") and rng.random() < 0.5 and len(cols[-1]["rooms"]) == 1 and cols[-1]["rooms"][0] != en:
            cols[-1]["rooms"].append(rid)
        else:
            cols.append({"rooms": [rid], "w": 0, "split": 0.5})
    if not bands["N"]:
        bands["N"].append(bands["S"].pop()) if any(T[r] in ("BR", "ST") for r in bands["S"]) else None

    def widths(items, span, depth):
        ws = [max(MIN_SIDE.get(T[i] if isinstance(i, str) else T[i["rooms"][0]], 1200),
                  targets[i if isinstance(i, str) else i["rooms"][0]][0] * 1e6 / depth) for i in items]
        s = sum(ws)
        out = [int(round(w / s * span / GRID)) * GRID for w in ws]
        out[-1] += span - sum(out)
        return out

    spanNM = U.X - U.wn
    st["N"] = [[r, w] for r, w in zip(bands["N"], widths(bands["N"], spanNM, st["y1"]))]
    ws = widths(cols, spanNM, st["y2"] - st["y1"])
    for c, w in zip(cols, ws):
        c["w"] = w
    st["M"] = cols
    st["S"] = [[r, w] for r, w in zip(bands["S"], widths(bands["S"], U.X, U.D - st["y2"]))]
    return st


def _copy(st):
    return {"y1": st["y1"], "y2": st["y2"], "N": [list(x) for x in st["N"]], "S": [list(x) for x in st["S"]],
            "M": [{"rooms": list(c["rooms"]), "w": c["w"], "split": c["split"]} for c in st["M"]]}


def propose(st, U, T, rng):
    s = _copy(st)
    m = rng.random()
    d = int(round(rng.gauss(0, SIGMA) / GRID)) * GRID or GRID * rng.choice((-1, 1))
    if m < 0.45:                                      # slide an x wall
        band = rng.choice([b for b in "NMS" if len(s[b]) > 1])
        L = s[band]
        i = rng.randrange(len(L) - 1)
        wi = L[i]["w"] if band == "M" else L[i][1]
        wj = L[i + 1]["w"] if band == "M" else L[i + 1][1]
        if wi + d < 900 or wj - d < 900:
            return None
        if band == "M":
            L[i]["w"] += d; L[i + 1]["w"] -= d
        else:
            L[i][1] += d; L[i + 1][1] -= d
    elif m < 0.55:                                    # slide a band line
        if rng.random() < 0.5:
            s["y1"] += d
        else:
            s["y2"] += d
        if not (2400 <= s["y1"] <= s["y2"] - 2400) or s["y2"] > U.dc or U.D - s["y2"] < 3300 or s["y2"] < U.dc - 3000:
            return None
    elif m < 0.62:                                    # slide a stack split
        cs = [c for c in s["M"] if len(c["rooms"]) == 2]
        if not cs:
            return None
        c = rng.choice(cs)
        c["split"] = min(0.8, max(0.2, c["split"] + d / max(1, s["y2"] - s["y1"])))
    elif m < 0.82:                                    # swap two rooms
        slots = [(b, i, j) for b in "NS" for i in range(len(s[b])) for j in (0,)] + \
                [("M", i, j) for i, c in enumerate(s["M"]) for j in range(len(c["rooms"]))]
        (b1, i1, j1), (b2, i2, j2) = rng.sample(slots, 2)
        g = lambda b, i, j: s[b][i][0] if b != "M" else s[b][i]["rooms"][j]
        r1, r2 = g(b1, i1, j1), g(b2, i2, j2)
        if b1 not in BAND_OK[T[r2]] or b2 not in BAND_OK[T[r1]] or "EN" in (T[r1], T[r2]):
            return None
        def put(b, i, j, r):
            if b == "M":
                s[b][i]["rooms"][j] = r
            else:
                s[b][i][0] = r
        put(b1, i1, j1, r2); put(b2, i2, j2, r1)
    else:                                             # relocate a room
        cands = [r for r in T if T[r] not in ("EN", "LR")]
        r = rng.choice(cands)
        # remove
        for b in "NS":
            for i, (rid, w) in enumerate(s[b]):
                if rid == r:
                    if len(s[b]) == 1:
                        return None
                    k = i - 1 if i > 0 else i + 1
                    s[b][k][1] += w
                    del s[b][i]
                    break
        for i, c in enumerate(s["M"]):
            if r in c["rooms"]:
                if len(c["rooms"]) == 2:
                    c["rooms"].remove(r)
                else:
                    if i == 0:
                        return None
                    s["M"][i - 1]["w"] += c["w"]
                    del s["M"][i]
                break
        # insert
        b = rng.choice(BAND_OK[T[r]])
        if b == "M":
            singles = [c for c in s["M"] if len(c["rooms"]) == 1]
            if singles and rng.random() < 0.5:
                c = rng.choice(singles)
                c["rooms"].insert(rng.randrange(2), r)
                c["split"] = 0.5
            else:
                i = rng.randrange(1, len(s["M"]) + 1)
                k = rng.randrange(len(s["M"]))
                half = (s["M"][k]["w"] // 2) // GRID * GRID
                if half < 900:
                    return None
                s["M"][k]["w"] -= half
                s["M"].insert(i, {"rooms": [r], "w": half, "split": 0.5})
        else:
            if not s[b]:
                return None
            k = rng.randrange(len(s[b]))
            half = (s[b][k][1] // 2) // GRID * GRID
            if half < 900:
                return None
            s[b][k][1] -= half
            s[b].insert(rng.randrange(len(s[b]) + 1), [r, half])
    return s


def optimise(prog, U, targets, want_south, seed, iters=6000, beta0=0.05, beta1=4.0):
    rng = random.Random(seed)
    T = dict(prog)
    st = initial(prog, U, rng, targets)
    c = cost(st, U, T, targets, want_south)
    best, bc = st, c
    for k in range(iters):
        beta = beta0 * (beta1 / beta0) ** (k / iters)     # geometric annealing
        s2 = propose(st, U, T, rng)
        if s2 is None:
            continue
        c2 = cost(s2, U, T, targets, want_south)
        if c2 <= c or rng.random() < math.exp(-beta * (c2 - c)):
            st, c = s2, c2
            if c < bc:
                best, bc = st, c
    return best, bc
