"""Plan → FreeCAD BIM model: walls with real openings, windows and doors, slabs, foundations, porches, stairs, roofs,
trim, furniture. Exports .FCStd, .ifc and a coloured mesh (for the web viewer).

Frame: X = u (along the street front), Y = v (front → back), Z up; mm. Lattice cell (x, y) covers
[x·c, (x+1)·c] × [y·c, (y+1)·c].
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, math, sys, os, base64, struct
import os as _os_env
import numpy as np
sys.path.insert(0, _HERE)
import FreeCAD, Part, Arch
from FreeCAD import Vector as V
from shapely.geometry import box as sbox, Polygon, MultiPolygon, LineString
from shapely.ops import unary_union
from styles import style_for, column_dims
import furniture as F
import openings as O
import roofs as RF
import stairs as STR
import doorlogic as DL
import layout as LAY

SLAB = 200


class Model:
    def __init__(self, name):
        self.doc = FreeCAD.newDocument(name)
        self.parts = []          # (role, storey, ifc, colour, shape) for the mesh export
        self.mats = {}
        self.levels = []

    def material(self, colour, name):
        if colour not in self.mats:
            m = Arch.makeMaterial(name); m.Color = tuple(int(colour[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (0.0,)
            self.mats[colour] = m
        return self.mats[colour]

    def add(self, shape, role, storey, colour, ifc="BuildingElementProxy", label=None, arch=True, matname=None):
        if shape is None or shape.isNull() or shape.Volume < 1: return None
        self.parts.append((role, storey, ifc, colour, shape))
        if not arch: return None
        base = self.doc.addObject("Part::Feature", (label or role) + "_base"); base.Shape = shape
        if ifc == "Wall": o = Arch.makeWall(base)
        elif ifc in ("Slab", "Column", "Beam", "Footing", "Railing", "Stair", "Roof", "Covering"):
            o = Arch.makeStructure(base); o.IfcType = {"Slab": "Slab", "Column": "Column", "Beam": "Beam", "Footing": "Footing", "Railing": "Railing", "Stair": "Stair", "Roof": "Roof", "Covering": "Covering"}[ifc]
        elif ifc in ("Window", "Door"):
            o = Arch.makeStructure(base); o.IfcType = ifc        # makeWindow needs the GUI; a typed component exports as IfcWindow / IfcDoor
        elif ifc == "Furniture":
            o = Arch.makeEquipment(base)
            try: o.IfcType = "Furniture"
            except Exception: pass
        else:
            o = Arch.makeComponent(base) if hasattr(Arch, "makeComponent") else Arch.makeStructure(base)
        o.Label = label or role
        try: o.Material = self.material(colour, matname or role)
        except Exception: pass
        if self.levels and storey is not None and storey < len(self.levels): self.levels[storey].addObject(o)
        return o


def cells_poly(mask, c):
    ys, xs = np.nonzero(mask)
    if not len(ys): return None
    return unary_union([sbox(x * c, y * c, (x + 1) * c, (y + 1) * c) for y, x in zip(ys, xs)]).buffer(0.5).buffer(-0.5)


def face_of(poly):
    polys = [poly] if isinstance(poly, Polygon) else list(poly.geoms)
    out = []
    for p in polys:
        if p.area < 1: continue
        w = Part.makePolygon([V(x, y, 0) for x, y in p.exterior.coords])
        f = Part.Face(w)
        for h in p.interiors:
            f = f.cut(Part.Face(Part.makePolygon([V(x, y, 0) for x, y in h.coords])))
        out.append(f)
    return out


def extrude(poly, z0, h):
    sol = [f.extrude(V(0, 0, h)).translated(V(0, 0, z0)) for f in face_of(poly)]
    if not sol: return None
    s = sol[0]
    for o in sol[1:]: s = s.fuse(o)
    return s


def rectangles(mask, min_side=2, max_n=10):
    """Greedy largest rectangles covering a cell mask (for roofs)."""
    m = mask.copy(); out = []
    H, W = m.shape
    while m.any() and len(out) < max_n:
        best, ba = None, 0
        h = np.zeros(W, int)
        for y in range(H):
            h = np.where(m[y], h + 1, 0)
            st = []
            for x in range(W + 1):
                cur = h[x] if x < W else 0
                while st and h[st[-1]] >= cur:
                    top = st.pop(); hh = h[top]; left = st[-1] + 1 if st else 0; ww = x - left
                    if hh * ww > ba and hh >= min_side and ww >= min_side: ba, best = hh * ww, (left, y - hh + 1, ww, hh)
                st.append(x)
        if not best: break
        x0, y0, w, hh = best; out.append(best); m[y0:y0 + hh, x0:x0 + w] = False
    return out, m


# ------------------------------------------------------------------------------------------------ roofs
def gable(x0, y0, x1, y1, z, pitch, along_x, eave, t=160):
    """Shell of a gable roof over [x0,x1]×[y0,y1] at plate height z; ridge along X (along_x) or Y."""
    X0, Y0, X1, Y1 = x0 - eave, y0 - eave, x1 + eave, y1 + eave
    tanp = math.tan(math.radians(pitch))
    def prism(X0, Y0, X1, Y1, z0):
        if along_x:
            half = (Y1 - Y0) / 2; hgt = half * tanp
            pts = [V(X0, Y0, z0), V(X0, Y1, z0), V(X0, (Y0 + Y1) / 2, z0 + hgt), V(X0, Y0, z0)]
            return Part.Face(Part.makePolygon(pts)).extrude(V(X1 - X0, 0, 0))
        half = (X1 - X0) / 2; hgt = half * tanp
        pts = [V(X0, Y0, z0), V(X1, Y0, z0), V((X0 + X1) / 2, Y0, z0 + hgt), V(X0, Y0, z0)]
        return Part.Face(Part.makePolygon(pts)).extrude(V(0, Y1 - Y0, 0))
    drop = eave * tanp
    outer = prism(X0, Y0, X1, Y1, z - drop)
    inner = prism(X0 - 10, Y0 + t, X1 + 10, Y1 - t, z - drop - t / math.cos(math.radians(pitch))) if along_x else prism(X0 + t, Y0 - 10, X1 - t, Y1 + 10, z - drop - t / math.cos(math.radians(pitch)))
    roof = outer.cut(inner)
    # gable infill (the triangle of wall under each gable end), at the wall line
    tri = prism(x0, y0, x1, y1, z)
    if along_x: ends = [tri.common(Part.makeBox(250, y1 - y0, 1e5, V(x0, y0, z))), tri.common(Part.makeBox(250, y1 - y0, 1e5, V(x1 - 250, y0, z)))]
    else: ends = [tri.common(Part.makeBox(x1 - x0, 250, 1e5, V(x0, y0, z))), tri.common(Part.makeBox(x1 - x0, 250, 1e5, V(x0, y1 - 250, z)))]
    return roof, ends, (y1 - y0) / 2 * tanp if along_x else (x1 - x0) / 2 * tanp


def hip(x0, y0, x1, y1, z, pitch, eave, t=160):
    a, _, _ = gable(x0, y0, x1, y1, z, pitch, True, eave, t)
    b, _, _ = gable(x0, y0, x1, y1, z, pitch, False, eave, t)
    # outer volumes intersect into the hipped shape; the shell is outer ∩ outer minus inner ∩ inner
    def solid(along):
        X0, Y0, X1, Y1 = x0 - eave, y0 - eave, x1 + eave, y1 + eave
        tanp = math.tan(math.radians(pitch)); drop = eave * tanp
        if along:
            half = (Y1 - Y0) / 2; pts = [V(X0, Y0, z - drop), V(X0, Y1, z - drop), V(X0, (Y0 + Y1) / 2, z - drop + half * tanp), V(X0, Y0, z - drop)]
            return Part.Face(Part.makePolygon(pts)).extrude(V(X1 - X0, 0, 0))
        half = (X1 - X0) / 2; pts = [V(X0, Y0, z - drop), V(X1, Y0, z - drop), V((X0 + X1) / 2, Y0, z - drop + half * tanp), V(X0, Y0, z - drop)]
        return Part.Face(Part.makePolygon(pts)).extrude(V(0, Y1 - Y0, 0))
    outer = solid(True).common(solid(False))
    inner = outer.translated(V(0, 0, -t * 1.4))
    return outer.cut(inner), [], 0


def shed(x0, y0, x1, y1, z, pitch, eave, t=160, rise_to_back=True):
    X0, Y0, X1, Y1 = x0 - eave, y0 - eave, x1 + eave, y1 + eave
    if (X1 - X0) < (Y1 - Y0):   # slope across the short side of the rectangle
        tanp = math.tan(math.radians(pitch)); d = X1 - X0
        pts = [V(X0, Y0, z), V(X1, Y0, z + d * tanp), V(X1, Y0, z + d * tanp + t), V(X0, Y0, z + t), V(X0, Y0, z)]
        return Part.Face(Part.makePolygon(pts)).extrude(V(0, Y1 - Y0, 0))
    tanp = math.tan(math.radians(pitch)); d = Y1 - Y0
    zf, zb = (z, z + d * tanp) if rise_to_back else (z + d * tanp, z)
    pts = [V(X0, Y0, zf), V(X0, Y1, zb), V(X0, Y1, zb + t), V(X0, Y0, zf + t), V(X0, Y0, zf)]
    return Part.Face(Part.makePolygon(pts)).extrude(V(X1 - X0, 0, 0))


# ------------------------------------------------------------------------------------------------ openings
def window_shapes(kind, x_along, w, sill, h, axis, line, inner, outer, z0, frame_c, glass_c="#b9d6df"):
    """Frame + glass for one window. axis 'x': wall runs along X at Y∈[inner,outer]; 'y': along Y at X∈[inner,outer]."""
    t0, t1 = min(inner, outer), max(inner, outer)
    mid = (t0 + t1) / 2
    def bx(a0, a1, z0_, z1_, d0, d1):
        if axis == "x": return Part.makeBox(a1 - a0, d1 - d0, z1_ - z0_, V(a0, d0, z0_))
        return Part.makeBox(d1 - d0, a1 - a0, z1_ - z0_, V(d0, a0, z0_))
    a0, a1, zs, zh = x_along - w / 2, x_along + w / 2, z0 + sill, z0 + sill + h
    fr = 60
    parts = [bx(a0, a1, zs, zs + fr, mid - 50, mid + 50), bx(a0, a1, zh - fr, zh, mid - 50, mid + 50), bx(a0, a0 + fr, zs, zh, mid - 50, mid + 50), bx(a1 - fr, a1, zs, zh, mid - 50, mid + 50)]
    if kind in ("sash", "french", "arched", "lancet"):
        parts.append(bx(a0, a1, (zs + zh) / 2 - 25, (zs + zh) / 2 + 25, mid - 40, mid + 40))
    if kind in ("french", "ribbon", "storefront", "casement") and w > 1200:
        n = max(1, int(w / 1300))
        for k in range(1, n + 1): xm = a0 + w * k / (n + 1); parts.append(bx(xm - 30, xm + 30, zs, zh, mid - 45, mid + 45))
    glass = bx(a0 + fr, a1 - fr, zs + fr, zh - fr, mid - 6, mid + 6)
    frame = parts[0]
    for p in parts[1:]: frame = frame.fuse(p)
    cut = bx(a0, a1, zs, zh, t0 - 20, t1 + 20)
    if kind == "arched" or kind == "lancet":   # rounded / pointed head above the rectangle
        r = w / 2; top = zh
        if axis == "x":
            arc = Part.makeCylinder(r, t1 - t0 + 40, V(x_along, t0 - 20, top), V(0, 1, 0)) if kind == "arched" else \
                  Part.Face(Part.makePolygon([V(a0, t0 - 20, top), V(a1, t0 - 20, top), V(x_along, t0 - 20, top + w * 0.9), V(a0, t0 - 20, top)])).extrude(V(0, t1 - t0 + 40, 0))
        else:
            arc = Part.makeCylinder(r, t1 - t0 + 40, V(t0 - 20, x_along, top), V(1, 0, 0)) if kind == "arched" else \
                  Part.Face(Part.makePolygon([V(t0 - 20, a0, top), V(t0 - 20, a1, top), V(t0 - 20, x_along, top + w * 0.9), V(t0 - 20, a0, top)])).extrude(V(t1 - t0 + 40, 0, 0))
        arc = arc.common(bx(a0, a1, top, top + w, t0 - 20, t1 + 20))
        cut = cut.fuse(arc)
        glass = glass.fuse(arc.common(bx(a0 + fr, a1 - fr, top, top + w, mid - 6, mid + 6)))
    return cut, [(frame, frame_c), (glass, glass_c)]


def door_shapes(x_along, w, h, axis, inner, outer, z0, leaf_c, frame_c, glazed=False, leaf=True):
    t0, t1 = min(inner, outer), max(inner, outer)
    mid = (t0 + t1) / 2
    def bx(a0, a1, z0_, z1_, d0, d1):
        if axis == "x": return Part.makeBox(a1 - a0, d1 - d0, z1_ - z0_, V(a0, d0, z0_))
        return Part.makeBox(d1 - d0, a1 - a0, z1_ - z0_, V(d0, a0, z0_))
    a0, a1 = x_along - w / 2, x_along + w / 2
    cut = bx(a0, a1, z0, z0 + h, t0 - 20, t1 + 20)
    frame = bx(a0, a0 + 50, z0, z0 + h, t0, t1).fuse(bx(a1 - 50, a1, z0, z0 + h, t0, t1)).fuse(bx(a0, a1, z0 + h - 50, z0 + h, t0, t1))
    out = [(frame, frame_c)]
    if not leaf: return cut, out        # cased opening between public rooms (Merrell §6)
    if w > 1300:  # double leaf
        out += [(bx(a0 + 50, x_along - 3, z0, z0 + h - 50, mid - 22, mid + 22), leaf_c), (bx(x_along + 3, a1 - 50, z0, z0 + h - 50, mid - 22, mid + 22), leaf_c)]
    else:
        out.append((bx(a0 + 50, a1 - 50, z0, z0 + h - 50, mid - 22, mid + 22), leaf_c))
    if glazed:
        out.append((bx(a0 + 160, a1 - 160, z0 + 900, z0 + h - 220, mid - 26, mid + 26), "#b9d6df"))
    return cut, out


# ------------------------------------------------------------------------------------------------ build
def build(plan, out_dir):
    th = plan["theme"]; st = style_for(th)
    c = plan["cell"] * 1000
    rooms = plan["program"]["rooms"] if plan["program"] else []
    edges = plan["program"]["edges"] if plan["program"] else []
    labels = [np.array(L) for L in plan.get("labels", [])]
    S = len(labels) if labels else 1
    Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000; te = st["ext"] * 1000; ti = st["int_"] * 1000
    zf = lambda s: R0 + s * Hs
    M = Model(f"b{plan['id']}")
    site = Arch.makeSite([], name="Site"); bld = Arch.makeBuilding([], name=plan.get("name") or f"OSM {plan['id']}")
    site.addObject(bld)
    for s in range(S):
        lv = Arch.makeFloor([], name=f"Level {s + 1}"); lv.Placement.Base = V(0, 0, zf(s)); bld.addObject(lv); M.levels.append(lv)
    mask = np.array(plan["site"]["mask"], bool) if labels else None
    party = np.array(plan["site"]["party"], bool) if labels else None
    room_of = lambda lab: rooms[lab - 1] if lab > 0 else None
    open_air = lambda lab: lab > 0 and rooms[lab - 1].get("open_air")
    indoor = lambda lab: lab > 0 and not rooms[lab - 1].get("open_air")
    etype = {}
    for e in edges: etype[(min(e["a"], e["b"]) + 1, max(e["a"], e["b"]) + 1)] = e["type"]
    report = {"walls": 0, "windows": 0, "doors": 0, "furniture": 0, "rooms": []}

    if th["archetype"] == "tank":
        poly = Polygon([(x * 1000, y * 1000) for x, y in plan["local_outline"]]).buffer(0)
        import shapely
        circ = shapely.minimum_bounding_circle(poly); r = math.sqrt(circ.area / math.pi); cx, cy = circ.centroid.x, circ.centroid.y
        h = max(6000, min(14000, r * 0.9))
        shell = Part.makeCylinder(r, h, V(cx, cy, 0)).cut(Part.makeCylinder(r - 250, h - 250, V(cx, cy, 250)))
        M.add(shell, "ext_wall", 0, "#d9dcdc", "BuildingElementProxy", "Tank shell")
        M.add(Part.makeCone(r + 150, 600, r * 0.18, V(cx, cy, h)), "roof", 0, "#c7cbcc", "Roof", "Tank roof")
        for k in range(0, 360, 30):  # stiffening rings and a ladder
            pass
        M.add(Part.makeBox(500, 80, h, V(cx + r, cy - 250, 0)), "rail", 0, "#5b6166", "Railing", "Ladder", arch=False)
        # access door at grade on the street side (the tank used to have none)
        dr = Part.makeBox(900, 400, 2000, V(cx - 450, cy - r - 120, 0))
        M.add(dr, "door", 0, "#59626a", "Door", "Access door"); report["doors"] += 1
        for z in range(1500, int(h), 3000):
            M.add(Part.makeCylinder(r + 60, 120, V(cx, cy, z)).cut(Part.makeCylinder(r - 10, 130, V(cx, cy, z - 5))), "cornice", 0, "#b8bcbd", "Covering", "Ring", arch=False)
        return finish(M, plan, out_dir, report)
    if th["archetype"] == "canopy" or not labels:
        # an open roof on posts over the footprint
        poly = Polygon(plan["local_outline"]).buffer(0); minx, miny, maxx, maxy = poly.bounds
        P = Polygon([(x * 1000, y * 1000) for x, y in poly.exterior.coords])
        for x in np.linspace(minx * 1000 + 200, maxx * 1000 - 400, max(2, int((maxx - minx) / 4) + 1)):
            for y in (miny * 1000 + 200, maxy * 1000 - 400):
                M.add(Part.makeBox(200, 200, 3400, V(x, y, 0)), "post", 0, "#5f676b", "Column", "Post")
        M.add(extrude(P, 3400, 250), "roof", 0, st["roofc"], "Roof", "Canopy")
        return finish(M, plan, out_dir, report)

    indoor_masks, porch_masks = [], []
    for s in range(S):
        L = labels[s]
        ind = np.vectorize(lambda v: indoor(v))(L) if L.size else L
        indoor_masks.append(ind.astype(bool))
        porch_masks.append(np.vectorize(lambda v: bool(open_air(v)))(L).astype(bool))

    # ---------------------------------------------------------------- foundations + slabs
    ground_poly = cells_poly(indoor_masks[0], c)
    porch_poly = cells_poly(porch_masks[0], c)
    if R0 > 350:   # raised on piers
        allp = unary_union([p for p in (ground_poly, porch_poly) if p is not None])
        minx, miny, maxx, maxy = allp.bounds
        for x in np.arange(minx + 150, maxx - 100, 2200):
            for y in np.arange(miny + 150, maxy - 100, 2200):
                if allp.contains(sbox(x, y, x + 350, y + 350)):
                    M.add(Part.makeBox(350, 350, R0 - SLAB, V(x, y, 0)), "pier", 0, "#9b5a43", "Footing", "Pier", arch=False)
        lattice = allp.difference(allp.buffer(-120))
        M.add(extrude(lattice, 120, R0 - SLAB - 120), "skirt", 0, "#6b5546", "Covering", "Lattice skirt", arch=False)
    else:
        M.add(extrude(ground_poly, 0, max(100, R0 - SLAB)), "plinth", 0, "#8d8a84", "Footing", "Plinth")
    STAIR = {}
    if plan.get("stair") and S > 1:
        x0, y0, w, h = plan["stair"]
        for s in range(S - 1):
            STAIR[s] = STR.stair_boxes(x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c, zf(s), Hs, rev=STR.ensure_rev(plan))
        report["stair"] = {k: v for k, v in STAIR[0][0].items() if k != "hole"}
    for s in range(S):
        poly = cells_poly(indoor_masks[s], c)
        if poly is None: continue
        if s > 0 and (s - 1) in STAIR:   # opening in the slab over the flights only; the arrival zone keeps its floor
            for hx0, hy0, hx1, hy1 in STAIR[s - 1][0]["hole"]:
                poly = poly.difference(sbox(hx0, hy0, hx1, hy1))
        M.add(extrude(poly, zf(s) - SLAB, SLAB), "slab", s, "#c9b48f" if th["archetype"] in ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse") else "#b8b4aa", "Slab", f"Floor slab L{s + 1}")
    if porch_poly is not None:
        M.add(extrude(porch_poly, R0 - 150, 150), "deck", 0, "#a08362", "Slab", "Porch deck")

    # ---------------------------------------------------------------- walls, doors, windows (shared with the Blender builder)
    LEGACY = os.environ.get("LEGACY_DOORS") == "1"
    ROOFS = RF.roof_plan(plan, st) if not LEGACY else None
    report["roofs"] = [dict(kind=r["kind"], programme=r["programme"], stages=r["stages"], classify=r["classify"]) for r in ROOFS] if ROOFS else []
    SPECS, DOOR_LOGS = O.all_openings(plan, st, legacy=LEGACY, roofs=ROOFS)
    report["passages"] = {}
    for sp_ in sum(SPECS, []):
        for o_ in sp_["openings"]:
            if o_["kind"] == "door": report["passages"][o_.get("ptype", "hinged")] = report["passages"].get(o_.get("ptype", "hinged"), 0) + 1
    report["clerestory"] = sum(1 for sp_ in sum(SPECS, []) for o_ in sp_["openings"] if o_["kind"] == "window" and o_["win"].get("clerestory"))
    report["windows_dropped_for_roof"] = sum(len(sp_.get("skipped", [])) for sp_ in sum(SPECS, []))
    report["door_audit"] = {k: v for k, v in O.audit(plan, SPECS, DOOR_LOGS).items() if k != "unreachable_ids"}
    report["door_notes"] = sum((l["notes"] for l in DOOR_LOGS), [])
    ENTRY = next(((sp, o) for sp in SPECS[0] for o in sp["openings"] if o.get("entry") and sp["axis"] == "x"), None) if SPECS else None
    if not LEGACY:
        report["door_logic"] = DL.decide(plan, st, SPECS, stair_rects={s_: tuple(D_["hole"][0]) for s_, (D_, _) in STAIR.items()})
        if _os_env.environ.get("DOORS", "v2") == "v2":          # door redesign (doors2.py), same as the blueprint
            import doors2 as D2
            D2.optimise(plan, st, SPECS, report["door_logic"])
        FURN = LAY.furnish(plan, st, SPECS, F.ITEMS, F.ROOM_ITEMS)
    for s in range(S):
        L = labels[s]; H, W = L.shape
        z0 = zf(s); zt = z0 + Hs - SLAB
        env = extrude(cells_poly(indoor_masks[s], c), z0 - 5, Hs)
        wall_specs = SPECS[s]
        # ---- build walls with their openings cut
        for sp in wall_specs:
            ext_ = 0 if not sp["ext"] else te
            if sp["axis"] == "x": wall = Part.makeBox(sp["a1"] - sp["a0"] + 2 * te, sp["d1"] - sp["d0"], zt - z0, V(sp["a0"] - te, sp["d0"], z0))
            else: wall = Part.makeBox(sp["d1"] - sp["d0"], sp["a1"] - sp["a0"] + 2 * te, zt - z0, V(sp["d0"], sp["a0"] - te, z0))
            if env is not None: wall = wall.common(env.fuse(extrude(cells_poly(porch_masks[s], c), z0 - 5, 10)) if False else env)
            cuts, extras = [], []
            for o in sp["openings"]:
                if o["kind"] == "bay":                       # revision 2026-10-30: the main wall opens over the bay
                    hb = o["head"]; p0_ = o["pos"] - o["w"] / 2
                    cuts.append(Part.makeBox(o["w"], sp["d1"] - sp["d0"] + 20, hb, V(p0_, sp["d0"] - 10, z0)) if sp["axis"] == "x" else Part.makeBox(sp["d1"] - sp["d0"] + 20, o["w"], hb, V(sp["d0"] - 10, p0_, z0)))
                    o["_nshapes"] = 0
                    continue
                if o["kind"] == "window":
                    w_ = o["win"]
                    cut, shapes = window_shapes(w_["kind"], o["pos"], w_["w"], w_["sill"], w_["h"], sp["axis"], sp["line"], sp["d0"], sp["d1"], z0, st["trim"])
                    cuts.append(cut); extras += [("window", s, "Window", col, sh) for sh, col in shapes]; report["windows"] += 1
                    if st.get("shutters") and sp["ext"] and w_["kind"] in ("sash", "french") and s >= 0:
                        sw = w_["w"] / 2; face = sp["d1"] if sp["outward"] == 1 else sp["d0"] - 40
                        for side in (-1, 1):
                            a0_ = o["pos"] + side * (w_["w"] / 2 + sw / 2) - sw / 2
                            shp = Part.makeBox(sw, 40, w_["h"], V(a0_, face, z0 + w_["sill"])) if sp["axis"] == "x" else Part.makeBox(40, sw, w_["h"], V(face, a0_, z0 + w_["sill"]))
                            extras.append(("shutter", s, "Covering", st["shutters"], shp))
                else:
                    hgt = 2100 if o["kind"] == "door" else 2600 if o["kind"] == "overhead" else 2100
                    if o.get("glazed") or (o.get("entry") and th["archetype"] in ("church", "civic")): hgt = min(Hs - SLAB - 300, 2400 if not o.get("entry") else 3000)
                    leaf = "#6b3f2a" if o.get("exterior") else "#f1ede4"
                    if o["kind"] == "overhead": leaf = "#c9cfd3"
                    if o.get("ptype") == "cased": hgt = min(Hs - SLAB - 300, 2300)
                    sw_ = o.get("swing") if not LEGACY else None
                    cut, shapes = door_shapes(o["pos"], o["w"], hgt, sp["axis"], sp["d0"], sp["d1"], z0, leaf, st["trim"], glazed=o.get("glazed", False),
                                              leaf=o.get("ptype") != "cased" and not sw_)
                    if sw_ and sw_.get("kind") in ("single", "french"):
                        for lf in sw_["leaves"]:      # the leaf stands open at 90° on its hinge (doorlogic.py)
                            hx, hy = lf["hinge"]; tx, ty = lf.get("tip_shown", lf["tip_open"]); ang = math.degrees(math.atan2(ty - hy, tx - hx))
                            if abs(math.sin(math.radians(ang - (0 if sp["axis"] == "x" else 90)))) < 0.05:       # closed: sit the leaf in the frame
                                hx, hy = (hx, (sp["d0"] + sp["d1"]) / 2) if sp["axis"] == "x" else ((sp["d0"] + sp["d1"]) / 2, hy)
                            lb = Part.makeBox(lf["w"] - 30, 44, hgt - 60, V(15, -22, 0)); lb.rotate(V(0, 0, 0), V(0, 0, 1), ang); lb.translate(V(hx, hy, z0 + 10))
                            shapes.append((lb, leaf))
                            if o.get("glazed"):
                                gl_ = Part.makeBox(lf["w"] - 320, 50, hgt - 1140, V(160, -25, 900)); gl_.rotate(V(0, 0, 0), V(0, 0, 1), ang); gl_.translate(V(hx, hy, z0 + 10))
                                shapes.append((gl_, "#b9d6df"))
                    o["_nshapes"] = len(shapes)
                    cuts.append(cut); extras += [("door", s, "Door", col, sh) for sh, col in shapes]; report["doors"] += 1
            for ct in cuts: wall = wall.cut(ct)
            wc = st["walls"] if sp["ext"] else "#efebe3"
            M.add(wall, "ext_wall" if sp["ext"] else "int_wall", s, wc, "Wall", f"{'Exterior' if sp['ext'] else 'Interior'} wall L{s + 1}")
            if st.get("half_timber") and sp["ext"] and not sp["party"] and S > 1 and s == S - 1 and not LEGACY:
                yy = sp["d0"] if sp["outward"] == -1 else sp["d1"]; nrm = (0, sp["outward"], 0) if sp["axis"] == "x" else (sp["outward"], 0, 0)
                quad = [(sp["a0"], yy, z0), (sp["a1"], yy, z0), (sp["a1"], yy, zt), (sp["a0"], yy, zt)] if sp["axis"] == "x" else [(yy, sp["a0"], z0), (yy, sp["a1"], z0), (yy, sp["a1"], zt), (yy, sp["a0"], zt)]
                try:
                    holes_ = [o for o in sp["openings"]]
                    half_timber(quad, nrm, st, M, s)
                except Exception: pass
            report["walls"] += 1
            # one IFC element per window / door (frame + glass + leaf compounded); coloured parts go to the mesh
            groups_ = {}
            for role, s_, ifc, col, sh in extras:
                M.parts.append((role, s_, ifc, col, sh))
                if role != "shutter": groups_.setdefault(id(cuts) if False else (role, len(groups_) // 99), []).append(sh)
            k_ = 0
            for o in sp["openings"]:
                if o["kind"] == "bay": continue
                n_ = 2 if o["kind"] == "window" else o.get("_nshapes", (4 if o["w"] > 1300 else 3) + (1 if o.get("glazed") else 0))
                shapes_ = [sh for role, s_, ifc, col, sh in extras if role != "shutter"][k_:k_ + n_]; k_ += n_
                if shapes_:
                    ifc_ = "Window" if o["kind"] == "window" else "Door"
                    M.add(Part.makeCompound(shapes_), ifc_.lower() + "_obj", s, st["trim"], ifc_, ifc_, arch=True); M.parts.pop()
            sp["z0"] = z0
        # ---- bays (angled window walls, bays.py): framed faces, glass, floor and a three-face hip roof
        import bays as BAY
        for s_, sp_, o_, g_ in BAY.bays_of([wall_specs]):
            for el in BAY.elements(g_, o_, z0, st["walls"], st["trim"], st.get("roofc", "#555555")):
                try:
                    if el["t"] == "prism":
                        w_ = Part.makePolygon([V(x, y, el["z0"]) for x, y in el["ring"]] + [V(el["ring"][0][0], el["ring"][0][1], el["z0"])])
                        shp = Part.Face(w_).extrude(V(0, 0, el["h"]))
                        ifc = {"ext_wall": "Wall", "window": "Window", "slab": "Slab"}.get(el["role"], "Covering")
                        M.add(shp, el["role"], s, el["colour"], ifc, f"Bay {el['role'].replace('_', ' ')}")
                    else:
                        e_, r_ = el["eave"], el["ridge"]; ze, zr = el["z_eave"], el["z_ridge"]
                        E0, E1, E2, E3 = [V(x, y, ze) for x, y in e_]; R1, R2 = [V(x, y, zr) for x, y in r_]
                        fs = [Part.Face(Part.makePolygon(q + [q[0]])) for q in ([E0, E1, E2, E3], [E0, R1, R2, E3], [E0, E1, R1], [E3, R2, E2], [E1, E2, R2, R1])]
                        M.add(Part.makeSolid(Part.makeShell(fs)), "roof", s, el["colour"], "Roof", "Bay roof")
                except Exception as ex:
                    report.setdefault("bay_errors", []).append(str(ex)[:120])
            report["bays"] = report.get("bays", 0) + 1
        # ---- trim: cornice / brackets / buttresses on exterior runs of the top storey
        if s == S - 1:
            for sp in wall_specs:
                if not sp["ext"] or sp["outer"] > 0: continue
                face_out = sp["d1"] if sp["outward"] == 1 else sp["d0"]
                proj = 1 if sp["outward"] == 1 else -1
                def ob(a0_, a1_, z0_, z1_, dep):
                    d0_, d1_ = sorted((face_out, face_out + proj * dep))
                    return Part.makeBox(a1_ - a0_, d1_ - d0_, z1_ - z0_, V(a0_, d0_, z0_)) if sp["axis"] == "x" else Part.makeBox(d1_ - d0_, a1_ - a0_, z1_ - z0_, V(d0_, a0_, z0_))
                if "cornice" in st["trimset"] or st["roof"] == "flat":
                    M.add(ob(sp["a0"] - te, sp["a1"] + te, zt - 350, zt, 220), "cornice", s, st["trim"], "Covering", "Cornice", arch=False)
                if "brackets" in st["trimset"]:
                    for a in np.arange(sp["a0"] + 300, sp["a1"] - 200, 700):
                        M.add(ob(a, a + 110, zt - 520, zt - 60, 300), "bracket", s, st["trim"], "Covering", "Bracket", arch=False)
                if "buttresses" in st["trimset"]:
                    for a in np.arange(sp["a0"] + 600, sp["a1"] - 300, 3600):
                        M.add(ob(a, a + 500, R0, zt - 900, 650), "buttress", s, st["walls"], "Column", "Buttress")
                if "piers" in st["trimset"] and sp["axis"] == "x" and sp["outward"] == -1:
                    for a in np.arange(sp["a0"] + 400, sp["a1"] - 200, 3000):
                        M.add(ob(a, a + 300, R0, zt + 1300, 200), "pier_fin", s, st["trim"], "Covering", "Pier", arch=False)

        # ---------------------------------------------------------------- furniture (layout.py, shared with Blender)
        if LEGACY:
            pass
        for fi in ([f for f in FURN if f["storey"] == s] if not LEGACY else []):
            Lw, Dw, builder = F.ITEMS[fi["name"]]
            for shp, col in builder():
                sh = shp.copy(); sh.rotate(V(0, 0, 0), V(0, 0, 1), fi["ang"]); sh.translate(V(fi["x"], fi["y"], zf(s)))
                M.parts.append(("furniture", s, "Furniture", col, sh))
            comp = Part.makeCompound([p for p, _ in builder()]); comp.rotate(V(0, 0, 0), V(0, 0, 1), fi["ang"]); comp.translate(V(fi["x"], fi["y"], zf(s)))
            M.add(comp, "furniture_obj", s, F.OAK, "Furniture", fi["name"], arch=True); M.parts.pop()
            report["furniture"] += 1
        for r in [r for r in rooms if r["storey"] == s]:
            m = L == r["id"] + 1
            if m.sum() >= 2 and not r.get("subdivided"): report["rooms"].append({"kind": r["kind"], "storey": s, "area": round(float(m.sum()) * plan["cell"] ** 2, 1)})

    # ---------------------------------------------------------------- stairs (stairs.py: form chosen by the stair space)
    if plan.get("stair") and S > 1:
        for s in range(S - 1):
            D_, parts_ = STAIR[s]
            for role, (bx0, by0, bz0, bx1, by1, bz1) in parts_:
                if bx1 - bx0 < 1 or by1 - by0 < 1 or bz1 - bz0 < 1: continue
                col = "#3a3a3a" if role in ("rail", "banister") else "#b48a5e"
                M.add(Part.makeBox(bx1 - bx0, by1 - by0, bz1 - bz0, V(bx0, by0, bz0)), "rail" if role in ("rail", "banister") else "stair", s + (1 if role == "banister" else 0), col,
                      "Railing" if role in ("rail", "banister") else "Stair", {"step": "Stair flight", "landing": "Landing", "rail": "Balustrade", "banister": "Banister"}[role], arch=True)
        M.doc.recompute()     # audit fix (2026-10-30): typed Arch components, so the stair exports as IfcStair / IfcRailing

    # ---------------------------------------------------------------- porch posts, rails, steps
    pm = porch_masks[0]
    if pm.any():
        L = labels[0]; H, W = L.shape
        zp, ztop = R0, zf(0) + Hs - SLAB
        posts = {"square": (150, 150), "turned": (130, 130), "tapered": (300, 300), "column": (320, 320), "steel": (90, 90), "round": (220, 220)}.get(st["porch"]["posts"], (150, 150))
        pw, pd = posts
        order = st.get("order") if st["porch"]["posts"] in ("column", "round") and not LEGACY else None
        if order:
            cd = column_dims(order, ztop - zp); pw = pd = cd["D"]
            report["columns"] = {"order": order, "D_mm": round(cd["D"]), "H_mm": round(ztop - zp), "k": round((ztop - zp) / cd["D"], 2)}
        door_x0 = ENTRY[1]["pos"] if ENTRY and os.environ.get("LEGACY_DOORS") != "1" else None
        PP = porch_post_layout(pm, labels[0], c, pw, door_x0)
        report["porch_posts"] = {"posts": len(PP["posts"]), "runs": [round(r["len"]) for r in PP["runs"]], "spacing_mm": PP["spacing"],
                                 "centres_mm": [[round(x), round(y)] for x, y in PP["posts"]], "steps_x_mm": round(PP["steps_x"]), "front_y_mm": round(PP["front_y"]), "post_w_mm": round(pw)}
        def post_top(x, y):     # 2026-11-03: a post stops under the roof that covers it (a porch roof sits below the ceiling)
            from shapely.geometry import Point as _Pt
            zs = [R["z_plate"] for R in (ROOFS or []) if R.get("storey", 0) == 0 and R.get("z_plate") is not None and R.get("poly") is not None
                  and R["poly"].buffer(1).contains(_Pt(x, y))]
            return min(zs + [Z_CEIL])
        Z_CEIL = ztop
        for (cx_, cy_) in PP["posts"]:
            X, Y = cx_ - pw / 2, cy_ - pd / 2
            ztop = post_top(cx_, cy_)
            if order:   # shaft with entasis approximated by a slight taper (top diameter 5/6 of the base), base and capital
                Hc = ztop - zp; r0 = pw / 2
                shaft = Part.makeCone(r0, r0 * 5 / 6, Hc - 2 * 0.5 * r0 * 2, V(X + r0, Y + r0, zp + r0))
                base = Part.makeBox(pw * 1.2, pw * 1.2, r0, V(X - pw * 0.1, Y - pw * 0.1, zp))
                capt = Part.makeBox(pw * 1.2, pw * 1.2, r0, V(X - pw * 0.1, Y - pw * 0.1, ztop - r0))
                M.add(shaft.fuse(base).fuse(capt), "post", 0, st["trim"], "Column", f"{order.title()} column")
            else:
                M.add(Part.makeBox(pw, pd, ztop - zp, V(X, Y, zp)), "post", 0, st["trim"], "Column", "Porch post")
        keep = [p[0] / c for p in PP["posts"]] or [0]; ylin = PP["front_y"] / c
        door_x = ENTRY[1]["pos"] if ENTRY and os.environ.get("LEGACY_DOORS") != "1" else None      # D7: steps meet the street door
        if st["porch"]["rail"]:
            for (ax_, ay_, bx_, by_, horiz) in PP["rails"]:
                if horiz:
                    A, B = min(ax_, bx_), max(ax_, bx_)
                    if B - A < 200: continue
                    M.add(Part.makeBox(B - A, 60, 70, V(A, ay_ - 30, zp + 880)), "rail", 0, st["trim"], "Railing", "Porch rail", arch=False)
                    for xb in np.arange(A + 60, B - 40, 130):
                        M.add(Part.makeBox(40, 40, 880, V(xb, ay_ - 20, zp)), "baluster", 0, st["trim"], "Railing", "Baluster", arch=False)
                else:
                    A, B = min(ay_, by_), max(ay_, by_)
                    if B - A < 200: continue
                    M.add(Part.makeBox(60, B - A, 70, V(ax_ - 30, A, zp + 880)), "rail", 0, st["trim"], "Railing", "Porch rail", arch=False)
                    for yb in np.arange(A + 60, B - 40, 130):
                        M.add(Part.makeBox(40, 40, 880, V(ax_ - 20, yb, zp)), "baluster", 0, st["trim"], "Railing", "Baluster", arch=False)
        # steps from grade up to the porch
        n = int(math.ceil(R0 / 175)); cx = PP["steps_x"]
        for i in range(n):
            M.add(Part.makeBox(1500, 300 * (n - i), R0 / n, V(cx - 750, ylin * c - 300 * (n - i) + 60, i * R0 / n)), "steps", 0, "#9a948a", "Stair", "Entry steps", arch=False)
    else:
        # steps to the entry door when the floor is raised
        if R0 > 200:
            n = int(math.ceil(R0 / 175))
            if ENTRY and os.environ.get("LEGACY_DOORS") != "1" and ENTRY[0]["outward"] == -1:
                sx, sy = ENTRY[1]["pos"], ENTRY[0]["line"]
            else: sx, sy = W_mid(labels[0], c, plan), 0
            M.add(Part.makeBox(1600, 300 * n, R0 - 1, V(sx - 800, sy - 300 * n, 0)), "steps", 0, "#9a948a", "Stair", "Entry steps", arch=False)

    # ---------------------------------------------------------------- roofs
    if LEGACY: build_roofs_legacy(M, plan, st, labels, indoor_masks, porch_masks, c, zf, Hs, rooms, th)
    else: build_roofs(M, plan, st, labels, indoor_masks, porch_masks, c, zf, Hs, rooms, th, ROOFS)
    return finish(M, plan, out_dir, report)


def W_mid(L, c, plan):
    ent = plan["program"]["entry"] + 1
    ys, xs = np.nonzero(L == ent)
    return (xs.min() + xs.max() + 1) / 2 * c if len(xs) else L.shape[1] * c / 2


def tri_face(P):
    pts = [V(float(x), float(y), float(z)) for x, y, z in P]
    return Part.Face(Part.makePolygon(pts + [pts[0]]))


def half_timber(face_pts, normal, st, M, s, step=600, t=40, w=150):
    """Tudor half-timbering on a vertical face: studs every `step`, a rail at mid height, braces from the corners."""
    P = np.array(face_pts); n = np.array(normal, float); n = n / (np.linalg.norm(n) or 1)
    zmin, zmax = P[:, 2].min(), P[:, 2].max()
    horiz = np.array([-n[1], n[0], 0.0])
    us = P @ horiz; u0, u1 = us.min(), us.max()
    o = P[0] - (P[0] @ horiz) * horiz; o[2] = 0
    face = tri_face(face_pts) if len(face_pts) == 3 else Part.Face(Part.makePolygon([V(*map(float, p)) for p in list(face_pts) + [face_pts[0]]]))
    slab = face.extrude(V(*(n * t)))
    boards = []
    def board(ua, ub, za, zb):
        A = o + horiz * ua; d = horiz * (ub - ua)
        bx = Part.makeBox(1, 1, 1)
        L = max(1.0, float(np.linalg.norm(d))) if ub - ua > 1 else w
        # an axis-aligned box in the face frame, then placed
        shp = Part.makeBox(max(1.0, ub - ua), 2 * t, max(1.0, zb - za), V(0, -t, 0))
        rot = FreeCAD.Rotation(V(1, 0, 0), V(*horiz))
        shp.Placement = FreeCAD.Placement(V(*(A + np.array([0, 0, za]))), rot)
        return shp
    for u in np.arange(u0 + step / 2, u1, step): boards.append(board(u - w / 2, u + w / 2, zmin, zmax))
    zm = zmin + min(1300, (zmax - zmin) * 0.45)
    boards.append(board(u0, u1, zm - w / 2, zm + w / 2)); boards.append(board(u0, u1, zmin, zmin + w))
    for bd in boards:
        try:
            cut = bd.common(slab)
            if cut.Volume > 1: M.add(cut, "timber", s, "#3b2a1e", "Covering", "Half-timber", arch=False)
        except Exception: pass


def build_roofs(M, plan, st, labels, indoor_masks, porch_masks, c, zf, Hs, rooms, th, ROOFS=None):
    """Roofs from the weighted straight skeleton (roofs.roof_plan): sloped faces → roof slabs, vertical faces →
    gable walls, flat roofs → tapered membrane + parapet + coping."""
    for R in ROOFS or []:
        s = R["storey"]
        flat = R["programme"] == "flat"
        for role, Vx, Fx in R["pieces"]:
            sl, ve, bo = RF.split_faces(Vx, Fx)
            prisms = []
            for f in sl:
                try: prisms.append(tri_face(Vx[f] + [0, 0, 5]).extrude(V(0, 0, 130 if not flat else 60)))
                except Exception: pass
            if prisms:
                M.add(Part.makeCompound(prisms), "roof", s, st["roofc"], "Roof", f"{R['programme'].replace('_', ' ').title()} roof")
            for f in ve:
                P = Vx[f]
                if P[:, 2].max() - P[:, 2].min() < 50: continue
                n = np.cross(P[1] - P[0], P[2] - P[0]); n = n / (np.linalg.norm(n) or 1)
                try:
                    wall = tri_face(P).extrude(V(*(-n * 120)))
                    M.add(wall, "gable_wall", s, st["walls"], "Wall", "Gable end")
                    if st.get("half_timber"): half_timber(P, n, st, M, s)
                except Exception: pass
        if flat and R.get("poly") is not None:
            poly = R["poly"]; zp = R["z_plate"]
            par = 900 if ("parapet" in st["trimset"] or "cornice" in st["trimset"]) else 450
            ring = poly.difference(poly.buffer(-st["ext"] * 1000, join_style=2))
            M.add(extrude(ring, zp, par), "parapet", s, st["walls"], "Wall", "Parapet")
            cop = poly.buffer(40, join_style=2).difference(poly.buffer(-st["ext"] * 1000 - 40, join_style=2))
            M.add(extrude(cop, zp + par, 60), "cornice", s, st["trim"], "Covering", "Coping", arch=False)
            if "shaped_parapet" in st["trimset"] and R["kind"] == "main":
                # Mission revival: a stepped, bell-shaped parapet on the street axis (5 tiers)
                minx, miny, maxx, maxy = poly.bounds; cx = (minx + maxx) / 2; W_ = (maxx - minx) * 0.45
                for k in range(5):
                    ww = W_ * (1 - k / 5.5); hh = 260
                    M.add(Part.makeBox(ww, st["ext"] * 1000, hh, V(cx - ww / 2, miny, zp + par + k * hh)), "parapet", s, st["walls"], "Wall", "Shaped parapet")
            if "parapet" in st["trimset"] and th["style"] == "art_deco" and R["kind"] == "main":
                minx, miny, maxx, maxy = poly.bounds
                M.add(Part.makeBox((maxx - minx) / 3, 300, 1600, V(minx + (maxx - minx) / 3, miny, zp + par)), "parapet", s, st["trim"], "Covering", "Stepped parapet")
    # towers / turrets
    if ("tower" in st["trimset"] and th["archetype"] in ("church", "civic")) or ("turret" in st["trimset"] and th["archetype"] in ("bungalow", "two_storey_house")):
        m0 = indoor_masks[0]; ys, xs = np.nonzero(m0)
        X0, Y0 = xs.min() * c, ys.min() * c
        size = 4500 if th["archetype"] == "church" else 3000
        if th["archetype"] == "church": X0 = (xs.min() + xs.max() + 1) / 2 * c - size / 2
        zt = zf(len(labels) - 1) + Hs + (9000 if th["archetype"] == "church" else 2500)
        M.add(Part.makeBox(size, size, zt - st["raise_"] * 1000, V(X0, Y0, st["raise_"] * 1000)), "tower", 0, st["walls"], "Wall", "Tower")
        spire = Part.makeCone(size * 0.72, 0, size * (2.4 if th["archetype"] == "church" else 1.2), V(X0 + size / 2, Y0 + size / 2, zt), V(0, 0, 1), 360)
        M.add(spire, "roof", 0, st["roofc"], "Roof", "Spire")


def build_roofs_legacy(M, plan, st, labels, indoor_masks, porch_masks, c, zf, Hs, rooms, th):
    S = len(labels)
    eave = st["eave"] * 1000; pitch = st["pitch"]
    for s in range(S):
        top = indoor_masks[s].copy()
        if S == 1 or s == 0: top |= porch_masks[s] if S == 1 else np.zeros_like(top)
        above = indoor_masks[s + 1] if s + 1 < S else np.zeros_like(top)
        region = top & ~above
        if not region.any(): continue
        zplate = zf(s) + Hs - SLAB
        main = s == S - 1
        kind = st["roof"] if main else ("shed" if st["roof"] != "flat" else "flat")
        rects, rest = rectangles(region, 2)
        for i, (x0, y0, w, h) in enumerate(rects):
            X0, Y0, X1, Y1 = x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c
            k = kind
            if k == "dome": k = "hip"
            if i > 0 and k in ("side_gable", "front_gable"):  # wings: ridge along their long side, as additions are built
                k = "side_gable" if (X1 - X0) >= (Y1 - Y0) else "front_gable"
            if k == "flat":
                M.add(Part.makeBox(X1 - X0, Y1 - Y0, 250, V(X0, Y0, zplate)), "roof", s, st["roofc"], "Roof", "Flat roof")
                par = 900 if ("parapet" in st["trimset"] or "cornice" in st["trimset"]) else 400
                ring = Part.makeBox(X1 - X0, Y1 - Y0, par, V(X0, Y0, zplate)).cut(Part.makeBox(X1 - X0 - 500, Y1 - Y0 - 500, par + 10, V(X0 + 250, Y0 + 250, zplate)))
                M.add(ring, "parapet", s, st["walls"], "Wall", "Parapet")
                if "parapet" in st["trimset"] and th["style"] == "art_deco" and i == 0:
                    M.add(Part.makeBox((X1 - X0) / 3, 300, 1600, V(X0 + (X1 - X0) / 3, Y0, zplate + par)), "parapet", s, st["trim"], "Covering", "Stepped parapet")
            elif k == "shed":
                M.add(shed(X0, Y0, X1, Y1, zplate, min(max(pitch, 8), 14 if not main else 20), eave), "roof", s, st["roofc"], "Roof", "Shed roof")
            elif k == "hip":
                sh, _, _ = hip(X0, Y0, X1, Y1, zplate, pitch, eave); M.add(sh, "roof", s, st["roofc"], "Roof", "Hipped roof")
            else:
                along_x = k == "side_gable" or (k in ("steep_gable", "low_gable") and (X1 - X0) >= (Y1 - Y0))
                if k == "front_gable": along_x = False
                p = pitch if k not in ("low_gable",) else 8
                sh, ends, hgt = gable(X0, Y0, X1, Y1, zplate, p, along_x, eave)
                M.add(sh, "roof", s, st["roofc"], "Roof", "Gable roof")
                for e in ends: M.add(e, "gable_wall", s, st["walls"], "Wall", "Gable end")
        ys, xs = np.nonzero(rest)
        for y, x in zip(ys, xs):
            M.add(Part.makeBox(c, c, 200, V(x * c, y * c, zplate)), "roof", s, st["roofc"], "Roof", "Roof patch", arch=False)
        # porch roof on multi-storey houses
        if s == 0 and S > 1 and porch_masks[0].any():
            for (x0, y0, w, h) in rectangles(porch_masks[0], 1)[0]:
                M.add(shed(x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c, zplate - 200, 12, 300, rise_to_back=True), "roof", 0, st["roofc"], "Roof", "Porch roof")
    # towers / turrets
    if ("tower" in st["trimset"] and th["archetype"] in ("church", "civic")) or ("turret" in st["trimset"] and th["archetype"] in ("bungalow", "two_storey_house")):
        m0 = indoor_masks[0]; ys, xs = np.nonzero(m0)
        X0, Y0 = xs.min() * c, ys.min() * c
        size = 4500 if th["archetype"] == "church" else 3000
        if th["archetype"] == "church": X0 = (xs.min() + xs.max() + 1) / 2 * c - size / 2
        zt = zf(len(labels) - 1) + Hs + (9000 if th["archetype"] == "church" else 2500)
        M.add(Part.makeBox(size, size, zt - st["raise_"] * 1000, V(X0, Y0, st["raise_"] * 1000)), "tower", 0, st["walls"], "Wall", "Tower")
        spire = Part.makeCone(size * 0.72, 0, size * (2.4 if th["archetype"] == "church" else 1.2), V(X0 + size / 2, Y0 + size / 2, zt), V(0, 0, 1), 360)
        M.add(spire, "roof", 0, st["roofc"], "Roof", "Spire")


def poses(free, placed, Lw, Dw, mode, seed=0):
    """Positions for one item in a free region: yields (x, y, angle°, footprint polygon)."""
    import random
    rnd = random.Random(seed)
    occupied = unary_union(placed) if placed else None
    def ok(fp, clear=None):
        if not free.contains(fp): return False
        if occupied is not None and fp.buffer(40).intersects(occupied): return False
        if clear is not None and occupied is not None and clear.intersects(occupied): return False
        return True
    def rect(x, y, ang):
        a = math.radians(ang); ca, sa = math.cos(a), math.sin(a)
        pts = [(0, 0), (Lw, 0), (Lw, Dw), (0, Dw)]
        return Polygon([(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in pts])
    if mode in ("wall", "corner"):
        polys = [free] if isinstance(free, Polygon) else sorted(free.geoms, key=lambda p: -p.area)
        for P in polys:
            ring = list(P.exterior.coords)
            if not P.exterior.is_ccw: ring = ring[::-1]
            segs = sorted(zip(ring, ring[1:]), key=lambda s: -math.dist(*s))
            for (x1, y1), (x2, y2) in segs:
                Ls = math.dist((x1, y1), (x2, y2))
                if Ls < Lw: continue
                ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
                ux, uy = (x2 - x1) / Ls, (y2 - y1) / Ls
                offs = list(np.arange(0, Ls - Lw + 1, 150)) if mode == "wall" else [0, Ls - Lw]
                if mode == "wall": rnd.shuffle(offs)
                for t in offs:
                    x, y = x1 + ux * t, y1 + uy * t
                    fp = rect(x, y, ang)
                    clear = Polygon([(x + ux * 0 - uy * Dw, y + uy * 0 + ux * Dw)]) if False else None
                    if ok(fp):
                        yield (x, y, ang, fp); return
        return
    if mode == "centre":
        minx, miny, maxx, maxy = free.bounds
        longx = (maxx - minx) >= (maxy - miny)
        p = free.representative_point() if not isinstance(free, Polygon) else free.centroid
        if not free.contains(p): p = free.representative_point()
        for ang in ((0, 90) if longx else (90, 0)):
            a = math.radians(ang)
            x = p.x - (Lw / 2 * math.cos(a) - Dw / 2 * math.sin(a)); y = p.y - (Lw / 2 * math.sin(a) + Dw / 2 * math.cos(a))
            fp = rect(x, y, ang)
            if ok(fp): yield (x, y, ang, fp); return
        return
    if mode == "grid":
        minx, miny, maxx, maxy = free.bounds
        longx = (maxx - minx) >= (maxy - miny)
        gapx, gapy = (600, 900) if Lw < 3000 else (1500, 900)
        if longx:   # rows run along Y so the items face along X? keep items facing the front (−Y): rows along X
            pass
        n = 0
        for y in np.arange(miny + 300, maxy - Dw, Dw + gapy):
            for x in np.arange(minx + 300, maxx - Lw, Lw + gapx):
                fp = rect(x, y, 0)
                if ok(fp):
                    yield (x, y, 0, fp); n += 1
                    occupied = unary_union([occupied, fp]) if occupied is not None else fp
                    if n > 60: return
        return


def finish(M, plan, out_dir, report):
    M.doc.recompute()
    os.makedirs(out_dir, exist_ok=True)
    stem = f"{out_dir}/{plan['key']}"
    M.doc.saveAs(stem + ".FCStd")
    try:
        from importers import exportIFC
        objs = [o for o in M.doc.Objects if hasattr(o, "IfcType") or o.TypeId == "App::FeaturePython"]
        exportIFC.export([o for o in M.doc.Objects if o.Name.startswith("Site")], stem + ".ifc")
        report["ifc"] = os.path.getsize(stem + ".ifc")
    except Exception as e:
        report["ifc_error"] = repr(e)[:300]
    # coloured mesh for the viewer: one buffer per (role, storey, colour)
    groups = {}
    for role, s, ifc, col, sh in M.parts:
        try:
            v, f = sh.tessellate(25)
        except Exception:
            continue
        if not f: continue
        g = groups.setdefault((role, s, col), {"v": [], "f": [], "n": 0})
        g["v"] += [c for p in v for c in (p.x / 1000, p.z / 1000, -p.y / 1000)]
        g["f"] += [i + g["n"] for t in f for i in t]
        g["n"] += len(v)
    mesh = []
    for (role, s, col), g in groups.items():
        mesh.append({"role": role, "storey": s, "color": col, "pos": base64.b64encode(np.array(g["v"], np.float32).tobytes()).decode(),
                     "idx": base64.b64encode(np.array(g["f"], np.uint32).tobytes()).decode()})
    report["triangles"] = sum(len(g["f"]) // 3 for g in groups.values())
    meta = {k: plan[k] for k in ("id", "key", "name", "theme", "metrics", "front", "context", "cell", "cost", "terms") if k in plan}
    meta["program_log"] = plan["program"]["log"] if plan.get("program") else []
    meta["rooms"] = report.get("rooms", [])
    meta["report"] = {k: v for k, v in report.items() if k != "rooms"}
    st = style_for(plan["theme"]); meta["style_params"] = {k: st[k] for k in ("roof", "pitch", "storey", "raise_", "cladding", "roofmat", "walls", "roofc")}
    meta["storey_h"] = st["storey"]; meta["raise"] = st["raise_"]
    meta["labels"] = plan.get("labels"); meta["room_kinds"] = [r["kind"] for r in plan["program"]["rooms"]] if plan.get("program") else []
    json.dump({"meta": meta, "mesh": mesh}, open(stem + ".mesh.json", "w"))
    FreeCAD.closeDocument(M.doc.Name)
    return report


if __name__ == "__main__":
    import os as _os
    src = _os.environ.get("PLAN_DIR", _ARCH_OUT + ""); dst = _os.environ.get("BIM_DIR", _ARCH_OUT + "/bim")
    for key in sys.argv[1:]:
        plan = json.load(open(f"{src}/plan-{key}.json")); plan["key"] = key
        rep = build(plan, dst)
        print(key, {k: v for k, v in rep.items() if k != "rooms"})



def porch_post_layout(pm, L0, c, pw, door_x=None, max_bay=2400.0, min_bay=1500.0, inset=60.0):
    """2026-11-03: porch posts on every open edge of the porch, evenly spaced (Merrell §6: patio poles from the style;
    spacing ours). Each straight open run gets a post at both ends — corners shared between runs — and n equal bays,
    n = ceil(run / 2.4 m); on the street-facing run the bay count is chosen so no post stands within 0.9 m of the entry
    steps. Before, posts went only along one front line, greedily every ≥ 2.3 m plus one at the end, so the last gap
    could be a few hundred mm and side edges got none. Returns posts (centres, mm), rail segments, the front line and
    the steps' x."""
    from shapely.geometry import Point
    import numpy as _np
    H, W = pm.shape
    house = _np.vectorize(lambda v: v > 0)(L0) & ~pm
    def open_side(y, x, k):            # is the neighbour of porch cell (y, x) in direction k outside the house?
        du, dv = [(0, -1), (1, 0), (0, 1), (-1, 0)][k]
        yy, xx = y + dv, x + du
        if not (0 <= yy < H and 0 <= xx < W): return True
        return not house[yy, xx] and not pm[yy, xx]
    # open edge segments on the cell grid, merged into straight runs: horizontal runs keyed by (k, row line)
    runs = []
    for k in range(4):
        horiz = k in (0, 2)
        lines = {}
        for y in range(H):
            for x in range(W):
                if pm[y, x] and open_side(y, x, k):
                    if horiz: line = y if k == 0 else y + 1; lines.setdefault(line, []).append(x)
                    else: line = x + 1 if k == 1 else x; lines.setdefault(line, []).append(y)
        for line, idx in lines.items():
            idx = sorted(idx); start = prev = idx[0]
            for v in idx[1:] + [None]:
                if v is not None and v == prev + 1: prev = v; continue
                a0, a1 = start * c, (prev + 1) * c
                sgn = -1 if k in (0, 3) else 1                       # outward direction along the normal
                off = line * c - sgn * (inset + pw / 2)               # post centre line, inset into the porch
                runs.append(dict(k=k, horiz=horiz, line=off, a0=a0 + inset + pw / 2, a1=a1 - inset - pw / 2, len=a1 - a0, edge=line * c))
                if v is not None: start = prev = v
    posts, rails = [], []
    front = [r for r in runs if r["k"] == 0 and r["len"] >= min_bay]
    front_y = min((r["edge"] for r in runs if r["k"] == 0), default=0.0)
    # 2026-11-03 (walkway fix): the entry steps (1.5 m wide) and the walk from them to the door stay clear of posts.
    # The steps go on the front run that holds the door (else the longest front run), clamped so a corner post cannot
    # stand in them; no post comes within half the steps + half a post + 250 mm of the steps' centre line.
    STEP_W = 1500.0
    clear = STEP_W / 2 + pw / 2 + 250
    step_run, steps_x = None, None
    if front:
        holds = [r for r in front if door_x is not None and r["a0"] - pw <= door_x <= r["a1"] + pw]
        step_run = holds[0] if holds else max(front, key=lambda r: r["len"])
        want = door_x if door_x is not None else (step_run["a0"] + step_run["a1"]) / 2
        lo, hi = step_run["a0"] + clear, step_run["a1"] - clear
        steps_x = min(max(want, lo), hi) if lo <= hi else (step_run["a0"] + step_run["a1"]) / 2
        front_y = step_run["edge"]         # the steps meet the run whose posts frame them, not a jog in front of it
    def even(a0, a1):                  # posts at both ends and equal bays of at most max_bay between them
        L_ = a1 - a0
        if L_ <= 0: return [a0]
        m = max(1, int(math.ceil(L_ / max_bay)))
        return [a0 + L_ * i / m for i in range(m + 1)]
    for r in runs:
        L_ = r["a1"] - r["a0"]
        if L_ <= 0 or r["len"] < min_bay: continue        # a jog in the outline is not a bay: its corners come from the long runs
        if r is step_run and steps_x is not None:
            ts = even(r["a0"], r["a1"])
            if any(abs(t - steps_x) < clear for t in ts):
                # equal bays cannot clear the steps: frame the opening with a post either side, equal bays beyond
                # corner posts stay unless they would touch the steps (clear_min); inner posts keep the full clearance
                clear_min = STEP_W / 2 + pw / 2 + 50
                left = even(r["a0"], steps_x - clear) if steps_x - clear - r["a0"] >= 0.6 * min_bay else [r["a0"]] if steps_x - r["a0"] >= clear_min else []
                right = even(steps_x + clear, r["a1"]) if r["a1"] - steps_x - clear >= 0.6 * min_bay else [r["a1"]] if r["a1"] - steps_x >= clear_min else []
                ts = left + right
        else:
            ts = even(r["a0"], r["a1"])
        for t in ts:
            p = (t, r["line"]) if r["horiz"] else (r["line"], t)
            if not any(abs(p[0] - q[0]) < pw and abs(p[1] - q[1]) < pw for q in posts): posts.append(p)
        # rails between consecutive posts, leaving the steps open on the front run
        for t0, t1 in zip(ts, ts[1:]):
            A, B = t0 + pw / 2, t1 - pw / 2
            if r is step_run and steps_x is not None and A < steps_x + STEP_W / 2 and steps_x - STEP_W / 2 < B:
                segs = [(A, steps_x - STEP_W / 2 - 50), (steps_x + STEP_W / 2 + 50, B)]
            else: segs = [(A, B)]
            for A_, B_ in segs:
                if B_ - A_ > 200: rails.append((A_, r["line"], B_, r["line"], True) if r["horiz"] else (r["line"], A_, r["line"], B_, False))
    # posts closer than 1.2 m (two runs ending near one corner of a jog) become one
    merged = []
    for p in posts:
        q = next((m for m in merged if abs(m[0] - p[0]) < 1200 and abs(m[1] - p[1]) < 1200), None)
        if q is None: merged.append(list(p))
        else: q[0] = (q[0] + p[0]) / 2; q[1] = (q[1] + p[1]) / 2
    posts = [tuple(m) for m in merged]
    if steps_x is not None:
        posts = [p for p in posts if not (abs(p[0] - steps_x) < STEP_W / 2 + pw / 2 + 49 and abs(p[1] - front_y) < 2 * pw + 200)]
    if steps_x is None:
        steps_x = door_x if door_x is not None else (sum(r["a0"] + r["a1"] for r in front) / (2 * len(front)) if front else W * c / 2)
    sp_ = sorted({round((r["a1"] - r["a0"]) / max(1, int(math.ceil((r["a1"] - r["a0"]) / max_bay)))) for r in runs if r["a1"] > r["a0"]})
    return dict(posts=posts, rails=rails, runs=runs, front_y=front_y, steps_x=steps_x, spacing=sp_)
