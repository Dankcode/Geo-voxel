"""Door redesign (v2): every door of a storey is placed together — position, leaf width, swing side, hinge, pocket —
by minimising one explicit cost, instead of edge by edge with the swing decided afterwards.

Why: the v1 greedy placer put each door at its own best corner and only then chose the swing, so a room's doors
were never judged together (Alexander's point quoted in Merrell §6 is about the *pattern of movement* through the
room), back doors went to the middle of the wall (rb16), and a leaf could only be flipped, not moved, when it clashed.

Variables per door d: run r_d (any wall the two rooms share; for back doors any non-party, non-front exterior wall
of the room), centre p_d (100 mm steps), width w_d (the programme width, then 100 mm narrower steps to 700 mm),
operation o_d ∈ {swing into the rule's room × hinge at either jamb, swing into the other room × either jamb (interior
only), pocket leaf into the wall on either side (interior single doors where the wall can hide it)}.

Cost of a storey (all lengths in metres):
    J = Σ_d [ k_c · C_d  +  k_r · R_d  +  k_l · Λ_d  +  k_w · (w⁰_d − w_d)/0.1  +  k_o · [o_d ≠ rule]  +  k_p · [o_d = pocket] ]
      + Σ_rooms k_u · (1 − U_room)  +  k_x · Σ_{d<e} [arcs of d and e overlap]
  C_d  Merrell §6:  Σ_{rooms a, b} min(p − w/2 − e₀, e₁ − (p + w/2))   (distance to the nearest corner in each room)
  R_d  hinge return: distance from the hinge jamb to the swing room's wall end beyond t + 0.3 m, so the open leaf
       rests against the side wall (0 for pocket, French, cased)
  Λ_d  latch-side shortfall on the pull (swing) side: max(0, λ − distance from latch jamb to the wall end),
       λ = 0.455 m for public buildings (ICC A117.1 404.2.4.1, 18 in), 0.30 m for dwellings
  U    Alexander usability: largest axis-aligned free rectangle of the room after removing the swing arcs, a 0.45 m
       approach disc at every door and 0.9 m movement lanes between its doors, divided by the same rectangle of the
       bare room  (rooms of habitable kinds only)
Hard constraints (candidate rejected): jambs 100 mm clear of the meeting walls (D1), 150 mm between openings and
200 mm to windows, the 900 mm swing zone misses the stair flight (D5), every leaf's arc stays inside its room.
Search: coordinate descent from the v1 layout — each door in turn takes its best candidate with the others fixed,
until a sweep changes nothing (≤ 4 sweeps). Deterministic: no random numbers, ties broken by candidate order.
"""
import math
import numpy as np
from shapely.geometry import Polygon, box as sbox
from shapely import contains_xy
import doorlogic as DL, openings as O

K = dict(c=1.0, r=1.0, l=2.0, w=0.5, o=0.8, p=0.6, u=3.0, x=50.0)
STEP, RASTER, APPROACH, LANE = 100.0, 150.0, 600.0, 450.0
BATH = ("bathroom", "wc", "wc_block")
HABIT = {"living", "dining", "kitchen", "bedroom", "study", "office", "family", "sales", "meeting", "open_office", "classroom",
         "library", "staff", "dining_room", "chamber", "nave", "gallery_room", "lobby", "foyer", "utility"}


# ------------------------------------------------------------------------------------------------ geometry helpers
def side_sign(sp, lab):
    """+1 if room `lab` lies on the + side of the run's line (larger y for axis x, larger x for axis y), else −1."""
    inner = -1 if (not sp["ext"] or sp["outward"] == 1) else 1
    return inner if lab == sp["inner"] else -inner


def extent_of(sp, lab):
    return sp["ext_in"] if lab == sp["inner"] else sp["ext_out"]


def max_rect(M):
    H, W = M.shape; h = np.zeros(W + 1, int); best = 0
    for y in range(H):
        h[:W] = np.where(M[y], h[:W] + 1, 0)
        st = []
        for x in range(W + 1):
            cur = h[x]; start = x
            while st and st[-1][1] >= cur:
                s0, hh = st.pop()
                if hh * (x - s0) > best: best = hh * (x - s0)
                start = s0
            st.append((start, cur))
    return best


