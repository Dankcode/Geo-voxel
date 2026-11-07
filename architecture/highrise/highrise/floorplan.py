"""The whole typical floor of a 4- or 6-flat slab in one search, as the houses are planned (2026-11-06).

The houses' optimiser (pipeline/planner.py: Merrell, Schkufza & Koltun 2010 on a label lattice) plans the floor:
labels are the public corridor, each flat, and the core. The core is one block that the search moves among candidate
spots along the north facade, mirrored or not (the houses' stair move); the corridor and the flats grow around it by the
houses' wall slides. Each flat's rooms are then planned on the domain it got, by the same lattice search as before
(lattice.py), and checked against the codes.

Core (GB 50016 5.5.27 / 5.5.28 / 7.3.5, GB 55038 4.2.4):
    stair box         on the north facade (scissor stair with 2 runs where 2 exits are needed)
    fire lobby        between the stair and the corridor (smoke-proof stairs, above 33 m); the fire lift opens into it,
                      so it is the combined lobby of 5.5.28 (>= 12 m2 with the fire lift, short side >= 2.4 m); one
                      Class B fire door from it onto the corridor
    lifts             beside the lobby; the fire lift's door faces the lobby, every other lift opens straight onto the
                      public corridor, which is 1.5 m deep in front of it (GB 55038 4.2.4 lift lobby)
    service shafts    north of the lifts
So no door stands between the lifts and the flats: the corridor is the lift lobby, and only the stair's fire lobby has
a door. Without a smoke-proof stair (33 m and below) the stair opens straight onto the corridor.

Floor costs: the corridor and every flat in one piece; the corridor touching the fire lobby's door and every lift door,
1.2 m clear everywhere, as small as it can be; every flat on the corridor for 1.5 m (its door), with enough south facade
for its daylit rooms (5.4 m with no north facade, else 3.6 m), near an even share of the floor, compact (Merrell M_c);
the walk from each flat door to the stair's lobby within the code's limit (10 m above 27 m, 15 m below).
"""
import math

import numpy as np
from scipy import ndimage

from highrise import codes
from highrise.core import LIFT_SHAFT, WALL, stair_box
from highrise.lattice import HP, room_rects
from highrise.planner import Unit

M = 300                                    # floor lattice module, mm
K = dict(v=1000.0, a=60.0, w=0.8, c=2.5, d=40.0, s=30.0, t=40.0, f=40.0)
SITE = {"carve": False}
CORR_CLEAR = 1500                          # public corridor: 1.5 m clear, a wheelchair's turning circle (GB 55019 2.2.1 /
                                           # GB 50763 3.5.1) and a stretcher's passage; GB 50096 6.1.1's 1.2 m is the floor
LIFT_HALL = 1500                           # GB 55038 4.2.4: lift lobby >= 1.5 m deep
DOOR_SPAN = 1500                           # corridor wall a flat door needs


def cm(v):
    return int(math.ceil(v / M - 1e-9) * M)


