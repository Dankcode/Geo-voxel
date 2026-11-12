"""A flat's rooms planned by the houses' planner (2026-11-06).

Leon: the rooms of the 4- and 6-flat floors came out elongated and some did not work; use the houses' room planner.
The houses plan each apartment of a multi-unit building with pipeline/planner.py (Merrell, Schkufza & Koltun 2010):
a programme of rooms with target areas and Merrell's access edges (door / open), on a lattice of the flat's cells,
with the flat's corridor edge as its entry and its facades as the only edges that take light. Its cost carries what
the lattice planner here lacked: every room's aspect ratio (log-normal around 1.35, hard limit 2.0 : 1), its minimum
side, a clear square in habitable rooms (CLEAR_W), Merrell's convexity, a door-wide shared wall for every access edge,
daylight for the daylit rooms, and halls sized by the doors they serve and no wider than 2 m.

This module turns one planner.Unit and its high-rise programme into the houses' site and programme, runs the houses'
optimiser, and returns the rooms as rectangles in the unit frame (so compile_unit, the Chinese-code scorecard, walls,
diagonal cuts, furniture, FreeCAD and the drawings work unchanged).
"""
import math
import os

import numpy as np
from highrise.analyze import aspect_model

from highrise.lattice import HP, room_rects

CELL = 300                       # mm, the floor lattice's module

# high-rise room type -> the houses' room kind, tier and extra limits
KIND = {
    "EN": ("foyer", "circulation", dict(min_side=1.3, hard_min_side=1.2, hard_fill=0.8)),
    # hard_aspect / hard_min_side (m): proportions the plan may not exceed (Leon, 2026-11-06: rooms were elongated)
    "LR": ("living", "public", dict(hard_fill=0.8, min_side=3.3, light_min=2.7, min_mu=13.0, hard_aspect=2.2, hard_min_side=3.0)),
    "DR": ("dining", "public", dict(min_side=2.6, hard_aspect=2.0, hard_min_side=2.4)),
    "KT": ("kitchen", "semi", dict(min_side=1.8, light_min=2.1, min_mu=5.5, hard_aspect=3.0, hard_min_side=1.8)),
    "BRM": ("bedroom", "private", dict(hard_fill=0.8, min_side=3.3, light_min=2.4, min_mu=12.0, avoid="lift", hard_aspect=2.0,
                                       hard_min_side=2.9)),
    "BR": ("bedroom", "private", dict(hard_fill=0.8, min_side=2.4, light_min=2.4, min_mu=7.5, avoid="lift", hard_aspect=2.2,
                                      hard_min_side=2.4)),
    "ST": ("study", "semi", dict(hard_fill=0.8, min_side=2.1, light_min=2.1, min_mu=7.0, avoid="lift", hard_aspect=2.2, hard_min_side=2.1)),
    "BA": ("bathroom", "private", dict(min_side=1.5, min_mu=3.6, hard_aspect=2.4, hard_min_side=1.5)),
    "BAM": ("bathroom", "private", dict(min_side=1.5, min_mu=3.6, hard_aspect=2.4, hard_min_side=1.5)),
    "HL": ("hall", "circulation", dict(min_side=1.1)),
    "CL": ("storage", "private", dict(min_side=1.2, max_aspect=3.0)),
    "SR": ("storage", "service", dict(min_side=1.2, max_aspect=3.0)),
    "NA": ("utility", "service", dict(min_side=1.2)),
}
FLAGS = {"living": dict(daylight=1), "dining": dict(daylight=1), "kitchen": dict(daylight=1, wet=1),
         "bedroom": dict(daylight=1, private=1), "study": dict(daylight=1), "bathroom": dict(wet=1, private=1, max_aspect=2.4),
         "utility": dict(wet=1)}


def _hard_area(t):
    """Axis area (m2) whose net area (walls off) meets codes.MIN_NET_AREA, for the houses' planner's hard check."""
    from highrise import codes
    mn = codes.MIN_NET_AREA.get(t)
    return round(mn * 1.15 + 0.45, 2) if mn else None


ASPECT_TYPES = ("LR", "DR", "KT", "BRM", "BR", "ST", "BA", "BAM")


