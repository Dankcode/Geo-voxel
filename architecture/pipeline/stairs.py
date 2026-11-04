"""Stairs shaped by the stair space (Merrell et al. 2010 §6): straight run, U (two flights, half landing) or L
(quarter landing), with the AIA Architectural Graphic Standards limits the paper quotes and Blondel's step rule.

    risers     N = ⌈H / R_max⌉,          R = H / N ≤ R_max = 210 mm  (8¼ in)
    tread      T = clamp(630 − 2R, 229, 279) mm                      (Blondel 2R + T ≈ 630 mm; 9–11 in)
    width      W ≥ 914 mm (36 in); landings at least W deep
    straight   needs  L_long ≥ (N − 1)·T + W  and  L_short ≥ W
    U          needs  L_short ≥ 2W + g        and  L_long ≥ (⌈N/2⌉ − 1)·T + W        (g = 50 mm well)
    L          needs  L_a ≥ n₁·T + W  and  L_b ≥ n₂·T + W   with  n₁ + n₂ = N − 1

The first form that fits wins, in the order the paper describes (straight → U → L); if none fits the space is
reported as too small and the most compact stair (U with R_max and minimum tread) is built and flagged.
All boxes are (x0, y0, z0, x1, y1, z1) in mm in the plan frame.
"""
import math

R_MAX, T_MIN, T_MAX, W_MIN, WELL = 210.0, 229.0, 279.0, 914.0, 50.0


def stair_design(x0, y0, x1, y1, H):
    Lx, Ly = x1 - x0, y1 - y0
    N = math.ceil(H / R_MAX); R = H / N
    T = min(T_MAX, max(T_MIN, 630.0 - 2 * R))
    along_y = Ly >= Lx
    L_long, L_short = (Ly, Lx) if along_y else (Lx, Ly)
    W = max(W_MIN, min(1100.0, L_short))
    d = dict(N=N, R=round(R, 1), T=round(T, 1), blondel=round(2 * R + T, 1), along_y=along_y, space=(round(Lx), round(Ly)))
    if L_long >= (N - 1) * T + W_MIN and L_short >= W_MIN:
        return dict(d, form="straight", W=min(W, L_short))
    n1 = math.ceil(N / 2)
    Wu = min(1100.0, (L_short - WELL) / 2, L_long - (n1 - 1) * T)       # flights as wide as both sides allow
    if Wu >= W_MIN:
        return dict(d, form="U", W=Wu)
    # L: first flight along the long side, second along the short side
    for n1 in range(N - 1, 0, -1):
        n2 = N - 1 - n1
        if L_long >= n1 * T + W_MIN and L_short >= n2 * T + W_MIN:
            return dict(d, form="L", W=W_MIN, n1=n1, n2=n2)
    # too small: steepest legal U, flagged
    T2 = T_MIN; Wu = max(700.0, (L_short - WELL) / 2)
    return dict(d, form="U", W=Wu, T=T2, blondel=round(2 * R + T2, 1), too_small=True)


