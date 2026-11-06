"""Stage 3 on a lattice: the house planner's search (pipeline/planner.py, Merrell et al. 2010 §5) for one dwelling.

The houses are planned as a label grid over the lot, searched with the paper's moves: slide a wall (split it at a
random point, preferring existing vertices, move one part by d ~ N(0, σ²) cells, snap to a parallel wall within one
cell) and swap two rooms, under Metropolis with a geometric annealing schedule. The dwelling of a high-rise floor is
planned the same way here, with the same move functions (planner.slide, planner.swap):

    lot       the dwelling domain [0, X] × [0, D] minus the core notch [0, wn] × [0, dc] (planner.Unit), as a grid on
              the 300 mm module (GB/T 50002 3M) whose lines also pass through the core, lobby and lift edges
    start     the banded layout of planner.initial, rasterised onto the grid (the houses start from rows the same way)
    state     one label per cell; a room is the set of its cells and may become L-shaped, T-shaped or a wing
    cost      the high-rise cost of planner.cost on the rooms' rectangles (code minimum areas, daylight, the unit door
              on the lobby, no bedroom on a lift shaft, south-facing rooms, through ventilation, windowed bathrooms,
              dining open to living, circulation share, access preferences), plus the two house terms a free-form
              room needs: Merrell's shape measure M_c(S) = (A(H(S)) − A(S)) / A(S) + (e(S) − 4) (k_s) and a room in one
              piece (k_v, as the houses' v term), the houses' clear-width test (CLEAR_W: a living room 2.4 m, a
              dining room 2.6 m for its table, bedrooms 2.4 / 2.1 m, kitchen 1.8 m; k_w); and the banded search's zones (planner.BAND_OK, from the traced
              references) as a soft facade rule (k_z): living room and master bedroom on the south face, kitchen and
              bathrooms off it
A move may shrink a room, never delete it (as in the houses). The result is the rooms' rectangles in the planner's
dwelling frame (x = 0 on the core's centre line, y = 0 at the north face), so compile_unit, the scorecard, walls,
furniture, FreeCAD and the drawings use it unchanged.
"""
import importlib.util
import math
import os

import numpy as np
from scipy import ndimage

from highrise.planner import BAND_OK, cost, exterior, initial, rects_of

_PIPE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "pipeline", "planner.py"))
_spec = importlib.util.spec_from_file_location("house_planner", _PIPE)
HP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(HP)

MOD = 300                       # grid module, mm
K_S, K_V = 2.0, 1000.0          # shape (Merrell M_c) and one-piece weights
K_Z = 30.0                      # zoning: the bands of planner.BAND_OK (from the traced references) as soft facade rules
# clear width, as the houses' CLEAR_W test (pipeline/planner.py): the room's cells, eroded by a square of the width plus
# a wall, must not vanish. Dining: the 1.6 × 1.8 m table with chairs and 0.6 m around it (furnish2, dining_table)
CLEAR_W = {"LR": 2.4, "DR": 2.6, "BRM": 2.4, "BR": 2.1, "ST": 1.8, "KT": 1.8}
K_W = 100.0
SITE = {"carve": False}         # the dwelling fills its domain: walls on the domain edge never move


def grid_lines(U):
    """Grid lines through every edge the plan must respect, filled in at about MOD (multiples of 100 mm)."""
    def fill(req, hi):
        req = sorted({int(v) for v in req if 0 <= v <= hi})
        out = [req[0]]
        for a, b in zip(req, req[1:]):
            n = max(1, int(round((b - a) / MOD)))
            for i in range(1, n):
                v = a + int(round((b - a) * i / n / 100.0)) * 100
                if out[-1] < v < b:
                    out.append(v)
            out.append(b)
        return out
    xs = fill({0, U.wn, U.X} | {v for l in U.lifts for v in (l[0], l[2])}, U.X)
    ys = fill({0, U.dc, U.D} | set(U.lobby_y) | {v for l in U.lifts for v in (l[1], l[3])}, U.D)
    return np.array(xs), np.array(ys)


def rasterise(R, rooms, xs, ys, U):
    """Labels from rectangles: -1 outside the dwelling (the core notch), k = 1 + index of the room at the cell centre."""
    cx, cy = (xs[:-1] + xs[1:]) / 2, (ys[:-1] + ys[1:]) / 2
    L = np.zeros((len(cy), len(cx)), np.int32)
    L[np.ix_(cy < U.dc, cx < U.wn)] = -1
    for k, rid in enumerate(rooms, 1):
        for x0, y0, x1, y1 in R[rid]:
            L[np.ix_((cy > y0) & (cy < y1), (cx > x0) & (cx < x1))] = k
    for _ in range(100):                                  # cells no rectangle covered take a neighbour's room
        hole = L == 0
        if not hole.any():
            break
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = np.roll(L, (dy, dx), (0, 1))
            f = hole & (nb > 0)
            L[f] = nb[f]
            hole = L == 0
    return L


def room_rects(m, xs, ys):
    """Cells of one room -> rectangles in mm (greedy: widest run from the top-left cell, grown downwards)."""
    m = m.copy()
    out = []
    while m.any():
        ys_, xs_ = np.nonzero(m)
        y0, x0 = ys_[0], xs_[0]
        x1 = x0
        while x1 + 1 < m.shape[1] and m[y0, x1 + 1]:
            x1 += 1
        y1 = y0
        while y1 + 1 < m.shape[0] and m[y1 + 1, x0:x1 + 1].all():
            y1 += 1
        m[y0:y1 + 1, x0:x1 + 1] = False
        out.append([int(xs[x0]), int(ys[y0]), int(xs[x1 + 1]), int(ys[y1 + 1])])
    out.sort(key=lambda q: -(q[2] - q[0]) * (q[3] - q[1]))
    return out