# ----------------------------------------------------------------------------------------------- the core block
def core_template(req, form="wide"):
    """The core in its own frame (x east from its west edge, y south from the north facade), dimensions on the
    300 mm module. Two forms the search picks between:
        wide      stair over its fire lobby, the lifts beside them; the lobby's door and the passenger lifts face south
                  onto the corridor (12 m x 5.4 m for a scissor stair and 2 lifts)
        stacked   stair, fire lobby and lift row one above the other (as the old centred core); the lobby's door is on
                  its east end, the fire lift opens north into the lobby, the passenger lifts south onto the corridor
                  (7.2 m x 7.9 m)
    fronts: [(kind, side, a, b)] spans of the block's faces the corridor must touch (side S: x span; E: y span)."""
    kind, sl, sd, exits = stair_box(req)
    sl, sd = cm(sl), cm(sd)
    nl = max(1, req["lifts"])
    lw, ld = nl * LIFT_SHAFT[0], cm(LIFT_SHAFT[1])
    smoke = req["stair_type"] == "smoke-proof"
    fire = bool(req["fire_lift"])
    parts, fronts, lifts, lift_doors = {}, [], [], []
    if form == "stacked":
        W = max(sl, cm(lw + 1200))
        fd = cm(codes.COMBINED_LOBBY_SHORT * 1000 + WALL) if smoke else 0
        if smoke and req["lobby_min_m2"]:
            fd = max(fd, cm(req["lobby_min_m2"] * 1e6 / (W - WALL) + WALL))
        y1 = sd + fd
        Dp = y1 + ld
        parts["stair"] = ("stair", [0, 0, W, sd])
        if smoke:
            parts["lobby"] = ("lobby", [0, sd, W, y1])
            stair_doors = [(700, sd)] + ([(W - 700, sd)] if exits == 2 else [])
            m = (sd + y1) / 2
            lobby_door = {"orient": "v", "at": W, "from": m - 600, "to": m + 600}
            fronts.append(("lobby", "E", m - 750, m + 750))
        else:
            stair_doors = [(W - 700, sd)]
            lobby_door = None
            parts["hall"] = ("lobby", [0, sd, W, y1]) if fd else None
            fronts.append(("stair", "E", sd - 1500, sd))
        side = (W - lw) // 2
        if side > 0:
            parts["shaft_w"] = ("shaft", [0, y1, side, Dp])
            parts["shaft_e"] = ("shaft", [side + lw, y1, W, Dp])
        for i in range(nl):
            r = [side + i * LIFT_SHAFT[0], y1, side + (i + 1) * LIFT_SHAFT[0], Dp]
            role = "fire lift" if (i == 0 and fire) else "lift"
            parts[f"lift{i + 1}"] = (role, r)
            lifts.append(r)
            cx = (r[0] + r[2]) / 2
            if role == "fire lift" and smoke:
                lift_doors.append({"orient": "h", "at": y1, "from": cx - 550, "to": cx + 550, "side": "N"})
            else:
                lift_doors.append({"orient": "h", "at": Dp, "from": cx - 550, "to": cx + 550, "side": "S"})
                fronts.append(("lift", "S", r[0], r[2]))
        parts = {k: v for k, v in parts.items() if v}
        return {"parts": parts, "W": W, "D": Dp, "stair_doors": stair_doors, "lobby_door": lobby_door,
                "lift_doors": lift_doors, "fronts": fronts, "lifts": lifts, "kind": kind, "exits": exits, "sl": W,
                "sd": sd, "smoke": smoke, "fire": fire and nl > 0, "form": form, "lobby_y": (sd, y1)}
    if smoke:
        fd = ld
        if req["lobby_min_m2"]:
            fd = max(fd, cm(req["lobby_min_m2"] * 1e6 / (sl - WALL) + WALL), cm(codes.COMBINED_LOBBY_SHORT * 1000 + WALL))
        Dp = sd + fd
        parts["stair"] = ("stair", [0, 0, sl, sd])
        parts["lobby"] = ("lobby", [0, sd, sl, Dp])
        ly0 = Dp - ld                                       # lifts on the corridor side
        if ly0 > 0:
            parts["shaft_n"] = ("shaft", [sl, 0, sl + lw, ly0])
        stair_doors = [(700, sd)] + ([(sl - 700, sd)] if exits == 2 else [])
        lobby_door = {"orient": "h", "at": Dp, "from": sl / 2 - 600, "to": sl / 2 + 600}
        fronts.append(("lobby", "S", sl / 2 - 750, sl / 2 + 750))
    else:
        Dp = max(sd, ld)
        parts["stair"] = ("stair", [0, 0, sl, Dp])
        ly0 = Dp - ld
        if ly0 > 0:
            parts["shaft_n"] = ("shaft", [sl, 0, sl + lw, ly0])
        stair_doors = [(sl / 2, Dp)]                         # the stair opens straight onto the corridor
        lobby_door = None
        fronts.append(("stair", "S", sl / 2 - 750, sl / 2 + 750))
    for i in range(nl):
        r = [sl + i * LIFT_SHAFT[0], ly0, sl + (i + 1) * LIFT_SHAFT[0], Dp]
        role = "fire lift" if (i == 0 and fire) else "lift"
        parts[f"lift{i + 1}"] = (role, r)
        lifts.append(r)
        if role == "fire lift" and smoke:                    # the fire lift opens into the fire lobby
            m = (max(ly0, sd) + Dp) / 2
            lift_doors.append({"orient": "v", "at": sl, "from": m - 550, "to": m + 550, "side": "W"})
        else:
            cx = (r[0] + r[2]) / 2
            lift_doors.append({"orient": "h", "at": Dp, "from": cx - 550, "to": cx + 550, "side": "S"})
            fronts.append(("lift", "S", r[0], r[2]))
    W = sl + lw
    return {"parts": parts, "W": W, "D": Dp, "stair_doors": stair_doors, "lobby_door": lobby_door,
            "lift_doors": lift_doors, "fronts": fronts, "lifts": lifts, "kind": kind, "exits": exits, "sl": sl, "sd": sd,
            "smoke": smoke, "fire": fire and nl > 0, "form": form, "lobby_y": (sd, Dp) if smoke else (Dp, Dp)}


