"""Walls, doors and windows from a plan, in plain Python (no FreeCAD), shared by the FreeCAD and Blender builders.

Frame and units as in bim.py: X = u along the street front, Y = v front → back, mm; cell (x, y) covers
[x·c, (x+1)·c] × [y·c, (y+1)·c]. A wall spec is one straight run of boundary between two labels.

`legacy=True` reproduces the door rules used up to 2026-10-29 exactly, so the audit can compare before and after.
The fixed rules (legacy=False):
  D1  door jambs keep clear of the walls that meet the run's ends (exterior walls are 200–500 mm thick, so a door
      150 mm from an outline corner used to cut into the exterior wall);
  D2  a door slides along its whole run (150 mm steps) instead of trying only the two corner positions, and falls
      back to a narrower leaf (800 mm), then to any other shared run, before the connection is given up;
  D3  every building with rooms gets a street door: front wall of the entry room first, then its side walls, then
      a front wall of a public room that touches the entry room, then any exterior non-party wall on the ground floor;
  D4  a porch entry gets a door into the room behind it even when the programme has no porch→room door edge;
  D5  no door swings into a stair flight (its 900 mm swing zone must miss the stair rectangle).
"""
import math
import numpy as np

SLAB = 200
HOUSES = ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse")


def _labels(plan):
    return [np.array(L) for L in plan.get("labels", [])]


def wall_specs(plan, s, st):
    """Every straight run of boundary on storey s that has an indoor room on at least one side."""
    rooms = plan["program"]["rooms"]
    edges = plan["program"]["edges"]
    indoor = lambda lab: lab > 0 and not rooms[lab - 1].get("open_air")
    etype = {(min(e["a"], e["b"]) + 1, max(e["a"], e["b"]) + 1): e["type"] for e in edges}
    L = _labels(plan)[s]; H, W = L.shape
    c = plan["cell"] * 1000; te = st["ext"] * 1000; ti = st["int_"] * 1000
    party = np.array(plan["site"]["party"], bool)
    runs = []
    for x in range(-1, W):
        col_a = L[:, x] if x >= 0 else np.full(H, -1)
        col_b = L[:, x + 1] if x + 1 < W else np.full(H, -1)
        cur = None
        for y in range(H + 1):
            key = None
            if y < H:
                a, b = int(col_a[y]), int(col_b[y])
                if a != b and (indoor(a) or indoor(b)): key = (a, b)
            if cur and key == cur[0]: cur[2] = y
            else:
                if cur: runs.append(("y", (x + 1) * c, cur[1] * c, (cur[2] + 1) * c, cur[0][0], cur[0][1], x, x + 1, cur[1], cur[2]))
                cur = [key, y, y] if key else None
    for y in range(-1, H):
        row_a = L[y, :] if y >= 0 else np.full(W, -1)
        row_b = L[y + 1, :] if y + 1 < H else np.full(W, -1)
        cur = None
        for x in range(W + 1):
            key = None
            if x < W:
                a, b = int(row_a[x]), int(row_b[x])
                if a != b and (indoor(a) or indoor(b)): key = (a, b)
            if cur and key == cur[0]: cur[2] = x
            else:
                if cur: runs.append(("x", (y + 1) * c, cur[1] * c, (cur[2] + 1) * c, cur[0][0], cur[0][1], y, y + 1, cur[1], cur[2]))
                cur = [key, x, x] if key else None
    specs = []
    for axis, line, a0, a1, la, lb, ia, ib, k0, k1 in runs:
        pair = (min(la, lb), max(la, lb))
        interior = indoor(la) and indoor(lb)
        if interior and etype.get(pair) == "open": continue
        if interior:
            d0, d1 = line - ti / 2, line + ti / 2; ext, inner_lab, outer_lab, outward = False, la, lb, None
        else:
            ext = True
            inner_lab, outer_lab = (la, lb) if indoor(la) else (lb, la)
            if indoor(la): d0, d1, outward = line - te, line, +1
            else: d0, d1, outward = line, line + te, -1
        is_party = False
        if ext and outer_lab <= 0:
            kdir = (1 if outward > 0 else 3) if axis == "y" else (2 if outward > 0 else 0)
            cells = [(k, ia if outward > 0 else ib) for k in range(k0, k1 + 1)] if axis == "y" else [(ia if outward > 0 else ib, k) for k in range(k0, k1 + 1)]
            vals = [party[yy, xx, kdir] for (yy, xx) in ([(k, xx) for k, xx in cells] if axis == "y" else [(yy, k) for yy, k in cells]) if 0 <= yy < H and 0 <= xx < W]
            is_party = bool(vals) and sum(vals) > len(vals) / 2
        sp = dict(axis=axis, line=line, a0=a0, a1=a1, d0=d0, d1=d1, ext=ext, inner=inner_lab, outer=outer_lab, outward=outward,
                  party=is_party, openings=[], storey=s)
        # D1: how much of each end is taken by the wall that meets it (exterior walls are thick; interior half-thick)
        sp["clear0"], sp["clear1"] = _end_clearance(L, sp, c, te, ti, indoor)
        sp["ext_in"], sp["ext_out"] = _extent(L, sp, c, inner_lab, la, lb), _extent(L, sp, c, outer_lab, la, lb)
        specs.append(sp)
    return specs


def _end_clearance(L, sp, c, te, ti, indoor):
    """How far the wall that meets each end of a run reaches into it (D1).

    At the run's end vertex, look across the perpendicular cell boundary on each indoor side of the run: an exterior
    wall there (one of the two cells is outside or a porch) intrudes by its full thickness te, an interior wall by
    ti/2, and no wall (the run just continues past a change on the other side) by 0."""
    H, W = L.shape
    def lab(y, x): return int(L[y, x]) if 0 <= y < H and 0 <= x < W else -1
    m = int(round(sp["line"] / c))
    sides = [r for r, l in ((m - 1, sp["inner"]), (m, sp["outer"])) if True]
    out = []
    for a in (sp["a0"], sp["a1"]):
        k = int(round(a / c)); need = 0.0
        for row in (m - 1, m):          # the two rows (or columns) either side of the run's line
            if sp["axis"] == "x": p, q = lab(row, k - 1), lab(row, k)
            else: p, q = lab(k - 1, row), lab(k, row)
            run_side = p if a == sp["a1"] else q        # the cell of this row that belongs to the run
            if not indoor(run_side): continue
            if p == q: continue
            need = max(need, te if (not indoor(p) or not indoor(q)) else ti / 2)
        out.append(need)
    return out


def _extent(L, sp, c, lab, la, lb):
    """[start, end] (mm) of room `lab`'s wall along this run's line on its own side (it may run past the run)."""
    if lab <= 0: return (sp["a0"], sp["a1"])
    H, W = L.shape; m = int(round(sp["line"] / c))
    row = m - 1 if lab == la else m
    k0, k1 = int(round(sp["a0"] / c)), int(round(sp["a1"] / c)) - 1
    get = (lambda k: L[row, k] if 0 <= row < H and 0 <= k < W else -1) if sp["axis"] == "x" else (lambda k: L[k, row] if 0 <= row < W and 0 <= k < H else -1)
    while k0 - 1 >= 0 and get(k0 - 1) == lab: k0 -= 1
    while get(k1 + 1) == lab: k1 += 1
    return (k0 * c, (k1 + 1) * c)