def zoning(R, T, U):
    """The banded search kept each room in the bands the references put it in (planner.BAND_OK); on the lattice that
    becomes a facade rule. A south-band-only room (living room, master bedroom) needs 2 m of south facade; a room the
    references never put in the south band (kitchen, bathrooms, entry, hall, dining, cloakroom, store) takes none of it."""
    ext = exterior(R, U)
    z = 0.0
    for rid, t in T.items():
        ok = BAND_OK.get(t, "NMS")
        if ok == "S" and ext[rid]["S"] < 2000:
            z += 1.0
        elif "S" not in ok and ext[rid]["S"] > 0:
            z += 0.5 + ext[rid]["S"] / 1000.0
    return z


class State:
    """Labels plus a per-room cache of rectangles and shape terms (only the rooms a move touches are recomputed)."""

    def __init__(self, L, rooms, T, U, xs, ys):
        self.L, self.rooms, self.T, self.U, self.xs, self.ys = L, rooms, T, U, xs, ys
        self.R, self.shape = {}, {}
        for k in range(1, len(rooms) + 1):
            self.update(k)

    def update(self, k):
        rid = self.rooms[k - 1]
        m = self.L == k
        if not m.any():
            self.R[rid], self.shape[rid] = [], (0.0, 0)
            return
        rs = room_rects(m, self.xs, self.ys)
        if self.T[rid] == "EN":                           # the rectangle on the lobby first (the unit door goes there)
            ly = self.U.lobby_y
            rs.sort(key=lambda q: not (q[0] == self.U.wn and min(q[3], ly[1]) - max(q[1], ly[0]) > 0))
        self.R[rid] = rs
        yy, xx = np.nonzero(m)
        crop = m[yy.min():yy.max() + 1, xx.min():xx.max() + 1]
        pieces = ndimage.label(m)[1] - 1
        w = CLEAR_W.get(self.T[rid])
        if w:
            k = int(math.ceil((w + 0.15) * 1000 / MOD - 1e-9))
            if not ndimage.binary_erosion(np.pad(m, 1), np.ones((k, k), bool)).any():
                pieces += K_W / K_V                          # counted with the one-piece term: K_V * (K_W / K_V) = K_W
        self.shape[rid] = (HP.mc(crop), pieces)

    def evaluate(self, targets, want_south):
        if any(not rs for rs in self.R.values()):
            return float("inf")
        c = cost({"R": self.R}, self.U, self.T, targets, want_south)
        return (c + K_S * sum(s for s, _ in self.shape.values()) + K_V * sum(p for _, p in self.shape.values())
                + K_Z * zoning(self.R, self.T, self.U))


def optimise(prog, U, targets, want_south, seed, iters=6000, beta0=0.05, beta1=4.0):
    """Same signature and result shape as planner.optimise: (state, cost); state carries the rooms' rectangles."""
    import random
    rng = random.Random(seed)
    T = dict(prog)
    rooms = [rid for rid, _ in prog]
    xs, ys = grid_lines(U)
    st0 = initial(prog, U, rng, targets)
    L = rasterise(rects_of(st0, U), rooms, xs, ys, U)
    S = State(L, rooms, T, U, xs, ys)
    R = HP.Rng(HP.stable_seed(f"hr:{seed}"))
    ids = list(range(len(rooms)))
    c = S.evaluate(targets, want_south)
    best = ({k: [list(q) for q in v] for k, v in S.R.items()}, L.copy(), c)
    for it in range(iters):
        b = beta0 * (beta1 / beta0) ** (it / iters)       # geometric annealing, as planner.optimise
        ch = HP.slide(L, R, set(), SITE) if R.next() < 0.82 else HP.swap(L, ids, R)
        if not ch:
            continue
        touched = {v for _, _, v in ch} | {int(L[y, x]) for y, x, _ in ch}
        # a move may shrink a room, never delete it (as in the houses); and a dwelling has no yard: a wall running
        # along the core notch must not hand cells to "unbuilt" (label 0), which the house move does on a lot edge
        if 0 in touched or any(not (L == k).any() for k in touched if k > 0):
            for y, x, v in reversed(ch):
                L[y, x] = v
            continue
        touched = {k for k in touched if k > 0}
        saved = {k: (S.R[rooms[k - 1]], S.shape[rooms[k - 1]]) for k in touched}
        for k in touched:
            S.update(k)
        c2 = S.evaluate(targets, want_south)
        if c2 <= c or R.next() < math.exp(-b * (c2 - c)):
            c = c2
            if c < best[2]:
                best = ({k: [list(q) for q in v] for k, v in S.R.items()}, L.copy(), c)
        else:
            for y, x, v in reversed(ch):
                L[y, x] = v
            for k, (rs, sh) in saved.items():
                S.R[rooms[k - 1]], S.shape[rooms[k - 1]] = rs, sh
    return {"R": best[0], "labels": best[1].tolist(), "grid": [xs.tolist(), ys.tolist()], "planner": "lattice"}, best[2]