def _place(T, bx, mirror):
    """Template -> floor frame: x = bx + (x or W - x), rects, doors and front spans."""
    W = T["W"]
    fx = (lambda x: bx + W - x) if mirror else (lambda x: bx + x)

    def fr(q):
        a, b = fx(q[0]), fx(q[2])
        return [min(a, b), q[1], max(a, b), q[3]]

    def fd(d):
        d = dict(d)
        if d["orient"] == "v":
            d["at"] = fx(d["at"])
            if mirror:
                d["side"] = {"W": "E", "E": "W"}.get(d.get("side"), d.get("side"))
        else:
            a, b = fx(d["from"]), fx(d["to"])
            d["from"], d["to"] = min(a, b), max(a, b)
        return d
    return {"parts": {k: (role, fr(q)) for k, (role, q) in T["parts"].items()},
            "stair_doors": [(fx(x), y) for x, y in T["stair_doors"]],
            "lobby_door": fd(T["lobby_door"]) if T["lobby_door"] else None,
            "lift_doors": [fd(d) for d in T["lift_doors"]],
            "fronts": [(k, side, min(fx(a), fx(b)), max(fx(a), fx(b))) if side == "S"
                       else (k, ({"E": "W", "W": "E"}[side] if mirror else side), a, b) for k, side, a, b in T["fronts"]],
            "lifts": [fr(q) for q in T["lifts"]], "x0": bx, "x1": bx + W}