def corner_cost(sp, pos, w):
    """Merrell 2010 §6: a door sits near a corner, never mid-wall; choose the position that minimises the summed
    distance to the nearest corner in each of the two rooms:  J(p) = Σ_r min(p − w/2 − e_r0, e_r1 − (p + w/2))."""
    J = 0.0
    for e0, e1 in (sp["ext_in"], sp["ext_out"]):
        J += max(0.0, min(pos - w / 2 - e0, e1 - (pos + w / 2)))
    return J


# Merrell 2010 §6: passageways by privacy — ordinary doors for private rooms, glazed French doors for semi-private
# rooms (studies, patios), wide openings between public rooms
PUBLIC = {"living", "dining", "kitchen", "foyer", "hall", "corridor", "lobby", "family", "narthex", "sales", "staff"}
SEMI = {"study", "office", "porch", "patio", "sunroom", "library", "meeting", "gallery_room"}


def passage_type(ka, kb, open_air=False):
    if open_air or ka in SEMI or kb in SEMI: return "french"
    if ka in PUBLIC and kb in PUBLIC: return "cased"
    return "hinged"


def stair_rect(plan, s):
    """The stair flight rectangle (mm) on storeys that have a stair room, else None."""
    rooms = plan["program"]["rooms"]
    if not plan.get("stair") or not any(r.get("stair") for r in rooms if r["storey"] == s): return None
    c = plan["cell"] * 1000; x0, y0, w, h = plan["stair"]
    return (x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c)


def stair_obstacles(plan, s):
    """D5 (audit fix 2026-10-30): what a door may not swing over on storey s — the treads of the flight that starts
    on this storey and the slab opening of the flight arriving from below. Landings are allowed: a door may open onto a
    landing (IRC R311.7.6, IBC 1011.6), so testing the whole stair room failed every door into a stair hall."""
    rooms = plan["program"]["rooms"]
    if not plan.get("stair") or not any(r.get("stair") for r in rooms if r["storey"] == s): return None
    import stairs as STR
    from styles import style_for
    st = style_for(plan["theme"]); Hs = st["storey"] * 1000; S = len(plan["labels"])
    c = plan["cell"] * 1000; x0, y0, w, h = plan["stair"]
    box_ = (x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c)
    out = []
    if s < S - 1:
        D, parts = STR.stair_boxes(*box_, 0, Hs, rev=STR.ensure_rev(plan))
        out += [(b[0], b[1], b[3], b[4]) for role, b in parts if role == "step"]
    if s > 0:
        D, parts = STR.stair_boxes(*box_, 0, Hs, rev=STR.ensure_rev(plan))
        out += [tuple(hh) for hh in D["hole"]]
    return out or None


def stair_parts(plan, s):
    """Treads (in walking order) of the flight starting on storey s and the slab opening of the flight from below."""
    rooms = plan["program"]["rooms"]
    if not plan.get("stair") or not any(r.get("stair") for r in rooms if r["storey"] == s): return None
    import stairs as STR
    from styles import style_for
    st = style_for(plan["theme"]); Hs = st["storey"] * 1000; S = len(plan["labels"])
    c = plan["cell"] * 1000; x0, y0, w, h = plan["stair"]
    box_ = (x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c)
    D, parts = STR.stair_boxes(*box_, 0, Hs, rev=STR.ensure_rev(plan))
    steps = [(b[0], b[1], b[3], b[4]) for role, b in parts if role == "step"] if s < S - 1 else []
    hole = [tuple(hh) for hh in D["hole"]] if s > 0 else []
    return dict(steps=steps, hole=hole)


def stair_conflict(sp, pos, w, arcs, parts):
    """D5 by the codes, not by a box around the whole stair room (IRC R311.7.6 / IBC 1011.6): a door may not swing
    over treads or over the slab opening, and the 300 mm beyond its threshold must be floor or landing — or the bottom
    tread of a flight, whose landing is the floor of the room the door leads from."""
    if not parts: return False
    from shapely.geometry import box as B_
    bad = [B_(*b).buffer(-20) for b in parts["steps"][1:] + parts["hole"]]
    allb = [B_(*b).buffer(-20) for b in parts["steps"] + parts["hole"]]
    a0, a1 = pos - w / 2, pos + w / 2
    q = 200      # one stride beyond the threshold (less than the 229 mm minimum tread, so the bottom tread alone is allowed)
    th = [B_(a0, sp["d0"] - q, a1, sp["d0"]), B_(a0, sp["d1"], a1, sp["d1"] + q)] if sp["axis"] == "x" else [B_(sp["d0"] - q, a0, sp["d0"], a1), B_(sp["d1"], a0, sp["d1"] + q, a1)]
    if any(t.intersection(b).area > 5000 for t in th for b in bad): return True
    return any(A.intersection(b).area > 5000 for A in arcs for b in allb)


def _swing(sp, pos, w, depth=900):
    """Rectangles (mm) swept by a door leaf on both sides of the wall."""
    a0, a1 = pos - w / 2, pos + w / 2
    if sp["axis"] == "x": return [(a0, sp["line"] - depth, a1, sp["line"]), (a0, sp["line"], a1, sp["line"] + depth)]
    return [(sp["line"] - depth, a0, sp["line"], a1), (sp["line"], a0, sp["line"] + depth, a1)]


def _hits(r, q):
    if q is None: return False
    if isinstance(q, list): return any(_hits(r, qq) for qq in q)
    return r[0] < q[2] and q[0] < r[2] and r[1] < q[3] and q[1] < r[3]


# 2026-11-03: doors come in real sizes. Before, widths were whatever a call asked for (900, 800, 700 down a fallback
# ladder; 840 or 880 for a cased opening cut to its wall run; 1000 front doors, 1400 French pairs, 2700 / 4880 garage
# doors), so one house mixed six door widths. Now every door is a stock US size (the doors sold for Baton Rouge
# houses), by role: interior passage door 32 in, falling back to 30 in only where 32 in cannot fit; exterior doors
# 36 in; French pairs 5 ft; cased openings 3, 4, 5, 6 or 8 ft (the largest that the request allows); garage doors
# 9 ft (one car) or 16 ft (two); a warehouse door 12 ft.
IN = 25.4
STD_INTERIOR = (32 * IN, 30 * IN)                    # 812.8, 762.0 mm
STD_EXTERIOR = 36 * IN                               # 914.4 mm
STD_FRENCH = 60 * IN                                 # 1524 mm
STD_CASED = (36 * IN, 48 * IN, 60 * IN, 72 * IN, 96 * IN)
STD_GARAGE = (9 * 12 * IN, 12 * 12 * IN, 16 * 12 * IN)   # 2743.2, 3657.6, 4876.8 mm


def std_width(w, kind, kw):
    """The stock size for a requested opening width (see the table above)."""
    if kind == "overhead": return min(STD_GARAGE, key=lambda g: abs(g - w))
    if kind != "door": return w
    pt = kw.get("ptype")
    if pt == "cased" or kw.get("stair_mouth"):
        fit = [c for c in STD_CASED if c <= w + 1]
        return max(fit) if fit else w                # narrower than 3 ft: an opening across the whole clear width
    if pt == "french" or w >= 1300: return STD_FRENCH
    if kw.get("exterior") or kw.get("entry") or kw.get("street") or w >= 950: return STD_EXTERIOR
    return STD_INTERIOR[0] if w >= 805 else STD_INTERIOR[1]