class Room:
    def __init__(self, P):
        self.P = P
        minx, miny, maxx, maxy = P.bounds
        xs = np.arange(minx + RASTER / 2, maxx, RASTER); ys = np.arange(miny + RASTER / 2, maxy, RASTER)
        self.X, self.Y = np.meshgrid(xs, ys)
        self.inside = contains_xy(P, self.X, self.Y)
        self.base = max(1, max_rect(self.inside))
        self.cache = {}

    def usability(self, feats):
        """feats: tuple of ('arc', hx, hy, cx, cy, ox, oy, r) and ('pt', x, y) — cached by value."""
        if feats in self.cache: return self.cache[feats]
        M = self.inside.copy(); pts = []
        for f in feats:
            if f[0] == "arc":
                _, hx, hy, cx, cy, ox, oy, r = f
                vx, vy = self.X - hx, self.Y - hy
                M &= ~((vx * vx + vy * vy <= r * r) & (vx * cx + vy * cy >= 0) & (vx * ox + vy * oy >= 0))
            else:
                pts.append((f[1], f[2]))
        for (x, y) in pts:
            M &= (self.X - x) ** 2 + (self.Y - y) ** 2 > LANE ** 2
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                (x1, y1), (x2, y2) = pts[i], pts[j]
                dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1.0
                t = np.clip(((self.X - x1) * dx + (self.Y - y1) * dy) / L2, 0, 1)
                M &= (self.X - x1 - t * dx) ** 2 + (self.Y - y1 - t * dy) ** 2 > LANE ** 2
        u = max_rect(M) / self.base
        if len(self.cache) > 4000: self.cache.clear()
        self.cache[feats] = u
        return u


def clear_polys(plan, s, st):
    """Clear floor of every room: doorlogic's room polygon (interior wall faces) cut back by the full exterior wall
    thickness, which room_polys does not know about (exterior walls are 200–500 mm, interior 120 mm)."""
    import roofs as RF
    rooms = plan["program"]["rooms"]; L = np.array(plan["labels"][s])
    ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(L)
    env = RF.cells_poly(ind, plan["cell"] * 1000)
    inner = env.buffer(-st["ext"] * 1000, join_style=2) if env is not None else None
    out = {}
    for lab, P in DL.room_polys(plan, s, st).items():
        out[lab] = P if (inner is None or rooms[lab - 1].get("open_air")) else P.intersection(inner)
    return out


# ------------------------------------------------------------------------------------------------ the swing rule (S1–S4)
def rule_into(plan, sp, o, polys, out_swing):
    rooms = plan["program"]["rooms"]
    a, b = sp["inner"], sp["outer"]
    ka = rooms[a - 1]["kind"]; kb = rooms[b - 1]["kind"] if b > 0 else "outside"
    ext = b <= 0 or rooms[b - 1].get("open_air")
    if ext: return (b if out_swing else a), True
    if ka in DL.CIRC and kb not in DL.CIRC: return b, False
    if kb in DL.CIRC and ka not in DL.CIRC: return a, False
    if ka == "garage" or kb == "garage": return (b if ka == "garage" else a), False
    if ka in BATH or kb in BATH:
        bath = a if ka in BATH else b; P = polys.get(bath)
        depth = DL._depth(P, sp) if P is not None else 0
        return (bath if depth >= o["w"] + 600 else (b if bath == a else a)), False
    ra, rb = DL.RANK.get(ka, 1), DL.RANK.get(kb, 1)
    if ra != rb: return (a if ra > rb else b), False
    Aa = polys[a].area if a in polys else 0; Ab = polys[b].area if b in polys else 0
    return (a if Aa >= Ab else b), False