# ----------------------------------------------------------------------------------------------- the floor lattice
class FloorSearch:
    def __init__(self, Xh, D, req, n, seed):
        self.Xh, self.D, self.n, self.req = Xh, D, n, req
        self.Ts = {f: core_template(req, f) for f in (("wide", "stacked") if req["stair_type"] == "smoke-proof" else ("wide",))}
        xs = list(range(-Xh, Xh, M)) + [Xh]
        if xs[-1] - xs[-2] < M / 2:                          # no sliver cell at the east end
            xs.pop(-2)
        ys = list(range(0, D, M)) + [D]
        if ys[-1] - ys[-2] < M / 2:
            ys.pop(-2)
        self.xs, self.ys = np.array(xs), np.array(ys)
        self.H, self.Wc = len(ys) - 1, len(xs) - 1
        self.cw = np.diff(self.xs)[None, :] * np.diff(self.ys)[:, None] / 1e6          # cell areas, m2
        self.CORR, self.CORE = 1, n + 2
        self.flats = list(range(2, n + 2))
        self.R = HP.Rng(HP.stable_seed(f"floor:{seed}"))
        self.cands = [(f, int(self.xs[i]), m) for f, T in self.Ts.items() for i in range(self.Wc + 1)
                      if self.xs[i] + T["W"] <= self.xs[-2] and T["D"] < D - 3600 for m in (False, True)]
        # the limit less 1.2 m: the walk is measured here to the flat's nearest corridor cell, on the built plate to
        # the middle of its door (x6 floors measured 11.0 m against a 10 m limit)
        self.limit = req.get("max_travel_m", 10) * 1000 - 1200
        tot = float(self.cw.sum())
        T = self.Ts["wide"]
        self.target = (tot - T["W"] * T["D"] / 1e6 - 18.0) / n                # even share after core + corridor

    # -- helpers
    def ix(self, x):
        return int(np.searchsorted(self.xs, x - 1e-6))

    def iy(self, y):
        return int(np.searchsorted(self.ys, y - 1e-6))

    def place(self, cand):
        f, bx, mir = cand
        return _place(self.Ts[f], bx, mir), self.Ts[f]

    def put_core(self, L, cand):
        P, T = self.place(cand)
        L[0:self.iy(T["D"]), self.ix(P["x0"]):self.ix(P["x1"])] = self.CORE
        return P

    def front_cells(self, P, T, kind, side, a, b):
        """Cells in front of a span of the block's face: (rows, cols) slices."""
        depth = int(math.ceil((LIFT_HALL + 100) / M)) if kind == "lift" else 2
        jD = self.iy(T["D"])
        if side == "S":
            return slice(jD, min(self.H, jD + depth)), slice(self.ix(a), self.ix(b))
        rows = slice(self.iy(a), self.iy(b))
        if side == "E":
            i = self.ix(P["x1"])
            return rows, slice(i, min(self.Wc, i + depth))
        i = self.ix(P["x0"])
        return rows, slice(max(0, i - depth), i)

    def start(self):
        """A double-loaded start: the core on the north facade, the corridor along its fronts, the end flats full depth
        at both ends (wrapping north beside the core), the other flats in a row south of the corridor."""
        L = np.zeros((self.H, self.Wc), np.int32)
        cand = self.R.pick(self.cands)
        P = self.put_core(L, cand)
        T = self.Ts[cand[0]]
        jD = self.iy(T["D"])
        jc = min(self.H - 2, jD + int(math.ceil(1800 / M)))
        e = int(round(3900 / M))                                  # end flats about 3.9 m wide to start with
        L[jD:jc, e:self.Wc - e] = self.CORR
        for kind, side, a, b in P["fronts"]:
            if side != "S":
                rs, cs = self.front_cells(P, T, kind, side, a, b)
                rows = slice(rs.start, jD)
                blk = L[rows, cs]
                blk[blk == 0] = self.CORR
        west, east = self.flats[0], self.flats[-1]
        mids = self.flats[1:-1]
        mid_core = (self.ix(P["x0"]) + self.ix(P["x1"])) / 2
        for y in range(self.H):
            for x in range(self.Wc):
                if L[y, x]:
                    continue
                if y < jc:                                            # beside the core and the corridor: an end flat
                    L[y, x] = west if x < mid_core else east
                elif x < e:
                    L[y, x] = west
                elif x >= self.Wc - e:
                    L[y, x] = east
                else:
                    k = int((x - e) * len(mids) / max(1, self.Wc - 2 * e))
                    L[y, x] = mids[min(len(mids) - 1, k)]
        return L, cand

    def move_core(self, L, cand):
        new = self.R.pick(self.cands)
        if new == cand:
            return None
        L2 = L.copy()
        L2[L2 == self.CORE] = 0
        self.put_core(L2, new)
        hole = L2 == 0
        if hole.any():                                       # cells the core leaves go to the nearest space
            src = (L2 != 0) & (L2 != self.CORE)
            _, idx = ndimage.distance_transform_edt(~src, return_indices=True)
            L2[hole] = L2[idx[0][hole], idx[1][hole]]
        if any(not (L2 == f).any() for f in self.flats + [self.CORR]):
            return None
        return L2, new

    def walk_door(self, P, T):
        if P["lobby_door"]:
            return P["lobby_door"]
        x, y = P["stair_doors"][0]
        return {"orient": "h", "at": y, "from": x - 500, "to": x + 500}

    # -- cost
    def cost(self, L, cand, detail=False):
        P, T = self.place(cand)
        c, why = 0.0, {}
        corr = L == self.CORR
        n_c = ndimage.label(corr)[1]
        if n_c == 0:
            return float("inf")
        c += K["v"] * (n_c - 1)
        # the corridor reaches the fire lobby's door and every lift door, and is a lift lobby in front of the lifts
        miss = 0.0
        for kind, side, a, b in P["fronts"]:
            rs, cs = self.front_cells(P, T, kind, side, a, b)
            blk = corr[rs, cs]
            miss += 1 - blk.mean() if blk.size else 1
        c += K["a"] * 10 * miss
        why["fronts_missing"] = round(miss, 2)
        # 1.2 m clear everywhere: what a 1.5 m (5-cell) square cannot reach is too narrow
        k = int(math.ceil((CORR_CLEAR + 120) / M))
        thin = corr & ~ndimage.binary_opening(corr, np.ones((k, k), bool))
        c += K["v"] * float((self.cw * thin).sum())                   # a narrow corridor is not an option: per m2
        why["corridor_thin_m2"] = round(float((self.cw * thin).sum()), 2)
        ca = float((self.cw * corr).sum())
        c += K["c"] * ca
        why["corridor_m2"] = round(ca, 1)

        dist = self._walk(corr, self.walk_door(P, T))
        worst = 0.0
        pm = None
        for f in self.flats:
            m = L == f
            n_f = ndimage.label(m)[1]
            c += K["v"] * (n_f - 1)
            pm = np.pad(m, 1)
            adj = (pm[1:-1, 2:] | pm[1:-1, :-2] | pm[2:, 1:-1] | pm[:-2, 1:-1]) & corr
            along = self._run(m, corr)
            if along * M < DOOR_SPAN:
                c += K["a"] * (1 + (DOOR_SPAN - along * M) / 1000)
            north = m[0].any()
            front = float((np.diff(self.xs) * m[-1]).sum())
            need = 3600 if north else 5400
            if front < need:
                c += K["f"] * (need - front) / 1000 + (250.0 if front == 0 else 0.0)   # no sunny room at all: GB 50096 7.1.1
                if north:
                    # 2026-11-07: a flat through the block has its living room (3.3 m+) on the south face; a 2.7 m south
                    # end left it a bedroom-width strip and the flat failed every plan
                    c += K["a"] * 10 * (need - front) / 1000
            a = float((self.cw * m).sum())
            c += K["d"] * ((a - self.target) / self.target) ** 2
            if a > 1.5 * self.target:
                # 2026-11-07: no flat of twice its share (an 83 m2 flat wrapping the north side as a 3.6 m x 15 m wing
                # failed every plan, studio included)
                c += K["a"] * 10 * (a - 1.5 * self.target)
            if a < 25.5:
                c += K["v"] * (25.5 - a) / 4                     # a studio needs ~26 m2 of plan (13 m2 room, kitchen, bath, entry)
            # no sliver of the flat under 1.2 m (a corridor stopping one cell short of the facade left 0.3 m strips)
            c += K["v"] * float((self.cw * (m & ~ndimage.binary_opening(m, np.ones((4, 4), bool)))).sum())
            ys_, xs_ = np.nonzero(m)
            c += K["s"] * HP.mc(m[ys_.min():ys_.max() + 1, xs_.min():xs_.max() + 1])
            # no strip of the flat narrower than a small room (2.1 m: a kitchen or a bathroom with its door)
            # 2026-11-07: most of a flat (65 %) is at least 3.6 m across, so the living room and bedrooms fit in it squarely
            # (a 2.7 m x 11 m flat passed the 2.4 m rule and gave 2.8 m x 6 m rooms); halls and baths take the rest
            body = float((self.cw * ndimage.binary_opening(m, np.ones((12, 12), bool))).sum())
            c += 100.0 * max(0.0, 0.65 * a - body)
            # 2026-11-07: every part of a flat at least 2.4 m across (no necks, arms or appendages the rooms cannot use)
            sl_ = m & ~ndimage.binary_opening(m, np.ones((8, 8), bool))
            c += K["w"] * 75 * float((self.cw * sl_).sum())
            # not drawn out beyond a 3.8 m x 11.4 m end flat (rooms stacked front to back in a 3.6 m+ strip are square;
            # 2026-11-07: the earlier 2:1 limit and 4.5 m square pushed the end flats into L shapes with 2.4 m arms)
            bw, bh = xs_.max() - xs_.min() + 1, ys_.max() - ys_.min() + 1
            asp = max(bw, bh) / min(bw, bh)
            if asp > 3.2:
                c += K["f"] * (asp - 3.2) * 2
            t = float(dist[adj].min()) if adj.any() else float("inf")
            worst = max(worst, t)
            if t > self.limit:
                c += K["t"] * min(10.0, (t - self.limit) / 1000)
        why["travel_m"] = round(worst / 1000, 1)
        why["core"] = f"{cand[0]} at x {cand[1]}{' mirrored' if cand[2] else ''}"
        return (c, why) if detail else c

    def _run(self, m, corr):
        """Longest straight run of the flat's edge against the corridor, in cells."""
        best = 0
        for a, b in ((m[:, :-1], corr[:, 1:]), (m[:, 1:], corr[:, :-1])):
            best = max(best, _longest2(a & b, along_rows=False))
        for a, b in ((m[:-1, :], corr[1:, :]), (m[1:, :], corr[:-1, :])):
            best = max(best, _longest2(a & b, along_rows=True))
        return best

    def _walk(self, corr, door):
        """Distance (mm) along the corridor from the stair lobby's door, 4-neighbour steps through cell centres."""
        dist = np.full(corr.shape, np.inf)
        cx = (self.xs[:-1] + self.xs[1:]) / 2
        cy = (self.ys[:-1] + self.ys[1:]) / 2
        seeds = []
        if door["orient"] == "h":
            j = self.iy(door["at"])
            for jj in (j, j - 1):
                for i in range(self.ix(door["from"]), max(self.ix(door["from"]) + 1, self.ix(door["to"]))):
                    if 0 <= jj < self.H and 0 <= i < self.Wc and corr[jj, i]:
                        seeds.append((jj, i))
        else:
            i = self.ix(door["at"])
            for ii in (i, i - 1):
                for j in range(self.iy(door["from"]), max(self.iy(door["from"]) + 1, self.iy(door["to"]))):
                    if 0 <= j < self.H and 0 <= ii < self.Wc and corr[j, ii]:
                        seeds.append((j, ii))
        if not seeds:
            return dist
        from collections import deque
        q = deque()
        for y, x in seeds:
            dist[y, x] = abs(cy[y] - door["at"]) if door["orient"] == "h" else abs(cx[x] - door["at"])
            q.append((y, x))
        while q:
            y, x = q.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                v, u = y + dy, x + dx
                if 0 <= v < self.H and 0 <= u < self.Wc and corr[v, u]:
                    nd_ = dist[y, x] + abs(cx[u] - cx[x]) + abs(cy[v] - cy[y])
                    if nd_ < dist[v, u]:
                        dist[v, u] = nd_
                        q.append((v, u))
        return dist

    # -- search
    def run(self, iters=12000, beta=(0.02, 3.0)):
        L, cand = self.start()
        cur = self.cost(L, cand)
        best = (L.copy(), cand, cur)
        frozen = {self.CORE}
        for it in range(iters):
            b = beta[0] * (beta[1] / beta[0]) ** (it / iters)
            if self.R.next() < 0.04:
                mv = self.move_core(L, cand)
                if not mv:
                    continue
                L2, cand2 = mv
                c2 = self.cost(L2, cand2)
                if c2 <= cur or self.R.next() < math.exp(-b * (c2 - cur)):
                    L, cand, cur = L2, cand2, c2
            else:
                ch = HP.slide(L, self.R, frozen, SITE)
                if not ch:
                    continue
                touched = {v for _, _, v in ch}
                if any(not (L == t).any() for t in touched if t > 0):
                    for y, x, v in reversed(ch):
                        L[y, x] = v
                    continue
                c2 = self.cost(L, cand)
                if c2 <= cur or self.R.next() < math.exp(-b * (c2 - cur)):
                    cur = c2
                else:
                    for y, x, v in reversed(ch):
                        L[y, x] = v
            if cur < best[2]:
                best = (L.copy(), cand, cur)
        return best