def place(sp, w, kind, where="corner", legacy=True, stair=None, **kw):
    """Put one opening of width w on a run. Legacy: two fixed positions. Fixed: scan the run, keep jambs clear."""
    if not legacy: w = round(std_width(w, kind, kw), 1)
    L_ = sp["a1"] - sp["a0"]
    if legacy:
        if L_ < w + 200: return False
        pos = sp["a0"] + 150 + w / 2 if where == "corner" else (sp["a0"] + sp["a1"]) / 2
        for o in sp["openings"]:
            if abs(o["pos"] - pos) < (o["w"] + w) / 2 + 150:
                pos = sp["a1"] - 150 - w / 2
                if abs(o["pos"] - pos) < (o["w"] + w) / 2 + 150: return False
        sp["openings"].append(dict(pos=pos, w=w, kind=kind, **kw)); return True
    lo = sp["a0"] + sp["clear0"] + 100 + w / 2           # jamb 100 mm clear of the wall that meets this end
    hi = sp["a1"] - sp["clear1"] - 100 - w / 2
    if hi < lo: return False
    if where == "corner":
        cand = sorted(list(np.arange(lo, hi + 1, 50)) + [hi], key=lambda p: corner_cost(sp, p, w))       # paper §6
    elif isinstance(where, (list, tuple)):        # explicit preferred positions (the facade's window slots), in order
        cand = [p for p in where if lo <= p <= hi] + sorted(list(np.arange(lo, hi + 1, 150)), key=lambda p: abs(p - (sp["a0"] + sp["a1"]) / 2))
    else:
        mid = (sp["a0"] + sp["a1"]) / 2
        cand = sorted(set([min(max(mid, lo), hi)] + list(np.arange(lo, hi + 1, 150)) + [hi]), key=lambda p: abs(p - mid))
    for pos in cand:
        if any(abs(o["pos"] - pos) < (o["w"] + w) / 2 + 150 for o in sp["openings"]): continue
        if kind == "door" and stair is not None and any(_hits(r, stair) for r in _swing(sp, pos, w)): continue      # D5
        sp["openings"].append(dict(pos=float(pos), w=w, kind=kind, **kw)); return True
    return False


