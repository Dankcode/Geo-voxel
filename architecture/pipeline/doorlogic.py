"""Door logic: which way every door swings, where it is hinged, and whether its swing is clear.

Rules (in order):
  S1 exterior doors of dwellings swing in; exterior doors of buildings whose ground-floor occupant load is ≥ 50
     swing out, in the direction of egress (IBC 1010.1.2.1). Occupant load  N = Σ_rooms A_r / f_r  with the IBC
     Table 1004.5 load factors f (m² per occupant): assembly 1.4 (net), classroom 1.9 (net), mercantile 5.6,
     business 13.9, residential 18.6.
  S2 a door between a circulation space (hall, corridor, foyer, lobby, landing, stair) and a room swings into the
     room, never into the circulation;
  S3 a bathroom / WC door swings in unless the room is too shallow for the leaf (depth < w + 600 mm), then out;
  S4 otherwise the door swings into the more private room (privacy rank public 0 < semi 1 < private 2 < service 3),
     ties into the larger room; a garage door to the house swings into the house;
  H  the hinge goes on the jamb nearer the swing room's corner, so the open leaf rests against the side wall
     (pairs with Merrell's corner rule for the door position);
  C  the swing arc (quarter disc of radius w about the hinge) must stay inside the swing room and miss the stair
     flight and every other arc; on conflict the hinge is flipped, then the swing side (if S1–S4 allow), and as
     a last resort the leaf becomes a pocket (sliding) door if the wall beside it can take it.
French doors are two leaves of w/2 hinged on both jambs; cased openings and garage doors have no leaf.
"""
import math
import numpy as np
from shapely.geometry import Point, Polygon, box as sbox
from shapely.ops import unary_union

CIRC = {"hall", "corridor", "foyer", "lobby", "landing", "stair", "narthex"}
RANK = {"living": 0, "dining": 0, "kitchen": 0, "foyer": 0, "hall": 0, "corridor": 0, "lobby": 0, "family": 0, "sales": 0, "nave": 0,
        "study": 1, "office": 1, "library": 1, "meeting": 1, "classroom": 1, "staff": 1, "open_office": 1,
        "bedroom": 2, "chamber": 2, "sacristy": 2,
        "bathroom": 3, "wc": 3, "wc_block": 3, "utility": 3, "storage": 3, "stockroom": 3, "garage": -1}
LOAD = {"nave": 1.4, "chamber": 1.4, "dining_room": 1.4, "classroom": 1.9, "library": 4.6, "sales": 5.6, "office": 13.9, "open_office": 13.9,
        "meeting": 1.4, "lobby": 13.9}
OUT_SWING_ARCH = {"church", "school", "civic", "big_box"}


def occupant_load(plan):
    rooms = plan["program"]["rooms"]; L0 = np.array(plan["labels"][0]); c2 = plan["cell"] ** 2
    N = 0.0
    for r in rooms:
        if r["storey"] != 0: continue
        A = float((L0 == r["id"] + 1).sum()) * c2
        N += A / LOAD.get(r["kind"], 18.6)
    return N


def room_polys(plan, s, st):
    """Clear floor polygon (inside the wall faces) of every room on storey s, mm."""
    rooms = plan["program"]["rooms"]; L = np.array(plan["labels"][s]); c = plan["cell"] * 1000
    out = {}
    for r in rooms:
        if r["storey"] != s: continue
        m = L == r["id"] + 1
        if not m.any(): continue
        ys, xs = np.nonzero(m)
        P = unary_union([sbox(x * c, y * c, (x + 1) * c, (y + 1) * c) for y, x in zip(ys, xs)])
        out[r["id"] + 1] = P.buffer(-st["int_"] * 500, join_style=2)
    return out


def _arc(hinge, closed_dir, open_dir, r, n=12):
    """Quarter disc swept by a leaf of length r hinged at `hinge`, from `closed_dir` to `open_dir` (unit vectors)."""
    a0 = math.atan2(closed_dir[1], closed_dir[0]); a1 = math.atan2(open_dir[1], open_dir[0])
    d = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    pts = [hinge] + [(hinge[0] + r * math.cos(a0 + d * k / n), hinge[1] + r * math.sin(a0 + d * k / n)) for k in range(n + 1)]
    return Polygon(pts)


AJAR_DEG = 30     # 3D models: exterior doors closed in their frames, interior doors ajar so leaf and opening both read