def programme(prog, targets):
    """The high-rise room list [(rid, type)] and axis-area targets -> the houses' programme (rooms, Merrell edges)."""
    T = dict(prog)
    rooms, idx = [], {}
    for rid, t in prog:
        kind, tier, kw = KIND[t]
        r = {"id": len(rooms), "kind": kind, "storey": 0, "tier": tier, "hr": rid, **FLAGS.get(kind, {}), **kw}
        if _hard_area(t):
            r["hard_area"] = _hard_area(t)
        am = aspect_model().get(t)
        if am and t in ASPECT_TYPES:
            # Merrell C_d (−ℓ_as) with the reference plans' aspect distribution, at full weight, and their largest
            # aspect (+10 %) as a hard limit (2026-11-11)
            r["aspect_mu"], r["aspect_sd"], r["aspect_w"] = am[0], am[1], 1.0
            r["hard_aspect"] = min(r.get("hard_aspect", 9.0), am[2])
            r["max_aspect"] = min(r.get("max_aspect", 9.0), am[2])
        if t in ("LR", "BRM", "BR", "ST") and r.get("hard_min_side"):
            r["hard_square"] = 0.7 if t == "LR" else 0.8               # planner.cost's square test, on the cell grid
        if t != "HL":
            # the target area, never under what the Chinese minimum net area needs on axis (codes.MIN_NET_AREA)
            mu = max(float(targets[rid][0]), r.pop("min_mu", 0.0))
            r["mu"], r["sigma"] = mu, 0.25 * mu
        r.pop("min_mu", None)
        idx[rid] = r["id"]
        rooms.append(r)
    by = lambda t: [rid for rid, tt in prog if tt == t]
    en, lr = by("EN")[0], by("LR")[0]
    hl = (by("HL") or [None])[0]
    edges = []

    def link(a, b, kind="door", cluster=None):
        edges.append({"a": idx[a], "b": idx[b], "type": kind, **({"cluster": cluster} if cluster else {})})
    # 2026-11-07: a flat with no hall (a studio or one bedroom) opens its bedroom and bath off the entry or the
    # living room, whichever they touch (planner.ACCESS lets both); the houses' planner meets such a group as a
    # cluster: its rooms joined by any of its links
    small = not hl and len(by("BRM") + by("BR") + by("ST")) <= 1
    if small:
        link(en, lr, "open")                  # the living room always off the entry (never through a bedroom)
        link(en, lr, "open", "hub")
        for b in by("BRM") + by("BR") + by("ST") + by("BA"):
            link(en, b, "door", "hub"); link(lr, b, "door", "hub")
    else:
        hub = hl or lr
    if hl:
        # the entry, living room and hall read as one public space: any two of them open onto each other, the
        # group joined (an L-shaped flat enters its hall in the wing and reaches the living room along it)
        link(en, lr, "open", "pub"); link(en, hl, "open", "pub"); link(lr, hl, "open", "pub")
    elif not small:
        link(en, lr, "open")
    for d in by("DR"):
        link(lr, d, "open")
    for k in by("KT"):
        link((by("DR") or [lr])[0], k)
    brm = (by("BRM") or [None])[0]
    for b in ([] if small else by("BRM") + by("BR") + by("ST")):
        link(hub, b)
    for b in by("BAM"):
        link(brm or hub, b)
    for b in ([] if small else by("BA")):
        link(hub if (hl or by("BRM")) else en, b)
    for c in by("CL"):
        link(brm or hub, c)
    for s in by("SR"):
        link(en, s)
    for n in by("NA"):
        link((by("KT") or [lr])[0], n)
    # the houses' hall rule: a hall's area follows the doors it serves, and it is a corridor (<= 2 m clear)
    for r in rooms:
        if r["kind"] == "hall":
            n = sum(1 for e in edges if r["id"] in (e["a"], e["b"]))
            r["mu"] = round(1.1 * (0.9 * n + 1.5), 1); r["sigma"] = round(0.35 * r["mu"], 1); r["max_width"] = 2.0
    studio = not any(t in ("BRM", "BR") for t in T.values())
    if studio:                                          # a studio's living room is its bedroom: off the lift shafts too
        rooms[idx[lr]]["avoid"] = "lift"
    sun = [idx[rid] for rid, t in prog if t in ("LR", "BRM", "BR", "ST")]
    return {"rooms": rooms, "edges": edges, "entry": idx[en], "log": [], "stair_size": (8, 11), "cover": 1.0,
            "lit_strip": True, "privacy": False, "sun_rooms": sun}