def place_doors(plan, s, specs, st, legacy=True):
    """Doors on programme edges, the street entry, garage doors and a back door. Returns a log of what failed."""
    rooms = plan["program"]["rooms"]; edges = plan["program"]["edges"]; th = plan["theme"]
    open_air = lambda lab: lab > 0 and rooms[lab - 1].get("open_air")
    stair = None if legacy else stair_obstacles(plan, s)
    log = {"edge_missing": [], "entry": None, "notes": []}
    for e in (edges if legacy else resolved_edges(plan)):
        a, b = e["a"] + 1, e["b"] + 1
        if rooms[e["a"]]["storey"] != s or e["type"] != "door": continue
        cands = [sp for sp in specs if {sp["inner"], sp["outer"]} == {a, b}]
        cands.sort(key=lambda sp: -(sp["a1"] - sp["a0"]))
        big = rooms[e["a"]]["kind"] in ("nave", "sales", "warehouse", "classroom", "dining_room") or rooms[e["b"]]["kind"] in ("nave", "sales", "warehouse")
        w = 1600 if big else 900 if th["archetype"] in HOUSES else 1000
        gl = rooms[e["a"]].get("open_air") or rooms[e["b"]].get("open_air")
        w0 = 1400 if (gl and st["window"]["kind"] == "french") else w
        kw = dict(glazed=bool(gl), exterior=gl, edge=(a, b))
        if not legacy:
            pt = passage_type(rooms[a - 1]["kind"], rooms[b - 1]["kind"], bool(gl))
            if big: pt = "cased" if not gl else pt
            kw["ptype"] = pt
            if pt == "cased": w0 = 1400 if not big else 2400; kw["glazed"] = False
            elif pt == "french": w0 = 1400; kw["glazed"] = True
            # (2026-11-03: bath, WC and utility doors are the same 32 in passage door as the rest; 30 in only if it can't fit)
        if gl and not legacy:       # a porch door faces the street when it can (D3 for porch entries)
            cands.sort(key=lambda sp: (not (sp["axis"] == "x" and sp["outward"] == -1), -(sp["a1"] - sp["a0"])))
            if s == 0 and plan["program"]["entry"] + 1 in (a, b): kw["entry"] = True
        if legacy:
            ok = any(place(sp, w0, "door", where="middle" if gl else "corner", legacy=True, **kw) for sp in cands)
        else:
            ok = _place_ladder(cands, [w0, w, 800, 700], "middle" if gl else "corner", stair, log, kw, rooms[a - 1]["kind"], rooms[b - 1]["kind"])
        if not ok: log["edge_missing"].append((rooms[a - 1]["kind"], rooms[b - 1]["kind"], max([sp["a1"] - sp["a0"] for sp in cands], default=0)))
    if s != 0: return log
    ent = plan["program"]["entry"] + 1
    big_entry = 1800 if th["archetype"] in ("church", "civic", "school", "big_box", "office") else 1000
    if not open_air(ent):
        fr = [sp for sp in specs if sp["ext"] and sp["inner"] == ent and sp["axis"] == "x" and sp["outward"] == -1 and not sp["party"]]
        fr.sort(key=lambda sp: -(sp["a1"] - sp["a0"]))
        for sp in fr:
            where = "middle" if legacy else window_slots(sp, st, central_first=True)
            if not legacy and plan.get("_facade") and st.get("facade") == "symmetric":
                F = plan["_facade"]; mid = (F["F0"] + F["F1"]) / 2
                where = sorted(F["x"], key=lambda p: abs(p - mid)) + list(where)
            if place(sp, big_entry, "door", where=where, legacy=legacy, exterior=True, entry=True, ptype="hinged"): log["entry"] = "front wall of the entry room" + ("" if legacy else " (central window slot)"); break
        if log["entry"] is None and not legacy:          # D3 fallbacks
            order = [
                ("side wall of the entry room", [sp for sp in specs if sp["ext"] and sp["inner"] == ent and not sp["party"] and sp["outer"] <= 0]),
                ("front wall of a public room next to the entry", [sp for sp in specs if sp["ext"] and sp["axis"] == "x" and sp["outward"] == -1 and not sp["party"]
                                                                    and _touches(specs, sp["inner"], ent) and rooms[sp["inner"] - 1]["kind"] in ("living", "hall", "foyer", "lobby", "corridor", "sales", "nave", "narthex", "office", "open_office")]),
                ("any exterior ground-floor wall", [sp for sp in specs if sp["ext"] and not sp["party"] and sp["outer"] <= 0 and rooms[sp["inner"] - 1]["kind"] not in ("bathroom", "wc", "bedroom", "stair")]),
            ]
            for why, sps in order:
                sps.sort(key=lambda sp: (not (sp["axis"] == "x" and sp["outward"] == -1), -(sp["a1"] - sp["a0"])))
                if any(place(sp, min(big_entry, 1000), "door", where="middle", legacy=False, exterior=True, entry=True) for sp in sps):
                    log["entry"] = why; break
    else:
        # porch entry: the door into the house is the porch → room edge; D4 adds one if the programme has none
        has = any(o.get("glazed") or o.get("exterior") for sp in specs for o in sp["openings"] if ent in (sp["inner"], sp["outer"]) and o["kind"] == "door")
        front = any(sp["axis"] == "x" and sp["outward"] == -1 for sp in specs for o in sp["openings"] if ent in (sp["inner"], sp["outer"]) and o["kind"] == "door")
        if has: log["entry"] = "porch door (programme edge)"
        if has and not front and not legacy:
            # 2026-11-02 (round 3): the programme door is on a side wall of the porch. Before, a SECOND, street-facing
            # door was added into the room behind the porch (two front doors). Now the one door moves to a street-facing
            # wall of the same room when there is one; otherwise the single side door stays (a porch entered from its side).
            side = [(sp, o) for sp in specs for o in sp["openings"] if ent in (sp["inner"], sp["outer"]) and o["kind"] == "door" and o.get("entry")]
            moved = False
            for sp0, o0 in side:
                room_ = sp0["inner"] if sp0["outer"] == ent else sp0["outer"]
                sps = [sp for sp in specs if sp["outer"] == ent and sp["inner"] == room_ and sp["axis"] == "x" and sp["outward"] == -1]
                kw0 = {k: v for k, v in o0.items() if k not in ("pos", "w", "kind", "swing")}
                if sps and _place_ladder(sps, [o0["w"], 1000, 900], "middle", None, log, kw0, "porch", rooms[room_ - 1]["kind"]):
                    sp0["openings"].remove(o0); moved = True; break
            log["entry"] = "porch door (programme edge)" + (", moved to the street side" if moved else ", on the porch's side")
        # fix (2026-11-02): this fallback was an `elif` of the side-wall case above, so a porch whose programme door
        # already faced the street got a SECOND door, into whichever room had the longest wall on the porch (a WC,
        # bedroom, study or utility in 9 of 25 designs). It runs only when there is no porch door at all, and only into
        # a front room.
        if not has and not legacy:
            pref = ("foyer", "hall", "living", "dining", "corridor", "lobby", "kitchen")
            sps = [sp for sp in specs if (sp["outer"] == ent or sp["inner"] == ent)
                   and rooms[(sp["inner"] if sp["outer"] == ent else sp["outer"]) - 1]["kind"] in pref]
            sps.sort(key=lambda sp: (pref.index(rooms[(sp["inner"] if sp["outer"] == ent else sp["outer"]) - 1]["kind"]), -(sp["a1"] - sp["a0"])))
            if any(place(sp, 1000, "door", where="middle", legacy=False, exterior=True, entry=True, glazed=True) for sp in sps): log["entry"] = "porch door (added)"
    if not legacy:
        for r in rooms:
            if r["storey"] != 0 or not r.get("street_door"): continue
            lab = r["id"] + 1
            sps = [sp for sp in specs if sp["ext"] and sp["inner"] == lab and not sp["party"] and sp["outer"] <= 0]
            sps.sort(key=lambda sp: (not (sp["axis"] == "x" and sp["outward"] == -1), -(sp["a1"] - sp["a0"])))
            if any(place(sp, 1000, "door", where="corner", legacy=False, stair=stair, exterior=True, street=True, ptype="hinged") for sp in sps) or \
               any(place(sp, 900, "door", where="corner", legacy=False, exterior=True, street=True, ptype="hinged") for sp in sps):
                log["notes"].append(f"street door for the {r['kind']} (own entrance)")
            else: log["edge_missing"].append((r["kind"], "street", 0))
    for r in rooms:
        if r["storey"] != 0: continue
        if r["kind"] in ("bay", "garage", "loading") or r["kind"] == "warehouse":
            sps = sorted([sp for sp in specs if sp["ext"] and sp["inner"] == r["id"] + 1 and not sp["party"] and sp["outer"] <= 0], key=lambda sp: (sp["axis"] != "x" or sp["outward"] != -1, -(sp["a1"] - sp["a0"])))
            if r["kind"] == "garage" and not legacy:
                # fix (2026-10-30): the overhead door goes on a short end, so a car drives straight in along the garage's
                # long axis and parks nose first with its rear to the door (a door on a long side would need a turn)
                Lg = np.array(plan["labels"][s]) == r["id"] + 1
                if Lg.any():
                    ys_, xs_ = np.nonzero(Lg); cell_ = plan["cell"]
                    depth = lambda sp: ((ys_.max() - ys_.min() + 1) if sp["axis"] == "x" else (xs_.max() - xs_.min() + 1)) * cell_
                    # the door goes where the garage is deep enough behind it for a sedan nose-in (6.3 m incl. walls);
                    # among those, the street front, then the longest run
                    sps = sorted(sps, key=lambda sp: (depth(sp) < 6.3, sp["axis"] != "x" or sp["outward"] != -1, -(sp["a1"] - sp["a0"])))
            for sp in sps:
                gw = 3600 if r["kind"] == "warehouse" else 4880 if r.get("cars", 1) >= 2 else 2700
                where = "middle"
                if r["kind"] == "garage" and not legacy:
                    # centre the door on the stretch of wall with full sedan depth behind it (an L-shaped garage has a notch)
                    Lg = np.array(plan["labels"][s]) == r["id"] + 1; cl = plan["cell"] * 1000
                    prof = Lg.sum(axis=0) if sp["axis"] == "x" else Lg.sum(axis=1)
                    ok_ = [(k + 0.5) * cl for k in range(len(prof)) if prof[k] * cl >= 6300 and sp["a0"] <= (k + 0.5) * cl <= sp["a1"]]
                    if ok_:
                        runs_, cur = [], [ok_[0]]
                        for v in ok_[1:]:
                            if v - cur[-1] <= cl * 1.01: cur.append(v)
                            else: runs_.append(cur); cur = [v]
                        runs_.append(cur); bestr = max(runs_, key=len)
                        where = [(bestr[0] + bestr[-1]) / 2]
                if place(sp, gw, "overhead", where=where, legacy=legacy, exterior=True): break
    for kind in ("kitchen", "kitchen_pro", "storage", "stockroom", "utility"):
        r = next((r for r in rooms if r["storey"] == 0 and r["kind"] == kind), None)
        if not r: continue
        sps = [sp for sp in specs if sp["ext"] and sp["inner"] == r["id"] + 1 and not sp["party"] and sp["outer"] <= 0 and not (sp["axis"] == "x" and sp["outward"] == -1)]
        if any(place(sp, 900, "door", where="middle", legacy=legacy, exterior=True, back=True) for sp in sorted(sps, key=lambda sp: -(sp["a1"] - sp["a0"]))): break
    return log


def _place_ladder(cands, widths, where, stair, log, kw, ka, kb):
    """D2 + D5: widest leaf first, stepping down to 700 mm; doors keep out of the stair flight unless nothing else fits."""
    seen = []
    for avoid in (True, False):
        for w in widths:
            if w in seen and avoid: continue
            for sp in cands:
                if place(sp, w, "door", where=where, legacy=False, stair=stair if avoid else None, **kw):
                    if w < widths[0]: log["notes"].append(f"{w} mm door {ka}–{kb}")
                    if not avoid and stair is not None: log["notes"].append(f"door {ka}–{kb} opens onto the stair")
                    return True
            seen.append(w)
        if stair is None: break
    return False