# ------------------------------------------------------------------------------------------------ optimiser
def optimise(plan, st, specs_by_storey, door_log, max_sweeps=4):
    rooms = plan["program"]["rooms"]; th = plan["theme"]
    out_swing = door_log.get("exterior_swing") == "out"
    lam = 455.0 if (out_swing or th["archetype"] not in O.HOUSES) else 300.0
    report = {"storeys": [], "moved": 0, "pocket": 0, "flipped_side": 0}
    for s, specs in enumerate(specs_by_storey):
        polys = clear_polys(plan, s, st)
        R = {lab: Room(P) for lab, P in polys.items() if not P.is_empty and rooms[lab - 1]["kind"] in HABIT and P.area > 3e6}
        stair = O.stair_obstacles(plan, s); sparts = O.stair_parts(plan, s)
        doors = []                      # (sp, o) movable interior/exterior doors (overhead doors stay)
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] == "door": doors.append([sp, o])
        if not doors: report["storeys"].append(dict(J0=0, J1=0, doors=0)); continue
        # candidate generators ------------------------------------------------------------------------------
        def runs_for(sp, o):
            if o.get("entry") or o.get("street") or o.get("stair_mouth"): return [sp]     # 2026-11-02: a stair mouth stays at the foot / head
            if sp["ext"]:
                if o.get("back") or (o.get("exterior") and sp["outer"] <= 0):
                    return [q for q in specs if q["ext"] and q["inner"] == sp["inner"] and not q["party"] and q["outer"] <= 0
                            and not (q["axis"] == "x" and q["outward"] == -1)] or [sp]
                return [q for q in specs if {q["inner"], q["outer"]} == {sp["inner"], sp["outer"]}] or [sp]
            return [q for q in specs if not q["ext"] and {q["inner"], q["outer"]} == {sp["inner"], sp["outer"]}] or [sp]

        def ops_for(sp, o, w):
            """[(label, into, sign, hinge_end, kind, penalty_terms)]"""
            if o.get("ptype") == "cased": return [("cased", 0, 0, 0, "cased", 0.0)]
            into, fixed = rule_into(plan, sp, o, polys, out_swing)
            sg = side_sign(sp, into) if into > 0 else -side_sign(sp, sp["inner"])
            out = [("rule", into, sg, he, "french" if o.get("ptype") == "french" else "single", 0.0) for he in (0, 1)]
            if not fixed:
                other = sp["outer"] if into == sp["inner"] else sp["inner"]
                out += [("other", other, -sg, he, "french" if o.get("ptype") == "french" else "single", K["o"]) for he in (0, 1)]
                if o.get("ptype") != "french" and w <= 1000:
                    out += [("pocket", 0, 0, side, "pocket", K["p"]) for side in (0, 1)]
            elif o.get("ptype") == "french": out = out[:1]
            return out

        def widths_for(o):
            w0 = o.get("w0", o["w"]); o["w0"] = w0
            if o.get("ptype") in ("cased", "french") or o.get("entry") or o.get("exterior") or o["w"] < 800: return [o["w"]]   # exterior doors stay 36 in
            # 2026-11-03: step down through stock sizes only (32 in, then 30 in), never to an odd width
            import openings as _O
            return [w for w in _O.STD_INTERIOR if w <= w0 + 1] or [w0]

        def positions(sp, w, others):
            lo = sp["a0"] + sp["clear0"] + 100 + w / 2; hi = sp["a1"] - sp["clear1"] - 100 - w / 2
            if hi < lo: return []
            P = list(np.arange(lo, hi, STEP)) + [hi]
            if len(P) > 60: P = [P[int(i)] for i in np.linspace(0, len(P) - 1, 60)]
            ok = []
            for p in P:
                if any(abs(q["pos"] - p) < (q["w"] + w) / 2 + (200 if q["kind"] == "window" else 150) for q in others): continue
                ok.append(float(p))
            return ok

        def geometry(sp, p, w, op, o):
            """→ (ok, leaves, arcs_polys, features_by_room, per-door cost terms dict)"""
            label, into, sg, he, kind, pen = op
            oo = dict(o, pos=p, w=w)
            leaves, arcs, feats = [], [], {}
            terms = dict(c=O.corner_cost(sp, p, w) / 1000.0 if sp["outer"] > 0 else max(0.0, min(p - w / 2 - sp["ext_in"][0], sp["ext_in"][1] - p - w / 2)) / 1000.0,
                         r=0.0, l=0.0, pen=pen)
            if kind == "pocket":
                room_left = (p - w / 2) - (sp["a0"] + sp["clear0"]); room_right = (sp["a1"] - sp["clear1"]) - (p + w / 2)
                if (room_left if he == 0 else room_right) < w: return None
                pocket_span = (p - w / 2 - w, p - w / 2) if he == 0 else (p + w / 2, p + w / 2 + w)
                if any(q is not o and q["kind"] in ("door", "window") and abs(q["pos"] - (pocket_span[0] + pocket_span[1]) / 2) < (q["w"] + w) / 2 for q in sp["openings"]): return None
            elif kind in ("single", "french"):
                Ls = DL.leaves(sp, oo, sg, he)
                P = polys.get(into) if into > 0 else None
                for lf in Ls:
                    if P is not None and lf["arc"].difference(P.buffer(30)).area > 0.02 * lf["arc"].area: return None
                    leaves.append(lf); arcs.append(lf["arc"])
                if into > 0 and kind == "single":
                    e0, e1 = extent_of(sp, into); t = sp["d1"] - sp["d0"]
                    hinge_a, latch_d = (p - w / 2 - e0, e1 - (p + w / 2)) if he == 0 else (e1 - (p + w / 2), p - w / 2 - e0)
                    terms["r"] = max(0.0, hinge_a - (t + 300)) / 1000.0
                    terms["l"] = max(0.0, lam - latch_d) / 1000.0
                if into in R:
                    feats.setdefault(into, []).extend(("arc", round(lf["hinge"][0]), round(lf["hinge"][1]), lf["closed_dir"][0], lf["closed_dir"][1],
                                                        lf["open_dir"][0], lf["open_dir"][1], round(lf["w"])) for lf in Ls)
            if sparts and O.stair_conflict(sp, p, w, arcs, sparts): return None
            for lab in (sp["inner"], sp["outer"]):
                if lab in R:
                    sgn = side_sign(sp, lab)
                    pt = (p, sp["line"] + sgn * APPROACH) if sp["axis"] == "x" else (sp["line"] + sgn * APPROACH, p)
                    feats.setdefault(lab, []).append(("pt", round(pt[0]), round(pt[1])))
            return leaves, arcs, feats, terms

        # state ----------------------------------------------------------------------------------------------
        state = []          # per door: dict(sp, p, w, op, leaves, arcs, feats, terms)
        for sp, o in doors:
            w = o["w"]; ops = ops_for(sp, o, w)
            sw = o.get("swing") or {}
            cur = None
            if sw.get("kind") == "pocket": cur = next((op for op in ops if op[4] == "pocket" and op[3] == (0 if sw["side"] == "a0" else 1)), None)
            elif sw.get("kind") in ("single", "french"):
                cur = next((op for op in ops if op[1] == sw.get("into") and op[3] == sw.get("hinge_end") and op[4] != "pocket"), None)
            cur = cur or ops[0]
            g = geometry(sp, o["pos"], w, cur, o)
            if g is None:
                for op in ops:
                    g = geometry(sp, o["pos"], w, op, o)
                    if g: cur = op; break
            if g is None: g = ([], [], {}, dict(c=0, r=0, l=0, pen=0))
            state.append(dict(sp=sp, p=o["pos"], w=w, op=cur, leaves=g[0], arcs=g[1], feats=g[2], terms=g[3], o=o))

        def room_feats(lab, skip=None):
            f = []
            for i, d in enumerate(state):
                if i != skip: f += d["feats"].get(lab, [])
            return f

        def door_cost(d):
            t = d["terms"]; w0 = d["o"].get("w0", d["w"])
            return K["c"] * t["c"] + K["r"] * t["r"] + K["l"] * t["l"] + K["w"] * (w0 - d["w"]) / 100.0 + t["pen"]

        def overlap(arcs, skip):
            n = 0
            for j, e in enumerate(state):
                if j == skip: continue
                for a in arcs:
                    for b in e["arcs"]:
                        if a.intersection(b).area > 0.01 * a.area: n += 1
            return n

        def total():
            J = sum(door_cost(d) for d in state)
            J += sum(K["u"] * (1 - R[lab].usability(tuple(sorted(room_feats(lab))))) for lab in R)
            J += K["x"] * sum(overlap(d["arcs"], i) for i, d in enumerate(state)) / 2
            return J

        J0 = total(); moved = 0
        for sweep in range(max_sweeps):
            changed = False
            for i, d in enumerate(state):
                o = d["o"]
                labs_i = {lab for q in runs_for(d["sp"], o) for lab in (q["inner"], q["outer"]) if lab in R}
                base_rooms = {lab: room_feats(lab, skip=i) for lab in labs_i}
                best = None
                for run in runs_for(d["sp"], o):
                    others = [q for q in run["openings"] if q is not o]
                    for w in widths_for(o):
                        for op in ops_for(run, o, w):
                            for p in ([o["pos"]] if o.get("stair_mouth") else positions(run, w, others)):
                                g = geometry(run, p, w, op, o)
                                if g is None: continue
                                leaves, arcs, feats, terms = g
                                c = door_cost(dict(terms=terms, w=w, o=o))
                                for lab in labs_i:
                                    c += K["u"] * (1 - R[lab].usability(tuple(sorted(base_rooms[lab] + feats.get(lab, [])))))
                                c += K["x"] * overlap(arcs, i)
                                key = (round(c, 6),)
                                if best is None or key < best[0]: best = (key, run, p, w, op, g)
                cur_c = door_cost(d) + sum(K["u"] * (1 - R[lab].usability(tuple(sorted(base_rooms[lab] + d["feats"].get(lab, []))))) for lab in labs_i) + K["x"] * overlap(d["arcs"], i)
                if best is not None and best[0][0] < cur_c - 1e-6:
                    _, run, p, w, op, g = best
                    if run is not d["sp"]:
                        d["sp"]["openings"].remove(o); run["openings"].append(o)
                    d.update(sp=run, p=p, w=w, op=op, leaves=g[0], arcs=g[1], feats=g[2], terms=g[3])
                    o["pos"], o["w"] = p, w
                    changed = True; moved += 1
            if not changed: break
        J1 = total()
        # write the chosen operation back in doorlogic's format
        for d in state:
            o, sp = d["o"], d["sp"]; label, into, sg, he, kind, pen = d["op"]
            o["pos"], o["w"] = float(d["p"]), d["w"]
            if kind == "cased": o.pop("swing", None); continue
            if kind == "pocket":
                o["swing"] = dict(kind="pocket", side="a0" if he == 0 else "a1"); report["pocket"] += 1; continue
            if label == "other": report["flipped_side"] += 1
            if not d["leaves"]:          # no feasible swing anywhere: keep the rule's leaf and let recheck() report it
                d["leaves"] = DL.leaves(sp, dict(o), sg, he)
            ext = sp["outer"] <= 0 or rooms[sp["outer"] - 1].get("open_air")
            o["swing"] = dict(kind=kind, into=int(into), into_kind=(rooms[into - 1]["kind"] if into > 0 else "outside"), sign=int(sg), hinge_end=int(he),
                              leaves=[dict(hinge=lf["hinge"], tip_closed=lf["tip_closed"], tip_open=lf["tip_open"], w=lf["w"],
                                           tip_shown=DL.leaf_tip(lf, 0 if ext else DL.AJAR_DEG)) for lf in d["leaves"]],
                              arcs=[list(lf["arc"].exterior.coords) for lf in d["leaves"]], v2=True)
        report["moved"] += moved
        report["storeys"].append(dict(J0=round(J0, 3), J1=round(J1, 3), doors=len(state), moved=moved))
    door_log["v2"] = report
    door_log["conflicts"] = []      # recomputed by recheck()
    recheck(plan, st, specs_by_storey, door_log)
    return report


def recheck(plan, st, specs_by_storey, door_log):
    """Independent re-check of the final swings (same rule as doorlogic C): arcs inside the room, no overlaps."""
    rooms = plan["program"]["rooms"]
    for s, specs in enumerate(specs_by_storey):
        polys = clear_polys(plan, s, st); arcs = []
        for sp in specs:
            for o in sp["openings"]:
                sw = o.get("swing") or {}
                if sw.get("kind") not in ("single", "french"): continue
                P = polys.get(sw["into"]) if sw["into"] > 0 else None
                for a in sw["arcs"]:
                    A = Polygon(a)
                    bad = (P is not None and A.difference(P.buffer(30)).area > 0.02 * A.area) or any(A.intersection(B).area > 0.01 * A.area for B in arcs)
                    if bad:
                        ka = rooms[sp["inner"] - 1]["kind"]; kb = rooms[sp["outer"] - 1]["kind"] if sp["outer"] > 0 else "outside"
                        door_log["conflicts"].append(f"L{s + 1} {ka}–{kb}: no clear swing")
                    arcs.append(A)
