"""Blueprint stage: the measured floor plans of a building, produced and checked before any interior or 3D work.

Pipeline order (as in Merrell et al. 2010 §3: programme → schematic plan → detailed plan → 3D):
    programme (programs.py) → plan lattice (planner.py, cost C_a ensures every connection and circulation)
    → BLUEPRINT (this module): walls with thickness, doors with swing and hinge (doorlogic.py), windows by facade
      rule (openings.py), stairs by stair space (stairs.py), roof plan (roofs.py), room areas and dimensions
    → gate: the checks below must pass
    → interior (furniture) → 3D (FreeCAD BIM, Blender) → voxels
The blueprint is the single vector master; every later stage reads it and none of them changes the layout.
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import math, json, sys
import numpy as np
from shapely.geometry import Polygon, box as sbox, LineString
from shapely.ops import unary_union

sys.path.insert(0, _HERE)
import openings as O, roofs as RF, stairs as STR, doorlogic as DL
from styles import style_for

TIER_FILL = {0: "#f4f1e8", 1: "#eef2ea", 2: "#ecf0f5", 3: "#f5ecea", -1: "#efefef"}
LABEL = {"wc": "WC", "foyer": "Foyer", "hall": "Hall", "stair": "Stair", "garage": "Garage", "porch": "Porch", "utility": "Utility"}


def build(plan):
    st = style_for(plan["theme"])
    rooms = plan["program"]["rooms"]; S = len(plan["labels"]); c = plan["cell"] * 1000
    Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000
    roofs = RF.roof_plan(plan, st)
    specs, logs = O.all_openings(plan, st, roofs=roofs)
    stairs = {}
    if plan.get("stair") and S > 1:
        x0, y0, w, h = plan["stair"]
        for s in range(S - 1): stairs[s] = STR.stair_boxes(x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c, R0 + s * Hs, Hs, rev=STR.ensure_rev(plan))
    doors = DL.decide(plan, st, specs, stair_rects={s: tuple(D["hole"][0]) for s, (D, _) in stairs.items()})
    if __import__("os").environ.get("DOORS", "v2") == "v2":       # door redesign: joint placement + operation (doors2.py)
        import doors2 as D2
        D2.optimise(plan, st, specs, doors)
    audit = O.audit(plan, specs, logs)
    polys = [DL.room_polys(plan, s, st) for s in range(S)]
    import bays as BAY                                    # the bay's floor joins its room
    for s_, sp_, o_, g_ in BAY.bays_of(specs):
        lab_ = o_["room"]
        if lab_ in polys[s_]: polys[s_][lab_] = polys[s_][lab_].union(g_["inner"]).buffer(0)
    bp = dict(labels=plan["labels"], key=plan.get("key"), theme=plan["theme"], style=st, specs=specs, door_logs=logs, doors=doors, stairs=stairs, roofs=roofs,
              rooms=rooms, polys=polys, audit=audit, cell=c, S=S)
    bp["checks"] = checks(bp, plan)
    return bp


def depth_and_privacy(bp, plan):
    """Thresholds from the street (door graph) and Spearman ρ(depth, privacy rank) — the privacy gradient."""
    rooms = bp["rooms"]; adj = {0: set()}
    def link(a, b): adj.setdefault(a, set()).add(b); adj.setdefault(b, set()).add(a)
    for e in O.resolved_edges(plan):
        if e["type"] == "open": link(e["a"] + 1, e["b"] + 1)
    for specs in bp["specs"]:
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] in ("door", "overhead"): link(sp["inner"], 0 if sp["outer"] <= 0 else sp["outer"])
    for r in rooms:
        if r.get("open_air"): link(r["id"] + 1, 0)
    st_ids = [r["id"] + 1 for r in rooms if r.get("stair")]
    for a in st_ids:
        for b in st_ids:
            if a != b: link(a, b)
    d = {0: 0}; q = [0]
    while q:
        v = q.pop(0)
        for w in adj.get(v, ()):
            if w not in d: d[w] = d[v] + 1; q.append(w)
    # audit fix (2026-10-30): the gradient is a property of one dwelling or business (Merrell §3: public rooms near
    # *the* entrance); a building with a separate upstairs flat has one gradient per tenancy, each from the street
    from scipy.stats import spearmanr
    groups = {}
    for r in rooms:
        if (r["id"] + 1) in d and not r.get("subdivided") and r["kind"] not in ("stair", "porch", "garage"):
            groups.setdefault(r.get("tenancy", "main"), []).append((d[r["id"] + 1], DL.RANK.get(r["kind"], 1)))
    rhos = []
    for g, pairs in sorted(groups.items()):
        if g.startswith("flat"):            # measured from the flat's own threshold (its hall), not from the street
            m0 = min(p_[0] for p_ in pairs); pairs = [(p_[0] - m0, p_[1]) for p_ in pairs]
        if len(pairs) > 2 and len(set(p_[0] for p_ in pairs)) > 1 and len(set(p_[1] for p_ in pairs)) > 1:
            rr = spearmanr(*zip(*pairs)).correlation
            if rr == rr: rhos.append(round(float(rr), 2))
    bp["privacy_by_tenancy"] = dict(zip(sorted(groups), rhos)) if len(rhos) == len(groups) else rhos
    return d, (min(rhos) if rhos else None)


def egress(win):
    """IRC R310 emergency escape opening: net clear area ≥ 0.53 m² (5.7 ft²), clear width ≥ 508 mm, height ≥ 610 mm,
    sill ≤ 1118 mm. A sash opens half its height; casement, French and ribbon units open fully."""
    w, h = win["w"] - 120, win["h"] - 120
    if win["kind"] in ("sash", "arched", "lancet"): h = h / 2 - 30
    return w * h / 1e6 >= 0.53 and w >= 508 and h >= 610 and win["sill"] <= 1118


def checks(bp, plan):
    A = bp["audit"]; rooms = bp["rooms"]; out = []
    def chk(name, ok, detail=""): out.append(dict(check=name, ok=bool(ok), detail=detail))
    chk("street door", A["street_door"], A.get("entry_rule") or "")
    miss = A["missing_edges"]
    chk("all programme connections realised (C_a = 0)", not miss, ", ".join(f"{a}–{b}" for a, b, _ in miss))
    chk("every room reachable through doors (circulation, C_a)", not A["unreachable"], ", ".join(A["unreachable"]))
    # merge (2026-10-31, the app's rule): rooms open off the circulation — none reached only by walking through a bedroom,
    # bath or garage
    chk("no room reached only through a bedroom, bath or garage", not A.get("through_private"), ", ".join(A.get("through_private") or []))
    # 2026-11-02: exterior doors as houses have them — one front door, at most one back or side door, the garage's own
    # doors; none from a bathroom, WC or bedroom
    if bp["theme"]["archetype"] in O.HOUSES or bp["theme"]["archetype"] in ("ranch", "two_storey_house", "cottage", "bungalow", "shotgun", "townhouse"):
        ex = []
        for s_, specs_ in enumerate(bp["specs"]):
            for sp in specs_:
                ob = sp["outer"]
                if not (ob <= 0 or rooms[ob - 1].get("open_air")) or rooms[sp["inner"] - 1].get("open_air"): continue
                for o in sp["openings"]:
                    if o["kind"] == "door": ex.append(rooms[sp["inner"] - 1]["kind"])
        person = [k for k in ex if k != "garage"]
        bad = [k for k in ex if k in ("bathroom", "wc", "bedroom")]
        chk("exterior doors: one front, at most one back or side, none from a bath, WC or bedroom",
            len(person) <= 2 and ex.count("garage") <= 1 and not bad, f"{len(ex)} person doors: " + ", ".join(ex))
    # 2026-11-02 (paper revision): Merrell §6 — no window behind a lower roof; IRC R311.6 — halls ≥ 914 mm clear
    st_ = bp["style"]; R0_ = st_["raise_"] * 1000; Hs_ = st_["storey"] * 1000; behind = 0
    for s_, specs_ in enumerate(bp["specs"]):
        if s_ == 0: continue
        for sp in specs_:
            if not sp["ext"]: continue
            for o in sp["openings"]:
                if o["kind"] == "window":
                    z = O.roof_over_window(bp["roofs"], s_, sp, o)
                    if z is not None and z + 100 > R0_ + s_ * Hs_ + o["win"]["sill"]: behind += 1
    chk("no window behind a lower roof (Merrell §6)", behind == 0, f"{behind} window(s)")
    facing = 0
    for s_, specs_ in enumerate(bp["specs"]):
        for sp in specs_:
            if not sp["ext"]: continue
            dep_ = O.OUTLOOK.get(rooms[sp["inner"] - 1]["kind"], 3000)
            for o in sp["openings"]:
                if o["kind"] == "window" and not O.outlook_clear(plan, s_, sp, o["pos"], o["w"], dep_): facing += 1
    chk("windows look out, not at a wall of the house (3 m clear)", facing == 0, f"{facing} window(s)")
    import numpy as _np2
    from scipy import ndimage as _nd
    narrow = []
    for s_, L_ in enumerate(plan["labels"]):
        L_ = _np2.array(L_); k_ = int(_np2.ceil((0.914 + 0.12) / plan["cell"] - 1e-9))
        for r in rooms:
            if r["storey"] != s_ or r["kind"] not in ("hall", "corridor", "landing"): continue
            m_ = L_ == r["id"] + 1
            if not m_.any(): continue
            op_ = _nd.binary_opening(_np2.pad(m_, 1), _np2.ones((k_, k_), bool))[1:-1, 1:-1]
            if (m_ & ~op_).sum() > 0: narrow.append(f"L{s_ + 1} {r['kind']}: {int((m_ & ~op_).sum())} cells under 914 mm")
    chk("hallways at least 914 mm clear (IRC R311.6)", not narrow, "; ".join(narrow))
    # 2026-11-03 person-width rule, on the built walls: a 914 mm person (762 mm at bath fixtures) fits from every
    # doorway of a room to its others and up to each doorway; and no part of a room is a strip a person cannot enter
    try:
        import circulation as _CI, planner as _PL
        _f = _CI.routes(plan, {"specs": bp["specs"]})
        chk("a person fits every route: 914 mm doorway to doorway, 762 mm at bath fixtures (IRC R311.6, R307.1)", not _f,
            "; ".join(_CI.summary(x) for x in _f))
        _strip = []
        for s_, L_ in enumerate(plan["labels"]):
            L_ = _np2.array(L_)
            for i_, r in enumerate(rooms):
                if r["storey"] != s_ or r["kind"] in _PL.PERSON_SKIP: continue
                m_ = L_ == i_ + 1
                if m_.sum() < 4: continue
                n_ = _PL.person_narrow(L_, i_ + 1, dict(mask=m_, kind=r["kind"]), {"cell": plan["cell"]})
                if n_: _strip.append(f"L{s_ + 1} {r['kind']}: {n_} narrow cells or neck units")
        chk("no part of a room, and no neck between parts, narrower than a person (914 mm; 762 mm in baths)", not _strip, "; ".join(_strip))
    except Exception as _e:
        chk("a person fits every route: 914 mm doorway to doorway, 762 mm at bath fixtures (IRC R311.6, R307.1)", False, f"check failed: {_e}")
    # 2026-11-02 (IRC R311.7.6 landings): the foot and the head of every flight open onto floor that reaches them
    if plan.get("stair") and bp["S"] > 1:
        import audit_stairs as AS_
        sa = AS_.audit(plan, dict(labels=plan["labels"], specs=bp["specs"]))
        if sa: chk("stair foot and head open onto a landing (IRC R311.7.6)", sa["foot"]["ok"] and sa["head"]["ok"],
                   ("" if sa["foot"]["ok"] else f"foot: {sa['foot']['walled']:.0%} wall, {sa['foot']['outside']:.0%} outside") + ("" if sa["head"]["ok"] else " head: no open exit"))
    chk("door jambs clear of meeting walls", A["jamb_in_wall"] == 0, str(A["jamb_in_wall"]))
    chk("no door swings onto a stair", A["into_stair"] == 0, str(A["into_stair"]))
    chk("door swings clear (arcs inside the room, no overlaps)", not bp["doors"]["conflicts"], "; ".join(bp["doors"]["conflicts"]))
    for s, (D, _) in bp["stairs"].items():
        ok = not D.get("too_small") and D["R"] <= 210 and 229 <= D["T"] <= 279 and 600 <= D["blondel"] <= 650 and D["W"] >= 914
        chk(f"stair L{s + 1}→L{s + 2} legal", ok, f"{D['form']}: N={D['N']}, R={D['R']} mm, T={D['T']} mm, 2R+T={D['blondel']} mm, W={D['W']} mm")
    # daylight + egress
    win_by_room = {}
    for specs in bp["specs"]:
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] == "window" and sp["ext"]: win_by_room.setdefault(sp["inner"], []).append(o["win"])
                if o["kind"] == "bay": win_by_room.setdefault(sp["inner"], []).extend(o["bay_wins"])
    # IRC R303.2 adjoining rooms: a room joined to a lit room by an open wall (an open programme edge, so no wall
    # is built between them) is lit through it — Merrell §5.2 judges such groups as one space
    opn = {}
    for e in O.resolved_edges(plan):
        if e["type"] == "open": opn.setdefault(e["a"] + 1, set()).add(e["b"] + 1); opn.setdefault(e["b"] + 1, set()).add(e["a"] + 1)
    def lit(lab, seen=()):
        if win_by_room.get(lab): return True
        return any(lit(n, seen + (lab,)) for n in opn.get(lab, ()) if n not in seen and rooms[n - 1].get("daylight") is not None and not rooms[n - 1].get("stair"))
    dark = [r["kind"] for r in rooms if r.get("daylight") and not r.get("subdivided") and not lit(r["id"] + 1)]
    chk("habitable rooms have windows", not dark, ", ".join(dark))
    no_egress = [r["kind"] for r in rooms if r["kind"] == "bedroom" and not any(egress(w) for w in win_by_room.get(r["id"] + 1, []))]
    chk("bedrooms have an egress window (IRC R310)", not no_egress, ", ".join(no_egress))
    # audit fix D1: habitable rooms meet IRC R304 minimum size (bedrooms 7 m², 2.1 m clear width; living 2.4 m)
    MIN_A = {"bedroom": 6.5, "living": 11.0, "kitchen": 4.5, "dining": 6.5}; MIN_W = {"bedroom": 2.1, "living": 2.4, "dining": 2.1, "kitchen": 1.8}
    small = []
    for s_, polys in enumerate(bp["polys"]):
        for rid, P in (polys.items() if isinstance(polys, dict) else []):
            r = rooms[rid - 1] if isinstance(rid, int) and 0 < rid <= len(rooms) else None      # room_polys keys are id + 1
            if r is None or r.get("subdivided") or r["kind"] not in MIN_A or P is None: continue
            if P.area / 1e6 < MIN_A[r["kind"]] or P.buffer(-MIN_W[r["kind"]] * 500 + 1, join_style=2).is_empty: small.append(f"{r['kind']} {P.area / 1e6:.1f} m²")
    chk("habitable rooms meet minimum size (IRC R304)", not small, ", ".join(small))
    d, rho = depth_and_privacy(bp, plan)
    bp["depth"] = d; bp["privacy_rho"] = rho
    chk("privacy gradient (ρ(depth, privacy) ≥ 0)", rho is None or rho >= 0, f"ρ = {rho}")
    # 2026-10-30 (ours): a garage parks a full-size sedan driven in nose first, rear to the door; a porch faces the
    # street and opens into the house
    if any(r["kind"] == "garage" for r in rooms):
        import furnish2 as F2
        G = F2.garage_fit(plan, bp)
        bp["garage_fit"] = G
        chk("garage parks its sedans (4920 × 1840 mm, nose in, rear to the door)", G and all(g and g["ok"] for g in G),
            "; ".join((f"{g['ncars']} car{'s' if g['ncars'] > 1 else ''}: front {g['front']} mm, sides {g['left']}/{g['right']} mm, door {g['door_w']} mm" if g else "no straight drive-in") for g in G))
    # revision (2026-10-30): a two-storey house's upper floor covers the whole enclosed floor below
    if plan["program"].get("upper_cover") and len(plan["labels"]) > 1:
        import numpy as _np
        lo, up = _np.array(plan["labels"][0]), _np.array(plan["labels"][1])
        oa = [r["id"] + 1 for r in rooms if r.get("open_air")]
        lo_in = (lo > 0) & ~_np.isin(lo, oa); share = float(((up > 0) & lo_in).sum()) / max(1, lo_in.sum())
        bp["upper_share"] = share
        want_ = min(1.0, float(list(plan["program"]["upper_cover"].values())[0]) if isinstance(plan["program"]["upper_cover"], dict) else 1.0)
        # 2026-11-02: the target is the programme's (recorded living area), within 10 points; upper outside the lower = 0
        unsup_ = float(((up > 0) & ~lo_in).sum()) / max(1, (up > 0).sum())
        # paper revision (2026-11-02): an upper floor is as big as its rooms (C_d); the gate asks what C_f asks — that it
        # stands on the floor below. Its size against the public record is scored (A18), not gated.
        chk("upper floor stands on the floor below (C_f, Merrell §5.2)", unsup_ < 0.03,
            f"{unsup_:.0%} unsupported; covers {share:.0%} of the enclosed ground floor")
    porches = [r for r in rooms if r["kind"] == "porch" and r["storey"] == 0]
    if porches:
        fp_ = unary_union(list(bp["polys"][0].values())); y0 = fp_.bounds[1]
        bad = []
        for r in porches:
            P = bp["polys"][0].get(r["id"] + 1)
            if P is None: bad.append("porch not built"); continue
            door = any(o["kind"] == "door" for sp in bp["specs"][0] if r["id"] + 1 in (sp["inner"], sp["outer"]) and max(sp["inner"], sp["outer"]) > 0 and min(sp["inner"], sp["outer"]) > 0 for o in sp["openings"])
            # faces the street: most of the porch's width has no room between it and the street (a porch set back
            # beside a forward garage still faces the street)
            L0 = np.array(plan["labels"][0]); pm = L0 == r["id"] + 1
            cols = [x for x in range(L0.shape[1]) if pm[:, x].any()]
            blocked = sum(1 for x in cols if (L0[:np.nonzero(pm[:, x])[0].min(), x] > 0).any())
            if not cols or blocked > 0.5 * len(cols): bad.append("porch not on the street side")
            if not door: bad.append("no door from the porch into the house")
        bp["porch_ok"] = not bad
        chk("front porch on the street side, opening into the house", not bad, "; ".join(bad))
    return out


# ------------------------------------------------------------------------------------------------ drawing
def _wall_poche(specs, env=None):
    ext, inte = [], []
    for sp in specs:
        e0, e1 = sp["clear0"] if sp["ext"] else 0, sp["clear1"] if sp["ext"] else 0
        a0, a1 = sp["a0"] - (sp["d1"] - sp["d0"] if sp["ext"] else (sp["d1"] - sp["d0"]) / 2), sp["a1"] + (sp["d1"] - sp["d0"] if sp["ext"] else (sp["d1"] - sp["d0"]) / 2)
        R = sbox(a0, sp["d0"], a1, sp["d1"]) if sp["axis"] == "x" else sbox(sp["d0"], a0, sp["d1"], a1)
        holes = []
        for o in sp["openings"]:
            p0, p1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
            holes.append(sbox(p0, sp["d0"] - 5, p1, sp["d1"] + 5) if sp["axis"] == "x" else sbox(sp["d0"] - 5, p0, sp["d1"] + 5, p1))
        (ext if sp["ext"] else inte).append((R, holes))
    E = unary_union([r for r, _ in ext]) if ext else Polygon(); I = unary_union([r for r, _ in inte]) if inte else Polygon()
    H = unary_union([h for _, hs in ext + inte for h in hs]) if any(hs for _, hs in ext + inte) else Polygon()
    if env is not None: E = E.intersection(env); I = I.intersection(env)     # walls stay inside the outline
    I = I.difference(E)
    return E.difference(H), I.difference(H)


def _fill(ax, geom, **kw):
    from matplotlib.patches import Polygon as MP
    gs = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    for g in gs:
        if g.is_empty or g.geom_type != "Polygon": continue
        ax.add_patch(MP(np.array(g.exterior.coords) / 1000, closed=True, **kw))
        for h in g.interiors: ax.add_patch(MP(np.array(h.coords) / 1000, closed=True, facecolor=kw.get("hole", "white"), edgecolor="none"))


def _dim(ax, p0, p1, off, text, horizontal=True, fs=7):
    (x0, y0), (x1, y1) = p0, p1
    if horizontal:
        y = y0 + off
        ax.plot([x0, x1], [y, y], color="#222", lw=0.6); ax.plot([x0, x0], [y0, y + 0.15 * np.sign(off)], color="#222", lw=0.5); ax.plot([x1, x1], [y1, y + 0.15 * np.sign(off)], color="#222", lw=0.5)
        for x in (x0, x1): ax.plot([x - 0.12, x + 0.12], [y - 0.12, y + 0.12], color="#222", lw=0.8)
        ax.text((x0 + x1) / 2, y + 0.12 * np.sign(off) + (0.05 if off > 0 else -0.25), text, ha="center", va="bottom", fontsize=fs)
    else:
        x = x0 + off
        ax.plot([x, x], [y0, y1], color="#222", lw=0.6); ax.plot([x0, x + 0.15 * np.sign(off)], [y0, y0], color="#222", lw=0.5); ax.plot([x1, x + 0.15 * np.sign(off)], [y1, y1], color="#222", lw=0.5)
        for y in (y0, y1): ax.plot([x - 0.12, x + 0.12], [y - 0.12, y + 0.12], color="#222", lw=0.8)
        ax.text(x - 0.15, (y0 + y1) / 2, text, ha="right" if off < 0 else "left", va="center", rotation=90, fontsize=fs)


def draw(bp, path_png, path_svg=None, title=None):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    S = bp["S"]; rooms = bp["rooms"]; c = bp["cell"]; st = bp["style"]
    allp = unary_union([p for ps in bp["polys"] for p in ps.values()]).buffer(400)
    minx, miny, maxx, maxy = [v / 1000 for v in allp.bounds]
    wd, ht = maxx - minx + 3.5, maxy - miny + 3.5
    fig = plt.figure(figsize=(min(18, 4.2 * S * wd / max(wd, ht) + 2.5), 7.6))
    gs = fig.add_gridspec(2, S, height_ratios=[5.2, 1.3], hspace=0.05, wspace=0.05)
    for s in range(S):
        ax = fig.add_subplot(gs[0, s]); ax.set_aspect("equal"); ax.axis("off")
        ax.set_xlim(minx - 2.0, maxx + 1.0); ax.set_ylim(miny - 2.6, maxy + 0.9)
        L = np.array(bp["polys"][s] and list(bp["polys"][s].keys()))
        # rooms
        for lab, P in bp["polys"][s].items():
            r = rooms[lab - 1]
            if r.get("subdivided"): continue
            col = "#ffffff" if r.get("open_air") else TIER_FILL.get(DL.RANK.get(r["kind"], 1), "#f4f4f4")
            _fill(ax, P, facecolor=col, edgecolor="none", hatch="////" if r.get("open_air") else None)
            if r["kind"] == "stair": continue
            pt = P.representative_point(); bx0, by0, bx1, by1 = P.bounds
            name = LABEL.get(r["kind"], r["kind"].replace("_", " ").capitalize())
            small = P.area < 7e6
            ax.text(pt.x / 1000, pt.y / 1000 + (0.0 if small else 0.12), name, ha="center", va="center" if small else "bottom", fontsize=6 if small else 7.5, fontweight="bold", color="#222",
                    bbox=dict(boxstyle="square,pad=0.1", fc="white", ec="none", alpha=0.85) if r.get("open_air") else None)
            if not small: ax.text(pt.x / 1000, pt.y / 1000 + 0.1, f"{P.area / 1e6:.1f} m²\n{(bx1 - bx0) / 1000:.1f} × {(by1 - by0) / 1000:.1f}", ha="center", va="top", fontsize=6.2, color="#444", linespacing=1.1)
        # walls
        Lg = np.array(bp["labels"][s]); ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(Lg)
        env = RF.cells_poly(ind, c)
        E, I = _wall_poche(bp["specs"][s], env)
        import bays as BAY
        for s_, sp_, o_, g_ in BAY.bays_of([bp["specs"][s]]):
            E = unary_union([E, g_["walls"]])
            for x0_, y0_, x1_, y1_ in BAY.window_segments(g_, o_["bay_wins"]): ax.plot([x0_ / 1000, x1_ / 1000], [y0_ / 1000, y1_ / 1000], color="#ffffff", lw=2.2, zorder=6); ax.plot([x0_ / 1000, x1_ / 1000], [y0_ / 1000, y1_ / 1000], color="#5c9fbd", lw=0.9, zorder=7)
        _fill(ax, E, facecolor="#1b1b1b", edgecolor="#1b1b1b", lw=0.3)
        _fill(ax, I, facecolor="#5a5a5a", edgecolor="#5a5a5a", lw=0.2)
        # openings
        for sp in bp["specs"][s]:
            for o in sp["openings"]:
                p0, p1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
                if o["kind"] == "window":
                    for f in (0.25, 0.5, 0.75):
                        d = sp["d0"] + f * (sp["d1"] - sp["d0"])
                        xs, ys = ([p0, p1], [d, d]) if sp["axis"] == "x" else ([d, d], [p0, p1])
                        ax.plot(np.array(xs) / 1000, np.array(ys) / 1000, color="#1b1b1b", lw=0.45 if f != 0.5 else 0.8)
                    continue
                if o["kind"] == "overhead":
                    d = (sp["d0"] + sp["d1"]) / 2
                    xs, ys = ([p0, p1], [d, d]) if sp["axis"] == "x" else ([d, d], [p0, p1])
                    ax.plot(np.array(xs) / 1000, np.array(ys) / 1000, color="#1b1b1b", lw=0.8, ls=(0, (3, 2))); continue
                if o.get("ptype") == "cased":
                    for p in (p0, p1):
                        xs, ys = ([p, p], [sp["d0"], sp["d1"]]) if sp["axis"] == "x" else ([sp["d0"], sp["d1"]], [p, p])
                        ax.plot(np.array(xs) / 1000, np.array(ys) / 1000, color="#1b1b1b", lw=0.8)
                    continue
                sw = o.get("swing") or {}
                if sw.get("kind") == "pocket":
                    d = (sp["d0"] + sp["d1"]) / 2; q0, q1 = (p0 - o["w"], p0) if sw["side"] == "a0" else (p1, p1 + o["w"])
                    xs, ys = ([q0, q1], [d, d]) if sp["axis"] == "x" else ([d, d], [q0, q1])
                    ax.plot(np.array(xs) / 1000, np.array(ys) / 1000, color="#1b1b1b", lw=1.2, ls=(0, (2, 1.5))); continue
                for lf, arc in zip(sw.get("leaves", []), sw.get("arcs", [])):
                    h, t = np.array(lf["hinge"]) / 1000, np.array(lf["tip_open"]) / 1000
                    ax.plot([h[0], t[0]], [h[1], t[1]], color="#1b1b1b", lw=1.1)
                    A = np.array(arc)[1:] / 1000
                    ax.plot(A[:, 0], A[:, 1], color="#1b1b1b", lw=0.4)
        # stairs (from the lower storey's flights; upper storey shows the opening)
        for ss, (D, parts) in bp["stairs"].items():
            if ss not in (s, s - 1): continue
            for role, (x0, y0, z0, x1, y1, z1) in parts:
                if role == "step" and ss == s:
                    ax.add_patch(plt.Rectangle((x0 / 1000, y0 / 1000), (x1 - x0) / 1000, (y1 - y0) / 1000, fill=False, lw=0.45, ec="#1b1b1b"))
                if role == "landing" and ss == s:
                    ax.add_patch(plt.Rectangle((x0 / 1000, y0 / 1000), (x1 - x0) / 1000, (y1 - y0) / 1000, fill=False, lw=0.6, ec="#1b1b1b"))
            if ss == s:
                steps = [b for role, b in parts if role == "step"]
                pts = [((b[0] + b[3]) / 2000, (b[1] + b[4]) / 2000) for b in steps]
                k = len(pts) // 2
                ax.annotate("", xy=pts[k], xytext=pts[0], arrowprops=dict(arrowstyle="->", lw=0.8, color="#b23a2a"))
                ax.text(pts[0][0], pts[0][1], " UP", fontsize=6.5, color="#b23a2a", va="center")
            else:
                for hx0, hy0, hx1, hy1 in D["hole"]:
                    ax.add_patch(plt.Rectangle((hx0 / 1000, hy0 / 1000), (hx1 - hx0) / 1000, (hy1 - hy0) / 1000, fill=False, lw=0.6, ec="#1b1b1b", ls=(0, (4, 2))))
                    ax.plot([hx0 / 1000, hx1 / 1000], [hy0 / 1000, hy1 / 1000], color="#1b1b1b", lw=0.4)
                    ax.text((hx0 + hx1) / 2000, (hy0 + hy1) / 2000, "DN", fontsize=6.5, color="#b23a2a", ha="center")
        # dimensions: overall width along the front, depth along the left side
        fp = unary_union(list(bp["polys"][s].values())).buffer(st["int_"] * 500, join_style=2)
        bx0, by0, bx1, by1 = [v / 1000 for v in fp.bounds]
        _dim(ax, (bx0, by0), (bx1, by0), -1.0, f"{bx1 - bx0:.2f} m")
        _dim(ax, (bx0, by0), (bx0, by1), -0.9, f"{by1 - by0:.2f} m", horizontal=False)
        ax.text((bx0 + bx1) / 2, by0 - 1.95, "STREET  ▼", ha="center", fontsize=7, color="#555", fontweight="bold")
        ax.set_title(f"Level {s + 1}", fontsize=9, loc="left", color="#222")
        # scale bar
        sx, sy = maxx - 4.2, miny - 2.3
        for i in range(5): ax.add_patch(plt.Rectangle((sx + i, sy), 1, 0.12, facecolor="#1b1b1b" if i % 2 == 0 else "white", edgecolor="#1b1b1b", lw=0.5))
        ax.text(sx, sy + 0.18, "0", fontsize=6); ax.text(sx + 5, sy + 0.18, "5 m", fontsize=6, ha="right")
    # title block
    tb = fig.add_subplot(gs[1, :]); tb.axis("off")
    th = bp["theme"]
    head = title or f"{bp['key']} — {th['archetype'].replace('_', ' ')}, {th['style'].replace('_', ' ')}, {th['storeys']} storey{'s' if th['storeys'] > 1 else ''}"
    tb.text(0.0, 0.92, head, fontsize=10, fontweight="bold", va="top")
    def short(t, n=58): return t if len(t) <= n else t[:n - 1] + "…"
    lines = [("✓ " if c_["ok"] else "✗ ") + short(c_["check"] + (f" — {c_['detail']}" if c_["detail"] else "")) for c_ in bp["checks"]]
    half = (len(lines) + 1) // 2
    for k, col in enumerate((lines[:half], lines[half:])):
        tb.text(0.0 + 0.52 * k, 0.70, "\n".join(col), fontsize=6.4, va="top", family="DejaVu Sans", linespacing=1.35)
    roofs = ", ".join(f"{r['kind']}: {r['programme'].replace('_', ' ')} ({r['classify']['family']})" for r in bp["roofs"])
    tb.text(0.0, 0.02, f"Roof plan — {roofs}.   Doors: exterior swing {bp['doors']['exterior_swing']} (occupant load {bp['doors']['occupant_load']}).   Generated drawing, not for construction.", fontsize=6.3, color="#555")
    fig.savefig(path_png, dpi=170, bbox_inches="tight")
    if path_svg: fig.savefig(path_svg, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    import os
    os.makedirs(_ARCH_OUT + "/blueprints", exist_ok=True)
    for path in sys.argv[1:]:
        p = json.load(open(path)); p.setdefault("key", path.split("plan-")[1][:-5])
        bp = build(p)
        draw(bp, f"{_ARCH_OUT}/blueprints/{p['key']}.png", f"{_ARCH_OUT}/blueprints/{p['key']}.svg")
        print(p["key"], "PASS" if all(c["ok"] for c in bp["checks"]) else "FAIL", [c["check"] for c in bp["checks"] if not c["ok"]], "ρ", bp["privacy_rho"])
