"""Merrell, Schkufza & Koltun (2010) floor-plan optimisation on a fine lattice, with the map footprint as the lot.

Per storey a label grid over the lot: -1 outside the lot, 0 unbuilt (yard: the outline may retreat from the map
footprint, as the paper lets the outline change inside the lot F0), k ≥ 1 room k-1. Walls are the boundaries
between labels (no cells are spent on walls; the BIM stage gives them thickness).

Moves (§5.1): slide a wall (split at a random point, move one part by d ~ N(0, σ²)) — a wall on the lot edge can only
move inwards, which carves the outline; swap two rooms; move the stair (pinned on every storey).
Cost (§5.2 + map terms): accessibility, dimensions, shape (+ outline irregularity, k_o), floors (upper ⊆ lower),
footprint fidelity to the map, daylight, privacy, wet stacking.
"""
import math
import numpy as np
from scipy import ndimage

DIRS = [(0, -1), (1, 0), (0, 1), (-1, 0)]          # (du, dv): 0 front (-v), 1 +u, 2 back (+v), 3 -u
W8 = dict(a=100.0, d=1.5, s=3.0, o=0.4, f=12.0, fp=25.0, l=40.0, p=2.0, wet=1.5, v=1000.0, al=8.0)
# 2026-11-02 paper revision: C = k_a C_a + k_d C_d + k_f C_f + k_s C_s (Merrell 2010 §5.2), k_o for the floor outlines,
# plus our two input constraints — the ground floor fills the mapped footprint (fp) and rooms stay in one piece (v) —
# and the paper's wall alignment across floors (§5.1 snap, as a cost because our moves are cell slides: al)
import os as _os_w
PAPER = _os_w.environ.get("PAPER", "1") == "1"
LOW_LOWER_ROOFS = PAPER       # roofs.LOWER_CAP keeps lower roofs under the upper windows
W8P = dict(a=100.0, d=1.5, s=1.0, o=0.6, f=1000.0, fp=25.0, l=0.0, p=0.0, wet=0.0, v=1000.0, al=8.0)
# al (2026-10-30): wall stacking, the floor-coupling half of C_f that PLAN-geo-interiors-01 §5.5 specifies — share of an
# upper storey's partition length not standing on a lower wall (±1 cell); with the §5.1 snap it is what makes
# "walls aligned with walls on neighbouring floors" measurable instead of incidental
if __import__("os").environ.get("MOVES", "v2") != "v2": W8["al"] = 0.0      # v1 = the move set and cost as before this audit
TE_MAX, TI = 0.35, 0.12          # m: thickest exterior wall of the style table, interior wall (doorlogic / openings)
DOOR_MIN = 0.762                 # m: narrowest leaf the door ladder will use (30 in, a stock size)


# merge with the app's room building (2026-10-31): in Geo-voxel's planRows every room opens off the circulation row, so
# rooms always connect. Here: a room that the programme opens off "the hall" may open off any circulation room on its
# floor (hall, foyer, landing, corridor) — an access edge — instead of one particular hall.
import os as _os_m
MERGE_ACCESS = _os_m.environ.get("MERGE", "1") == "1"
MERGE_ROWS = _os_m.environ.get("START", "mix") if MERGE_ACCESS else "tree"
STAIR_ACCESS = _os_m.environ.get("STAIR_ACCESS", "1") == "1"
GARAGE_END = _os_m.environ.get("GARAGE_END", "1") == "1"
CLEAR_W = {"bedroom": 2.1, "living": 2.4, "dining": 2.1, "kitchen": 1.8} if _os_m.environ.get("CLEAR_W", "1") == "1" else {}
ACCESS_CIRC = {"hall", "corridor", "foyer", "landing"}
ACCESS_ROOMS = {"bedroom", "bathroom", "wc", "study", "utility"}


# 2026-11-02: which rooms may serve a room besides the one the programme names. A stair rises from any circulation or
# living room (a 1.5-storey house's stair sits under its upper floor, often off the living room); a garage opens into
# the kitchen, a utility (mudroom) or a hall.
SERVE_ALT = {k: ACCESS_CIRC for k in ACCESS_ROOMS}
SERVE_ALT["stair"] = ACCESS_CIRC | {"living", "dining"}
SERVE_ALT["garage"] = {"kitchen", "utility", "hall", "foyer", "corridor"}
SERVE_ALT["study"] = ACCESS_CIRC | {"living"}             # round 5: a study off the living room is as common as off a hall


def cluster_ok(edges_all, live, rooms):
    """Round 5: cluster edges (e["cluster"]) are met together — the group's rooms joined by its live edges.
    Returns {cluster name: number of extra links still needed (components − 1)}."""
    out = {}
    for name in {e["cluster"] for e in edges_all if e.get("cluster")}:
        es = [e for e in edges_all if e.get("cluster") == name]
        ids = {x for e in es for x in (e["a"], e["b"])}
        par = {i: i for i in ids}
        def f(x):
            while par[x] != x: x = par[x]
            return x
        for e in live:
            if e.get("cluster") == name and e["a"] in par and e["b"] in par: par[f(e["a"])] = f(e["b"])
        out[name] = len({f(i) for i in ids}) - 1
    return out


def access_edge(e, rooms):
    """(serving room id, served room id) if e is an access edge, else None."""
    ka, kb = rooms[e["a"]]["kind"], rooms[e["b"]]["kind"]
    if e.get("type") != "door" and not ("stair" in (ka, kb)): return None
    if kb in SERVE_ALT and ka in SERVE_ALT[kb]: return e["a"], e["b"]
    if ka in SERVE_ALT and kb in SERVE_ALT[ka]: return e["b"], e["a"]
    return None


def access_alternatives(e, rooms):
    """Rooms that may serve an access edge: same storey, same flat (unit) and tenancy."""
    ae = access_edge(e, rooms)
    if ae is None: return []
    c, r = ae; R = rooms[r]; ok = SERVE_ALT[R["kind"]]
    return [x["id"] for x in rooms if x["id"] != c and x["kind"] in ok and x["storey"] == R["storey"] and not x.get("stair")
            and x.get("unit") == R.get("unit") and x.get("tenancy", "main") == rooms[c].get("tenancy", "main")]


def door_fit(L, a, b, cell, wmin=None):
    """Blueprint-exact door test for the pair (a, b): the longest straight shared run, less the walls that meet its
    ends (exterior TE_MAX, interior TI/2, as openings._end_clearance) and 2 × 100 mm jamb clearance, must hold the
    narrowest leaf. Only called for runs near the threshold, so the cost stays vectorised for the rest."""
    H, W = L.shape; best = 0.0
    def lab(y, x): return int(L[y, x]) if 0 <= y < H and 0 <= x < W else -1
    def clear(p1, q1, p2, q2):
        need = 0.0
        for p, q in ((p1, q1), (p2, q2)):
            if p != q: need = max(need, TE_MAX if (p <= 0 or q <= 0) else TI / 2)
        return need
    for vertical in (True, False):
        A, B = (L[:, :-1], L[:, 1:]) if vertical else (L[:-1, :], L[1:, :])
        m = ((A == a) & (B == b)) | ((A == b) & (B == a))
        if not m.any(): continue
        lines = range(m.shape[1]) if vertical else range(m.shape[0])
        for ln in lines:
            col = m[:, ln] if vertical else m[ln, :]
            if not col.any(): continue
            k, n = 0, len(col)
            while k < n:
                if not col[k]: k += 1; continue
                j = k
                while j + 1 < n and col[j + 1]: j += 1
                if vertical:   # wall between columns ln, ln+1 over rows k..j
                    c0 = clear(lab(k - 1, ln), lab(k, ln), lab(k - 1, ln + 1), lab(k, ln + 1))
                    c1 = clear(lab(j, ln), lab(j + 1, ln), lab(j, ln + 1), lab(j + 1, ln + 1))
                else:
                    c0 = clear(lab(ln, k - 1), lab(ln, k), lab(ln + 1, k - 1), lab(ln + 1, k))
                    c1 = clear(lab(ln, j), lab(ln, j + 1), lab(ln + 1, j), lab(ln + 1, j + 1))
                best = max(best, (j - k + 1) * cell - c0 - c1 - 0.2)
                k = j + 1
    return best >= (wmin or DOOR_MIN) - 1e-9   # l (daylight, ours) raised 5 → 15 after the blueprint gate


