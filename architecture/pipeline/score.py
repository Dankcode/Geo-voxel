"""Score every mathematical algorithm of the FreeCAD design pipeline against Merrell, Schkufza & Koltun (2010).

Each algorithm gets   S = 1 + 9 · (0.4 · F + 0.6 · Q)   on a 1–10 scale, 7 = pass (0.4F + 0.6Q ≥ 2/3), where
  F ∈ [0, 1]  fidelity: share of the paper's specified elements the code implements (checklist below, each item
              scored 1 / 0.5 / 0 by reading the code; items the paper does not specify but codes require are marked)
  Q ∈ [0, 1]  outcome: a measured rate on the built test set, computed here from the plans, blueprints and specs
              (independently of the modules' own self-reports wherever the geometry allows).

Usage: python score.py <tag> <plan-dir> <spec-dir> <prefix> [findings.json]  → out/score/<tag>.json
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, glob, os, sys, math, pickle
import numpy as np
from shapely.geometry import Polygon, LineString, Point, box as sbox
from shapely.ops import unary_union
sys.path.insert(0, _HERE)

# ------------------------------------------------------------------------------------------------ fidelity checklists
# (item, paper section, value). Values are set by reading the code; FIDELITY_OVERRIDES lets a later version update them.
FIDELITY = {
    "A1 programme synthesis (§4)": [
        ("conditioned on requirements (area, storeys, use)", "§4", 1),
        ("ordered conditional choices, each on earlier ones (hand-specified network)", "§4", 1),
        ("per-room area distribution", "§4.1", 1),
        ("per-room aspect-ratio distribution (per room kind)", "§4.1", 0.5),
        ("adjacency existence and type (door / open wall)", "§4.1", 1),
        ("structure and CPTs learned from a plan corpus", "§4.2", 0),
        ("conditioning on any evidence subset (junction tree)", "§4.1", 0),
    ],
    "A2 proposal moves (§5.1)": [
        ("slide a wall after splitting it at a point", "§5.1", 1),
        ("split prioritises existing vertices, endpoints with p > 0", "§5.1", 0.5),
        ("d ~ N(0, σ²), σ = 2ε", "§5.1", 1),
        ("snap a moved wall to an existing wall within ε", "§5.1", 0),
        ("align walls with walls on neighbouring floors", "§5.1", 0),
        ("swap two rooms' labels", "§5.1", 1),
    ],
    "A3 Metropolis optimiser (§5)": [
        ("f(x) = exp(−βC(x))", "§5", 1), ("acceptance min(1, f(x*)/f(x))", "§5", 1), ("β annealing", "§5", 1),
        ("all storeys optimised jointly", "§5", 1), ("failure detection and restart", "§7", 1),
    ],
    "A4 accessibility cost C_a (§5.2)": [
        ("required connection needs a shared wall long enough for a door", "§5.2", 1),
        ("entrances / garages need outside access", "§5.2", 1), ("privacy gradient term", "§5.2", 1),
        ("reachability from the entrance (ours, audit gap 5)", "ours", 1),
    ],
    "A5 dimension cost C_d (§5.2)": [
        ("−log-likelihood of room area", "§5.2", 1), ("−log-likelihood of aspect ratio", "§5.2", 1),
        ("distributions from the learned network", "§5.2", 0.5),
    ],
    "A6 shape cost C_s (§5.2)": [
        ("M_c = (A(H) − A)/A + e(S)", "§5.2", 1), ("halls and stairs exempt", "§5.2", 1),
        ("open-wall groups judged as one space", "§5.2", 1), ("outline irregularity k_o Σ e(F_i)", "§5.2", 1),
    ],
    "A7 floor cost C_f (§5.2)": [
        ("C_f = Σ A(F_i − F_{i−1}) / Σ A(F_i) (ratio of sums)", "§5.2", 0.5),
        ("ground floor inside the lot F_0", "§5.2", 1), ("wet-room stacking (ours)", "ours", 1),
    ],
    "A8 door position (§6)": [
        ("interior doors minimise Σ distance to the nearest corner of both rooms", "§6", 1),
        ("front door replaces the entrance room's central window", "§6", 1),
        ("secondary exterior doors (back, side) also near corners", "§6", 0),
        ("a room's doors evaluated together (Alexander: keep the room's centre whole)", "§6", 0),
        ("jambs clear of the meeting walls", "ours", 1),
    ],
    "A9 passage type by privacy (§6)": [
        ("ordinary doors to private rooms", "§6", 1), ("glazed French doors to semi-private rooms", "§6", 1),
        ("wide openings between public rooms", "§6", 1),
    ],
    "A10 door swing and hinge (IBC/IRC, ours)": [
        ("exterior swing by occupant load (IBC 1010.1.2.1)", "code", 1), ("swing into rooms from circulation", "code", 1),
        ("hinge on the jamb nearer the swing room's corner", "code", 1), ("arc clear of other arcs, stair, room edge", "code", 1),
        ("arc clear of furniture, decided with the door position", "code", 0),
    ],
    "A11 windows (§6)": [
        ("regular intervals along each room's exterior walls", "§6", 1), ("size and type per room kind", "§6", 1),
        ("lower roof in the way → smaller window or none", "§6", 1), ("central window of the entrance room → front door", "§6", 1),
    ],
    "A12 stairs (§6)": [
        ("form from the stair space: straight / U / L", "§6", 1), ("width ≥ 36 in", "§6", 1),
        ("tread 9–11 in", "§6", 1), ("riser ≤ 8¼ in", "§6", 1),
    ],
    "A13 roofs (§6)": [
        ("straight skeleton → hipped roof", "§6", 1), ("gables by projecting faces onto the facade", "§6", 1),
        ("roof angle / overhang / gables from the style template", "§6", 1),
    ],
    "A14 failure gate (§7)": [("detect C_a > 0 and other failures", "§7", 1), ("re-run with a new seed", "§7", 1)],
    # 2026-10-30: furniture from Germer & Schwarz 2009 (GS) + Merrell et al. 2011 (M11); garages; porches
    "A15 furniture layout (GS 2009 + Merrell 2011)": [
        ("agents: oriented box, parent classes and the parent side to attach to", "GS §3.1–3.2", 1),
        ("parents placed before children (priority by hierarchy depth)", "GS §3.2", 1),
        ("collision test on boxes, except with the agent's own parent", "GS §3.1", 1),
        ("room parts (walls, floor, corners) as root parents; only real walls are walls", "GS §4", 1),
        ("agent deleted or replaced by a smaller one when the room is full", "GS §3.2", 1),
        ("deterministic per-room seed (persistent interiors)", "GS §4.1", 1),
        ("clearance violation m_cv from Table 1 (Minkowski sums)", "M11 §2.1", 1),
        ("circulation m_ci: components of C_free for an 18 in person disk", "M11 §2.1", 1),
        ("pairwise distance and angle m_pd, m_pa with t(d, m, M, α)", "M11 §2.1", 1),
        ("conversation m_cd (4–8 ft), m_ca", "M11 §2.1", 1),
        ("visual balance m_vb", "M11 §2.2", 1), ("alignment m_fa, m_wa", "M11 §2.2", 1),
        ("emphasis m_ef and symmetry m_sy about a focal point", "M11 §2.2", 1),
        ("Metropolis–Hastings, symmetric moves (re-pose, swap)", "M11 §3.1", 1),
        ("user groups and focal points (fixed per room kind here)", "M11 §2.3", 0.5),
        ("parallel tempering on the GPU", "M11 §3.2", 0), ("diversified suggestions (maximal marginal relevance)", "M11 §3.1", 0),
    ],
    "A16 garage and car (ours)": [
        ("sedan at real size: 2025 Camry 4920 × 1840 × 1445 mm, mirrors 2120 mm", "ours", 1),
        ("garage sized from the car and its clearances (programme + planner)", "ours", 1),
        ("overhead door on a short end: the car drives straight in", "ours", 1),
        ("car parked nose in, rear to the door, path through the door clear", "ours", 1), ("gate check", "ours", 1),
    ],
    "A17 porches (Merrell 2010 Fig. 1, 7)": [
        ("porch from mapped OSM porch / roof parts", "ours", 1), ("porch by style when the map has none", "ours", 1),
        ("porch on the street front, entry through it (planner band + gate)", "ours", 1),
        ("roofed porch with posts and steps in the model", "ours", 1), ("porch furniture", "ours", 1),
    ],
    "A18 real-house fidelity (public records, ours)": [
        ("public record / listing lookup per house, cited (house_facts.py)", "ours", 1),
        ("bedrooms from the record, else from listing-calibrated area thresholds", "ours", 1),
        ("baths and garage bays from the record or street listings", "ours", 1),
        ("upper floor sized from the recorded living area", "ours", 1),
        ("houses with no record fall back to footprint rules (Park Blvd)", "ours", 0.5),
    ],
    "A19 halls and stairs (Merrell 2010 §5.2, IRC R311.6 / R311.7.6)": [
        ("halls carry an area distribution in C_d like every room (Merrell §5.2)", "M10 §5.2", 1),
        ("halls exempt from the convexity term only (h_i)", "M10 §5.2", 1),
        ("hall width ≤ 2 m away from the stair landing (corridor, IRC R311.6 ≥ 914 mm)", "ours", 1),
        ("stair climbs the way its foot and head are reached; landing at both (R311.7.6)", "ours", 1),
        ("stair-wide opening at the foot and head", "ours", 1),
    ],
}
PASS_AT = float(os.environ.get("PASS_AT", 8))
FIDELITY_OVERRIDES = json.loads(os.environ.get("FIDELITY_OVERRIDES", "{}"))      # {"A2 …": {"item text": value}}


def fidelity(name):
    items = FIDELITY[name]; ov = FIDELITY_OVERRIDES.get(name, {})
    vals = [ov.get(t, v) for t, _, v in items]
    return sum(vals) / len(vals), [(t, ov.get(t, v)) for t, _, v in items]


# ------------------------------------------------------------------------------------------------ helpers
CIRC = {"hall", "corridor", "stair", "foyer", "lobby", "landing"}
HABIT = {"living", "dining", "kitchen", "bedroom", "study", "office", "family", "sales", "meeting", "open_office", "classroom",
         "library", "staff", "dining_room", "chamber", "nave", "gallery_room", "lobby"}


def max_rect(M):
    """Largest all-True axis-aligned rectangle in a boolean raster (histogram method), in cells."""
    H, W = M.shape; h = np.zeros(W, int); best = 0
    for y in range(H):
        h = np.where(M[y], h + 1, 0)
        st = []
        for x in range(W + 1):
            cur = h[x] if x < W else 0
            start = x
            while st and st[-1][1] >= cur:
                s0, hh = st.pop(); best = max(best, hh * (x - s0)); start = s0
            st.append((start, cur))
    return best


def raster(P, step=100):
    minx, miny, maxx, maxy = P.bounds
    xs = np.arange(minx + step / 2, maxx, step); ys = np.arange(miny + step / 2, maxy, step)
    from shapely import contains_xy
    X, Y = np.meshgrid(xs, ys)
    return contains_xy(P, X, Y)


def wall_runs(L, interior_only=True):
    """Maximal straight runs of label boundary (any pair), in cells: list of (axis, line, k0, k1)."""
    H, W = L.shape; out = []
    for x in range(W - 1):
        b = (L[:, x] != L[:, x + 1]) & ((L[:, x] > 0) & (L[:, x + 1] > 0) if interior_only else True)
        out += [("y", x + 1, a, e) for a, e in _segs(b)]
    for y in range(H - 1):
        b = (L[y, :] != L[y + 1, :]) & ((L[y, :] > 0) & (L[y + 1, :] > 0) if interior_only else True)
        out += [("x", y + 1, a, e) for a, e in _segs(b)]
    return out


def _segs(b):
    segs, k = [], 0; n = len(b)
    while k < n:
        if b[k]:
            j = k
            while j + 1 < n and b[j + 1]: j += 1
            segs.append((k, j + 1)); k = j + 1
        else: k += 1
    return segs


def wall_edges(L):
    """Set of unit cell edges that carry an interior wall: ('v', x, y) between (y,x-1)|(y,x); ('h', x, y) between rows."""
    E = set(); H, W = L.shape
    ys, xs = np.nonzero((L[:, :-1] != L[:, 1:]) & (L[:, :-1] > 0) & (L[:, 1:] > 0)); E |= {("v", x + 1, y) for y, x in zip(ys, xs)}
    ys, xs = np.nonzero((L[:-1, :] != L[1:, :]) & (L[:-1, :] > 0) & (L[1:, :] > 0)); E |= {("h", x, y + 1) for y, x in zip(ys, xs)}
    return E


# ------------------------------------------------------------------------------------------------ per-building metrics
def building_metrics(plan, bp, spec, findings):
    import doorlogic as DL, planner as PL, blueprint as BPm
    rooms = plan["program"]["rooms"]; edges = plan["program"]["edges"]; labels = [np.array(L) for L in plan["labels"]]
    cell = plan["cell"]; S = len(labels); st = bp["style"]
    M = {}
    # A1 programme validity
    ok = []
    for s in range(S):
        ids = [r["id"] for r in rooms if r["storey"] == s and not r.get("unit") is not None or (r["storey"] == s and r.get("unit") is None)]
        ids = [r["id"] for r in rooms if r["storey"] == s and r.get("unit") is None]
        if not ids: continue
        nb = {i: set() for i in ids}
        for e in edges:
            if e["a"] in nb and e["b"] in nb: nb[e["a"]].add(e["b"]); nb[e["b"]].add(e["a"])
        # every connected part of the storey must hold a way in: the entry, a room with its own street door
        # (a separate tenancy), or — upstairs — a stair
        roots = [i for i in ids if i == plan["program"]["entry"] or rooms[i].get("street_door") or rooms[i].get("stair")] or ids[:1]
        seen = set(roots); q = list(roots)
        while q:
            v = q.pop()
            for w in nb[v]:
                if w not in seen: seen.add(w); q.append(w)
        ok.append(len(seen) == len(ids))
    kbb = 0
    for r in rooms:
        if r["kind"] in ("bathroom", "wc"):
            ks = {rooms[e["b"] if e["a"] == r["id"] else e["a"]]["kind"] for e in edges if r["id"] in (e["a"], e["b"])}
            if "kitchen" in ks and "bedroom" in ks: kbb += 1
    fits = []
    for s in range(S):
        usable = float((labels[s] > 0).sum()) * cell * cell
        tot = sum(r.get("mu") or 0 for r in rooms if r["storey"] == s and r.get("unit") is None and not r.get("subdivided"))
        tot += sum(r.get("mu") or 0 for r in rooms if r["storey"] == s and r.get("subdivided"))
        if usable > 0 and tot > 0: fits.append(0.55 <= tot / usable <= 1.05)
    ent = rooms[plan["program"]["entry"]]
    M["A1"] = np.mean([all(ok), kbb == 0, all(fits) if fits else True, ent["tier"] in ("public", "porch")])
    # A2 move quality: cross-floor wall alignment and short jogs
    jog, runs_n = 0, 0
    for L in labels:
        R = wall_runs(L)
        runs_n += len(R); jog += sum(1 for _, _, a, e in R if (e - a) * cell <= 0.61)          # ≤ 2 ft: offsets a snap would remove
    M["A2_jog"] = jog / max(1, runs_n)
    if S > 1:
        al = []
        for s in range(1, S):
            up, lo = wall_edges(labels[s]), wall_edges(labels[s - 1])
            ext_lo = set()
            Lm = labels[s - 1]; H, W = Lm.shape
            # the lower storey's exterior wall also supports
            for y in range(H):
                for x in range(W):
                    if Lm[y, x] > 0:
                        if x == 0 or Lm[y, x - 1] <= 0: ext_lo.add(("v", x, y))
                        if x == W - 1 or Lm[y, x + 1] <= 0: ext_lo.add(("v", x + 1, y))
                        if y == 0 or Lm[y - 1, x] <= 0: ext_lo.add(("h", x, y))
                        if y == H - 1 or Lm[y + 1, x] <= 0: ext_lo.add(("h", x, y + 1))
            sup = lo | ext_lo
            near = lambda e: any((e[0], e[1] + dx, e[2]) in sup for dx in (-1, 0, 1)) if e[0] == "v" else any((e[0], e[1], e[2] + dy) in sup for dy in (-1, 0, 1))
            al += [near(e) for e in up]
        M["A2_align"] = float(np.mean(al)) if al else 1.0
    # A3 optimiser convergence
    T = plan.get("terms", {})
    M["A3"] = float(T.get("a", 1) == 0 and T.get("v", 1) == 0)
    # A4 accessibility in the built blueprint
    A = bp["audit"]; nd = sum(1 for e in edges if e["type"] in ("door", "open"))
    M["A4"] = (1 - len(A["missing_edges"]) / max(1, nd)) * (0 if A["unreachable"] else 1)
    # A5 dimensions
    within, n5 = 0, 0
    asp_ok = 0
    for r in rooms:
        if not r.get("mu") or r.get("subdivided"): continue
        m = labels[r["storey"]] == r["id"] + 1
        if not m.any(): continue
        a = m.sum() * cell * cell; n5 += 1
        within += abs(a - r["mu"]) <= r["sigma"]
        ys, xs = np.nonzero(m); bw, bh = np.ptp(xs) + 1, np.ptp(ys) + 1
        asp_ok += max(bw, bh) / min(bw, bh) <= r.get("max_aspect", 2.0) + 1e-9 or r["kind"] in CIRC
    M["A5_within"] = within / max(1, n5); M["A5_aspect"] = asp_ok / max(1, n5)
    # A6 shape
    good, n6 = 0, 0
    for r in rooms:
        if r["kind"] in CIRC or r.get("subdivided"): continue
        m = labels[r["storey"]] == r["id"] + 1
        if not m.any(): continue
        ys, xs = np.nonzero(m); crop = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        n6 += 1; good += PL.mc(crop) <= 0.25 + 1e-9
    M["A6"] = good / max(1, n6)
    # A7 floors: paper's ratio of sums
    if S > 1:
        num = sum(((labels[s] > 0) & ~(labels[s - 1] > 0)).sum() for s in range(1, S)); den = sum((labels[s] > 0).sum() for s in range(1, S))
        M["A7"] = 1 - num / max(1, den)
    # A8 / A10 doors (independent geometry)
    import doors2 as D2
    polys = [D2.clear_polys(plan, s, st) for s in range(S)]      # clear floor inside interior AND exterior wall faces
    fur = [f for f in spec.get("furniture", [])] if spec else []
    fps = {}
    if fur:
        import checks as CK
        for f in fur:
            P, h = CK.placed_fp(f)
            if P is not None: fps.setdefault(f["storey"], []).append(P)
    near, mid, n8, conflicts, nd10, rest = 0, 0, 0, 0, 0, 0
    usable = []
    for s, specs in enumerate(bp["specs"]):
        doors_by_room = {}
        arcs_all = []
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] != "door": continue
                for lab in (sp["inner"], sp["outer"]):
                    if lab > 0 and not rooms[lab - 1].get("open_air"): doors_by_room.setdefault(lab, []).append((sp, o))
                sw = o.get("swing") or {}
                if o.get("ptype") == "cased" or o.get("entry"): continue
                n8 += 1
                # nearest-corner distance in each indoor room along this run
                ds = []
                for e0, e1 in ([sp["ext_in"]] + ([sp["ext_out"]] if sp["outer"] > 0 else [])):
                    ds.append(max(0.0, min(o["pos"] - o["w"] / 2 - e0, e1 - (o["pos"] + o["w"] / 2))))
                if min(ds) <= 450: near += 1
                for e0, e1 in ([sp["ext_in"]] + ([sp["ext_out"]] if sp["outer"] > 0 else [])):
                    Lw = e1 - e0
                    if Lw >= 2400 and abs(o["pos"] - (e0 + e1) / 2) < Lw / 6: mid += 1; break
                if sw.get("kind") in ("single", "french"):
                    nd10 += 1
                    arcs = [Polygon(a) for a in sw.get("arcs", [])]
                    tgt = sw.get("into", 0); P = polys[s].get(tgt)
                    bad = False
                    for a in arcs:
                        if P is not None and a.difference(P.buffer(30)).area > 0.02 * a.area: bad = True
                        if any(a.intersection(b).area > 0.01 * a.area for b in arcs_all): bad = True
                        if fps.get(s) and a.intersection(unary_union(fps[s])).area > 1e4: bad = True
                    arcs_all += arcs
                    conflicts += bad
                    # leaf rests against a wall: hinge within 300 mm of the swing room's wall end
                    e0, e1 = sp["ext_in"] if tgt == sp["inner"] else sp["ext_out"]
                    hx = sw["leaves"][0]["hinge"]; hp = hx[0] if sp["axis"] == "x" else hx[1]
                    rest += min(abs(hp - e0), abs(e1 - hp)) <= 300 + (sp["d1"] - sp["d0"]) or sw["kind"] == "french"
        # Alexander usability: largest clear rectangle after arcs and movement lanes, relative to the bare room
        for lab, ds_ in doors_by_room.items():
            r = rooms[lab - 1]
            if r["kind"] not in HABIT or lab not in polys[s]: continue
            P = polys[s][lab]
            if P.is_empty or P.area < 4e6: continue
            base = max_rect(raster(P))
            if not base: continue
            cuts = []
            pts = []
            for sp, o in ds_:
                sw = o.get("swing") or {}
                cuts += [Polygon(a) for a in sw.get("arcs", []) if sw.get("into") == lab]
                # approach point 600 mm inside the room
                sign = 1 if ((sp["axis"] == "x" and P.centroid.y > sp["line"]) or (sp["axis"] == "y" and P.centroid.x > sp["line"])) else -1
                pt = (o["pos"], sp["line"] + sign * 600) if sp["axis"] == "x" else (sp["line"] + sign * 600, o["pos"])
                pts.append(pt)
                cuts.append(Point(pt).buffer(450))
            for i in range(len(pts)):
                for j in range(i + 1, len(pts)):
                    cuts.append(LineString([pts[i], pts[j]]).buffer(450))
            free = P.difference(unary_union(cuts)) if cuts else P
            usable.append(max_rect(raster(free)) / base if not free.is_empty else 0.0)
    M["A8_near"] = near / max(1, n8); M["A8_mid"] = mid / max(1, n8); M["A8_usable"] = float(np.mean(usable)) if usable else 1.0
    M["A8_n"] = n8; M["A8_usable_n"] = len(usable)
    M["A10"] = 1 - conflicts / max(1, nd10); M["A10_rest"] = rest / max(1, nd10)
    # A9 passage types recomputed from the rule
    import openings as O
    agree, n9 = 0, 0
    for specs in bp["specs"]:
        for sp in specs:
            if sp["ext"]: continue
            for o in sp["openings"]:
                if o["kind"] != "door" or o.get("repair") or not o.get("ptype"): continue
                ka, kb = rooms[sp["inner"] - 1]["kind"], rooms[sp["outer"] - 1]["kind"]
                big = ka in ("nave", "sales", "warehouse", "classroom", "dining_room") or kb in ("nave", "sales", "warehouse")
                want = O.passage_type(ka, kb)
                if big: want = "cased"
                if ka in ("bathroom", "wc", "wc_block") or kb in ("bathroom", "wc", "wc_block"): want = "hinged"
                n9 += 1; agree += o["ptype"] == want or (want != "hinged" and o["ptype"] == "hinged" and o["w"] <= 900)
    M["A9"] = agree / max(1, n9)
    # A11 windows: daylight rooms lit, bedroom egress, glazing ≥ 8 % of floor area (IRC R303.1)
    win = {}
    for specs in bp["specs"]:
        for sp in specs:
            if not sp["ext"] or sp["party"]: continue
            for o in sp["openings"]:
                if o["kind"] == "window": win.setdefault(sp["inner"], []).append(o["win"])
                if o["kind"] == "bay": win.setdefault(sp["inner"], []).extend(o["bay_wins"])
    dl = [r for r in rooms if r.get("daylight") and not r.get("subdivided") and r["kind"] not in ("warehouse",)]
    opn = {}
    for e in edges:
        if e["type"] == "open": opn.setdefault(e["a"] + 1, set()).add(e["b"] + 1); opn.setdefault(e["b"] + 1, set()).add(e["a"] + 1)
    lit = [bool(win.get(r["id"] + 1)) or any(win.get(n) for n in opn.get(r["id"] + 1, ())) for r in dl]      # IRC R303.2
    g8 = []
    for r in dl:
        P = polys[r["storey"]].get(r["id"] + 1)
        if P is None or P.is_empty: continue
        g = sum(w["w"] * w["h"] for w in win.get(r["id"] + 1, [])) / 1e6
        g8.append(g >= 0.08 * P.area / 1e6)
    beds = [r for r in rooms if r["kind"] == "bedroom" and not r.get("subdivided")]
    eg = [any(BPm.egress(w) for w in win.get(r["id"] + 1, [])) for r in beds]
    M["A11_lit"] = float(np.mean(lit)) if lit else 1.0; M["A11_g8"] = float(np.mean(g8)) if g8 else 1.0; M["A11_egress"] = float(np.mean(eg)) if eg else 1.0
    # A12 stairs
    if bp["stairs"]:
        M["A12"] = float(np.mean([not D.get("too_small") and D["R"] <= 210 and 229 <= D["T"] <= 279 and D["W"] >= 914 for D in bp["stairs"].values()]))
    # A13 roofs
    M["A13"] = 0.0 if any(f["check"].startswith("R") for f in (findings or [])) else 1.0
    # A14 gate
    M["A14"] = float(all(c["ok"] for c in bp["checks"]))
    # A2 per design: upper partitions over a lower wall; short wall runs
    jog = n = 0
    for L_ in labels:
        R_ = wall_runs(L_); n += len(R_); jog += sum(1 for _, _, a, e in R_ if (e - a) * cell <= 0.61)
    al = []
    for s_ in range(1, S):
        up, lo = wall_edges(labels[s_]), wall_edges(labels[s_ - 1]); Lm = labels[s_ - 1]; H, W = Lm.shape; ext = set()
        for y in range(H):
            for x in range(W):
                if Lm[y, x] > 0:
                    if x == 0 or Lm[y, x - 1] <= 0: ext.add(("v", x, y))
                    if x == W - 1 or Lm[y, x + 1] <= 0: ext.add(("v", x + 1, y))
                    if y == 0 or Lm[y - 1, x] <= 0: ext.add(("h", x, y))
                    if y == H - 1 or Lm[y + 1, x] <= 0: ext.add(("h", x, y + 1))
        sup = lo | ext
        al += [any((e[0], e[1] + k, e[2]) in sup for k in (-1, 0, 1)) if e[0] == "v" else any((e[0], e[1], e[2] + k) in sup for k in (-1, 0, 1)) for e in up]
    M["A2_jog"] = jog / max(1, n)
    if al: M["A2_align"] = float(np.mean(al))
    # A15 furniture: Germer & Schwarz + Merrell 2011 terms per room (furnish2.REPORT)
    try:
        import layout as LAY, furnish2 as F2, spec as SPm
        lib, ITEMS_, RI_ = SPm.furniture_library()
        LAY.furnish(plan, st, bp["specs"], ITEMS_, RI_)
        rep = F2.REPORT.get(str(plan.get("id")), {"rooms": [], "garages": []})
        qs, fl = [], []
        for rr in rep["rooms"]:
            if rr["kind"] == "garage": continue
            T_ = rr.get("terms", {})
            q = 0.4 * (not rr["missing"]) + 0.2 * (T_.get("cv", 0) <= 0.05) + 0.2 * (T_.get("ci", 0) == 0) + 0.2 * ((T_.get("pd", 0) + T_.get("pa", 0)) <= 0.5)
            qs.append(q); fl += rr.get("flush", [])
        if qs:
            M["A15_room"] = float(np.mean(qs)); M["A15_flush"] = float(np.mean(fl)) if fl else 1.0
            M["A15_rooms"] = [dict(kind=rr["kind"], cost=rr["cost"], placed=rr["placed"], missing=rr["missing"], terms=rr.get("terms", {})) for rr in rep["rooms"]]
    except Exception as e:
        M["A15_error"] = str(e)[:200]
    # A16 garage
    if any(r["kind"] == "garage" for r in rooms):
        import furnish2 as F2
        G = F2.garage_fit(plan, bp)
        M["A16"] = float(np.mean([bool(g and g["ok"]) for g in G])) if G else 0.0
        M["A16_fit"] = [{k: (int(v) if isinstance(v, (int, float, np.integer, np.floating)) and k != "ok" else v) for k, v in (g or {}).items() if k in ("front", "left", "right", "door_w", "ok")} for g in G]
    # A17 porch
    ARCH_H = ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse")
    if plan["theme"]["archetype"] in ARCH_H:
        porch_chk = [c for c in bp["checks"] if c["check"].startswith("front porch")]
        has = any(r["kind"] == "porch" for r in rooms)
        M["A17"] = float(porch_chk[0]["ok"]) if porch_chk else (0.0 if any("OSM" in l and "porch" in l for l in plan["program"]["log"]) else 0.5)
        M["A17_has"] = has
    # A18 real house (2026-11-02): model vs the public record / street listings
    try:
        import house_facts as HF
        Fct = HF.get(plan.get("id"))
        if Fct is not None and plan["theme"]["archetype"] in ARCH_H:
            oa = [r["id"] + 1 for r in rooms if r.get("open_air") or r["kind"] == "garage" or r.get("stair")]
            c2 = plan["cell"] ** 2
            living = sum(float(((np.array(L) > 0) & ~np.isin(np.array(L), oa)).sum()) * c2 for L in plan["labels"]) * HF.SQFT_M2
            nb = sum(1 for r in rooms if r["kind"] == "bedroom"); nbath = sum(1 for r in rooms if r["kind"] == "bathroom")
            cars = sum(r.get("cars", 0) for r in rooms if r["kind"] == "garage")
            want_b = Fct.get("beds") or HF.beds_for(Fct.get("living_sqft") or living)
            parts = [1.0 if nb == want_b else max(0.0, 1 - abs(nb - want_b) / 2)]
            if Fct.get("baths_full"): parts.append(1.0 if nbath == Fct["baths_full"] else 0.5 if abs(nbath - Fct["baths_full"]) == 1 else 0.0)
            if Fct.get("garage_cars"): parts.append(1.0 if cars == Fct["garage_cars"] else 0.0)
            if Fct.get("living_sqft"):
                err = abs(living - Fct["living_sqft"]) / Fct["living_sqft"]
                parts.append(max(0.0, 1 - max(0.0, err - 0.15) / 0.5))      # full marks within 15 %, zero at 65 %
            M["A18"] = float(np.mean(parts)); M["A18_detail"] = dict(living_sqft=round(living), record=Fct.get("living_sqft"), beds=nb, want_beds=want_b, baths=nbath, cars=cars)
    except Exception as e:
        M["A18_error"] = str(e)[:200]
    # A19 halls and stairs
    hq = []
    for s_, L in enumerate(plan["labels"]):
        La = np.array(L)
        for r in rooms:
            if r["storey"] != s_ or r["kind"] not in ("hall", "corridor", "landing") or not r.get("mu"): continue
            a = float((La == r["id"] + 1).sum()) * plan["cell"] ** 2
            if a == 0: continue
            hq.append(1.0 if abs(a - r["mu"]) <= r.get("sigma", 0.35 * r["mu"]) else max(0.0, 1 - (abs(a - r["mu"]) - r["sigma"]) / (2 * r["mu"])))
    st_ = [c for c in bp["checks"] if c["check"].startswith("stair foot and head")]
    if hq or st_:
        M["A19"] = float(np.mean(hq + [float(c["ok"]) for c in st_]))
    return M


# ------------------------------------------------------------------------------------------------ outcome Q per algorithm
def outcome(all_m):
    def mean(k, filt=None):
        v = [m[k] for m in all_m.values() if k in m and (filt is None or filt(m))]
        return float(np.mean(v)) if v else None
    Q = {}
    Q["A1 programme synthesis (§4)"] = (mean("A1"), "mean share of 4 programme tests passed (connected per storey, no kitchen–bath–bedroom, Σμ fits usable area, public entry)")
    al = mean("A2_align"); jog = mean("A2_jog")
    Q["A2 proposal moves (§5.1)"] = (0.5 * (al if al is not None else 1) + 0.5 * (1 - jog), f"½·upper walls over a lower wall ({'n/a' if al is None else f'{al:.2f}'}) + ½·(1 − share of wall runs ≤ 2 ft, {jog:.2f})")
    Q["A3 Metropolis optimiser (§5)"] = (mean("A3"), "share of plans ending with C_a = 0 and no broken room")
    Q["A4 accessibility cost C_a (§5.2)"] = (mean("A4"), "realised share of programme connections × all rooms reachable")
    w, a = mean("A5_within"), mean("A5_aspect")
    Q["A5 dimension cost C_d (§5.2)"] = (0.5 * min(1, w / 0.683) + 0.5 * a, f"½·min(1, share within ±1σ of μ ({w:.2f}) / 0.683) + ½·aspect within limit ({a:.2f})")
    Q["A6 shape cost C_s (§5.2)"] = (mean("A6"), "share of rooms with M_c ≤ 0.25")
    Q["A7 floor cost C_f (§5.2)"] = (mean("A7"), "1 − Σ A(F_i − F_{i−1}) / Σ A(F_i), multi-storey buildings")
    n, md, us = mean("A8_near"), mean("A8_mid"), mean("A8_usable")
    Q["A8 door position (§6)"] = ((n + (1 - md) + us) / 3, f"⅓·doors within 450 mm of a corner ({n:.2f}) + ⅓·(1 − mid-wall share {md:.2f}) + ⅓·room usability ({us:.2f})")
    Q["A9 passage type by privacy (§6)"] = (mean("A9"), "share of interior passages whose type matches the §6 rule")
    c, r = mean("A10"), mean("A10_rest")
    Q["A10 door swing and hinge (IBC/IRC, ours)"] = (0.6 * c + 0.4 * r, f"0.6·swings clear of room edge, other arcs and furniture ({c:.2f}) + 0.4·open leaf rests against a wall ({r:.2f})")
    l, g, e = mean("A11_lit"), mean("A11_g8"), mean("A11_egress")
    Q["A11 windows (§6)"] = ((l + g + e) / 3, f"⅓·daylight rooms with a window ({l:.2f}) + ⅓·glazing ≥ 8 % of floor ({g:.2f}) + ⅓·bedroom egress ({e:.2f})")
    Q["A12 stairs (§6)"] = (mean("A12"), "share of stairs within the §6 limits")
    Q["A13 roofs (§6)"] = (mean("A13"), "share of buildings with no roof finding (R1–R10)")
    Q["A14 failure gate (§7)"] = (mean("A14"), "share of buildings passing every gate check")
    rq, fq = mean("A15_room"), mean("A15_flush")
    Q["A15 furniture layout (GS 2009 + Merrell 2011)"] = ((0.8 * rq + 0.2 * fq) if rq is not None else None,
        f"0.8·room quality (required items, m_cv ≤ 0.05 m², m_ci = 0, m_pd + m_pa ≤ 0.5: {rq if rq is None else round(rq, 2)}) + 0.2·wall items flush ({fq if fq is None else round(fq, 2)})")
    Q["A16 garage and car (ours)"] = (mean("A16"), "share of garages where the sedan drives in and parks with ≥ 600 mm in front, ≥ 400/600 mm at the sides")
    Q["A17 porches (Merrell 2010 Fig. 1, 7)"] = (mean("A17"), "share of houses whose porch faces the street and opens into the house (no porch: 0.5)")
    Q["A18 real-house fidelity (public records, ours)"] = (mean("A18"), "mean of: bedrooms, full baths and garage bays as recorded; living area within 15 % of the record (zero at 65 %)")
    Q["A19 halls and stairs (Merrell 2010 §5.2, IRC R311.6 / R311.7.6)"] = (mean("A19"), "share of halls within ±1σ of their area target and stairs with a landing at foot and head")
    return Q


def score_table(all_m):
    Q = outcome(all_m); rows = []
    for name in FIDELITY:
        F, items = fidelity(name); q, how = Q[name]
        q = 1.0 if q is None else q
        S = 1 + 9 * (0.4 * F + 0.6 * q)
        rows.append(dict(algorithm=name, F=round(F, 3), Q=round(q, 3), score=round(S, 1), passed=S >= PASS_AT, how=how, items=items, applies=Q[name][0] is not None))
    return rows


def design_scores(all_m):
    """Competition: every design scored on its own metrics. Design score = mean of the algorithm scores that apply to it
    (stairs only with two storeys, garage only with a garage …); a design passes at PASS_AT with a clean gate."""
    out = {}
    for k, m in all_m.items():
        rows = score_table({k: m})
        ap = [r for r in rows if r["applies"]]
        sc = float(np.mean([r["score"] for r in ap]))
        roof_ok = m.get("A13", 1) >= 1          # 2026-11-02: the exterior meets the roof criteria (no R1–R10 finding) to pass
        out[k] = dict(score=round(sc, 2), gate=bool(m.get("A14")), roof_ok=bool(roof_ok), passed=bool(m.get("A14")) and roof_ok and sc >= PASS_AT,
                      low=[(r["algorithm"], r["score"]) for r in ap if r["score"] < PASS_AT],
                      per={r["algorithm"]: r["score"] for r in ap})
    return out


def run(tag, plan_dir, spec_dir, prefix, findings_path=None, names=None):
    F = json.load(open(findings_path)) if findings_path else {}
    all_m = {}
    for f in sorted(glob.glob(f"{plan_dir}/plan-*.json")):
        key = os.path.basename(f)[5:-5]
        if names and key not in names: continue
        name = f"{prefix}-{key}"
        pk = f"{spec_dir}/{name}.bp.pkl"
        if not os.path.exists(pk): continue
        plan = json.load(open(f)); plan.setdefault("key", key)
        bp = pickle.load(open(pk, "rb"))
        spec = json.load(open(f"{spec_dir}/{name}.json")) if os.path.exists(f"{spec_dir}/{name}.json") else None
        all_m[key] = building_metrics(plan, bp, spec, F.get(name))
    rows = score_table(all_m)
    os.makedirs(_ARCH_OUT + "/score", exist_ok=True)
    json.dump(dict(tag=tag, buildings=sorted(all_m), metrics=all_m, scores=rows), open(f"{_ARCH_OUT}/score/{tag}.json", "w"), indent=1,
              default=lambda o: o.item() if hasattr(o, "item") else str(o))
    for r in rows: print(f"{r['score']:5.1f} {'PASS' if r['passed'] else 'FAIL'}  F={r['F']:.2f} Q={r['Q']:.2f}  {r['algorithm']}  — {r['how']}")
    return rows, all_m


if __name__ == "__main__":
    run(*sys.argv[1:6])