def _longest2(e, along_rows=True):
    """Longest run of True along the rows (or the columns) of a boolean array."""
    a = e if along_rows else e.T
    if not a.any():
        return 0
    z = np.zeros((a.shape[0], 1), np.int8)
    f = np.hstack([z, a.astype(np.int8), z]).ravel()
    d = np.diff(f)
    return int((np.nonzero(d == -1)[0] - np.nonzero(d == 1)[0]).max())


def _longest(v):
    best = run = 0
    for t in v:
        run = run + 1 if t else 0
        best = max(best, run)
    return best


# ----------------------------------------------------------------------------------------------- results
def plan_floor(cfg, req, Xh, n, restarts=4, iters=12000, log=print, all_runs=False):
    """Search the floor several times; returns the best layout as a floor dict (core, corridor, flat domains), or with
    all_runs every layout, best first."""
    D = cfg["depth"]
    runs = []
    for r in range(restarts):
        S = FloorSearch(Xh, D, req, n, f"{cfg['id']}:{cfg.get('seed', 0)}:{r}")
        L, cand, c = S.run(iters)
        c, why = S.cost(L, cand, detail=True)
        why = {k: (v if isinstance(v, str) else float(v)) for k, v in why.items()}
        runs.append((c, r, S, L, cand, why))
        log(f"  floor search {r}: cost {c:.1f} {why}")
    out = []
    for c, r, S, L, cand, why in sorted(runs, key=lambda t: t[0]):
        fl = derive(S, L, cand, req, cfg)
        fl["core"]["max_travel_m"] = float(why["travel_m"])      # the search's estimate; building.py measures the doors
        out.append((fl, {"cost": round(float(c), 1), "restart": r, **why, "runs": [round(float(t[0]), 1) for t in runs]}))
    return out if all_runs else out[0]