class Rng:
    def __init__(self, seed):
        self.r = np.random.default_rng(abs(hash(seed)) % (2 ** 32) if not isinstance(seed, int) else seed)
    def next(self): return float(self.r.random())
    def int(self, n): return int(self.r.integers(n))
    def gauss(self): return float(self.r.normal())
    def pick(self, a): return a[self.int(len(a))]


def stable_seed(s):
    h = 2166136261
    for ch in str(s):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h


# ------------------------------------------------------------------------------------------------ site
def site_from_polygon(poly, cell, party_polys=()):
    """Lot mask from the local footprint polygon (cell centres inside), with entry/daylight edge masks."""
    from shapely.geometry import Point
    minx, miny, maxx, maxy = poly.bounds
    W, H = int(math.ceil((maxx - minx) / cell)), int(math.ceil((maxy - miny) / cell))
    xs = minx + (np.arange(W) + 0.5) * cell
    ys = miny + (np.arange(H) + 0.5) * cell
    from shapely import contains_xy
    X, Y = np.meshgrid(xs, ys)
    mask = contains_xy(poly, X, Y)
    party = np.zeros((H, W, 4), bool)
    if party_polys:
        from shapely.ops import unary_union
        P = unary_union([p.buffer(0.7) for p in party_polys])
        for k, (du, dv) in enumerate(DIRS):
            party[..., k] = contains_xy(P, X + du * cell, Y + dv * cell)
    return finish_site(mask, cell, party, origin=(minx, miny))


def finish_site(mask, cell, party=None, front_dir=0, origin=(0, 0), carve=True, entry_edges=None, light_edges=None):
    H, W = mask.shape
    party = np.zeros((H, W, 4), bool) if party is None else party
    out = np.zeros((H, W, 4), bool)                 # edge k of cell leaves the lot
    P = np.pad(mask, 1)
    for k, (du, dv) in enumerate(DIRS):
        out[..., k] = mask & ~P[1 + dv:1 + dv + H, 1 + du:1 + du + W]
    front = np.zeros((H, W, 4), bool); front[..., front_dir] = out[..., front_dir]
    light = out & ~party
    return {"mask": mask, "cell": cell, "out": out, "party": party & out, "entry": entry_edges if entry_edges is not None else front & ~party,
            "light": light_edges if light_edges is not None else light, "carve": carve, "origin": origin, "H": H, "W": W}


