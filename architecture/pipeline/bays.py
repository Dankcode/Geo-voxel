"""Bay windows: the angled window walls of Merrell et al. 2010's figures (Fig. 1, 7, 12: living rooms with a three-sided
bay). The paper's layout is rectilinear and the bays come with the style, so they are added here after the doors and
windows are placed (openings.all_openings), deterministically, so the blueprint, the furniture, the scorecard and the
FreeCAD model all see the same bay.

A bay sits on one exterior wall run of a ground-floor living or dining room:
  span    W  = min(3000, clear run − 800) mm, W ≥ 2400, centred on the run's clear part, no door on the run
  depth   P  = 700 mm beyond the wall's outside face; sides at 45° (side face length P·√2), centre face W − 2P
  walls   t  = 200 mm framed walls on the three faces; the main wall opens over the span up to the head (2400 mm)
  glass   one window per face, sill 450 mm, head 2250 mm, 150 mm piers at the corners
The run's own windows inside the span are replaced by the bay's three windows (they count for daylight and egress).
"""
import math
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union
import layout as LAY

STYLE_P = {"queen_anne": 0.9, "italianate": 0.8, "victorian": 0.85, "colonial_revival": 0.5, "italian_renaissance": 0.5,
           "craftsman": 0.4, "midcentury": 0.35, "tudor": 0.6, "neoclassical": 0.3, "creole": 0.1, "shotgun": 0.1}
P_DEPTH, T_WALL, SILL, HEAD, PIER = 700.0, 200.0, 450.0, 2250.0, 150.0
HOUSES = ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse")


def add_bays(plan, st, specs_by_storey):
    th = plan.get("theme", {})
    if th.get("archetype") not in HOUSES or not specs_by_storey: return
    rooms = plan["program"]["rooms"]
    rnd = LAY.stable_seed(plan.get("id"), plan.get("seed", plan.get("key")), "bay") / 65535.0
    p = STYLE_P.get(th.get("style"), 0.3)
    plan.setdefault("program", {}).setdefault("log", [])
    if rnd >= p:
        _log(plan, f"bay window | style {th.get('style')}: p={p:.2f} → no"); return
    specs = specs_by_storey[0]; best = None
    for sp in specs:
        if not sp["ext"] or sp["party"] or sp["outer"] > 0: continue
        r = rooms[sp["inner"] - 1] if 0 < sp["inner"] <= len(rooms) else None
        if r is None or r["kind"] not in ("living", "dining") or r["storey"] != 0: continue
        if any(o["kind"] in ("door", "overhead") for o in sp["openings"]): continue
        lo, hi = sp["a0"] + sp["clear0"] + 400, sp["a1"] - sp["clear1"] - 400
        W = min(3000.0, hi - lo)
        if W < 2400: continue
        street = sp["axis"] == "x" and sp["outward"] == -1
        score = (r["kind"] == "living", street, W)
        if best is None or score > best[0]: best = (score, sp, (lo + hi) / 2, W, r)
    if best is None:
        _log(plan, "bay window | no living/dining wall with 3.2 m clear and no door → none"); return
    _, sp, c, W, r = best
    sp["openings"] = [o for o in sp["openings"] if not (o["kind"] == "window" and abs(o["pos"] - c) < W / 2 + o["w"] / 2)]
    geo = geometry(sp, c, W)
    wins = [dict(kind="casement", w=round(L_ - 2 * PIER), h=HEAD - SILL, sill=SILL, face=i) for i, (_, _, L_) in enumerate(geo["faces"])]
    b0, b1 = geo["open"]
    sp["openings"].append(dict(kind="bay", pos=float(c), w=float(b1 - b0), span=float(W), proj=P_DEPTH, t=T_WALL, head=HEAD, bay_wins=wins, room=sp["inner"]))
    _log(plan, f"bay window | style {th.get('style')}: p={p:.2f} → yes, {r['kind']}, {W / 1000:.1f} m wide, {P_DEPTH / 1000:.1f} m deep, {'street front' if (sp['axis'] == 'x' and sp['outward'] == -1) else 'side/rear'}")


def _log(plan, msg):
    L = plan["program"].setdefault("log", [])
    if not any(l.startswith("bay window") for l in L): L.append(msg)