def derive(S, L, cand, req, cfg):
    """Core dict in the floor frame (what core.build_core returns, for every later stage), corridor rectangles and one
    planner.Unit per flat (mirrored so its end facade, if any, is on the east)."""
    P, T = S.place(cand)
    rooms = {name: {"type": "CORE", "role": role, "rects": [q]} for name, (role, q) in P["parts"].items()}
    corr = room_rects(L == S.CORR, S.xs, S.ys)
    lifts = P["lifts"]
    smoke = T["smoke"]
    lob = P["parts"].get("lobby")
    lobby_m2 = ((lob[1][2] - lob[1][0] - WALL) * (lob[1][3] - lob[1][1] - WALL) / 1e6) if lob else 0.0
    lobby_short = (min(lob[1][2] - lob[1][0], lob[1][3] - lob[1][1]) - WALL) / 1000 if lob else 0.0
    core = {
        "rooms": rooms, "layout": "floor search", "x0": P["x0"], "x1": P["x1"], "width": T["W"], "depth": T["D"],
        "lobby_y": T["lobby_y"], "lifts": len(lifts), "lift_rects": lifts, "form": T["form"],
        "lift_doors": P["lift_doors"], "lobby_door": P["lobby_door"], "stair_kind": T["kind"],
        "stair_type": req["stair_type"], "exits": T["exits"], "fire_lift": T["fire"], "lobby_m2": round(lobby_m2, 1),
        "lobby_short": round(lobby_short, 2), "area_m2": round(T["W"] * T["D"] / 1e6, 1), "stair_box": (T["sl"], T["sd"]),
        "stair_doors": P["stair_doors"], "unit_doors": [], "lift_car_m": codes.LIFT_CAR[0], "mirrored": cand[2],
    }
    dist = S._walk(L == S.CORR, S.walk_door(P, T))            # walk along the corridor from the stair's lobby door
    flats = []
    for k, f in enumerate(S.flats):
        m = L == f
        ys_, xs_ = np.nonzero(m)
        mir = xs_.min() == 0 and xs_.max() < S.Wc - 1         # on the west end: plan it mirrored (end facade east)
        xs = S.xs if not mir else -S.xs[::-1]
        mm = m if not mir else m[:, ::-1]
        cc = (L == S.CORR) if not mir else (L == S.CORR)[:, ::-1]
        ys2, xs2 = np.nonzero(mm)
        i0, i1 = xs2.min(), xs2.max()
        sub = ~mm[:, i0:i1 + 1]
        cuts = [tuple(q) for q in room_rects(sub, xs[i0:i1 + 2], S.ys)]
        door = _door(mm, cc, xs, S.ys, dist if not mir else dist[:, ::-1])
        lifts_u = [_mx(q) if mir else list(q) for q in lifts]
        lifts_u = [q for q in lifts_u if q[2] >= xs[i0] - 1 and q[0] <= xs[i1 + 1] + 1]
        X, x0 = int(xs[i1 + 1]), int(xs[i0])
        U = Unit(X, S.D, x0, 0, (0, S.D), end_unit=bool(i1 == S.Wc - 1), lifts=lifts_u, x0=x0, cuts=cuts, door=door,
                 north=bool(mm[0].any()))
        U.compact = True
        front = float((np.diff(xs) * mm[-1]).sum())
        beds = 0 if (not U.north and front < 9000) else None  # one facade, south: a studio unless it is very wide
        tag = "ABCDEF"[k]
        flats.append({"tag": tag, "U": U, "beds": beds, "mirror": bool(mir), "area": round(float((S.cw * m).sum()), 1)})
    flats.sort(key=lambda d: min(q for q in [d["U"].x0 if not d["mirror"] else -d["U"].X]))
    for k, d in enumerate(flats):
        d["tag"] = "ABCDEF"[k]
    return {"core": core, "corridor": corr, "flats": flats, "labels": L.tolist(),
            "grid": [S.xs.tolist(), S.ys.tolist()]}