# ------------------------------------------------------------------------------------------------ analysis
def pair_runs(L):
    """Longest straight run of shared boundary per label pair (vectorised run-length over both axes)."""
    L = L.astype(np.int64)
    K = 4096
    runs = {}
    for A, B, axis in ((L[:, :-1], L[:, 1:], 0), (L[:-1, :], L[1:, :], 1)):
        code = np.where(A != B, np.minimum(A, B) * K + np.maximum(A, B) + K * K, -1)
        C = code.T if axis == 0 else code             # runs go along y for vertical walls, along x for horizontal ones
        C = np.concatenate([C, np.full((C.shape[0], 1), -2)], axis=1).ravel()
        starts = np.flatnonzero(np.r_[True, C[1:] != C[:-1]])
        lengths = np.diff(np.r_[starts, len(C)])
        vals = C[starts]
        keep = vals >= 0
        vals, lengths = vals[keep], lengths[keep]
        if not len(vals): continue
        order = np.lexsort((-lengths, vals))
        vals, lengths = vals[order], lengths[order]
        first = np.r_[True, vals[1:] != vals[:-1]]
        for cc, rr in zip(vals[first].tolist(), lengths[first].tolist()):
            cc -= K * K
            key = (cc // K, cc % K)
            if runs.get(key, 0) < rr: runs[key] = rr
    return runs


def corners(m):
    p = np.zeros((m.shape[0] + 2, m.shape[1] + 2), np.int8); p[1:-1, 1:-1] = m
    k = p[:-1, :-1] + p[1:, :-1] + p[:-1, 1:] + p[1:, 1:]
    diag = ((p[:-1, :-1] == p[1:, 1:]) & (p[1:, :-1] == p[:-1, 1:]) & (p[:-1, :-1] != p[1:, :-1]))
    return int((k == 1).sum() + (k == 3).sum() + 2 * diag.sum())


PERSON_W = _os_m.environ.get("PERSON_W", "1") == "1"
PERSON_SKIP = ("stair", "closet", "porch", "garage")
PERSON_WET = ("wc", "bathroom", "pantry")          # 762 mm (IRC R307.1: a 30-inch fixture space) — a person stands there


def person_narrow(L, lab, I, site):
    """Cells of room `lab` in a strip or neck narrower than 914 mm clear (see the person-width rule in cost)."""
    m = I["mask"]
    ys, xs = np.nonzero(m); y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    pad = 1
    Y0, Y1, X0, X1 = max(0, y0 - pad), min(L.shape[0], y1 + pad + 1), max(0, x0 - pad), min(L.shape[1], x1 + pad + 1)
    sub = L[Y0:Y1, X0:X1]; mm = sub == lab
    outside = sub <= 0
    ext = np.zeros_like(mm)
    ext[1:, :] |= outside[:-1, :]; ext[:-1, :] |= outside[1:, :]; ext[:, 1:] |= outside[:, :-1]; ext[:, :-1] |= outside[:, 1:]
    # cells at the lattice border are outside walls too
    ext[0, :] |= Y0 == 0; ext[-1, :] |= Y1 == L.shape[0]; ext[:, 0] |= X0 == 0; ext[:, -1] |= X1 == L.shape[1]
    wet = I.get("kind") in PERSON_WET
    core = mm if wet else mm & ~ext          # wet rooms: 3 cells is 840 mm even against an outside wall, enough for 762
    k = int(math.ceil(((0.762 if wet else 0.914) + 0.12) / site["cell"] - 1e-9))
    st = np.ones((k, k), bool)
    op = ndimage.binary_opening(np.pad(core, 1), st)[1:-1, 1:-1]
    # necks: two wide parts joined by less than a person's width (an S-jog overlapping by one cell). The positions a
    # k×k person can stand (the erosion) must form one 4-connected piece; each extra piece costs like 6 narrow cells.
    er = ndimage.binary_erosion(np.pad(core, k), st)
    pieces = ndimage.label(er)[1]
    return int((core & ~op).sum()) + 6 * max(0, pieces - 1)


def neighbour(L, k, fill=-1):
    H, W = L.shape
    du, dv = DIRS[k]
    P = np.pad(L, 1, constant_values=fill)
    return P[1 + dv:1 + dv + H, 1 + du:1 + du + W]


_NB = {}
def edge_counts(L, room, site, which):
    """Cell edges of `room` in edge mask `which` (H×W×4) that lead out of the built area."""
    m = L == room
    if not m.any(): return 0
    key = id(L)
    nbs = _NB.get(key)
    if nbs is None or nbs[0] is not L or nbs[2] != L.tobytes().__hash__():
        out = np.stack([neighbour(L, k) <= 0 for k in range(4)], -1)
        nbs = (L, out, L.tobytes().__hash__()); _NB.clear(); _NB[key] = nbs
    return int((m[..., None] & nbs[1] & which).sum())


# ------------------------------------------------------------------------------------------------ cost
_HULL = {}
def mc(crop):
    """Merrell 2010 shape measure M_c(S) = (A(H(S)) − A(S)) / A(S) + e(S). 2026-11-02 (paper revision): e(S) is the raw
    edge count, as in §5.2 — shifted by the constant 4 so a rectangle costs 0 (a constant per room changes nothing in the
    optimisation). Before, e was divided by 4, which made an L-shaped room cost 0.5 instead of 2 more than a rectangle."""
    n = int(crop.sum()); bw_bh = crop.shape[0] * crop.shape[1]
    if n == bw_bh: return 0.0
    key = crop.tobytes() + bytes(crop.shape)
    v = _HULL.get(key)
    if v is None:
        from scipy.spatial import ConvexHull
        ys, xs = np.nonzero(crop)
        pts = np.concatenate([np.stack([xs + dx, ys + dy], 1) for dx in (0, 1) for dy in (0, 1)])
        try: hull = ConvexHull(pts).volume
        except Exception: hull = float(bw_bh)
        v = (hull - n) / n + (corners(crop) - 4) if PAPER else (hull - n) / n + (corners(crop) - 4) / 4
        if len(_HULL) > 200000: _HULL.clear()
        _HULL[key] = v
    return v


def open_groups(prog, s):
    """Rooms on storey s joined by open walls (Merrell's groups G_i, judged as one space)."""
    key = (id(prog), s)
    if key in _GROUPS: return _GROUPS[key]
    rooms = prog["rooms"]; par = {r["id"]: r["id"] for r in rooms if r["storey"] == s}
    def f(a):
        while par[a] != a: a = par[a]
        return a
    for e in prog["edges"]:
        if e["type"] == "open" and e["a"] in par and e["b"] in par: par[f(e["a"])] = f(e["b"])
    groups = {}
    for a in par: groups.setdefault(f(a), []).append(a)
    out = [g for g in groups.values() if len(g) > 1]
    _GROUPS[key] = out
    return out
_GROUPS = {}


def evaluate(labels, prog, sites, want_detail=False):
    T = {k: 0.0 for k in W8}
    CF = [0.0, 0.0]
    detail = []
    rooms = prog["rooms"]
    for s, L in enumerate(labels):
        site = sites[s]
        ids = [r["id"] for r in rooms if r["storey"] == s]
        cell2 = site["cell"] ** 2
        runs = pair_runs(L)
        info = {}
        for rid in ids:
            lab = rid + 1
            m = L == lab
            n = int(m.sum())
            if n < 4:
                T["v"] += 1; info[rid] = None; continue
            ys, xs = np.nonzero(m)
            x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
            bw, bh = x1 - x0 + 1, y1 - y0 + 1
            crop = m[y0:y1 + 1, x0:x1 + 1]
            if n < bw * bh:
                _, ncomp = ndimage.label(crop)
                if ncomp > 1: T["v"] += 1
            info[rid] = dict(n=n, bw=bw, bh=bh, area=n * cell2, mask=m, crop=crop, y1=y1)
        # accessibility: every program edge needs a straight shared wall long enough for its door / opening
        live = []
        for e in prog["edges"]:
            if rooms[e["a"]]["storey"] != s: continue
            a, b = e["a"] + 1, e["b"] + 1
            # Merrell: "they must share a sufficiently long wall segment to accommodate a door" — a 900 mm leaf,
            # 2×50 mm jambs, 100 mm either side and the half-walls that meet it: 1.25 m (open passages 1.6 m)
            need = math.ceil((1.25 if e["type"] == "door" else 1.6 if e["type"] == "open" else 1.25) / site["cell"] - 1e-9)
            run = runs.get((min(a, b), max(a, b)), 0)
            ok = run >= need
            # 2026-11-03: stock sizes — an exterior door (to a porch) is 36 in, an interior one at least 30 in
            ext_ = rooms[e["a"]].get("open_air") or rooms[e["b"]].get("open_air")
            if ok and e["type"] == "door" and run * site["cell"] < (0.9144 if ext_ else DOOR_MIN) + 0.2 + 2 * TE_MAX:
                ok = door_fit(L, a, b, site["cell"], 0.9144 if ext_ else None)
            if not ok and MERGE_ACCESS:                   # served by another circulation room (the app's rule)
                ae = access_edge(e, rooms)
                if ae:
                    r_ = ae[1] + 1
                    for c_ in access_alternatives(e, rooms):
                        if runs.get((min(r_, c_ + 1), max(r_, c_ + 1)), 0) >= need:
                            ok = True; e = dict(e, a=ae[1], b=c_); break
            if ok: live.append(e)
            elif not e.get("cluster"): T["a"] += 1
        for _n, _k in cluster_ok([e for e in prog["edges"] if rooms[e["a"]]["storey"] == s], live, rooms).items(): T["a"] += _k
        # entry: the entry room (porch first) needs street-front edge for the front door; reachability from it
        if s == 0:
            ent = prog["entry"]
            if info.get(ent) is not None and edge_counts(L, ent + 1, site, site["entry"]) < math.ceil(1.0 / site["cell"]): T["a"] += 1
            start = ent
        else:
            st = [r["id"] for r in rooms if r["storey"] == s and r.get("stair")]
            start = st[0] if st else ids[0]
        seen, q = {start}, [start]
        if s == 0:                       # a room with its own street door is a second way in (separate tenancy)
            for r_ in ids:
                if rooms[r_].get("street_door") and r_ not in seen: seen.add(r_); q.append(r_)
        while q:
            v = q.pop()
            for e in live:
                w = e["b"] if e["a"] == v else e["a"] if e["b"] == v else None
                if w is not None and w not in seen: seen.add(w); q.append(w)
        T["a"] += sum(1 for r in ids if r not in seen and not rooms[r].get("detached"))
        for rid in ids:
            R, I = rooms[rid], info[rid]
            if I is None: continue
            if R.get("exterior_access") and edge_counts(L, rid + 1, site, site["light"]) < math.ceil(2.4 / site["cell"]): T["a"] += 1
            if R["kind"] == "garage" and GARAGE_END:
                # 2026-11-02 (round 2): a garage is a clean rectangle — a notch (a bath in its back corner, an L) takes a
                # parking space away (North Shore design 3: 4.4 m of depth left for the second car)
                T["d"] += 25.0 * (I["bw"] * I["bh"] - I["n"]) / max(1, I["n"])
                if I["n"] < I["bw"] * I["bh"]: T["a"] += 1          # round 4: any notch fails, as a missing door would
                # 2026-11-02: a car drives in along the garage's long axis, so the garage door needs a SHORT end on the
                # outside (Ducros design 1 had only a long side outside: no straight drive-in)
                door_m = 4.88 if R.get("cars", 1) >= 2 else 2.75; deep = R.get("long_min", 6.4)
                ok_ = False
                for ks, depth, side in (((0, 2), I["bh"], I["bw"]), ((1, 3), I["bw"], I["bh"])):     # door facing ±y, or ±x
                    # round 4: the door side is as wide as the programme's min_side (6.0 m clear for two sedans with
                    # mirrors and side clearances), not just the door + 0.4 m
                    if depth * site["cell"] < deep - 1e-6 or side * site["cell"] < max(door_m + 0.4, R.get("min_side", 0) + 0.25) - 1e-6: continue
                    # the door needs ONE straight run of outside wall on one end (not two stubs on opposite ends)
                    need_ = math.ceil((door_m + 0.4) / site["cell"]); m_ = L == rid + 1
                    for k_ in ks:
                        du, dv = DIRS[k_]
                        e_ = m_ & (neighbour(L, k_) <= 0) & site["light"][..., k_]
                        run_ = max((int(r_.sum()) for r_ in (e_ if dv else e_.T)), default=0)     # per row (±y) or column (±x)
                        if run_ >= need_: ok_ = True; break
                    if ok_: break
                if not ok_: T["a"] += 1
            if R.get("street_door") and s == 0 and edge_counts(L, rid + 1, site, site["entry"]) < math.ceil(1.4 / site["cell"]): T["a"] += 1
            if R.get("mu"):                                   # −ℓ_a: area ~ N(μ, σ²)  (constants dropped)
                T["d"] += 0.5 * ((I["area"] - R["mu"]) / R["sigma"]) ** 2
            if PAPER and R["kind"] in ("hall", "corridor", "landing"):
                asp_h = max(I["bw"], I["bh"]) / min(I["bw"], I["bh"])
                T["d"] += 0.5 * ((math.log(asp_h) - math.log(2.5)) / 0.5) ** 2 * 0.25        # −ℓ_as for halls (§5.2)
            if PERSON_W and R["kind"] not in PERSON_SKIP:
                # 2026-11-03 person-width rule (IRC R311.6, 914 mm): every part of a room a person walks through is at
                # least 914 mm clear between wall faces. Interior walls (120 mm) sit on cell lines; an exterior wall
                # (300 mm) sits inside the room's edge cell, so that cell does not count as walking width. On a
                # 0.4 m grid: 3 cells between interior walls, 4 against an outside wall. Narrow cells (a strip or neck
                # a person cannot pass) cost per cell in C_d, Merrell's dimension term — smooth, so the annealer can
                # work them out; the hard requirement is the gate on the built walls when a restart is accepted.
                n_narrow = person_narrow(L, rid + 1, dict(I, kind=R["kind"]), site)
                if n_narrow: T["d"] += 4.0 * n_narrow
            if R["kind"] not in ("hall", "stair", "corridor"):
                asp = max(I["bw"], I["bh"]) / min(I["bw"], I["bh"])
                # 2026-11-06 (high-rise flats): hard proportions where the programme asks for them
                if R.get("hard_aspect") and asp > R["hard_aspect"] + 1e-9: T["a"] += 1
                if R.get("hard_min_side") and min(I["bw"], I["bh"]) * site["cell"] < R["hard_min_side"] - 1e-9: T["a"] += 1
                if R.get("hard_fill") and I["n"] < R["hard_fill"] * I["bw"] * I["bh"]: T["a"] += 1     # mostly a rectangle
                if R.get("hard_area") and I["area"] < R["hard_area"] - 1e-9: T["a"] += 1             # a minimum area (m²)
                if R.get("hard_square"):
                    # 2026-11-07: most of the room swept by a square of its minimum side (not a 2.4 m strip with a bump);
                    # the shortfall also costs in C_d so the search has a slope towards it
                    k_ = max(1, int(round(R["hard_min_side"] / site["cell"])))
                    m_ = L == rid + 1
                    sq = int(ndimage.binary_opening(m_, np.ones((k_, k_), bool)).sum())
                    if sq < R["hard_square"] * I["n"]:
                        T["a"] += 1; T["d"] += 4.0 * (R["hard_square"] * I["n"] - sq) / max(1, I["n"])
                # −ℓ_as: aspect ratio log-normal around μ_r = 1.35 (σ_r = 0.25 in log space), plus the hard limit
                T["d"] += 0.5 * ((math.log(asp) - math.log(R.get("aspect_mu", 1.35))) / R.get("aspect_sd", 0.25)) ** 2 * R.get("aspect_w", 0.25)
                T["d"] += 0.5 * (max(0.0, asp - R.get("max_aspect", 2.0)) / 0.5) ** 2
                ms = R.get("min_side", 2.4) / site["cell"]
                T["d"] += 3.0 * max(0.0, ms - min(I["bw"], I["bh"])) / ms * 4
                if R.get("long_min"):                         # garage: long enough for a sedan driven in nose first
                    ml = R["long_min"] / site["cell"]; T["d"] += 3.0 * max(0.0, ml - max(I["bw"], I["bh"])) / ml * 8
                    T["d"] += 3.0 * max(0.0, ms - min(I["bw"], I["bh"])) / ms * 24      # and wide enough for its bays
                    T["s"] += 6.0 * mc(I["crop"])                                       # and rectangular (cars hit notches)
                T["s"] += mc(I["crop"]) * (4.0 if R.get("open_air") and PAPER else 1.0)    # porches: rectangles, so their posts line up
            if R.get("span"):
                T["d"] += 6.0 * max(0.0, R["span"] - I["bw"] / site["W"])
            if R.get("band"):
                T["d"] += 4.0 * max(0.0, (I["y1"] + 1) * site["cell"] - R["band"]) / R["band"]
            if R.get("avoid") is not None and site.get(R["avoid"]) is not None and \
                    edge_counts(L, rid + 1, site, site[R["avoid"]]) > 0:
                T["a"] += 1                     # 2026-11-06 (high-rise flats): a bedroom off the lift shafts (GB 55038 4.2.3)
            if R.get("daylight"):
                # 2026-11-06 (high-rise flats): light_min, the facade a room needs for its window and its AC platform
                need = math.ceil(R.get("light_min", 1.2) / site["cell"] - 1e-9)
                have = edge_counts(L, rid + 1, site, site["light"])
                # IRC R303.2: a room open to an adjoining room (Merrell's open-wall group) may take its light
                for grp in open_groups(prog, s):
                    # fix (2026-10-30, score A14): only group members that take windows count (halls and stairs get
                    # none in openings.py), matching the gate's lit() — a flat's hall facade "lit" its living group
                    if rid in grp: have = max(have, sum(edge_counts(L, g + 1, site, site["light"]) for g in grp
                                                        if info.get(g) is not None and rooms[g].get("daylight") and not rooms[g].get("stair")))
                if PAPER:
                    if s > 0 and not LOW_LOWER_ROOFS:   # (lower roofs now stay under the upper sills: every upper wall can take a window)
                        lo_ = labels[s - 1]
                        open_ = np.stack([neighbour(lo_, k) <= 0 for k in range(4)], -1)
                        have = int(((L == rid + 1)[..., None] & np.stack([neighbour(L, k) <= 0 for k in range(4)], -1) & site["light"] & open_).sum())
                        for grp in open_groups(prog, s):
                            if rid in grp:
                                for g in grp:
                                    if g != rid and info.get(g) is not None and rooms[g].get("daylight") and not rooms[g].get("stair"):
                                        have = max(have, int(((L == g + 1)[..., None] & np.stack([neighbour(L, k) <= 0 for k in range(4)], -1) & site["light"] & open_).sum()))
                    if have < need: T["a"] += 1
                else: T["l"] += max(0, need - have) / need
            if not PAPER and R.get("private") and s == 0 and edge_counts(L, rid + 1, site, site["entry"]) > 0 and prog.get("privacy", True):
                T["p"] += 1
        if prog.get("sun_rooms") and site.get("sun") is not None:
            # 2026-11-06 (high-rise flats): one habitable room on the sunny facade (GB 50096 7.1.1 / GB 55038 6.2.1)
            sun = max((edge_counts(L, r_ + 1, site, site["sun"]) for r_ in prog["sun_rooms"] if info.get(r_) is not None), default=0)
            need_ = math.ceil(2.4 / site["cell"] - 1e-9)
            if sun < need_:
                T["a"] += 1
                T["l"] = T.get("l", 0) + 2.0 * (need_ - sun) / need_      # a slope towards the sunny wall
        for grp in open_groups(prog, s):
            gm = np.isin(L, [g + 1 for g in grp])
            if gm.any():
                ys_, xs_ = np.nonzero(gm); T["s"] += 0.5 * mc(gm[ys_.min():ys_.max() + 1, xs_.min():xs_.max() + 1])
        built = (L > 0)
        T["o"] += (max(0, corners(built) - 4) if PAPER else max(0, corners(built) - 4) / 4)   # k_o Σ e(F_i), §5.2 (raw edges)
        if s == 0:
            lot = site["mask"].sum()
            frac = built.sum() / lot
            T["fp"] += max(0.0, prog.get("cover", 0.92) - frac) * 4
        else:
            lower = labels[s - 1] > 0
            lower_indoor = lower & ~np.isin(labels[s - 1], [r["id"] + 1 for r in rooms if r["storey"] == s - 1 and r.get("open_air")])
            unsup = (built & ~lower_indoor).sum() / max(1, built.sum())
            if PAPER: CF[0] += float((built & ~lower_indoor).sum()); CF[1] += float(built.sum())
            else: T["f"] += unsup
            want = prog.get("upper_cover", {}).get(s, 0.95) * lower_indoor.sum()
            if PAPER: pass          # §5.2: an upper floor is as big as its rooms (C_d); C_f only asks it to stand on the floor below
            elif prog.get("upper_cover", {}).get(s, 0.95) >= 0.99:
                # full upper floor (two-storey house): every enclosed ground-floor cell covered, nothing over the porch
                T["fp"] += 12 * (lower_indoor & ~built).sum() / max(1, lower_indoor.sum()); T["f"] += 3 * unsup
            else:
                # 2026-11-02: the upper floor is as big as the record says — too much floor costs as much as too little
                T["fp"] += abs(want - built.sum()) / max(1, lower_indoor.sum()) * 6
                T["f"] += 3 * unsup                      # a partial upper floor stands on the floor below too
            # wall stacking: upper partitions (label changes between two built cells) over a lower wall, ±1 cell
            Lo = labels[s - 1]
            uv = (L[:, :-1] != L[:, 1:]) & (L[:, :-1] > 0) & (L[:, 1:] > 0)
            uh = (L[:-1, :] != L[1:, :]) & (L[:-1, :] > 0) & (L[1:, :] > 0)
            lv = (Lo[:, :-1] != Lo[:, 1:]) & ((Lo[:, :-1] > 0) | (Lo[:, 1:] > 0))
            lh = (Lo[:-1, :] != Lo[1:, :]) & ((Lo[:-1, :] > 0) | (Lo[1:, :] > 0))
            lv = lv | np.pad(lv[:, 1:], ((0, 0), (0, 1))) | np.pad(lv[:, :-1], ((0, 0), (1, 0)))
            lh = lh | np.pad(lh[1:, :], ((0, 1), (0, 0))) | np.pad(lh[:-1, :], ((1, 0), (0, 0)))
            nu = int(uv.sum() + uh.sum())
            if nu: T["al"] += float((uv & ~lv).sum() + (uh & ~lh).sum()) / nu
            wet_lo = np.isin(labels[s - 1], [r["id"] + 1 for r in rooms if r["storey"] == s - 1 and r.get("wet")])
            wet_lo = ndimage.binary_dilation(wet_lo, iterations=2)
            for rid in (ids if not PAPER else []):
                if rooms[rid].get("wet") and info[rid] is not None:
                    T["wet"] += 1 - (info[rid]["mask"] & wet_lo).sum() / info[rid]["n"]
        # 2026-11-02 (round 3): IRC R304 — a habitable room has a clear square of its minimum width somewhere in it
        # (the bounding-box min_side test let L-shaped and thin rooms through: 12.6 m² bedrooms with no 2.1 m part)
        for rid in ids:
            R = rooms[rid]
            if R["kind"] in CLEAR_W and info.get(rid) is not None:
                k_ = int(math.ceil((CLEAR_W[R["kind"]] + 0.15) / site["cell"] - 1e-9))   # + wall thickness
                cr = info[rid]["crop"]
                if cr.shape[0] < k_ or cr.shape[1] < k_ or not ndimage.binary_erosion(cr, np.ones((k_, k_), bool), border_value=0).any():
                    T["d"] += 3.0
        # 2026-11-02: hall width. A hall is a corridor (Merrell §5.2 exempts it from convexity, not from size): cells more
        # than max_width/2 from its edge count, except the 1.2 m landing in front of a stair
        for rid in ids:
            R = rooms[rid]
            if R.get("max_width") and info.get(rid) is not None and not PAPER:
                m = info[rid]["mask"]
                d = ndimage.distance_transform_cdt(np.pad(m, 1), metric="taxicab")[1:-1, 1:-1]
                fat = m & (d > max(1, int(round(R["max_width"] / 2 / site["cell"]))))
                stm = np.isin(L, [r["id"] + 1 for r in rooms if r.get("stair") and r["storey"] == s])
                if stm.any(): fat &= ~ndimage.binary_dilation(stm, iterations=max(1, int(round(1.2 / site["cell"]))))
                T["d"] += 2.0 * fat.sum() * site["cell"] ** 2
        detail.append(info)
    # 2026-11-02 (IRC R311.7.6, ours): the flight's foot and head face rooms that reach them, in one of its two climbing
    # directions (stairs.choose_rev picks it for the build)
    if STAIR_ACCESS and len(labels) > 1:
        st0 = [r["id"] + 1 for r in rooms if r.get("stair") and r["storey"] == 0]
        if st0:
            ys_, xs_ = np.nonzero(labels[0] == st0[0])
            if len(ys_):
                import stairs as STR
                pl = {"stair": (int(xs_.min()), int(ys_.min()), int(xs_.max() - xs_.min() + 1), int(ys_.max() - ys_.min() + 1)), "cell": sites[0]["cell"]}
                T["a"] += min(STR.access_cost(pl, labels, rooms, False), STR.access_cost(pl, labels, rooms, True))
    if PAPER and CF[1] > 0:
        # C_f = Σ A(F_i − F_{i−1}) / Σ A(F_i) (§5.2); the ground floor is inside its lot by construction
        tot_area = CF[1] + float(sum((labels[0] > 0).sum() for _ in [0]))
        T["f"] += CF[0] / max(1.0, tot_area)
    hook = prog.get("hard_hook")              # 2026-11-07: a caller's own hard checks (high-rise flats), once these pass
    if hook is not None and T["a"] == 0:
        T["a"] += hook(labels)
    total = sum((W8P if PAPER else W8)[k] * v for k, v in T.items())
    return (total, T, detail) if want_detail else (total, T)


# ------------------------------------------------------------------------------------------------ moves
MOVES = __import__("os").environ.get("MOVES", "v2")


def _boundary_at(L, vertical, b, lo, hi):
    """Share of t ∈ [lo, hi] where a wall (label change between built cells) lies on boundary line b."""
    H, W = L.shape
    if vertical:
        if b <= 0 or b >= W: return 0.0
        A, B = L[lo:hi + 1, b - 1], L[lo:hi + 1, b]
    else:
        if b <= 0 or b >= H: return 0.0
        A, B = L[b - 1, lo:hi + 1], L[b, lo:hi + 1]
    return float(((A != B) & ((A > 0) | (B > 0))).mean()) if len(A) else 0.0


def _vertices(L, vertical, line, t0, t1):
    """Positions along a wall (t0..t1, cells) where a perpendicular wall meets it: Merrell's existing vertices."""
    out = []
    for t in range(t0 + 1, t1 + 1):
        if vertical:   # wall between columns line and line+1; perpendicular walls lie between rows t-1 and t
            if (L[t - 1, line] != L[t, line]) or (L[t - 1, line + 1] != L[t, line + 1]): out.append(t)
        else:
            if (L[line, t - 1] != L[line, t]) or (L[line + 1, t - 1] != L[line + 1, t]): out.append(t)
    return out


def slide(L, R, frozen, site, others=()):
    """Merrell §5.1 slide move. v2 (MOVES=v2): the split point prefers existing vertices (perpendicular walls
    meeting this one) with probability ½, and after the move the wall snaps to an existing parallel wall within
    ε = 1 cell on the same storey or on a neighbouring storey ("to increase consistency across floors")."""
    H, W = L.shape
    for _ in range(40):
        y, x = R.int(H), R.int(W)
        if L[y, x] < 0 and not site["carve"]: continue
        vertical = R.next() < 0.5
        if vertical:
            if x >= W - 1: continue
            a, b = L[y, x], L[y, x + 1]
        else:
            if y >= H - 1: continue
            a, b = L[y, x], L[y + 1, x]
        if a == b or a in frozen or b in frozen: continue
        if (a < 0 or b < 0) and not site["carve"]: continue
        if a < 0 and b < 0: continue
        # the wall: maximal straight run through this edge
        def is_b(t):
            if vertical:
                return 0 <= t < H and L[t, x] != L[t, x + 1] and L[t, x] not in frozen and L[t, x + 1] not in frozen and not (L[t, x] < 0 and L[t, x + 1] < 0)
            return 0 <= t < W and L[y, t] != L[y + 1, t] and L[y, t] not in frozen and L[y + 1, t] not in frozen and not (L[y, t] < 0 and L[y + 1, t] < 0)
        t0 = t1 = y if vertical else x
        while is_b(t0 - 1): t0 -= 1
        while is_b(t1 + 1): t1 += 1
        lo, hi = t0, t1
        if R.next() >= 0.5 and t1 > t0:
            vx = _vertices(L, vertical, x if vertical else y, t0, t1) if MOVES == "v2" else []
            cut = R.pick(vx) if (vx and R.next() < 0.5) else t0 + 1 + R.int(t1 - t0)
            if R.next() < 0.5: lo = cut
            else: hi = cut - 1
        d = int(round(R.gauss() * 2)) or (1 if R.next() < 0.5 else -1)
        d = max(-5, min(5, d))
        if MOVES == "v2":
            # snap: the moved part's new line b = (x + 1 + d) (vertical) / (y + 1 + d); look ε = 1 cell either side for
            # a wall on a neighbouring floor first, then on this floor, over at least half the moved extent
            b = (x + 1 if vertical else y + 1) + d
            best = None
            for pri, LL in ((0, o) for o in others):
                for e in (0, -1, 1):
                    if _boundary_at(LL, vertical, b + e, lo, hi) >= 0.5: best = e; break
                if best is not None: break
            if best is None:
                for e in (-1, 1):
                    if _boundary_at(L, vertical, b + e, lo, hi) >= 0.5 and (b + e) != (x + 1 if vertical else y + 1): best = e; break
            if best: d = d + best
            if d == 0: continue
        changed = []
        for t in range(lo, hi + 1):
            if vertical:
                A, B = L[t, x], L[t, x + 1]
                if d > 0:      # the wall moves +x: cells x+1.. take A
                    for k in range(1, d + 1):
                        c = x + k
                        if c >= W or L[t, c] in frozen or L[t, c] < 0: break
                        if A < 0: newv = 0
                        else: newv = A
                        if L[t, c] != newv: changed.append((t, c, L[t, c])); L[t, c] = newv
                else:
                    for k in range(0, -d):
                        c = x - k
                        if c < 0 or L[t, c] in frozen or L[t, c] < 0: break
                        newv = 0 if B < 0 else B
                        if L[t, c] != newv: changed.append((t, c, L[t, c])); L[t, c] = newv
            else:
                A, B = L[y, t], L[y + 1, t]
                if d > 0:
                    for k in range(1, d + 1):
                        c = y + k
                        if c >= H or L[c, t] in frozen or L[c, t] < 0: break
                        newv = 0 if A < 0 else A
                        if L[c, t] != newv: changed.append((c, t, L[c, t])); L[c, t] = newv
                else:
                    for k in range(0, -d):
                        c = y - k
                        if c < 0 or L[c, t] in frozen or L[c, t] < 0: break
                        newv = 0 if B < 0 else B
                        if L[c, t] != newv: changed.append((c, t, L[c, t])); L[c, t] = newv
        if changed: return changed
    return None


def swap(L, ids, R):
    if len(ids) < 2: return None
    a, b = R.pick(ids) + 1, R.pick(ids) + 1
    if a == b: return None
    ma, mb = L == a, L == b
    ch = [(y, x, a) for y, x in zip(*np.nonzero(ma))] + [(y, x, b) for y, x in zip(*np.nonzero(mb))]
    L[ma] = b; L[mb] = a
    return ch


# ------------------------------------------------------------------------------------------------ start state
TIER = {"porch": -1, "public": 0, "semi": 1, "circulation": 1, "service": 2, "private": 3}

def initial(prog, sites, R, stair_rect):
    labels = []
    for s, site in enumerate(sites):
        L = np.where(site["mask"], 0, -1).astype(np.int16)
        # start order: breadth-first over the programme graph from the entry (rooms that must connect are packed
        # next to each other), porch first; ties by tier
        order = bfs_order(prog, s)
        rs = sorted([r for r in prog["rooms"] if r["storey"] == s and not r.get("stair")], key=lambda r: (r["tier"] != "porch", order.get(r["id"], 999), TIER.get(r["tier"], 1)))
        H, W = L.shape
        ys, xs = np.nonzero(site["mask"])
        box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
        cover = 1.0 if s == 0 else prog.get("upper_cover", {}).get(s, 1.0)
        if cover < 0.99:   # an upper floor that only covers part: start it at the back of the house
            y0 = int(box[1] + (box[3] - box[1]) * (1 - cover)); box = (box[0], y0, box[2], box[3])
        corr = [r for r in rs if r["kind"] in ("corridor",) or (prog.get("layout") == "double_loaded" and r["kind"] == "hall")]
        if prog.get("layout") == "double_loaded" and corr:
            # canonical double-loaded plan: a corridor band down the long axis, rooms treemapped on both sides
            x0, y0, x1, y1 = box
            band = max(2, int(round(1.8 / site["cell"])))
            others = [r for r in rs if r not in corr and r["tier"] != "porch"]
            pub = [r for r in others if r["tier"] == "public" and r["kind"] in ("lobby",)]
            rest_ = [r for r in others if r not in pub]
            dep = max(3, int(round(4.5 / site["cell"]))) if pub else 0
            A_, B_ = rest_[0::2], rest_[1::2]
            if (x1 - x0) >= (y1 - y0):
                ym = (y0 + y1) // 2 - band // 2
                xa = x0
                if pub: treemap(L, site, pub, (x0, y0, x0 + dep, y1)); xa = x0 + dep
                _paint(L, site, corr[0]["id"] + 1, (xa, ym, x1, ym + band))
                if A_: strip(L, site, A_, (xa, y0, x1, ym), along_x=True)
                if B_: strip(L, site, B_, (xa, ym + band, x1, y1), along_x=True)
            else:
                xm = (x0 + x1) // 2 - band // 2
                if pub: treemap(L, site, pub, (x0, y0, x1, y0 + dep))
                _paint(L, site, corr[0]["id"] + 1, (xm, y0 + dep, xm + band, y1))
                if A_: strip(L, site, A_, (x0, y0 + dep, xm, y1), along_x=False)
                if B_: strip(L, site, B_, (xm + band, y0 + dep, x1, y1), along_x=False)
            if stair_rect is not None:
                x0_, y0_, w_, h_ = stair_rect
                stt = [r for r in prog["rooms"] if r["storey"] == s and r.get("stair")][0]
                L[y0_:y0_ + h_, x0_:x0_ + w_] = stt["id"] + 1
            if s > 0: L[(labels[s - 1] <= 0) & (L > 0)] = 0
            labels.append(L)
            continue
        if prog.get("lit_strip") and site["light"].any():
            # fix (2026-10-30, score A14): a flat between party walls is lit on one face only, so its start state puts
            # the daylit rooms in a band along that face and the hall and baths behind it (the treemap start left the
            # living group with no facade, which 9,000 iterations rarely recovered)
            k_ = int(np.argmax([site["light"][..., k].sum() for k in range(4)])); du, dv = DIRS[k_]
            lit_r = [r for r in rs if r.get("daylight")]; dark_r = [r for r in rs if not r.get("daylight")]
            x0, y0, x1, y1 = box
            span = (y1 - y0) if dv else (x1 - x0)
            dep = max(3, min(span - 3, int(round(span * 0.62)))) if dark_r else span
            if dv:   # lit face is a row edge: the band runs along x
                band = (x0, y0, x1, y0 + dep) if dv < 0 else (x0, y1 - dep, x1, y1)
                back = (x0, y0 + dep, x1, y1) if dv < 0 else (x0, y0, x1, y1 - dep)
                strip(L, site, lit_r, band, along_x=True)
            else:
                band = (x0, y0, x0 + dep, y1) if du < 0 else (x1 - dep, y0, x1, y1)
                back = (x0 + dep, y0, x1, y1) if du < 0 else (x0, y0, x1 - dep, y1)
                strip(L, site, lit_r, band, along_x=False)
            if dark_r: treemap(L, site, dark_r, back)
            labels.append(L); continue
        porch = [r for r in rs if r["tier"] == "porch"]
        rest = [r for r in rs if r["tier"] != "porch"]
        if porch:
            dep = max(2, int(round(prog.get("porch_depth", 2.4) / site["cell"])))
            sub = (box[0], box[1], box[2], box[1] + dep)
            _paint(L, site, porch[0]["id"] + 1, sub)
            box = (box[0], box[1] + dep, box[2], box[3])
        hallr = [r for r in rest if r["kind"] in ("hall", "landing", "corridor")]
        use_rows = MERGE_ROWS == "rows" or (MERGE_ROWS == "mix" and R.next() < 0.6)
        if hallr and len(rest) >= 4 and use_rows:
            # merge (2026-10-31), Geo-voxel planRows: rooms in rows from the street to the back with the hall as a spine
            # across the full width between them, so every private room starts on the hall and the public rooms on
            # the street side; Metropolis then refines the rows (the app keeps them as they are)
            x0, y0, x1, y1 = box
            band = max(2, int(round(1.2 / site["cell"])))
            others = [r for r in rest if r not in hallr]
            front = [r for r in others if TIER.get(r["tier"], 1) <= 1 or r["kind"] == "garage"]
            back = [r for r in others if r not in front]
            if not front or not back:
                both = front or back; front, back = both[0::2], both[1::2]
            af = sum(r.get("mu") or 8.0 for r in front); ab = sum(r.get("mu") or 8.0 for r in back)
            D = (y1 - y0) - band
            df = min(D - 3, max(3, int(round(D * af / max(1e-6, af + ab)))))
            strip(L, site, front, (x0, y0, x1, y0 + df), along_x=True)
            _paint(L, site, hallr[0]["id"] + 1, (x0, y0 + df, x1, y0 + df + band))
            strip(L, site, back, (x0, y0 + df + band, x1, y1), along_x=True)
            for h_ in hallr[1:]: _paint(L, site, h_["id"] + 1, (x0, y0 + df, x0 + band, y0 + df + band))
        else:
            treemap(L, site, rest, box)
        if stair_rect is not None:
            x0, y0, w, h = stair_rect
            st = [r for r in prog["rooms"] if r["storey"] == s and r.get("stair")][0]
            L[y0:y0 + h, x0:x0 + w] = st["id"] + 1
        if MERGE_ACCESS: attach_small(L, site, prog, s, frozen={st_["id"] + 1 for st_ in prog["rooms"] if st_.get("stair")})
        if s > 0:   # upper floors keep inside the lower built area
            L[(labels[s - 1] <= 0) & (L > 0)] = 0
        labels.append(L)
    return labels


def attach_small(L, site, prog, s, frozen=()):
    """Merge (2026-10-31): a small room the programme opens off a circulation room (a wc off the foyer, a utility off the
    hall) starts cut from that room's far side, the way Geo-voxel puts every room where it connects. The treemap start
    otherwise drops it wherever the weights fall, and Metropolis's boundary moves cannot carry a 4 m² room across a house
    (Quail Oak: foyer–wc missed in 5 of 5 designs)."""
    rooms = prog["rooms"]; cell = site["cell"]
    runs = pair_runs(L)
    need = math.ceil(1.25 / cell - 1e-9)
    for e in prog["edges"]:
        if e.get("type") != "door": continue
        a, b = rooms[e["a"]], rooms[e["b"]]
        if a["storey"] != s or b["storey"] != s: continue
        circ, small = (a, b) if a["kind"] in ACCESS_CIRC else (b, a) if b["kind"] in ACCESS_CIRC else (None, None)
        if circ is None or (small.get("mu") or 99) > 7.5 or small.get("stair") or small.get("open_air"): continue
        ci, si = circ["id"] + 1, small["id"] + 1
        if runs.get((min(ci, si), max(ci, si)), 0) >= need: continue
        cm = L == ci
        if cm.sum() * cell * cell < (small["mu"] + 6): continue          # the circulation room cannot spare the area
        # hand the small room's old cells to its biggest neighbour
        old = L == si
        if old.any():
            from scipy import ndimage as nd_
            ring = nd_.binary_dilation(old) & ~old & (L > 0)
            nb = [v for v in L[ring].tolist() if v not in frozen and v != si]
            if nb: L[old] = max(set(nb), key=nb.count)
        ys, xs = np.nonzero(cm)
        side = max(2, int(round(math.sqrt(small["mu"]) / cell)))
        dep = max(2, int(math.ceil(small["mu"] / (side * cell * cell))))
        best = None
        for (yy, xx) in ((ys.max() - dep + 1, xs.min()), (ys.max() - dep + 1, xs.max() - side + 1), (ys.min(), xs.min()), (ys.min(), xs.max() - side + 1)):
            blk = np.zeros_like(cm); blk[max(0, yy):yy + dep, max(0, xx):xx + side] = True
            got = blk & cm
            if got.sum() < 0.7 * blk.sum(): continue
            rest = cm & ~got
            from scipy import ndimage as nd_
            if nd_.label(rest)[1] != 1: continue                         # the circulation room stays in one piece
            if best is None or got.sum() > best.sum(): best = got
        if best is not None:
            L[best] = si; runs = pair_runs(L)


def bfs_order(prog, s):
    rooms = [r for r in prog["rooms"] if r["storey"] == s]
    ids = {r["id"] for r in rooms}
    start = prog["entry"] if prog["entry"] in ids else (next((r["id"] for r in rooms if r.get("stair")), rooms[0]["id"]) if rooms else None)
    if start is None: return {}
    nb = {i: [] for i in ids}
    for e in prog["edges"]:
        if e["a"] in ids and e["b"] in ids: nb[e["a"]].append(e["b"]); nb[e["b"]].append(e["a"])
    out, q = {start: 0}, [start]
    while q:
        v = q.pop(0)
        for w in sorted(nb[v], key=lambda w: -(prog["rooms"][w].get("mu") or 0)):
            if w not in out: out[w] = len(out); q.append(w)
    return out


def strip(L, site, rooms, box, along_x):
    """Rooms side by side in one row along the corridor, each spanning the full depth of its side."""
    x0, y0, x1, y1 = box
    tot = sum(r.get("mu") or 8.0 for r in rooms)
    a0, a1 = (x0, x1) if along_x else (y0, y1)
    pos = a0
    for k, r in enumerate(rooms):
        end = a1 if k == len(rooms) - 1 else max(pos + 1, int(round(pos + (a1 - a0) * (r.get("mu") or 8.0) / tot)))
        _paint(L, site, r["id"] + 1, (pos, y0, end, y1) if along_x else (x0, pos, x1, end))
        pos = end


def _paint(L, site, lab, box):
    x0, y0, x1, y1 = box
    sub = site["mask"][y0:y1, x0:x1]
    L[y0:y1, x0:x1][sub] = lab


def treemap(L, site, rooms, box):
    if not rooms: return
    if len(rooms) == 1: _paint(L, site, rooms[0]["id"] + 1, box); return
    wt = lambda r: r.get("mu") or 8.0
    total = sum(wt(r) for r in rooms)
    acc, k = wt(rooms[0]), 1
    while k < len(rooms) - 1 and acc + wt(rooms[k]) <= total / 2: acc += wt(rooms[k]); k += 1
    t = acc / total
    x0, y0, x1, y1 = box
    if (y1 - y0) >= (x1 - x0):
        ym = max(y0 + 1, min(y1 - 1, int(round(y0 + (y1 - y0) * t))))
        treemap(L, site, rooms[:k], (x0, y0, x1, ym)); treemap(L, site, rooms[k:], (x0, ym, x1, y1))
    else:
        xm = max(x0 + 1, min(x1 - 1, int(round(x0 + (x1 - x0) * t))))
        treemap(L, site, rooms[:k], (x0, y0, xm, y1)); treemap(L, site, rooms[k:], (xm, y0, x1, y1))


def stair_candidates(sites, size):
    w, h = size
    m = np.logical_and.reduce([s["mask"] for s in sites])
    H, W = m.shape
    out = []
    for (ww, hh) in ((w, h), (h, w)):
        for y in range(0, H - hh + 1):
            for x in range(0, W - ww + 1):
                if m[y:y + hh, x:x + ww].all(): out.append((x, y, ww, hh))
    return out


# ------------------------------------------------------------------------------------------------ optimiser
def optimize(prog, sites, seed, iterations=None, beta=(0.03, 6.0)):
    R = Rng(stable_seed(seed))
    S = len(sites)
    stair_rooms = [r for r in prog["rooms"] if r.get("stair")]
    cands = stair_candidates(sites, prog["stair_size"]) if stair_rooms else []
    if stair_rooms and not cands: raise RuntimeError("no room for the stair")
    rect = R.pick(cands) if cands else None
    if cands and prog.get("layout") == "double_loaded":
        # the stair core straddles the corridor, a third of the way along it
        m = sites[0]["mask"]; ys, xs = np.nonzero(m)
        cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
        if (xs.max() - xs.min()) >= (ys.max() - ys.min()): tx, ty = xs.min() + (xs.max() - xs.min()) * 0.35, cy
        else: tx, ty = cx, ys.min() + (ys.max() - ys.min()) * 0.35
        rect = min(cands, key=lambda r: abs(r[0] + r[2] / 2 - tx) + abs(r[1] + r[3] / 2 - ty))
    cov1 = prog.get("upper_cover", {}).get(1, 1.0) if isinstance(prog.get("upper_cover"), dict) else 1.0
    if cands and cov1 < 0.99:
        # round 5 (2026-11-02): a partial upper floor starts at the back (initial()), so its stair stands under it, in the
        # back (1 − cover) share of the house, reached from the living room or a hall below (SERVE_ALT["stair"]).
        # Before, the stair-at-the-front rule pulled part of the upper floor forward (Stanford design 1: 49 % unsupported)
        m0 = sites[0]["mask"]; ys0, xs0 = np.nonzero(m0)
        y_up = ys0.min() + (ys0.max() + 1 - ys0.min()) * (1 - cov1)
        inside = [r_ for r_ in cands if r_[1] >= y_up]
        if inside:
            cands = inside
            rect = R.pick(sorted(cands, key=lambda r_: (min(r_[0] - xs0.min(), xs0.max() + 1 - (r_[0] + r_[2])), r_[1]))[:6])
    elif cands and MERGE_ACCESS and prog.get("layout") != "double_loaded" and any(r_["kind"] == "foyer" for r_ in prog["rooms"]):
        # merge (2026-10-31): a house's straight flight starts at the front, along a side wall, beside the foyer
        m0 = sites[0]["mask"]; ys0, xs0 = np.nonzero(m0); front_y = ys0.min()
        def sc(r_):
            x0_, y0_, w_, h_ = r_
            side = min(x0_ - xs0.min(), xs0.max() + 1 - (x0_ + w_))
            band = prog.get("porch_depth", 0) / sites[0]["cell"] + 1
            return abs((y0_ - front_y) - band) + 2 * side + (0 if h_ >= w_ else 6)
        best6 = sorted(cands, key=sc)[:6]
        rect = R.pick(best6)
    vest = [r for r in prog["rooms"] if r.get("street_door") and r["storey"] == 0]
    if cands and vest and prog.get("layout") != "double_loaded":
        # audit fix (2026-10-30): a stair with its own street vestibule starts on the street front, at one end of it,
        # so the vestibule can sit beside it on the front (the stair move can still relocate both)
        m0 = sites[0]["mask"]; ys0, xs0 = np.nonzero(m0)
        front = [r_ for r_ in cands if r_[1] == min(c_[1] for c_ in cands)]
        cands = front                       # the street stair stays on the street front: stair moves slide it along
        rect = min(front, key=lambda r_: (min(r_[0] - xs0.min(), xs0.max() + 1 - (r_[0] + r_[2])), R.next()))
    labels = initial(prog, sites, R, rect)
    if prog.get("initial_hook") is not None: prog["initial_hook"](labels)     # 2026-11-07: a caller's start (high-rise flats)
    if cands and vest and rect is not None:
        x0, y0, w, h = rect; c_ = sites[0]["cell"]; m0 = sites[0]["mask"]
        k = max(2, int(math.ceil(1.6 / c_))); dep = max(2, min(h, int(math.ceil(vest[0].get("mu", 4.5) / 1.6 / c_))))
        left = x0 - xs0.min() > xs0.max() + 1 - (x0 + w)          # the stair sits at the right end → vestibule to its left
        xa, xb = (x0 - k, x0) if left else (x0 + w, x0 + w + k)
        blk = np.zeros_like(m0); blk[y0:y0 + dep, max(0, xa):max(0, xb)] = True
        labels[0][blk & m0 & (labels[0] > 0)] = vest[0]["id"] + 1
    frozen = {r["id"] + 1 for r in stair_rooms}
    cur, _ = evaluate(labels, prog, sites)
    present_sets = [set(np.unique(l).tolist()) for l in labels]
    n_rooms = len(prog["rooms"])
    cells = int(sum(s_["mask"].sum() for s_ in sites))
    cap = 24000 if cells < 2500 else 12000 if cells < 5000 else 8000      # big plans cost more per step: fewer steps
    N = iterations or int(max(6000, min(cap, 900 * n_rooms)))
    best = ([l.copy() for l in labels], cur, rect)
    acc = 0
    for it in range(N):
        b = beta[0] * (beta[1] / beta[0]) ** (it / N)
        u, s = R.next(), R.int(S)
        L = labels[s]
        if stair_rooms and u < 0.05:
            new = R.pick(cands)
            saved = [l.copy() for l in labels]
            for k, LL in enumerate(labels):
                sid = [r for r in stair_rooms if r["storey"] == k][0]["id"] + 1
                old = LL == sid
                x0, y0, w, h = new
                LL[old] = 0
                block = np.zeros_like(old); block[y0:y0 + h, x0:x0 + w] = True
                # cells the stair leaves go to the room next to them
                LL[block] = sid
                for _ in range(30):
                    hole = (LL == 0) & old
                    if not hole.any(): break
                    for (dy, dx) in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nb = np.roll(LL, (dy, dx), (0, 1))
                        fill = hole & (nb > 0) & (nb != sid)
                        LL[fill] = nb[fill]
                        hole = (LL == 0) & old
            nxt, _ = evaluate(labels, prog, sites)
            if nxt <= cur or R.next() < math.exp(-b * (nxt - cur)): cur = nxt; rect = new; acc += 1; present_sets = [set(np.unique(l).tolist()) for l in labels]
            else:
                for k in range(S): labels[k][:] = saved[k]
        else:
            ids = [r["id"] for r in prog["rooms"] if r["storey"] == s and not r.get("stair")]
            before = present_sets[s]
            ch = slide(L, R, frozen, sites[s], [labels[k] for k in (s - 1, s + 1) if 0 <= k < S]) if u < 0.82 else swap(L, ids, R)
            if not ch: continue
            present = set(np.unique(L).tolist())
            if any((i + 1) in before and (i + 1) not in present for i in ids):   # a move may shrink a room, never delete it
                for y, x, v in reversed(ch): L[y, x] = v
                continue
            nxt, _ = evaluate(labels, prog, sites)
            if nxt <= cur or R.next() < math.exp(-b * (nxt - cur)): cur = nxt; acc += 1; present_sets[s] = present
            else:
                for y, x, v in reversed(ch): L[y, x] = v
        if it % 50 == 0:
            for s2, L2 in enumerate(labels):
                for r in prog["rooms"]:
                    if r["storey"] == s2 and not r.get("stair") and (r["id"] + 1) not in present_sets[s2]:
                        vals, cnt = np.unique(L2[L2 > 0], return_counts=True)
                        if not len(vals): continue
                        big = vals[np.argmax(cnt)]; ys, xs = np.nonzero(L2 == big)
                        k = R.int(len(ys)); y0, x0 = ys[k], xs[k]
                        L2[max(0, y0 - 2):y0 + 3, max(0, x0 - 2):x0 + 3][L2[max(0, y0 - 2):y0 + 3, max(0, x0 - 2):x0 + 3] == big] = r["id"] + 1
                        present_sets[s2] = set(np.unique(L2).tolist())
                        cur, _ = evaluate(labels, prog, sites)
        if cur < best[1]: best = ([l.copy() for l in labels], cur, rect)
    total, T, detail = evaluate(best[0], prog, sites, want_detail=True)
    return {"labels": best[0], "cost": total, "terms": T, "stair": best[2], "iterations": N, "accepted": acc}