def stair_boxes(x0, y0, x1, y1, z0, H, inset=60, rev=False):
    """Geometry for one storey's stair inside the stair room: steps, landing(s), balustrade. Returns (design, parts).
    rev (2026-11-02): the flight climbs from the high end of the room to the low end instead (mirrored along its long
    axis), so the foot and head can face the rooms that reach them (choose_rev)."""
    X0, Y0, X1, Y1 = x0 + inset, y0 + inset, x1 - inset, y1 - inset
    D = stair_design(X0, Y0, X1, Y1, H)
    N, R, T, W = D["N"], H / D["N"], D["T"], D["W"]
    parts = []
    ay = D["along_y"]

    def box(a0, a1, b0, b1, zlo, zhi, role="step"):
        # a = along the long axis, b = across it
        if rev: a0, a1 = A0 + A1 - a1, A0 + A1 - a0
        if ay: parts.append((role, (b0, a0, zlo, b1, a1, zhi)))
        else: parts.append((role, (a0, b0, zlo, a1, b1, zhi)))

    A0, A1 = (Y0, Y1) if ay else (X0, X1)
    B0, B1 = (X0, X1) if ay else (Y0, Y1)
    if D["form"] == "straight":
        for i in range(N - 1):
            box(A0 + i * T, A0 + (i + 1) * T, B0, B0 + W, z0, z0 + (i + 1) * R)
        # straight run: the floor above is the top landing (revision 2026-10-30: no separate landing box under its slab)
        box(A0, A0 + (N - 1) * T, B0 + W, B0 + W + 40, z0 + H - 150, z0 + H + 900, "rail")
    elif D["form"] == "U":
        n1 = math.ceil(N / 2); n2 = N - n1
        for i in range(n1 - 1):                       # first flight up the long side
            box(A0 + i * T, A0 + (i + 1) * T, B0, B0 + W, z0, z0 + (i + 1) * R)
        zl = z0 + n1 * R
        box(A1 - W, A1, B0, B1, zl - 150, zl, "landing")                       # half landing across the end
        for j in range(n2 - 1):                       # second flight back down the other side
            a1_ = A1 - W - j * T
            box(a1_ - T, a1_, B1 - W, B1, z0, zl + (j + 1) * R)
        box(A0, A1 - W, B0 + W + 5, B0 + W + WELL - 5, zl - 1000, zl + 900, "rail")   # balustrade in the well
    else:  # L
        n1, n2 = D["n1"], D["n2"]
        for i in range(n1):
            box(A0 + i * T, A0 + (i + 1) * T, B0, B0 + W, z0, z0 + (i + 1) * R)
        zl = z0 + (n1 + 1) * R
        box(A0 + n1 * T, A0 + n1 * T + W, B0, B0 + W, zl - 150, zl, "landing")          # quarter landing
        for j in range(n2):
            b = B0 + W + j * T
            box(A0 + n1 * T, A0 + n1 * T + W, b, b + T, z0, zl + (j + 1) * R)
        box(A0, A0 + n1 * T, B0 + W, B0 + W + 40, zl - 1000, zl + 900, "rail")
    # slab opening on the floor above (only over the flights; the arrival zone keeps its floor) and the banister
    # around it on every side people could fall from (Merrell §6: banister where floor levels differ)
    zt = z0 + H
    def rect(a0, a1, b0, b1):
        if rev: a0, a1 = A0 + A1 - a1, A0 + A1 - a0
        return (b0, a0, b1, a1) if ay else (a0, b0, a1, b1)
    if D["form"] == "straight":
        hole = [rect(A0, A0 + (N - 1) * T, B0, B0 + W)]
        rails = [(A0, A0 + (N - 1) * T, B0 + W, B0 + W + 40), (A0, A0 + 40, B0, B0 + W)]
    elif D["form"] == "U":
        n1 = math.ceil(N / 2); n2 = N - n1
        a_arr = A1 - W - (n2 - 1) * T
        hole = [rect(a_arr, A1, B0, B1)]
        rails = [(a_arr, a_arr + 40, B0, B0 + W + WELL)]                         # along the first-flight side only
    else:
        n1, n2 = D["n1"], D["n2"]
        hole = [rect(A0, A0 + n1 * T + W, B0, B0 + W), rect(A0 + n1 * T, A0 + n1 * T + W, B0 + W, B0 + W + n2 * T)]
        rails = [(A0, A0 + n1 * T, B0 + W, B0 + W + 40)]
    for a0_, a1_, b0_, b1_ in rails:
        box(a0_, a1_, b0_, b1_, zt, zt + 1000, "banister")
    D["hole"] = hole
    D["W"] = round(W); D["T"] = round(T, 1); D["rev"] = bool(rev)
    return D, parts


def well_railing(x0, y0, x1, y1, z_floor, arrival_side, t=40, h=1000):
    """Merrell §6: where floor levels differ, a banister replaces the wall. Rails on the three non-arrival sides of
    the slab opening above a stair (arrival_side: 'x0'|'x1'|'y0'|'y1')."""
    R = []
    if arrival_side != "y0": R.append(("rail", (x0, y0, z_floor, x1, y0 + t, z_floor + h)))
    if arrival_side != "y1": R.append(("rail", (x0, y1 - t, z_floor, x1, y1, z_floor + h)))
    if arrival_side != "x0": R.append(("rail", (x0, y0, z_floor, x0 + t, y1, z_floor + h)))
    if arrival_side != "x1": R.append(("rail", (x1 - t, y0, z_floor, x1, y1, z_floor + h)))
    return R