def resolved_edges(plan):
    """Programme edges with apartment units resolved: an edge to a subdivided unit room goes to the unit's entry room.
    Merge (2026-10-31): an access edge whose rooms do not share a door-length wall goes to the circulation room that does
    (hall, foyer, landing, corridor on the same floor) — the app's rule that rooms open off the circulation."""
    rooms = plan["program"]["rooms"]; edges = plan["program"]["edges"]
    unit_entry = {e["a"]: e["b"] for e in edges if e.get("unit_entry")}
    import planner as PL_
    runs = None
    out = []
    for e in edges:
        if e.get("unit_entry"): continue
        a, b = e["a"], e["b"]
        if rooms[a].get("subdivided"): a = unit_entry.get(a, a)
        if rooms[b].get("subdivided"): b = unit_entry.get(b, b)
        e2 = dict(e, a=a, b=b)
        if PL_.MERGE_ACCESS and PL_.access_edge(e2, rooms) and plan.get("labels"):
            if runs is None: runs = [PL_.pair_runs(np.array(L)) for L in plan["labels"]]
            c, r = PL_.access_edge(e2, rooms); s = rooms[r]["storey"]; need = math.ceil((1.6 if e2["type"] == "open" else 1.25) / plan["cell"] - 1e-9)
            if runs[s].get((min(c, r) + 1, max(c, r) + 1), 0) < need:
                alts = [(runs[s].get((min(x, r) + 1, max(x, r) + 1), 0), x) for x in PL_.access_alternatives(e2, rooms)]
                alts = [t for t in alts if t[0] >= need]
                if alts: e2 = dict(e2, a=r, b=max(alts)[1], served_by=rooms[max(alts)[1]]["kind"])
        out.append(e2)
    return out