def leaf_tip(lf, deg):
    """Leaf tip with the door opened `deg` degrees from closed towards its swing side."""
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    d = (c * lf["closed_dir"][0] + s * lf["open_dir"][0], c * lf["closed_dir"][1] + s * lf["open_dir"][1])
    return (lf["hinge"][0] + d[0] * lf["w"], lf["hinge"][1] + d[1] * lf["w"])


def leaves(sp, o, into_sign, hinge_end):
    """Leaves of one door: list of dict(hinge, tip_closed, tip_open, arc). into_sign: +1 = towards +y (axis x) /
    +x (axis y); hinge_end: 0 = the a0-side jamb, 1 = the a1-side jamb."""
    w = o["w"]; line = sp["line"]; p = o["pos"]
    along = np.array([1.0, 0.0]) if sp["axis"] == "x" else np.array([0.0, 1.0])
    across = np.array([0.0, 1.0]) if sp["axis"] == "x" else np.array([1.0, 0.0])
    def pt(a): return np.array([a, line]) if sp["axis"] == "x" else np.array([line, a])
    # leaves hang on the face of the wall they open to (audit fix, doors v2: the real face d0 / d1 — an exterior wall
    # runs from the outline inwards, so its face is not line ± t/2 as for an interior wall)
    face = across * (((sp["d1"] if into_sign > 0 else sp["d0"]) - sp["line"]))
    out = []
    spans = [(p - w / 2, p + w / 2, hinge_end)] if o.get("ptype") != "french" else [(p - w / 2, p, 0), (p, p + w / 2, 1)]
    for a0, a1, he in spans:
        h = pt(a0 if he == 0 else a1) + face
        lw = a1 - a0
        closed = along if he == 0 else -along
        opened = across * into_sign
        arc = _arc(tuple(h), tuple(closed), tuple(opened), lw)
        out.append(dict(hinge=tuple(h), tip_closed=tuple(h + closed * lw), tip_open=tuple(h + opened * lw), arc=arc, w=lw,
                        closed_dir=tuple(closed), open_dir=tuple(opened)))
    return out