def _mx(q):
    return [-q[2], q[1], -q[0], q[3]]


def _door(m, corr, xs, ys, dist=None):
    """Where the flat's door goes on the corridor, as a planner.Unit door (orient, at, lo, hi): of its straight edges on
    the corridor at least 1.5 m long, the one nearest the stair's lobby along the corridor (dist, mm per corridor cell),
    cut to the 2.4 m of it nearest the lobby; without dist, the longest."""
    runs = []                                              # (length, nearest walk, (orient, at, lo, hi), cells)
    H, W = m.shape
    for i in range(W - 1):                                 # vertical edges between columns i and i+1
        for side in (0, 1):
            e = (m[:, i] & corr[:, i + 1]) if side == 0 else (m[:, i + 1] & corr[:, i])
            ci = i + 1 if side == 0 else i
            j = 0
            while j < H:
                if e[j]:
                    j0 = j
                    while j < H and e[j]:
                        j += 1
                    cells = [(jj, ci) for jj in range(j0, j)]
                    runs.append((ys[j] - ys[j0], ("v", int(xs[i + 1])), cells, [int(ys[k]) for k in range(j0, j + 1)]))
                else:
                    j += 1
    for j in range(H - 1):
        for side in (0, 1):
            e = (m[j] & corr[j + 1]) if side == 0 else (m[j + 1] & corr[j])
            cj = j + 1 if side == 0 else j
            i = 0
            while i < W:
                if e[i]:
                    i0 = i
                    while i < W and e[i]:
                        i += 1
                    cells = [(cj, ii) for ii in range(i0, i)]
                    runs.append((xs[i] - xs[i0], ("h", int(ys[j + 1])), cells, [int(xs[k]) for k in range(i0, i + 1)]))
                else:
                    i += 1
    if not runs:
        return ("v", int(xs[0]), 0, 0)
    if dist is None:
        Lr, (o, at), cells, edges = max(runs, key=lambda r: r[0])
        return (o, at, edges[0], edges[-1])
    ok = [r for r in runs if r[0] >= DOOR_SPAN] or runs
    Lr, (o, at), cells, edges = min(ok, key=lambda r: min(dist[c] for c in r[2]))
    d = [dist[c] for c in cells]
    k = int(np.argmin(d))                                    # the cell nearest the lobby; keep 2.4 m around it
    lo_i, hi_i = k, k + 1
    while edges[hi_i] - edges[lo_i] < 2400 and (lo_i > 0 or hi_i < len(edges) - 1):
        if lo_i > 0 and (hi_i >= len(edges) - 1 or d[lo_i - 1] <= d[min(hi_i, len(d) - 1)]):
            lo_i -= 1
        else:
            hi_i += 1
    return (o, at, edges[lo_i], edges[hi_i])


# ----------------------------------------------------------------------------------------------- the floor plate
def plate(flats, core, corridor, stair_fire):
    """Typical floor: flats = [(tag, plan, mirrored)] planned in their own frame; core rooms and doors in the floor
    frame; corridor = the public corridor's rectangles."""
    from highrise.compile import copy_room, mirror_item, mirror_x
    rooms = {"core." + rid: dict(rm) for rid, rm in core["rooms"].items()}
    rooms["core.corridor"] = {"type": "CORE", "role": "corridor", "rects": [list(q) for q in corridor]}
    doors, windows, ac, refuge = [], [], [], []
    for tag, plan, mir in flats:
        if plan.get("refuge_room"):
            refuge.append(f"{tag}.{plan['refuge_room']}")
        f = mirror_x if mir else (lambda r: r)
        mi = mirror_item if mir else (lambda d: dict(d))
        for rid, rm in plan["rooms"].items():
            rooms[f"{tag}.{rid}"] = copy_room(rm, f)
        doors += [dict(mi(d), side=tag) for d in plan["doors"]]
        windows += [mi(w) for w in plan["windows"]]
        ac += [mi(a) for a in plan["ac"]]
    for sx, sy in core["stair_doors"]:
        doors.append({"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "role": "stair", "swing": -1,
                      "fire": "B" if stair_fire else None})
    return {"rooms": rooms, "doors": doors, "windows": windows, "ac": ac, "corridor": [list(q) for q in corridor],
            "refuge_rooms": refuge}