def geometry(sp, c, W):
    """Bay polygons (mm, plan frame): `outer` (bay floor incl. its walls and the opened main-wall span), `inner` (floor
    added to the room), `walls` (the three framed faces, t thick), `faces` [(p0, p1, length)] of the outside faces."""
    out = sp["outward"]
    face = sp["d0"] if out == -1 else sp["d1"]            # outside face of the main wall
    inner_face = sp["d1"] if out == -1 else sp["d0"]
    a0, a1 = c - W / 2, c + W / 2
    def pt(a, d): return (a, d) if sp["axis"] == "x" else (d, a)
    o = lambda k: face + out * k
    Q = [pt(a0, face), pt(a0 + P_DEPTH, o(P_DEPTH)), pt(a1 - P_DEPTH, o(P_DEPTH)), pt(a1, face)]
    t = T_WALL
    bq = Polygon(Q).buffer(0)
    bext = Polygon([pt(a0, face - out * t)] + Q + [pt(a1, face - out * t)]).buffer(0)       # pushed t into the wall
    bin_ = bext.buffer(-t, join_style=2)                                                    # inside of the three faces
    walls = bq.difference(bin_)
    lo_ = bin_.intersection(sbox(*_bb(pt(a0 - 1, face - 1), pt(a1 + 1, face + 1))))
    b0, b1 = ((lo_.bounds[0], lo_.bounds[2]) if sp["axis"] == "x" else (lo_.bounds[1], lo_.bounds[3])) if not lo_.is_empty else (a0 + t, a1 - t)
    gap = sbox(*_bb(pt(b0, inner_face), pt(b1, face)))                                       # the main wall opened over the bay
    inner = bin_.intersection(bq).union(gap).buffer(0)
    outer = bq.union(sbox(*_bb(pt(a0, inner_face), pt(a1, face)))).buffer(0)
    faces = [(Q[i], Q[i + 1], math.dist(Q[i], Q[i + 1])) for i in range(3)]
    return dict(outer=outer, inner=inner, walls=walls, faces=faces, gap=gap, open=(b0, b1), axis=sp["axis"], outward=out, face=face,
                inner_face=inner_face, a0=a0, a1=a1)


def _bb(p, q): return (min(p[0], q[0]), min(p[1], q[1]), max(p[0], q[0]), max(p[1], q[1]))


def bays_of(specs_by_storey):
    """[(storey, spec, opening, geometry)] for every bay."""
    return [(s, sp, o, geometry(sp, o["pos"], o["span"])) for s, specs in enumerate(specs_by_storey) for sp in specs for o in sp["openings"] if o["kind"] == "bay"]


def window_segments(g, wins):
    """Window spans on each outside face (for drawings): [(x0, y0, x1, y1)]."""
    out = []
    for (p0, p1, L), w in zip(g["faces"], wins):
        ux, uy = (p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L; m = (L - w["w"]) / 2
        out.append((p0[0] + ux * m, p0[1] + uy * m, p1[0] - ux * m, p1[1] - uy * m))
    return out


def elements(g, o, z0, walls_col, trim_col, roof_col):
    """Generic solids for one bay (mm): prisms {ring, z0, h, role, colour}; the roof as a 3-face hip
    {"t": "hip", "eave": [4 pts], "ridge": [2 pts], "z_eave", "z_ridge"} (FreeCAD builds it; the mesh spec caps it)."""
    E = []
    def prism(poly, za, zb, role, col):
        for p in (poly.geoms if hasattr(poly, "geoms") else [poly]):
            if p.is_empty or p.area < 100: continue
            E.append(dict(t="prism", ring=list(p.exterior.coords)[:-1], holes=[list(h.coords)[:-1] for h in p.interiors], z0=z0 + za, h=zb - za, role=role, colour=col))
    W = g["walls"]
    prism(W, 0, SILL, "ext_wall", walls_col)                                   # knee wall
    prism(W, HEAD, HEAD + 300, "ext_wall", walls_col)                          # header
    # corner piers at the three face junctions and both ends, full height between sill and head
    from shapely.geometry import Point
    for p in [f[0] for f in g["faces"]] + [g["faces"][-1][1]]:
        prism(W.intersection(Point(p).buffer(PIER * 1.2)), SILL, HEAD, "ext_wall", trim_col)
    # glass: the wall ring between piers
    piers = unary_union([Point(f[0]).buffer(PIER * 1.2) for f in g["faces"]] + [Point(g["faces"][-1][1]).buffer(PIER * 1.2)])
    glass = W.difference(piers).buffer(-T_WALL * 0.35)
    prism(glass, SILL, HEAD, "window", "#b9d6df")
    prism(W.difference(piers).difference(W.difference(piers).buffer(-T_WALL * 0.3)), SILL, SILL + 50, "window", trim_col)   # sill frame
    prism(g["outer"].difference(g["inner"].buffer(-1)).union(g["inner"]).buffer(0), -150, 0, "slab", "#c9b48f")       # bay floor
    # hip roof: eaves 150 mm outside the faces at head + 300, ridge on the main wall's outside face
    ov = 150; out = g["outward"]; ax = g["axis"]
    def pt(a, d): return (a, d) if ax == "x" else (d, a)
    f, a0, a1 = g["face"], g["a0"], g["a1"]
    P = P_DEPTH + ov
    eave = [pt(a0 - ov, f), pt(a0 + P_DEPTH, f + out * P), pt(a1 - P_DEPTH, f + out * P), pt(a1 + ov, f)]
    rise = P * math.tan(math.radians(30))
    E.append(dict(t="hip", eave=eave, ridge=[pt(a0 + P_DEPTH, f), pt(a1 - P_DEPTH, f)], z_eave=z0 + HEAD + 300, z_ridge=z0 + HEAD + 300 + rise, role="roof", colour=roof_col))
    return E