def site(U):
    """The flat's cells (300 mm, the last row / column cut to the flat's edge), its entry edge on the corridor door and
    its light edges on the facades (north at y = 0, south at y = D, east at x = X for an end flat)."""
    xs = list(range(int(U.x0), int(U.X), CELL)) + [int(U.X)]
    if xs[-1] - xs[-2] < CELL / 3:
        xs.pop(-2)
    ys = list(range(0, int(U.D), CELL)) + [int(U.D)]
    if ys[-1] - ys[-2] < CELL / 3:
        ys.pop(-2)
    xs, ys = np.array(xs), np.array(ys)
    cx, cy = (xs[:-1] + xs[1:]) / 2, (ys[:-1] + ys[1:]) / 2
    H, W = len(cy), len(cx)
    mask = np.ones((H, W), bool)
    for x0, y0, x1, y1 in U.cuts:
        mask &= ~((cx[None, :] > x0) & (cx[None, :] < x1) & (cy[:, None] > y0) & (cy[:, None] < y1))
    entry = np.zeros((H, W, 4), bool)
    light = np.zeros((H, W, 4), bool)
    o, at, lo, hi = U.door
    for j in range(H):
        for i in range(W):
            if not mask[j, i]:
                continue
            if o == "v" and lo < cy[j] < hi:
                if xs[i] == at:
                    entry[j, i, 3] = True
                if xs[i + 1] == at:
                    entry[j, i, 1] = True
            if o == "h" and lo < cx[i] < hi:
                if ys[j] == at:
                    entry[j, i, 0] = True
                if ys[j + 1] == at:
                    entry[j, i, 2] = True
            if j == 0:
                light[j, i, 0] = True
            if j == H - 1:
                light[j, i, 2] = True
            if i == W - 1 and U.end:
                light[j, i, 1] = True
    s = HP.finish_site(mask, CELL / 1000, None, carve=False, entry_edges=entry, light_edges=light)
    sun = np.zeros_like(light); sun[..., 2] = light[..., 2]          # the south facade
    sun[..., 1] = light[..., 1]                                       # and an end flat's gable (2026-11-11)
    s["sun"] = sun
    # cell edges against a lift shaft (in the flat's frame): no bed behind them
    lift = np.zeros_like(light)
    for x0, y0, x1, y1 in U.lifts:
        for j in range(H):
            for i in range(W):
                if not mask[j, i]:
                    continue
                if xs[i + 1] == x0 and y0 < cy[j] < y1: lift[j, i, 1] = True
                if xs[i] == x1 and y0 < cy[j] < y1: lift[j, i, 3] = True
                if ys[j + 1] == y0 and x0 < cx[i] < x1: lift[j, i, 2] = True
                if ys[j] == y1 and x0 < cx[i] < x1: lift[j, i, 0] = True
    s["lift"] = lift
    return s, xs, ys


# annealing schedule: colder than the houses' (0.03 -> 6) so the start (entry on the door, rooms stacked front to back)
# survives the first, hot iterations (2026-11-07)
BETA = tuple(float(v) for v in os.environ.get("HR_HOUSE_BETA", "0.3,6").split(","))


def _rooms(labels, S, P, xs, ys):
    """Label grid -> {hr rid: [rects]}; a cell the optimiser left unbuilt goes to the room next to it."""
    L = np.array(labels[0])
    for _ in range(40):
        hole = (L <= 0) & S["mask"]
        if not hole.any():
            break
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = np.roll(L, (dy, dx), (0, 1))
            f = hole & (nb > 0)
            L[f] = nb[f]
            hole = (L <= 0) & S["mask"]
    R = {}
    for r in P["rooms"]:
        m = (L == r["id"] + 1) & S["mask"]
        R[r["hr"]] = [tuple(int(v) for v in q) for q in room_rects(m, xs, ys)] if m.any() else []
    return R


def plan(prog, U, targets, seed, iters=None, want_south=1):
    """One run of the houses' optimiser on the flat -> ({"R": {rid: rects}}, cost, terms).

    2026-11-07: the high-rise's own hard checks (planner.cost C_a: walkable after diagonal cuts, the entry in front
    of the flat door, net areas, proportions, sun, no bedroom on the lifts) are added to the houses' hard term
    whenever the houses' own checks pass, so the search ends on a plan that also passes the high-rise gate."""
    P, S, xs, ys = setup(prog, U, targets, want_south)
    res = HP.optimize(P, [S], seed, iterations=iters, beta=BETA)
    return {"R": _rooms(res["labels"], S, P, xs, ys)}, float(res["cost"]), res["terms"]