def facade_slots(specs0, st):
    """Symmetric facade (Georgian / colonial / Greek revival): one bay rhythm across the whole street front,
    independent of the rooms behind it:  n = 2⌊(L_f − 600)/(2s)⌋ + 1 (odd, so a bay sits on the axis),
    p_i = F0 + (i + ½)·L_f / n.  The entrance takes the central bay; upper storeys reuse the same x positions."""
    front = [sp for sp in specs0 if sp["ext"] and not sp["party"] and sp["axis"] == "x" and sp["outward"] == -1 and sp["outer"] <= 0 or
             (sp["ext"] and sp["axis"] == "x" and sp["outward"] == -1 and sp["outer"] > 0)]
    if not front: return None
    line = min(sp["line"] for sp in front)
    row = [sp for sp in front if abs(sp["line"] - line) < 1]
    F0, F1 = min(sp["a0"] for sp in row), max(sp["a1"] for sp in row)
    s_ = st["window"]["spacing"] * 1000
    n = max(1, int((F1 - F0 - 600) // s_))
    if n % 2 == 0: n = max(1, n - 1)
    return dict(line=line, x=[F0 + (i + 0.5) * (F1 - F0) / n for i in range(n)], n=n, F0=F0, F1=F1)


def window_slots(sp, st, central_first=False):
    """Positions of the regular window rhythm on a run:  n = max(1, ⌊(L − 600)/s⌋),  p_i = a0 + (i + ½)·L/n."""
    Lr = sp["a1"] - sp["a0"]; s_ = st["window"]["spacing"] * 1000
    n = max(1, int((Lr - 600) // s_))
    P = [sp["a0"] + (i + 0.5) * Lr / n for i in range(n)]
    if central_first: P.sort(key=lambda p: abs(p - (sp["a0"] + sp["a1"]) / 2))
    return P


def _touches(specs, a, b):
    return any({sp["inner"], sp["outer"]} == {a, b} for sp in specs)


def place_windows(plan, s, specs, st, roof_z=None, z_floor=0.0, facade=None, slots=None):
    """Windows at regular intervals along each room's exterior walls (Merrell §6), sized by room type; on upper storeys
    a window that a lower roof would hit falls back to a short clerestory window above the roof, or is left out."""
    rooms = plan["program"]["rooms"]; th = plan["theme"]
    Hs = st["storey"] * 1000
    for sp in specs:
        if not sp["ext"] or sp["party"]: continue
        k = rooms[sp["inner"] - 1]["kind"]
        if k in ("stair", "corridor", "warehouse", "bay", "garage", "loading", "stockroom") and th["archetype"] not in ("warehouse",):
            if k not in ("stair", "corridor"): continue
        win = dict(st["window"])
        if k in ("bathroom", "wc", "wc_block", "utility"): win = dict(w=650, h=800, sill=1450, spacing=99, kind="casement")
        else: win = dict(w=win["w"] * 1000, h=win["h"] * 1000, sill=win["sill"] * 1000, spacing=win["spacing"] * 1000, kind=win["kind"])
        if th["archetype"] in ("storefront", "big_box") and s == 0 and sp["axis"] == "x" and sp["outward"] == -1 and k in ("sales", "dining_room", "lobby"):
            win.update(h=2700, sill=450, spacing=99, kind="storefront")
        if th["archetype"] == "church" and k == "nave": win.update(h=min(4200, Hs - 2200), sill=1400)
        if k == "kitchen" and win["sill"] < 1050: win.update(sill=1050, h=min(win["h"], 1200))          # above the worktop
        if k == "bedroom" and win["sill"] > 1100: win["sill"] = 1100                                     # egress sill ≤ 44 in
        if win["h"] + win["sill"] > Hs - SLAB - 250: win["h"] = Hs - SLAB - 250 - win["sill"]
        if win["kind"] == "storefront":
            cuts_ = sorted((o["pos"] - o["w"] / 2 - 150, o["pos"] + o["w"] / 2 + 150) for o in sp["openings"])
            lo = sp["a0"] + 250
            for c0, c1 in cuts_ + [(sp["a1"] - 250, sp["a1"])]:
                if c0 - lo >= 1200: sp["openings"].append(dict(pos=(lo + c0) / 2, w=c0 - lo, kind="window", win=dict(win, w=c0 - lo)))
                lo = max(lo, c1)
            continue
        Lr = sp["a1"] - sp["a0"]
        habitable = k not in ("bathroom", "wc", "wc_block", "utility", "stair", "corridor")
        positions = None
        if facade == "ribbon" and habitable and Lr >= 1800:
            # one continuous band per room wall:  w = L − 2·600 (split around any door on the run)
            lo = sp["a0"] + 600
            for c0, c1 in sorted((o["pos"] - o["w"] / 2 - 300, o["pos"] + o["w"] / 2 + 300) for o in sp["openings"]) + [(sp["a1"] - 600, sp["a1"])]:
                if c0 - lo >= 1200: sp["openings"].append(dict(pos=(lo + c0) / 2, w=c0 - lo, kind="window", win=dict(win, w=c0 - lo, kind="ribbon")))
                lo = max(lo, c1)
            continue
        if facade == "symmetric" and slots and sp["axis"] == "x" and sp["outward"] == -1 and abs(sp["line"] - slots["line"]) < 1 + (s > 0) * 1e9:
            m_ = win["w"] / 2 + 250
            positions = [p for p in slots["x"] if sp["a0"] + m_ <= p <= sp["a1"] - m_]
            if not positions or all(any(abs(o["pos"] - p) < (o["w"] + win["w"]) / 2 + 200 for o in sp["openings"]) for p in positions):
                positions = None if habitable else []      # no free bay on this room's front: fall back to its own rhythm
        if positions == []: continue
        n = int((Lr - 600) // win["spacing"]) if win["spacing"] < 99 else 1
        n = max(0, n)
        if Lr < win["w"] + 600: continue
        if n == 0: n = 1
        step = Lr / n
        for pos in (positions if positions is not None else [sp["a0"] + step * (i + 0.5) for i in range(n)]):
            if any(abs(o["pos"] - pos) < (o["w"] + win["w"]) / 2 + 200 for o in sp["openings"]): continue
            w_ = win
            if roof_z is not None and s > 0:
                # the lower roof just outside this window, if any
                off = 300 * (1 if sp["outward"] == 1 else -1)
                x, y = (pos, sp["line"] + off) if sp["axis"] == "x" else (sp["line"] + off, pos)
                rz = roof_z(x, y)
                if rz is not None and rz + 150 > z_floor + win["sill"]:
                    sill2 = rz - z_floor + 200; h2 = Hs - SLAB - 250 - sill2
                    if h2 < 450: sp.setdefault("skipped", []).append(pos); continue                   # no window
                    w_ = dict(win, sill=sill2, h=min(h2, 700), kind="casement", clerestory=True)
            sp["openings"].append(dict(pos=pos, w=w_["w"], kind="window", win=w_))
    # audit fix (daylight): a habitable room whose rhythm slots all collided with doors gets one window centred in the
    # largest free gap of its exterior walls (Merrell §6 rhythm first, daylight guaranteed second)
    lit = {sp["inner"] for sp in specs if sp["ext"] and any(o["kind"] == "window" for o in sp["openings"])}
    for sp in specs:
        if not sp["ext"] or sp["party"] or sp["inner"] in lit: continue
        r = rooms[sp["inner"] - 1]; k = r["kind"]
        if not r.get("daylight") or r.get("subdivided"): continue
        win = dict(st["window"]); win = dict(w=win["w"] * 1000, h=win["h"] * 1000, sill=win["sill"] * 1000, spacing=win["spacing"] * 1000, kind=win["kind"])
        if k == "kitchen" and win["sill"] < 1050: win.update(sill=1050, h=min(win["h"], 1200))
        if k == "bedroom" and win["sill"] > 1100: win["sill"] = 1100
        if win["h"] + win["sill"] > Hs - SLAB - 250: win["h"] = Hs - SLAB - 250 - win["sill"]
        cuts_ = sorted((o["pos"] - o["w"] / 2 - 200, o["pos"] + o["w"] / 2 + 200) for o in sp["openings"])
        lo, best = sp["a0"] + 300, None
        for c0, c1 in cuts_ + [(sp["a1"] - 300, sp["a1"])]:
            if best is None or c0 - lo > best[1] - best[0]: best = (lo, c0)
            lo = max(lo, c1)
        if best is None or best[1] - best[0] < 700: continue
        w = min(win["w"], best[1] - best[0])
        if roof_z is not None and s > 0:                      # the lower-roof rule applies to rescue windows too
            off = 300 * (1 if sp["outward"] == 1 else -1); pos_ = (best[0] + best[1]) / 2
            x, y = (pos_, sp["line"] + off) if sp["axis"] == "x" else (sp["line"] + off, pos_)
            rz = roof_z(x, y)
            if rz is not None and rz + 150 > z_floor + win["sill"]: continue
        sp["openings"].append(dict(pos=(best[0] + best[1]) / 2, w=w, kind="window", win=dict(win, w=w), rescue=True)); lit.add(sp["inner"])


def all_openings(plan, st, legacy=False, roofs=None):
    """Specs with doors and windows for every storey + the door log per storey. `roofs` (roofs.roof_plan) enables
    the lower-roof window rule."""
    out, logs = [], []
    plan.pop("_facade", None)
    for s in range(len(plan.get("labels", []))):
        specs = wall_specs(plan, s, st)
        if s == 0 and not legacy: plan["_facade"] = facade_slots(specs, st)
        logs.append(place_doors(plan, s, specs, st, legacy=legacy))
        out.append(specs)
    if not legacy: repair_reachability(plan, out, logs)
    if not legacy: stair_mouths(plan, out, logs)
    R0 = st["raise_"] * 1000; Hs = st["storey"] * 1000
    for s, specs in enumerate(out):
        rz = None
        if roofs and s > 0 and not legacy:
            import roofs as RF
            rz = (lambda s_: (lambda x, y: RF.height_at([r for r in roofs if r["storey"] < s_], x, y)))(s)
        place_windows(plan, s, specs, st, roof_z=rz, z_floor=R0 + s * Hs, facade=None if legacy else st.get("facade"), slots=None if legacy else plan.get("_facade"))
    plan.pop("_facade", None)
    if not legacy and __import__("os").environ.get("BAYS", "1") == "1":     # revision 2026-10-30: angled bay windows (bays.py)
        import bays as BAY
        BAY.add_bays(plan, st, out)
    if not legacy and roofs: lower_roof_windows(plan, st, out, logs, roofs)
    if not legacy: window_outlook(plan, out, logs)
    return out, logs


OUTLOOK = {"bathroom": 1500, "wc": 1500, "utility": 1500, "garage": 1500, "stair": 1500, "hall": 1500}


def outlook_clear(plan, s, sp, pos, w, depth):
    """Is the view from a window at `pos` (width w) clear of the building itself for `depth` mm outward?"""
    rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000
    built = None
    for ss in range(s, len(plan["labels"])):
        Ls = np.asarray(plan["labels"][ss])
        b = (Ls > 0) & ~np.isin(Ls, [r["id"] + 1 for r in rooms if r.get("open_air")])
        built = b if built is None else (built | b)
    H, W = built.shape
    face = sp["d1"] if sp["outward"] == 1 else sp["d0"]; sgn = 1 if sp["outward"] == 1 else -1
    for dist in range(200, int(depth) + 1, 200):
        for t in (-w / 2 + 100, 0.0, w / 2 - 100):
            a = pos + t; d = face + sgn * dist
            x, y = (a, d) if sp["axis"] == "x" else (d, a)
            i, j = int(y // c), int(x // c)
            if 0 <= i < H and 0 <= j < W and built[i, j]: return False
    return True


def window_outlook(plan, out, logs):
    """2026-11-03: a window looks out, not at a wall of the same house: no part of the building (this storey or above)
    within 3 m of a habitable room's window (1.5 m for baths, utility and halls; cf. IRC R303.1 light to a yard or
    court). A blocked window slides along its wall to a clear spot, else it is dropped (the daylight term in C_a and
    the rescue windows keep each habitable room lit)."""
    rooms = plan["program"]["rooms"]
    for s, specs in enumerate(out):
        for sp in specs:
            if not sp["ext"]: continue
            kind = rooms[sp["inner"] - 1]["kind"]; depth = OUTLOOK.get(kind, 3000)
            keep = []
            for o in sp["openings"]:
                if o["kind"] != "window" or outlook_clear(plan, s, sp, o["pos"], o["w"], depth): keep.append(o); continue
                others = [q for q in sp["openings"] if q is not o]
                lo = sp["a0"] + sp.get("clear0", 0) + 150 + o["w"] / 2; hi = sp["a1"] - sp.get("clear1", 0) - 150 - o["w"] / 2
                moved = False
                for p in sorted(np.arange(lo, hi + 1, 100), key=lambda p: abs(p - o["pos"])):
                    if any(abs(q["pos"] - p) < (q["w"] + o["w"]) / 2 + 200 for q in others): continue
                    if outlook_clear(plan, s, sp, p, o["w"], depth):
                        o["pos"] = float(p); keep.append(o); moved = True
                        logs[s]["notes"].append(f"{kind} window moved to a clear outlook"); break
                if not moved: logs[s]["notes"].append(f"{kind} window facing a wall dropped")
            sp["openings"] = keep


def roof_over_window(roofs, s, sp, o, margin=60):
    """Highest lower-roof point (mm, absolute) across the opening's full width just outside the wall face, or None."""
    import roofs as RF
    lower = [r for r in roofs if r["storey"] < s]
    if not lower: return None
    face = (sp["d1"] + margin) if sp["outward"] == 1 else (sp["d0"] - margin)
    zs = []
    for t in np.linspace(-o["w"] / 2, o["w"] / 2, 9):
        a = o["pos"] + t
        x, y = (a, face) if sp["axis"] == "x" else (face, a)
        z = RF.height_at(lower, x, y)
        if z is not None: zs.append(z)
    return max(zs) if zs else None


def lower_roof_windows(plan, st, out, logs, roofs):
    """Merrell 2010 §6: "If a window is obstructed by a roof segment from a lower floor, the system defaults to a smaller
    window type, if available. If the obstruction is too great for any available window type, no window is placed."
    2026-11-02: tested across the window's whole width at the wall face (before: one point 300 mm out at its centre,
    which left the window's edges behind a sloping roof — 5 of ~15 upper windows per design). The smaller type keeps
    the head and raises the sill 150 mm above the roof; under 600 mm of glass there is no window. Bays over a lower
    roof are dropped (they project 0.7 m into it)."""
    R0 = st["raise_"] * 1000; Hs = st["storey"] * 1000
    for s, specs in enumerate(out):
        if s == 0: continue
        zf = R0 + s * Hs
        for sp in specs:
            if not sp["ext"]: continue
            keep = []
            for o in sp["openings"]:
                if o["kind"] == "bay":
                    z = roof_over_window(roofs, s, sp, dict(o, w=o.get("span", o["w"])), margin=800)
                    if z is not None and z + 150 > zf + 450:
                        logs[s]["notes"].append("bay over a lower roof dropped (§6)"); continue
                if o["kind"] == "window":
                    z = roof_over_window(roofs, s, sp, o)
                    w = o["win"]; sill, head = w["sill"], w["sill"] + w["h"]
                    if z is not None and z + 150 > zf + sill:
                        new_sill = z + 150 - zf
                        if head - new_sill >= 600:
                            o["win"] = dict(w, sill=float(new_sill), h=float(head - new_sill)); o["smaller_type"] = True
                            logs[s]["notes"].append(f"window over a lower roof: smaller type, sill {new_sill:.0f} mm (§6)")
                        else:
                            logs[s]["notes"].append("window behind a lower roof dropped (§6)"); continue
                keep.append(o)
            sp["openings"] = keep


def stair_mouths(plan, out, logs):
    """2026-11-02 (IRC R311.7.6, Merrell 2010 §6): the foot of a flight and its arrival zone open onto the rooms that
    reach them. A stair space is only ~1.1 m wide, below the 1.6 m an open edge needs, so the wall builder always closed
    its ends; 13 of 15 flights in the 2026-10-31 competition had a wall straight across the foot. Here the wall at the
    foot and at the best head exit gets a stair-wide cased opening (no leaf)."""
    import stairs as STR
    if not plan.get("stair") or len(out) < 2: return
    rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000
    rev = STR.ensure_rev(plan); sc = STR.stair_cells(plan, rev)
    if sc is None: return
    ay = sc["D"]["along_y"]
    stl = {r["storey"]: r["id"] + 1 for r in rooms if r.get("stair")}
    def majority(L, cells):
        H, W = L.shape; v = [int(L[i, j]) for i, j in cells if 0 <= i < H and 0 <= j < W and L[i, j] > 0]
        return max(set(v), key=v.count) if v else None
    def open_strip(s, cells, boundary_axis):
        L = np.asarray(plan["labels"][s]); nb = majority(L, cells); st_ = stl.get(s)
        if nb is None or st_ is None or not STR.strip_ok(L, rooms, cells): return False
        # boundary between the strip and the stair room: the strip's cells are all on one side of one grid line
        rows = [i for i, j in cells]; cols = [j for i, j in cells]
        if boundary_axis == "x":       # the boundary is a row line; the strip runs along x
            sr = rows[0]; line_ = (sr + 1) * c if np.asarray(plan["labels"][s])[min(sr + 1, L.shape[0] - 1), cols[0]] == st_ else sr * c
            lo, hi = min(cols) * c, (max(cols) + 1) * c
        else:
            sc_ = cols[0]; line_ = (sc_ + 1) * c if np.asarray(plan["labels"][s])[rows[0], min(sc_ + 1, L.shape[1] - 1)] == st_ else sc_ * c
            lo, hi = min(rows) * c, (max(rows) + 1) * c
        for sp in out[s]:
            if sp["axis"] != boundary_axis or {sp["inner"], sp["outer"]} != {st_, nb} or abs(sp["line"] - line_) > c / 2: continue
            # jambs clear of the walls that meet this run (the D1 jamb rule), round 3
            a0, a1 = max(lo, sp["a0"] + sp.get("clear0", 0) + 100), min(hi, sp["a1"] - sp.get("clear1", 0) - 100)
            if a1 - a0 < 800:
                # 2026-11-02: a stair end too short for the jamb clearances is left open across its whole clear width
                # (before, the code skipped it and reported "no wall": Quail Oak design 1's stair foot stayed walled)
                a0, a1 = max(lo, sp["a0"] + sp.get("clear0", 0)), min(hi, sp["a1"] - sp.get("clear1", 0))
                if a1 - a0 < 800: return False
            w = std_width(min(1000.0, a1 - a0), "door", dict(ptype="cased")); pos = (a0 + a1) / 2
            if any(abs(o["pos"] - pos) < (o["w"] + w) / 2 and o["kind"] in ("door", "overhead") and o["w"] >= 800 for o in sp["openings"]): return True
            sp["openings"] = [o for o in sp["openings"] if abs(o["pos"] - pos) >= (o["w"] + w) / 2 + 50]
            sp["openings"].append(dict(pos=float(pos), w=float(w), kind="door", ptype="cased", glazed=False, exterior=False, edge=(st_, nb), stair_mouth=True))
            logs[s]["notes"].append(f"stair mouth: {w:.0f} mm cased opening to the {rooms[nb - 1]['kind']}")
            return True
        # no wall between the stair and that room on this line: open only if the two really meet here (an open edge)
        return not any(sp["axis"] == boundary_axis and abs(sp["line"] - line_) <= c / 2 and st_ in (sp["inner"], sp["outer"])
                       and min(hi, sp["a1"]) - max(lo, sp["a0"]) > 200 for sp in out[s])
    across = "x" if ay else "y"         # foot/end strips run across the flight; side strips run along it
    along = "y" if ay else "x"
    plan["_stair_foot_ok"] = open_strip(0, sc["foot"], across)
    plan["_stair_head_ok"] = any(open_strip(1, e, across if k == 0 else along) for k, e in enumerate(sc["exits"]))


REPAIR_PREF = ("corridor", "hall", "foyer", "lobby", "living", "dining", "kitchen", "stair", "office", "open_office", "sales", "nave",
               "narthex", "classroom", "utility", "study", "bedroom")


def _merge():
    import planner as PL_
    return PL_.MERGE_ACCESS


def repair_reachability(plan, specs_by_storey, logs):
    """D6: a room the programme meant to reach but that no door reaches gets a door to the best reachable neighbour
    (circulation first, then public rooms; never through a bathroom), so no room is sealed."""
    rooms = plan["program"]["rooms"]
    for _ in range(len(rooms)):
        R = audit(plan, specs_by_storey, logs, quick=True)
        bad = [i for i in R["unreachable_ids"]]
        if not bad: return
        fixed = False
        for rid in bad:
            lab = rid + 1; s = rooms[rid]["storey"]
            specs = specs_by_storey[s]; stair = stair_obstacles(plan, s)
            nbrs = [sp for sp in specs if not sp["ext"] and lab in (sp["inner"], sp["outer"])]
            def other(sp): return sp["outer"] if sp["inner"] == lab else sp["inner"]
            # merge (2026-10-31): never route a door through a bedroom, bath or garage (no walk-through bedrooms)
            ok_n = [sp for sp in nbrs if other(sp) - 1 not in bad and rooms[other(sp) - 1]["kind"] not in (("bathroom", "wc", "wc_block", "bedroom", "garage") if _merge() else ("bathroom", "wc", "wc_block"))]
            ok_n.sort(key=lambda sp: (REPAIR_PREF.index(rooms[other(sp) - 1]["kind"]) if rooms[other(sp) - 1]["kind"] in REPAIR_PREF else 99, -(sp["a1"] - sp["a0"])))
            for sp in ok_n:
                if _place_ladder([sp], [900, 800, 700], "corner", stair, logs[s], dict(glazed=False, exterior=False, edge=(lab, other(sp)), repair=True),
                                 rooms[rid]["kind"], rooms[other(sp) - 1]["kind"]):
                    logs[s]["notes"].append(f"repair door {rooms[rid]['kind']}–{rooms[other(sp) - 1]['kind']}"); fixed = True; break
            if fixed: break
        if not fixed: return


# ------------------------------------------------------------------------------------------------ audit
def audit(plan, specs_by_storey, logs, quick=False):
    """Door checks: street door, every door edge realised, every room reachable, jambs clear, no door into a stair."""
    rooms = plan["program"]["rooms"]; edges = plan["program"]["edges"]
    R = {"street_door": False, "front_door": False, "missing_edges": [], "unreachable": [], "jamb_in_wall": 0, "into_stair": 0, "doors": 0}
    graph = {i + 1: set() for i in range(len(rooms))}
    OUT = 0; graph[OUT] = set()
    def link(a, b): graph.setdefault(a, set()).add(b); graph.setdefault(b, set()).add(a)
    # audit fix (2026-10-30): an open-wall edge is only realised when the two rooms really share a wall run wide enough
    # for the opening (1.6 m, the planner's C_a rule); before, any open edge counted as a link even with the rooms apart
    import planner as PL_
    runs_by_storey = [PL_.pair_runs(np.array(L)) for L in plan["labels"]]
    for e in resolved_edges(plan):
        if e["type"] != "open": continue
        a, b = e["a"] + 1, e["b"] + 1; s_ = rooms[e["a"]]["storey"]
        if rooms[e["b"]]["storey"] != s_ or (rooms[e["a"]].get("stair") and rooms[e["b"]].get("stair")): link(a, b); continue
        if runs_by_storey[s_].get((min(a, b), max(a, b)), 0) * plan["cell"] >= 1.6 - 1e-9: link(a, b)
        else: R["missing_edges"].append((rooms[a - 1]["kind"], rooms[b - 1]["kind"], 0.0))
    for s, specs in enumerate(specs_by_storey):
        stair = stair_obstacles(plan, s)
        for sp in specs:
            for o in sp["openings"]:
                if o["kind"] not in ("door", "overhead"): continue
                R["doors"] += 1
                a, b = sp["inner"], sp["outer"]
                if b <= 0 or rooms[b - 1].get("open_air"):
                    if s == 0 and o["kind"] == "door": R["street_door"] = True
                    if s == 0 and o["kind"] == "door" and sp["axis"] == "x" and sp["outward"] == -1 and (b <= 0 or rooms[b - 1].get("open_air")): R["front_door"] = True
                    link(a, OUT if b <= 0 else b)
                    if b > 0: link(b, OUT)
                else: link(a, b)
                if o["pos"] - o["w"] / 2 < sp["a0"] + sp["clear0"] or o["pos"] + o["w"] / 2 > sp["a1"] - sp["clear1"]: R["jamb_in_wall"] += 1
                if o["kind"] == "door" and stair is not None:
                    sw = o.get("swing") or {}
                    if sw.get("v2") or sw.get("kind") == "pocket" or o.get("ptype") == "cased":     # swing known: the exact D5 rule
                        from shapely.geometry import Polygon as P_
                        if stair_conflict(sp, o["pos"], o["w"], [P_(a) for a in sw.get("arcs", [])], stair_parts(plan, s)): R["into_stair"] += 1
                    elif any(_hits(r, stair) for r in _swing(sp, o["pos"], o["w"])): R["into_stair"] += 1
        R["missing_edges"] += logs[s]["edge_missing"]
    # round 5 (2026-11-02): a cluster (living–dining–kitchen) is realised when its rooms are joined by doors or open
    # passages among themselves; its unrealised members are then not missing
    for name in {e.get("cluster") for e in edges if e.get("cluster")}:
        ces = [e for e in edges if e.get("cluster") == name]
        ids = {x + 1 for e in ces for x in (e["a"], e["b"])}
        par = {i: i for i in ids}
        def f_(x):
            while par[x] != x: x = par[x]
            return x
        for a_ in ids:
            for b_ in graph.get(a_, ()):
                if b_ in ids: par[f_(a_)] = f_(b_)
        if len({f_(i) for i in ids}) == 1:
            kinds = [{rooms[e["a"]]["kind"], rooms[e["b"]]["kind"]} for e in ces]
            R["missing_edges"] = [m for m in R["missing_edges"] if {m[0], m[1]} not in kinds]
    # open-air rooms (porches) touch the outside
    for r in rooms:
        if r.get("open_air"): link(r["id"] + 1, OUT)
    # stairs connect storeys: stair rooms on consecutive storeys
    st_ids = [r["id"] + 1 for r in rooms if r.get("stair")]
    for a in st_ids:
        for b in st_ids:
            if a != b: link(a, b)
    seen, q = {OUT}, [OUT]
    while q:
        v = q.pop()
        for w in graph.get(v, ()):
            if w not in seen: seen.add(w); q.append(w)
    R["unreachable_ids"] = [i for i in range(len(rooms)) if i + 1 not in seen and not rooms[i].get("subdivided")]
    R["unreachable"] = [rooms[i]["kind"] for i in R["unreachable_ids"]]
    # merge (2026-10-31): walk-through check. A private room (bedroom, bath, wc, garage) may be entered but not walked
    # through, except into its own en-suite (a bath, wc or closet the programme opens off it).
    PRIV = {"bedroom", "bathroom", "wc", "wc_block", "garage"}; ENS = {"bathroom", "wc", "closet", "wic"}
    prog_pairs = {(min(e["a"], e["b"]) + 1, max(e["a"], e["b"]) + 1) for e in edges}
    seen2, q = {OUT}, [OUT]
    while q:
        v = q.pop()
        vk = rooms[v - 1]["kind"] if v > 0 else None
        for w in graph.get(v, ()):
            if w in seen2: continue
            if vk in PRIV and not (w > 0 and rooms[w - 1]["kind"] in ENS and (min(v, w), max(v, w)) in prog_pairs and vk == "bedroom"):
                continue
            seen2.add(w); q.append(w)
    R["through_private"] = [rooms[i]["kind"] for i in range(len(rooms)) if i + 1 in seen and i + 1 not in seen2
                            and not rooms[i].get("subdivided")]
    if quick: return R
    R["entry_rule"] = logs[0]["entry"] if logs else None
    return R