def travel(fp, core, fl):
    """Longest walk from a flat door along the corridor to the stair's fire lobby door (or the stair door), m."""
    L = np.array(fl["labels"]); xs, ys = np.array(fl["grid"][0]), np.array(fl["grid"][1])
    corr = L == 1
    door = core["lobby_door"] or {"orient": "h", "at": core["stair_doors"][0][1], "from": core["stair_doors"][0][0] - 500,
                                   "to": core["stair_doors"][0][0] + 500}
    S = FloorSearch.__new__(FloorSearch)
    S.xs, S.ys, S.H, S.Wc = xs, ys, len(ys) - 1, len(xs) - 1
    dist = S._walk(corr, door)
    cx, cy = (xs[:-1] + xs[1:]) / 2, (ys[:-1] + ys[1:]) / 2
    best = 0.0
    for d in fp["doors"]:
        if d.get("role") != "unit":
            continue
        m = (d["from"] + d["to"]) / 2
        p = (d["at"], m) if d["orient"] == "v" else (m, d["at"])
        jj, ii = np.nonzero(corr)
        k = int(np.argmin(np.abs(cx[ii] - p[0]) + np.abs(cy[jj] - p[1])))
        best = max(best, dist[jj[k], ii[k]] + abs(cx[ii[k]] - p[0]) + abs(cy[jj[k]] - p[1]))
    return round(best / 1000, 1)


def ground(fp, core, D):
    """Pilotis ground floor: an entrance hall along the core's corridor front (the lifts and the fire lobby open into
    it), mailboxes, the stair's own exit north, columns under the flats' corner walls."""
    x0, x1, Dp = core["x0"], core["x1"], core["depth"]
    hall = [x0 - 1500, Dp, x1 + 1500, min(D, Dp + 3600)]
    extra = []
    ld = core.get("lobby_door")
    if ld and ld["orient"] == "v":                      # stacked core: the lobby's door is on its end, so the hall
        side = [ld["at"], core["lobby_y"][0], ld["at"] + 1500, Dp] if ld["at"] >= x1 - 1 else [ld["at"] - 1500, core["lobby_y"][0], ld["at"], Dp]
        extra.append(side)                               # reaches up beside the core to it
    mail = [hall[2] - 1800, hall[1], hall[2], hall[1] + 1200]
    door_x = (x0 + x1) / 2
    entrance = {"orient": "h", "at": hall[3], "from": door_x - 900, "to": door_x + 900, "kind": "door", "role": "entrance",
                "clear_m": 1.70}
    ramp = [door_x - 900, hall[3], door_x + 900, hall[3] + int(codes.GROUND_OFFSET / codes.RAMP_SLOPE * 1000)]
    st = core["rooms"]["stair"]["rects"][0]
    pts = set()
    for rid, rm in fp["rooms"].items():
        if rm["type"] in ("CORE", "BL", "AC"):
            continue
        for q in rm["rects"]:
            for p in ((q[0], q[1]), (q[2], q[1]), (q[0], q[3]), (q[2], q[3])):
                if not any(h[0] - 200 <= p[0] <= h[2] + 200 and h[1] - 200 <= p[1] <= h[3] + 200 for h in [hall] + extra):
                    pts.add((round(p[0] / 100) * 100, round(p[1] / 100) * 100))
    cols = []
    for p in sorted(pts):
        if all(abs(p[0] - c[0]) > 600 or abs(p[1] - c[1]) > 600 for c in cols):
            cols.append(p)
    outline = [q for rid, rm in fp["rooms"].items() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    return {"hall": hall, "hall_extra": extra, "mail": mail, "entrance": entrance, "ramp": ramp, "columns": cols,
            "stair_exit": {"orient": "h", "at": 0, "from": st[0] + 1500, "to": st[0] + 2500, "kind": "door", "role": "stair exit"},
            "pilotis_extent": [min(q[0] for q in outline), 0, max(q[2] for q in outline), D]}


def roof(core):
    """The stair head over the stair and its fire lobby, the lift machine room over the lifts beside it; a door between
    them and the stair head's door out onto the roof on its south side."""
    st = core["rooms"]["stair"]["rects"][0]
    lob = core["rooms"].get("lobby", {}).get("rects", [st])[0]
    head = [st[0], 0, st[2], max(st[3], lob[3])]
    lx = [q for q in core["lift_rects"]]
    mr = [min(q[0] for q in lx), 0, max(q[2] for q in lx), core["depth"]]
    east = mr[0] >= head[2] - 1                      # machine room east of the stair head
    at = head[2] if east else head[0]
    m = head[3] / 2
    cx = (head[0] + head[2]) / 2
    return {"stair_head": head, "machine_room": mr, "parapet_h": codes.RAILING_H, "head_h": 3000,
            "roof_door": {"orient": "v", "at": at, "from": m - 500, "to": m + 500},
            "roof_exit": {"orient": "h", "at": head[3], "from": cx - 500, "to": cx + 500},
            "sides": {"exit": "S", "head_door": "E" if east else "W", "machine_door": "W" if east else "E"}}