def setup(prog, U, targets, want_south=1):
    """The houses' programme and site for a flat, with the high-rise's hard checks and start hooked in."""
    from highrise import planner as HRP
    P = programme(prog, targets)
    S, xs, ys = site(U)
    T = {rid: t for rid, t in prog}
    memo = {}

    def hook(labels):
        key = np.asarray(labels[0]).tobytes()
        if key not in memo:
            if len(memo) > 50000:
                memo.clear()
            R = _rooms(labels, S, P, xs, ys)
            memo[key] = 0 if any(not rs for rs in R.values()) else HRP.cost({"R": R}, U, T, targets, want_south, detail=True)[1]["Ca"]
        return memo[key]

    en = P["entry"] + 1

    def start(labels):
        L = labels[0]
        H, W = L.shape
        m = S["mask"]
        rows = [np.nonzero(m[j])[0] for j in range(H)]
        if U.north and all(len(r) for r in rows) and max(len(r) for r in rows) * CELL <= 5400:
            # a flat through the block, 5.4 m wide or less: rooms stacked front to back, the bedrooms on the north,
            # the living room on the sunny south end (a bedroom there when the south end is too narrow for it), the
            # entry, bath and kitchen between them; the search rarely trades a 13 m2 room end for end by itself
            by = {r["kind"]: [] for r in P["rooms"]}
            for r in P["rooms"]:
                by[r["kind"]].append(r)
            beds_, liv = by.get("bedroom", []), by.get("living", [])
            south = liv[:1]
            if liv and len(rows[-1]) * CELL < 1000 * KIND["LR"][2]["hard_min_side"] and beds_:
                south, beds_ = beds_[:1], liv[:1] + beds_[1:]
            def band(rs, js):
                out = []
                for r in rs:
                    need, got = r.get("mu", 10.0), 0.0
                    while js and got < need:
                        j = js.pop(0)
                        L[j, rows[j]] = r["id"] + 1
                        got += len(rows[j]) * (CELL / 1000) ** 2
                        out.append(j)
                return out
            js = list(range(H))
            band(beds_, js)
            js.reverse()
            band(south, js)
            mid = sorted(js)
            # between them: the entry (or the hall) on the door side as the passage from the bedrooms to the living
            # room; the bath (north) and the kitchen (south, on the living room) on the far side
            door_side = by.get("hall", [])[:1] or by.get("foyer", [])[:1]
            far = by.get("bathroom", []) + by.get("utility", []) + by.get("storage", []) + by.get("kitchen", []) + \
                by.get("dining", []) + by.get("study", [])
            if south and south[0]["kind"] != "living":
                far = far[::-1]                     # the kitchen next to the living room, wherever it is
            # the far side shared out by the rooms' target areas, front to back
            tot = sum(r.get("mu", 4.0) for r in far) or 1.0
            cut, acc = [], 0.0
            for r in far:
                acc += r.get("mu", 4.0) / tot
                cut.append(acc)
            n_mid = len(mid)
            for q, j in enumerate(mid):
                cols = rows[j]
                half = max(1, min(len(cols) - 3, max(6, int(round(len(cols) * 0.38)))))   # 1.6 m+ open to the living
                if door_side:
                    L[j, cols[:half]] = door_side[0]["id"] + 1
                if far:
                    t_ = (q + 0.5) / max(1, n_mid)
                    L[j, cols[half:]] = far[next((i for i, c_ in enumerate(cut) if t_ <= c_), len(far) - 1)]["id"] + 1
        elif U.north and len(rows[-1]) and max(len(r) for r in rows) > len(rows[-1]) + 3 and len(rows[-1]) * CELL <= 5400:
            # an L: a strip through the block at the end (the south row's columns) and a wing along the north face.
            # The strip: kitchen and bath on the north, the hall across, the living room on the sunny south end; the
            # wing: the bedrooms on the north face over a 1.2 m hall that runs from the entry to the strip
            strip = set(rows[-1].tolist())
            wing_rows = [j for j in range(H) if any(c not in strip for c in rows[j])]
            if wing_rows and wing_rows == list(range(wing_rows[0], wing_rows[-1] + 1)) and wing_rows[0] == 0:
                wr0, wr1 = 0, wing_rows[-1] + 1
                by = {}
                for r in P["rooms"]:
                    by.setdefault(r["kind"], []).append(r)
                hall = (by.get("hall") or by.get("foyer"))[0]
                hb = 4                                                  # hall band, rows
                beds_ = by.get("bedroom", []) + by.get("study", [])
                svc = by.get("bathroom", []) + by.get("utility", [])
                # the wing: all bedrooms but the last, then the bath; the strip's north end: the last bedroom
                # (gable and north windows), or the bath and kitchen when there is one bedroom
                wing = (beds_[:-1] if len(beds_) > 1 else beds_) + svc
                north_end = beds_[-1:] if len(beds_) > 1 else []
                kt = by.get("kitchen", [])
                sc = sorted(strip)
                tot = sum(b_.get("mu", 6.0) for b_ in wing) or 1.0
                for j in range(wr0, wr1):
                    wc = [c for c in rows[j] if c not in strip]
                    if j >= wr1 - hb:
                        L[j, wc] = hall["id"] + 1
                        L[j, sc] = hall["id"] + 1
                        continue
                    acc, k_ = 0.0, 0
                    for q, c in enumerate(wc):
                        while k_ < len(wing) - 1 and q >= len(wc) * (acc + wing[k_].get("mu", 6.0)) / tot:
                            acc += wing[k_].get("mu", 6.0); k_ += 1
                        if wing:
                            L[j, c] = wing[k_]["id"] + 1
                    if north_end:
                        L[j, sc] = north_end[0]["id"] + 1
                    elif kt:
                        L[j, sc] = kt[0]["id"] + 1
                # under the hall in the strip: the kitchen (when not on the north end), then the living room
                lv = by.get("living", [])
                got, need = 0.0, (kt[0].get("mu", 6.0) if (kt and north_end) else 0.0)
                for j in range(wr1, H):
                    if got < need:
                        L[j, rows[j]] = kt[0]["id"] + 1
                        got += len(rows[j]) * (CELL / 1000) ** 2
                    elif lv:
                        L[j, rows[j]] = lv[0]["id"] + 1
        elif not U.north and U.door[0] == "h":
            # a flat on the south face only, its door on the corridor to the north (the studios): the living room
            # across the full depth at one end, beside it the entry on the door with the bath past it, and the
            # kitchen behind them on the south face, opening off the living room
            ys_, xs_ = np.nonzero(m)
            y0, y1, x0, x1 = ys_.min(), ys_.max() + 1, xs_.min(), xs_.max() + 1
            dc = [i for i in range(W) if S["entry"][..., :].any(axis=(0, 2))[i]]
            lv = [r for r in P["rooms"] if r["kind"] == "living"]
            if dc and lv:
                lr = lv[0]
                wl = max(11, int(math.ceil(lr.get("mu", 13.0) / ((y1 - y0) * CELL / 1000) / (CELL / 1000))))
                d0, d1 = min(dc), max(dc) + 1
                west = (d0 - x0) >= (x1 - d1)          # the living room on the side with more room beside the door
                lx = (x0, min(x1 - 9, x0 + wl)) if west else (max(x0 + 9, x1 - wl), x1)
                zx = (lx[1], x1) if west else (x0, lx[0])
                kinds = {r["kind"]: r for r in P["rooms"]}
                band = min(y1 - y0 - 6, 7)
                L[y0:y1, lx[0]:lx[1]][m[y0:y1, lx[0]:lx[1]]] = lr["id"] + 1
                if "kitchen" in kinds:
                    sub = m[y0 + band:y1, zx[0]:zx[1]]
                    L[y0 + band:y1, zx[0]:zx[1]][sub] = kinds["kitchen"]["id"] + 1
                if "bathroom" in kinds:
                    sub = m[y0:y0 + band, zx[0]:zx[1]]
                    L[y0:y0 + band, zx[0]:zx[1]][sub] = kinds["bathroom"]["id"] + 1
                # the entry: 5 columns of the door next to the living room, the band deep
                ex = (max(zx[0], d0), min(zx[0] + 5, x1)) if west else (max(zx[1] - 5, x0), min(zx[1], d1))
                if ex[1] - ex[0] < 4:
                    ex = (d0, min(d1, d0 + 5)) if west else (max(d0, d1 - 5), d1)
                L[y0:y0 + band, ex[0]:ex[1]][m[y0:y0 + band, ex[0]:ex[1]]] = en
        # the entry starts on the flat door, 1.5 m deep (the search rarely swaps it there from elsewhere)
        for y, x, k in np.argwhere(S["entry"]):
            du, dv = HP.DIRS[k]
            for d in range(5):
                yy, xx = y - dv * d, x - du * d
                if 0 <= yy < H and 0 <= xx < W and S["mask"][yy, xx]:
                    L[yy, xx] = en

    P["hard_hook"] = hook
    P["initial_hook"] = start
    return P, S, xs, ys
