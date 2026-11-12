"""Modular floors and flats for 4 and 6 dwellings a floor (2026-11-11).

Leon, 2026-11-11: "do not elongate the designs", "make it modular for a realistic interior design using algorithms";
he chose modules at both levels and let the footprint follow the modules.

Two levels, both on the 300 mm (3M) grid:

  flat modules   rectangles from a small catalogue, assembled round the core as Chinese slab floors are: the core on
                 the north face, a straight corridor in front of it from gable to gable (a window at each end), a row
                 of flats on the south face, and a corner flat in each pocket beside the core (north and gable
                 windows; its sun comes over the gable, checked per flat by facade.sun_study). `floor()` enumerates
                 the catalogue and keeps the assembly nearest the 2-flat slab's floor area whose flats all stay
                 within the reference flats' proportions (frontage : depth <= 1.8, refs/: mean 1.13, largest 1.61).

  room modules   every room is a rectangle. `pack()` cuts the flat's rectangle with a slicing tree (guillotine cuts on
                 the grid, each cut placed by the rooms' target areas), keeping only rooms inside their module range:
                 the minimum side and the largest aspect ratio the reference plans show for the type, a daylit wall
                 where the code asks for one, the entry on the flat door. Candidates are ranked by Merrell's C_d
                 (area and aspect log-likelihood against the reference distributions) and then scored by the same
                 planner.cost and gate as every other flat.
"""
import itertools
import math

import numpy as np

from highrise import floorplan
from highrise.analyze import aspect_model
from highrise.codes import DAYLIT

M = 300
CORRIDOR = 1800                      # 1.5 m clear + walls (GB 55038 4.2.4, wheelchair turning circle)
FLAT_ASPECT_MAX = 1.8
# flat modules: frontage (mm) -> bedrooms. South-face flats light every daylit room from one face, so each bedroom
# adds a bay: studio = living 3.6 + kitchen 2.4+; one bedroom = + 2.7..3.0; two bedrooms = + 2.7 again
SOUTH = {6000: 0, 6600: 0, 7200: 0, 8400: 1, 9000: 1, 11400: 2, 12000: 2}
SOUTH_DEPTH = (4800, 5400, 6000, 6600)
# corner flats are as deep as the core; lit from the north and the gable
CORNER = {4800: 0, 5400: 0, 6000: 0, 7800: 1, 8400: 1, 9000: 1}

MIN_SIDE = {"EN": 1200, "HL": 1200, "BA": 1500, "BAM": 1500, "KT": 1800, "LR": 3000, "DR": 2400, "BRM": 3000,
            "BR": 2400, "ST": 2100, "CL": 1200, "SR": 1200, "NA": 1200}
ASPECT_CAP = {"EN": 3.0, "HL": 6.0}