# ---------------------------------------------------------------------------------------------- stair access (2026-11-02)
# IRC R311.7.6: a landing at the top and bottom of every stair, at least as wide as the stair and 36 in (914 mm) deep in
# the direction of travel. Merrell 2010 §6 lays the steps out from the stair space's shape but says nothing about which
# end is the foot; our builder always climbed from the low-coordinate end, so 13 of 15 flights had their foot against a
# wall (2026-10-31 competition). The foot and head now face rooms that reach them.
STAIR_OK = {"hall", "foyer", "landing", "corridor", "lobby", "living", "dining", "family", "kitchen"}


def stair_cells(plan, rev, cell_m=None):
    """Cell strips (lists of (row, col)) for a flight in grid cells: foot strip on the lower floor, and the head exits on
    the upper floor (end strip and the two side strips of the arrival zone). Straight flights only (others: None)."""
    if not plan.get("stair"): return None
    c = (cell_m or plan["cell"]) * 1000; x0, y0, w, h = plan["stair"]
    D = stair_design(x0 * c + 60, y0 * c + 60, (x0 + w) * c - 60, (y0 + h) * c - 60, 2900)
    if D["form"] != "straight": return None
    ay = D["along_y"]
    n_along = h if ay else w
    hole_cells = min(n_along - 1, int(math.ceil(((D["N"] - 1) * D["T"] + 60) / c)))
    arr = list(range(hole_cells, n_along))                       # arrival zone, as offsets along the run from the foot end
    def cellat(a, b):                                            # a = offset along from the foot end, b = offset across
        a_ = (n_along - 1 - a) if rev else a
        return (y0 + a_, x0 + b) if ay else (y0 + b, x0 + a_)
    n_across = w if ay else h
    # 2026-11-02 (round 2): the landing is 914 mm deep (IRC R311.7.6): the strips reach that far, not one cell
    dep = max(1, int(math.ceil(0.9 / (c / 1000) - 1e-9)))
    foot = [cellat(-d, b) for d in range(1, dep + 1) for b in range(n_across)]
    end = [cellat(n_along - 1 + d, b) for d in range(1, dep + 1) for b in range(n_across)]
    side0 = [cellat(a, -d) for a in arr for d in range(1, dep)]; side1 = [cellat(a, n_across - 1 + d) for a in arr for d in range(1, dep)]
    return dict(foot=foot, exits=[end, side0, side1], D=D)


def strip_ok(L, rooms, cells, need=0.6):
    H, W = L.shape; good = 0
    for (i, j) in cells:
        if 0 <= i < H and 0 <= j < W and L[i, j] > 0:
            r = rooms[L[i, j] - 1]
            if r["kind"] in STAIR_OK and not r.get("stair") and not r.get("open_air"): good += 1
    return len(cells) > 0 and good / len(cells) >= need


def access_cost(plan_like, labels, rooms, rev):
    """0, 1 or 2: how many of foot / head lack a reachable landing for this climbing direction."""
    sc = stair_cells(plan_like, rev)
    if sc is None or len(labels) < 2: return 0
    import numpy as np
    L0, L1 = np.asarray(labels[0]), np.asarray(labels[1])
    return (not strip_ok(L0, rooms, sc["foot"])) + (not any(strip_ok(L1, rooms, e) for e in sc["exits"]))


def choose_rev(plan):
    """The climbing direction whose foot and head are reached from a circulation or living room (ties: as built)."""
    if not plan.get("stair") or len(plan.get("labels", [])) < 2: return False
    rooms = plan["program"]["rooms"]
    c0 = access_cost(plan, plan["labels"], rooms, False); c1 = access_cost(plan, plan["labels"], rooms, True)
    return c1 < c0


def ensure_rev(plan):
    if "stair_rev" not in plan: plan["stair_rev"] = choose_rev(plan)
    return plan["stair_rev"]