def decide(plan, st, specs_by_storey, stair_rects=None, furniture=None):
    """Assign swing side, hinge and leaves to every hinged / French door; returns a log of rules and conflicts."""
    rooms = plan["program"]["rooms"]; th = plan["theme"]
    load = occupant_load(plan)
    out_swing = th["archetype"] in OUT_SWING_ARCH or load >= 50
    log = {"occupant_load": round(load, 1), "exterior_swing": "out" if out_swing else "in", "rules": {}, "conflicts": [], "flips": 0, "pocket": 0}
    def rule(r): log["rules"][r] = log["rules"].get(r, 0) + 1
    for s, specs in enumerate(specs_by_storey):
        polys = room_polys(plan, s, st)
        stair = (stair_rects or {}).get(s)
        arcs_by_room = {}
        doors = [(sp, o) for sp in specs for o in sp["openings"] if o["kind"] == "door" and o.get("ptype") != "cased"]
        for sp, o in doors:
            a, b = sp["inner"], sp["outer"]                     # inner is indoor; outer may be outside (≤ 0) or a porch
            ka = rooms[a - 1]["kind"]; kb = rooms[b - 1]["kind"] if b > 0 else "outside"
            ext = b <= 0 or rooms[b - 1].get("open_air")
            # which side is "a" on? for axis x the inner room lies at −y when outward = +1 …; interior runs: inner = la (−side)
            sign_a = (-1 if sp["outward"] == 1 else 1) if sp["ext"] else -1
            if ext:
                into = b if out_swing else a; rule("S1 exterior " + ("out (egress)" if out_swing else "in (dwelling)"))
            elif ka in CIRC and kb not in CIRC: into = b; rule("S2 into room from circulation")
            elif kb in CIRC and ka not in CIRC: into = a; rule("S2 into room from circulation")
            elif ka == "garage" or kb == "garage": into = b if ka == "garage" else a; rule("S4 garage → house")
            elif ka in ("bathroom", "wc", "wc_block") or kb in ("bathroom", "wc", "wc_block"):
                bath = a if ka in ("bathroom", "wc", "wc_block") else b
                P = polys.get(bath)
                depth = _depth(P, sp) if P is not None else 0
                into = bath if depth >= o["w"] + 600 else (b if bath == a else a); rule("S3 bathroom " + ("in" if into == bath else "out (shallow)"))
            else:
                ra, rb = RANK.get(ka, 1), RANK.get(kb, 1)
                if ra != rb: into = a if ra > rb else b
                else:
                    Aa = polys[a].area if a in polys else 0; Ab = polys[b].area if b in polys else 0
                    into = a if Aa >= Ab else b
                rule("S4 into the more private room")
            into_sign = sign_a if into == a else -sign_a
            # H: hinge on the jamb nearer the swing room's corner
            e0, e1 = (sp["ext_in"] if into == sp["inner"] else sp["ext_out"])
            d0 = o["pos"] - o["w"] / 2 - e0; d1 = e1 - (o["pos"] + o["w"] / 2)
            hinge_end = 0 if d0 <= d1 else 1
            # C: try (hinge, side) combinations until the arcs are clear
            room_poly = polys.get(into) if into > 0 else None
            options = [(into_sign, hinge_end), (into_sign, 1 - hinge_end)]
            fixed_side = ext                      # exterior swing is set by code; interior may flip side if needed
            if not fixed_side: options += [(-into_sign, hinge_end), (-into_sign, 1 - hinge_end)]
            chosen = None
            for k, (sg, he) in enumerate(options):
                L_ = leaves(sp, o, sg, he)
                tgt = into if sg == into_sign else (b if into == a else a)
                P = polys.get(tgt) if tgt > 0 else None
                ok = True
                for lf in L_:
                    arc = lf["arc"]
                    if P is not None and arc.difference(P.buffer(30)).area > 0.02 * arc.area: ok = False
                    if stair is not None and arc.intersects(sbox(*stair).buffer(-20)): ok = False
                    if any(arc.intersection(q).area > 0.01 * arc.area for q in arcs_by_room.get(tgt, [])): ok = False
                if ok:
                    chosen = (sg, he, tgt, L_)
                    if k: log["flips"] += 1
                    break
            if chosen is None:
                # pocket door if the wall can hide the leaf beside the opening, else keep the rule's choice and report
                room_left = (o["pos"] - o["w"] / 2) - (sp["a0"] + sp["clear0"]); room_right = (sp["a1"] - sp["clear1"]) - (o["pos"] + o["w"] / 2)
                if max(room_left, room_right) >= o["w"] and o.get("ptype") != "french" and not ext:
                    o["swing"] = dict(kind="pocket", side="a0" if room_left >= room_right else "a1"); log["pocket"] += 1; continue
                L_ = leaves(sp, o, into_sign, hinge_end); chosen = (into_sign, hinge_end, into, L_)
                log["conflicts"].append(f"L{s + 1} {ka}–{kb}: no clear swing")
            sg, he, tgt, L_ = chosen
            o["swing"] = dict(kind="french" if o.get("ptype") == "french" else "single", into=int(tgt), into_kind=(rooms[tgt - 1]["kind"] if tgt > 0 else "outside"),
                              sign=int(sg), hinge_end=int(he),
                              leaves=[dict(hinge=lf["hinge"], tip_closed=lf["tip_closed"], tip_open=lf["tip_open"], w=lf["w"],
                                           tip_shown=leaf_tip(lf, 0 if ext else AJAR_DEG)) for lf in L_],
                              arcs=[list(lf["arc"].exterior.coords) for lf in L_])
            arcs_by_room.setdefault(tgt, []).extend(lf["arc"] for lf in L_)
    return log


def _depth(P, sp):
    """Depth of a room perpendicular to the wall the door is on (mm)."""
    minx, miny, maxx, maxy = P.bounds
    return (maxy - miny) if sp["axis"] == "x" else (maxx - minx)


def furniture_conflicts(specs_by_storey, furniture):
    """Swing arcs that hit placed furniture (furniture: list of dict(storey, fp polygon))."""
    hits = []
    for s, specs in enumerate(specs_by_storey):
        fps = [f["fp"] for f in furniture if f["storey"] == s]
        if not fps: continue
        U = unary_union(fps)
        for sp in specs:
            for o in sp["openings"]:
                for a in (o.get("swing") or {}).get("arcs", []):
                    if Polygon(a).intersection(U).area > 1e4: hits.append((s, o.get("edge")))
    return hits