def floor(cfg, req, area_goal, log=print):
    """Pick the flat modules for cfg["dwellings"] flats and lay the floor out -> (floor dict as floorplan.derive
    returns, info). area_goal: the 2-flat slab's floor area (m2) the assembly should stay near."""
    n = int(cfg["dwellings"])
    T = floorplan.core_template(req, "wide")
    cw, cd = T["W"], T["D"]
    opts = []
    ns = n - 2
    for widths in itertools.product(sorted(SOUTH), repeat=(ns + 1) // 2):
        row = list(widths) + list(reversed(widths[: ns // 2]))          # symmetric about the middle
        L = sum(row)
        wc = (L - cw) / 2
        if wc not in CORNER:
            continue
        for ds in SOUTH_DEPTH:
            asp = [max(w, ds) / min(w, ds) for w in row] + [max(wc, cd) / min(wc, cd)]
            if max(asp) > FLAT_ASPECT_MAX + 1e-9:
                continue
            D = cd + CORRIDOR + ds
            area = L * D / 1e6
            beds = sum(SOUTH[w] for w in row) + 2 * CORNER[wc]
            # near the 2-flat slab's area; then squarer flats; then more bedrooms
            key = (round(abs(area - area_goal) / area_goal, 2), round(sum(math.log(a) ** 2 for a in asp), 3), -beds)
            opts.append((key, row, int(wc), ds, L, D))
    if not opts:
        raise ValueError(f"no modular floor for {n} flats")
    opts.sort(key=lambda t: t[0])
    lim = req.get("max_travel_m", 10) - 0.9          # measured here to the corridor cell, on the plate to the door
    pick = None
    for key, row, wc, ds, L, D in opts:
        got = _lay(cfg, req, n, row, wc, ds, L, D, cw, cd)
        if pick is None or got[2]["travel_m"] < pick[0][2]["travel_m"]:
            pick = (got, row, wc, ds, L, D)
        if got[2]["travel_m"] <= lim:
            pick = (got, row, wc, ds, L, D)
            break
    (S, Lb, why, cand), row, wc, ds, L, D = pick
    Xh = L // 2
    fl = floorplan.derive(S, Lb, cand, req, dict(cfg, depth=D))
    fl["core"]["max_travel_m"] = float(why["travel_m"])
    for f in fl["flats"]:
        U = f["U"]
        U.rect = free_rect(U)
        w = U.rect[2] - U.rect[0]
        f["beds"] = CORNER[w] if U.north else SOUTH[w]
        f["module"] = f"{'corner' if U.north else 'south'} {w / 1000:.1f} x {(U.rect[3] - U.rect[1]) / 1000:.1f} m"
    info = {"modules": [f["module"] for f in fl["flats"]], "length_m": L / 1000, "depth_m": D / 1000,
            "area_m2": round(L * D / 1e6, 1), "area_goal_m2": round(area_goal, 1), "travel_m": why["travel_m"],
            "corridor_m2": why.get("corridor_m2"), "core": why.get("core"), "cost": 0.0}
    log(f"  modular floor: {info['modules']} · {L / 1000:.1f} x {D / 1000:.1f} m")
    return fl, info, Xh, D


def _lay(cfg, req, n, row, wc, ds, L, D, cw, cd):
    """The label grid of one assembly, with the core mirrored whichever way walks less -> (S, labels, why, cand)."""
    Xh = L // 2
    S = floorplan.FloorSearch(Xh, D, req, n, f"modular:{cfg['id']}")
    out = None
    # the core slides along the north face as far as both pockets stay corner modules, and may be mirrored: the
    # position with the shortest walk from the farthest flat door to the stair's lobby
    offs = [o for o in range(-3000, 3001, M) if (Xh - cw // 2 + o) in CORNER and (Xh - cw // 2 - o) in CORNER]
    for mir, off in itertools.product((False, True), offs):
        cand = ("wide", -cw // 2 + off, mir)
        Lb = np.zeros((S.H, S.Wc), np.int32)
        S.put_core(Lb, cand)
        jd, jc = S.iy(cd), S.iy(cd + CORRIDOR)
        Lb[jd:jc, :] = S.CORR
        i0, i1 = S.ix(-cw // 2 + off), S.ix(cw // 2 + off)
        Lb[:jd, :i0] = S.flats[0]
        Lb[:jd, i1:] = S.flats[-1]
        x = -Xh
        for k, w in enumerate(row):
            Lb[jc:, S.ix(x):S.ix(x + w)] = S.flats[1 + k]
            x += w
        c, why = S.cost(Lb, cand, detail=True)
        # the core stays centred (equal corner flats) unless the walk then breaks the limit
        ok = why["travel_m"] <= req.get("max_travel_m", 10) - 0.9
        key2 = (0, abs(off), why["travel_m"]) if ok else (1, why["travel_m"], abs(off))
        if out is None or key2 < out[3]:
            out = (Lb, cand, why, key2)
    Lb, cand, why, _ = out
    return S, Lb, why, cand


def free_rect(U):
    """The flat's rectangle: its domain less the cut-outs (a flat module is always one rectangle)."""
    from shapely.geometry import box
    from shapely.ops import unary_union
    g = box(U.x0, 0, U.X, U.D).difference(unary_union([box(*c) for c in U.cuts]) if U.cuts else box(0, 0, 0, 0))
    x0, y0, x1, y1 = (int(round(v)) for v in g.bounds)
    assert abs(g.area - (x1 - x0) * (y1 - y0)) < 1, "a flat module is a rectangle"
    return (x0, y0, x1, y1)


# ------------------------------------------------------------------------------------------------ room modules
def _leaf_ok(t, q, U, rect):
    w, h = q[2] - q[0], q[3] - q[1]
    if min(w, h) < MIN_SIDE.get(t, 1200):
        return False
    cap = ASPECT_CAP.get(t) or aspect_model().get(t, (0, 0, 3.0))[2]
    if max(w, h) / min(w, h) > cap + 1e-9:
        return False
    if t in DAYLIT:                                  # a wall on a lit face of the flat, 1.2 m at least
        lit = (q[1] == 0 and w >= 1200) or (q[3] == U.D and w >= 1200) or (U.end and q[2] == U.X and h >= 1200)
        if not lit:
            return False
    if t == "EN" and (U.door_overlap(q) < 1200 or U.door_depth(q) < 1200):
        return False
    return True


def _leaf_cost(t, q, target):
    w, h = q[2] - q[0], q[3] - q[1]
    mu, sd, _ = aspect_model().get(t, (1.5, 0.4, 3.0))
    a = w * h / 1e6
    c = 0.5 * ((math.log(max(w, h) / min(w, h)) - math.log(mu)) / sd) ** 2
    return c + 0.5 * ((a - target) / (0.25 * target)) ** 2


def pack(prog, U, targets, want_south, keep=12, beam=48, evals=1500):
    """Slicing-tree packing of the programme's rooms into the flat's rectangle -> [(st, cost)] best first, at most
    `keep`, every one with planner.cost C_a = 0 when any exists."""
    from highrise import planner as HRP
    rect = getattr(U, "rect", None) or free_rect(U)
    T = dict(prog)
    area = (rect[2] - rect[0]) * (rect[3] - rect[1]) / 1e6
    tot = sum(targets[r][0] for r, _ in prog)
    tgt = {r: targets[r][0] * area / tot for r, _ in prog}          # the rooms fill the flat
    memo = {}

    def solve(ids, q):
        key = (ids, q)
        if key in memo:
            return memo[key]
        out = []
        if len(ids) == 1:
            r = ids[0]
            if _leaf_ok(T[r], q, U, rect):
                out = [(_leaf_cost(T[r], q, tgt[r]), {r: q})]
        else:
            w, h = q[2] - q[0], q[3] - q[1]
            need = max(MIN_SIDE.get(T[r], 1200) for r in ids)
            if min(w, h) >= min(MIN_SIDE.get(T[r], 1200) for r in ids) and max(w, h) >= need:
                first, rest = ids[0], ids[1:]
                asum = sum(tgt[r] for r in ids)
                for k in range(0, len(rest)):
                    for sub in itertools.combinations(rest, k):
                        A = (first,) + sub
                        B = tuple(r for r in rest if r not in sub)
                        if not B:
                            continue
                        fa = sum(tgt[r] for r in A) / asum
                        for vert in (True, False):
                            span = w if vert else h
                            base = int(round(span * fa / M)) * M
                            for cut in (base, base - M, base + M):
                                if cut < 1200 or span - cut < 1200:
                                    continue
                                for a_first in (True, False):
                                    c1 = cut if a_first else span - cut
                                    if vert:
                                        qa = (q[0], q[1], q[0] + c1, q[3]); qb = (q[0] + c1, q[1], q[2], q[3])
                                    else:
                                        qa = (q[0], q[1], q[2], q[1] + c1); qb = (q[0], q[1] + c1, q[2], q[3])
                                    if not a_first:
                                        qa, qb = qb, qa
                                    la = solve(A, qa)
                                    if not la:
                                        continue
                                    lb = solve(B, qb)
                                    for ca, ra in la:
                                        for cb, rb in lb:
                                            out.append((ca + cb, {**ra, **rb}))
                out.sort(key=lambda t: t[0])
                seen, uniq = set(), []
                for c, r in out:
                    kk = tuple(sorted(r.items()))
                    if kk not in seen:
                        seen.add(kk); uniq.append((c, r))
                    if len(uniq) >= (beam if len(ids) < len(prog) else evals):
                        break
                out = uniq
        memo[key] = out
        return out

    ids = tuple(r for r, _ in prog)
    cands = solve(ids, rect)
    scored = []
    for cd_, R in cands:
        st = {"R": {r: [tuple(q)] for r, q in R.items()}}
        c, det = HRP.cost(st, U, T, targets, want_south, detail=True)
        scored.append((det["Ca"], c + cd_, st))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [(st, c) for _, c, st in scored[:keep]]
