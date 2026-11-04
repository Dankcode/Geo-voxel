"""Neutral build specification of one building, made from the blueprint, for builders other than FreeCAD (Blender).

Everything comes from the shared modules — blueprint (openings, door logic, stairs, roofs), layout (furniture),
exterior (porch, foundations, trim) — so FreeCAD and Blender model the same design with their own kernels:
FreeCAD as B-rep solids with Boolean openings and IFC classes, Blender as polygon meshes with modifiers and
node materials. Units in the spec: metres (Blender's), z up, x along the street, y front → back, so the
street faces −y in both tools (the plan frame: x along the street, y front → back).
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, math, sys, types
import numpy as np
from shapely.geometry import box as sbox, Polygon
from shapely.ops import unary_union

sys.path.insert(0, _HERE)


# ------------------------------------------------------------------------------------------------ furniture library
def furniture_library():
    """Run furniture.py's builders against a recording stand-in for FreeCAD's Part module."""
    class Sh:
        def __init__(self, d): self.d = d
        def translated(self, v): d = dict(self.d); d["off"] = tuple(np.add(d.get("off", (0, 0, 0)), v)); return Sh(d)
        def cut(self, o): return Sh(dict(t="cut", a=self.d, b=o.d))
        def copy(self): return Sh(dict(self.d))
    P = types.ModuleType("Part")
    P.makeBox = lambda dx, dy, dz, pos=(0, 0, 0): Sh(dict(t="box", p=tuple(pos), s=(dx, dy, dz)))
    P.makeCylinder = lambda r, h, pos=(0, 0, 0), dirn=(0, 0, 1): Sh(dict(t="cyl", p=tuple(pos), r=r, h=h, dir=tuple(dirn)))
    P.makeSphere = lambda r, pos=(0, 0, 0): Sh(dict(t="sph", p=tuple(pos), r=r))
    FC = types.ModuleType("FreeCAD"); FC.Vector = lambda *a: tuple(float(x) for x in a)
    saved = {k: sys.modules.get(k) for k in ("Part", "FreeCAD", "furniture")}
    sys.modules["Part"], sys.modules["FreeCAD"] = P, FC
    sys.modules.pop("furniture", None)
    import furniture as FUR
    lib = {}
    for name, (L, D, builder) in FUR.ITEMS.items():
        lib[name] = [dict(shape.d, colour=col) for shape, col in builder()]
    items, room_items = FUR.ITEMS, FUR.ROOM_ITEMS
    for k, v in saved.items():
        if v is not None: sys.modules[k] = v
        else: sys.modules.pop(k, None)
    return lib, items, room_items


def _m(v): return float(v) / 1000.0


def build_spec(plan):
    import blueprint as BP, layout as LAY, exterior as EXT, roofs as RF
    bp = BP.build(plan)
    st = bp["style"]; rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000; S = bp["S"]
    Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000; SLAB = 200
    zf = lambda s: R0 + s * Hs
    Y = lambda y: y        # the plan frame already has the street at −y, as Blender's front view does
    lib, ITEMS, ROOM_ITEMS = furniture_library()
    spec = dict(key=plan.get("key"), theme=plan["theme"], style={k: st[k] for k in ("walls", "trim", "roofc", "roofmat", "cladding", "storey", "raise_", "shutters") if k in st},
                half_timber=bool(st.get("half_timber")), checks=bp["checks"], walls=[], frames=[], glass=[], leaves=[], slabs=[], roofs=[], stairs=[], ext=[], furniture=[], library=lib)
    labels = [np.array(L) for L in plan["labels"]]
    for s, specs in enumerate(bp["specs"]):
        z0 = zf(s); zt = z0 + Hs - SLAB
        ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[s])
        env = RF.cells_poly(ind, c)
        # audit fix (doors v2): an exterior run is extended by its thickness only at a real corner; where another
        # exterior run continues on the same line the two abut, so the extension cannot cover a door near the joint
        ends = {(q["axis"], q["line"], q["d0"], round(e)) for q in specs if q["ext"] for e in (q["a0"], q["a1"])}
        for sp in specs:
            ext = sp["ext"]; t = sp["d1"] - sp["d0"]
            cont0 = ext and sum(1 for q in specs if q is not sp and q["ext"] and q["axis"] == sp["axis"] and q["line"] == sp["line"] and q["d0"] == sp["d0"] and round(q["a1"]) == round(sp["a0"])) > 0
            cont1 = ext and sum(1 for q in specs if q is not sp and q["ext"] and q["axis"] == sp["axis"] and q["line"] == sp["line"] and q["d0"] == sp["d0"] and round(q["a0"]) == round(sp["a1"])) > 0
            a0 = sp["a0"] - (0 if cont0 else t if ext else t / 2); a1 = sp["a1"] + (0 if cont1 else t if ext else t / 2)
            R = sbox(a0, sp["d0"], a1, sp["d1"]) if sp["axis"] == "x" else sbox(sp["d0"], a0, sp["d1"], a1)
            R = R.intersection(env) if env is not None else R
            if R.is_empty: continue
            bx0, by0, bx1, by1 = R.bounds
            a0, a1 = (bx0, bx1) if sp["axis"] == "x" else (by0, by1)
            col = st["walls"] if ext else "#efebe3"
            # 1-D split of the wall around its openings: full-height piers, sill and lintel pieces
            ops = sorted(sp["openings"], key=lambda o: o["pos"])
            cuts = []
            for o in ops:
                p0, p1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
                if o["kind"] == "window": zs, zh = o["win"]["sill"], o["win"]["sill"] + o["win"]["h"]
                elif o["kind"] == "bay": zs, zh = 0, o["head"]
                else:
                    zs = 0; zh = 2100 if o["kind"] == "door" else 2600
                    if o.get("ptype") == "cased": zh = min(Hs - SLAB - 300, 2300)
                    if o.get("glazed") or (o.get("entry") and plan["theme"]["archetype"] in ("church", "civic")): zh = min(Hs - SLAB - 300, 2400 if not o.get("entry") else 3000)
                cuts.append((p0, p1, zs, zh, o))
            def piece(u0, u1, w0, w1, role="wall", colour=col):
                if u1 - u0 < 5 or w1 - w0 < 5: return
                if sp["axis"] == "x": b = (u0, sp["d0"], z0 + w0, u1, sp["d1"], z0 + w1)
                else: b = (sp["d0"], u0, z0 + w0, sp["d1"], u1, z0 + w1)
                spec["walls" if role == "wall" else role].append(dict(b=[_m(b[0]), _m(b[1]), _m(b[2]), _m(b[3]), _m(b[4]), _m(b[5])], colour=colour, ext=ext, storey=s))
            u = a0
            for p0, p1, zs, zh, o in cuts:
                p0, p1 = max(p0, a0), min(p1, a1)
                piece(u, p0, 0, zt - z0); piece(p0, p1, 0, zs); piece(p0, p1, zh, zt - z0); u = max(u, p1)
                # frames, glass, leaves
                mid0, mid1 = (sp["d0"] + sp["d1"]) / 2 - 50, (sp["d0"] + sp["d1"]) / 2 + 50
                def fb(u0_, u1_, w0_, w1_, d0_=mid0, d1_=mid1, role="frames", colour=st["trim"]):
                    if sp["axis"] == "x": b = (u0_, d0_, z0 + w0_, u1_, d1_, z0 + w1_)
                    else: b = (d0_, u0_, z0 + w0_, d1_, u1_, z0 + w1_)
                    spec[role].append(dict(b=[_m(b[0]), _m(b[1]), _m(b[2]), _m(b[3]), _m(b[4]), _m(b[5])], colour=colour, storey=s))
                fr = 60
                if o["kind"] == "bay": continue                     # the bay itself is built below (bays.elements)
                if o["kind"] == "window":
                    fb(p0, p1, zs, zs + fr); fb(p0, p1, zh - fr, zh); fb(p0, p0 + fr, zs, zh); fb(p1 - fr, p1, zs, zh)
                    if o["win"]["kind"] in ("sash", "french", "arched", "lancet"): fb(p0, p1, (zs + zh) / 2 - 25, (zs + zh) / 2 + 25)
                    fb(p0 + fr, p1 - fr, zs + fr, zh - fr, (sp["d0"] + sp["d1"]) / 2 - 6, (sp["d0"] + sp["d1"]) / 2 + 6, role="glass", colour="#b9d6df")
                    if st.get("shutters") and ext and o["win"]["kind"] in ("sash", "french"):
                        swd = o["w"] / 2; face = sp["d1"] if sp["outward"] == 1 else sp["d0"] - 40
                        for side in (-1, 1):
                            q0 = o["pos"] + side * (o["w"] / 2 + swd / 2) - swd / 2
                            fb(q0, q0 + swd, zs, zh, face, face + 40, colour=st["shutters"])
                else:
                    fb(p0, p0 + 50, 0, zh, sp["d0"], sp["d1"]); fb(p1 - 50, p1, 0, zh, sp["d0"], sp["d1"]); fb(p0, p1, zh - 50, zh, sp["d0"], sp["d1"])
                    sw = o.get("swing") or {}
                    leafc = "#6b3f2a" if o.get("exterior") else "#f1ede4"
                    if o["kind"] == "overhead": fb(p0 + 50, p1 - 50, 0, zh - 50, colour="#c9cfd3")
                    for lf in sw.get("leaves", []):
                        hx, hy = lf["hinge"]; tx, ty = lf.get("tip_shown", lf["tip_open"])
                        if abs((ty - hy) if sp["axis"] == "x" else (tx - hx)) < 1:            # closed: in the frame
                            if sp["axis"] == "x": hy = ty = (sp["d0"] + sp["d1"]) / 2
                            else: hx = tx = (sp["d0"] + sp["d1"]) / 2
                        spec["leaves"].append(dict(hinge=[_m(hx), _m(Y(hy)), _m(z0 + 10)], tip=[_m(tx), _m(Y(ty))], w=_m(lf["w"] - 30), h=_m(zh - 60), t=0.044, colour=leafc,
                                                   glazed=bool(o.get("glazed")), storey=s))
            piece(u, a1, 0, zt - z0)
    # bays (angled window walls): prisms; the hip roof is capped flat in the mesh spec
    import bays as BAY
    for s_, sp_, o_, g_ in BAY.bays_of(bp["specs"]):
        for el in BAY.elements(g_, o_, zf(s_), st["walls"], st["trim"], st.get("roofc", "#555")):
            if el["t"] == "prism":
                spec["ext"].append(dict(t="prism", ring=[[_m(x), _m(Y(y))] for x, y in el["ring"]], holes=[[[_m(x), _m(Y(y))] for x, y in h] for h in el["holes"]],
                                        z0=_m(el["z0"]), h=_m(el["h"]), colour=el["colour"], role=el["role"], storey=s_))
            else:
                from shapely.geometry import Polygon as _Pg
                spec["ext"].append(dict(t="prism", ring=[[_m(x), _m(Y(y))] for x, y in el["eave"]], holes=[], z0=_m(el["z_eave"]), h=_m(el["z_ridge"] - el["z_eave"]) * 0.5,
                                        colour=el["colour"], role="roof", storey=s_))
    # slabs (with the stair opening above the flights)
    for s in range(S):
        ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[s])
        P = RF.cells_poly(ind, c)
        if P is None: continue
        if s > 0 and (s - 1) in bp["stairs"]:
            for hx0, hy0, hx1, hy1 in bp["stairs"][s - 1][0]["hole"]: P = P.difference(sbox(hx0, hy0, hx1, hy1))
        for g in ([P] if P.geom_type == "Polygon" else list(P.geoms)):
            spec["slabs"].append(dict(ring=[[_m(x), _m(Y(y))] for x, y in list(g.exterior.coords)[:-1]], holes=[[[_m(x), _m(Y(y))] for x, y in list(h.coords)[:-1]] for h in g.interiors],
                                      z0=_m(zf(s) - SLAB), h=_m(SLAB), colour="#c9b48f", storey=s))
    # floor finishes per room (clear floor inside the wall faces), 12 mm on the slab: oak, tile, concrete, stone
    FINISH = {"bathroom": "tile", "wc": "tile", "wc_block": "tile", "kitchen": "tile_large", "kitchen_pro": "tile_large", "utility": "tile", "laundry": "tile",
              "garage": "concrete", "bay": "concrete", "warehouse": "concrete", "loading": "concrete", "stockroom": "concrete", "storage": "concrete",
              "nave": "stone", "chancel": "stone", "narthex": "stone", "lobby": "stone", "foyer": "stone", "chamber": "stone", "sales": "vinyl",
              "classroom": "vinyl", "open_office": "carpet", "office": "carpet", "meeting": "carpet", "bedroom": "oak", "living": "oak"}
    spec["floors"] = []
    import doorlogic as _DL
    for s in range(S):
        holes_ = [sbox(*h) for h in bp["stairs"][s - 1][0]["hole"]] if s > 0 and (s - 1) in bp["stairs"] else []
        env_s = RF.cells_poly(np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[s]), c)
        for lab, P in _DL.room_polys(plan, s, st).items():
            r = rooms[lab - 1]
            if r.get("open_air") or r.get("subdivided") or P is None or P.is_empty: continue
            # back out to the cell boundary (joins hide under walls; open-plan rooms meet without a seam)
            P = P.buffer(st["int_"] * 500 + 1, join_style=2)
            if env_s is not None: P = P.intersection(env_s.buffer(-st["ext"] * 1000 + 5, join_style=2))
            for hh in holes_: P = P.difference(hh)
            for g in ([P] if P.geom_type == "Polygon" else list(getattr(P, "geoms", []))):
                if g.geom_type != "Polygon" or g.area < 0.2e6: continue
                spec["floors"].append(dict(ring=[[_m(x), _m(Y(y))] for x, y in list(g.exterior.coords)[:-1]], holes=[[[_m(x), _m(Y(y))] for x, y in list(h.coords)[:-1]] for h in g.interiors],
                                           z0=_m(zf(s)), h=0.012, finish=FINISH.get(r["kind"], "oak"), room=r["kind"], storey=s))
    # roofs: the skeleton meshes, sloped faces and vertical (gable) faces separated
    for R in bp["roofs"]:
        for role, V, F in R["pieces"]:
            sl, ve, bo = RF.split_faces(V, F)
            if R["programme"] != "flat" and role != "roof_flat":         # audit fix: capped decks are membrane
                deck = [f for f in sl if np.allclose(np.asarray(V)[list(f)][:, 2], np.asarray(V)[list(f)][0, 2], atol=1)]
                if deck:
                    sl = [f for f in sl if f not in deck]
                    spec["roofs"].append(dict(V=[[_m(x), _m(Y(y)), _m(z)] for x, y, z in V], slope=[list(map(int, f)) for f in deck], vertical=[], flat=True,
                                              programme=R["programme"], storey=R["storey"], roofc=st["roofc"], wallc=st["walls"]))
            spec["roofs"].append(dict(V=[[_m(x), _m(Y(y)), _m(z)] for x, y, z in V], slope=[list(map(int, f)) for f in sl], vertical=[list(map(int, f)) for f in ve],
                                      flat=R["programme"] == "flat" or role == "roof_flat", programme=R["programme"], storey=R["storey"], roofc=st["roofc"], wallc=st["walls"]))
        if R["programme"] == "flat" and R.get("poly") is not None:
            poly = R["poly"]; zp = R["z_plate"]; par = 900 if ("parapet" in st["trimset"] or "cornice" in st["trimset"]) else 450
            ring = poly.difference(poly.buffer(-st["ext"] * 1000, join_style=2))
            for el in EXT.prism(ring, zp, par, role="parapet", colour=st["walls"], ifc="Wall", label="Parapet"): spec["ext"].append(_ext(el, Y))
    # audit fix R3: a porch under the main roof gets a ceiling at plate height, closing the attic from below
    if True:
        pm = np.vectorize(lambda v: v > 0 and bool(rooms[v - 1].get("open_air")))(labels[0])
        if S > 1:     # only porch parts under a pitched main/wing roof (not lean-tos, not under the upper floor)
            up = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[1])
            pm = pm & ~up
            covered = np.zeros_like(pm)
            ys_, xs_ = np.nonzero(pm)
            for yy, xx in zip(ys_, xs_):
                cx_, cy_ = (xx + 0.5) * c, (yy + 0.5) * c
                if RF.height_at([R for R in bp["roofs"] if R["kind"] != "porch"], cx_, cy_) is not None: covered[yy, xx] = True
            pm = covered
        if pm.any():
            Pp = RF.cells_poly(pm, c)
            if Pp is not None:
                for el in EXT.prism(Pp, zf(0) + Hs - SLAB - 20, 20, role="porch_ceiling", colour="#efe9dc", ifc="Covering", label="Porch ceiling"): spec["ext"].append(_ext(el, Y))
    # audit fix R3: outdoor area under a roof whose surface is above the wall plate (porches, loggias, notches the
    # roof spans) gets a soffit at plate height, closing the attic; plain eave overhangs (below the plate) stay open
    for s_ in range(S):
        ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[s_])
        env_ = RF.cells_poly(ind, c)
        if env_ is None: continue
        tris = []
        for R in bp["roofs"]:
            if R["storey"] != s_ or R["kind"] == "porch": continue
            for role, V, F in R["pieces"]:
                V = np.asarray(V, float); sl, _, _ = RF.split_faces(V, F)
                tris += [V[list(f)] for f in sl if len(f) == 3]
        if not tris: continue
        T = np.array(tris)                                         # (n, 3, 3)
        x0, y0, x1, y1 = unary_union([Polygon(t[:, :2]) for t in T if Polygon(t[:, :2]).area > 1]).bounds
        g = 150.0; xs = np.arange(x0 + g / 2, x1, g); ys = np.arange(y0 + g / 2, y1, g)
        X, Yg = np.meshgrid(xs, ys); P = np.stack([X.ravel(), Yg.ravel()], 1)
        A, B, Cc = T[:, 0], T[:, 1], T[:, 2]
        det = (B[:, 1] - Cc[:, 1]) * (A[:, 0] - Cc[:, 0]) + (Cc[:, 0] - B[:, 0]) * (A[:, 1] - Cc[:, 1])
        ok = np.abs(det) > 1e-9
        A, B, Cc, det = A[ok], B[ok], Cc[ok], det[ok]
        zmax = np.full(len(P), -np.inf)
        for k0 in range(0, len(P), 4000):
            q = P[k0:k0 + 4000][:, None, :]
            l1 = ((B[:, 1] - Cc[:, 1]) * (q[..., 0] - Cc[:, 0]) + (Cc[:, 0] - B[:, 0]) * (q[..., 1] - Cc[:, 1])) / det
            l2 = ((Cc[:, 1] - A[:, 1]) * (q[..., 0] - Cc[:, 0]) + (A[:, 0] - Cc[:, 0]) * (q[..., 1] - Cc[:, 1])) / det
            l3 = 1 - l1 - l2
            inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
            z = l1 * A[:, 2] + l2 * B[:, 2] + l3 * Cc[:, 2]
            zmax[k0:k0 + 4000] = np.where(inside, z, -np.inf).max(axis=1)
        plate = zf(s_) + Hs - SLAB
        hit = P[zmax > plate + 30]
        if not len(hit): continue
        cells = unary_union([sbox(x - g / 2, y - g / 2, x + g / 2, y + g / 2) for x, y in hit])
        if s_ + 1 < S:
            up_ = RF.cells_poly(np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(labels[s_ + 1]), c)
            if up_ is not None: cells = cells.difference(up_)
        sof = cells.buffer(g, join_style=2).difference(env_).buffer(-5, join_style=2).buffer(5, join_style=2)
        for gg in ([sof] if sof.geom_type == "Polygon" else list(getattr(sof, "geoms", []))):
            if gg.geom_type != "Polygon" or gg.area < 0.05e6: continue
            for el in EXT.prism(gg, plate - 20, 20, role="soffit", colour="#efe9dc", ifc="Covering", label="Soffit"): spec["ext"].append(_ext(el, Y))
    # stairs
    for s, (D, parts) in bp["stairs"].items():
        for role, (x0, y0, z0_, x1, y1, z1) in parts:
            spec["stairs"].append(dict(b=[_m(x0), _m(y0), _m(z0_), _m(x1), _m(y1), _m(z1)], role=role, colour="#3a3a3a" if role in ("rail", "banister") else "#b48a5e"))
    # exterior primitives and furniture
    E, rep = EXT.elements(plan, st, bp["specs"], RF.cells_poly)
    spec["ext"] += [_ext(el, Y) for el in E]
    for fi in LAY.furnish(plan, st, bp["specs"], ITEMS, ROOM_ITEMS):
        spec["furniture"].append(dict(name=fi["name"], x=_m(fi["x"]), y=_m(Y(fi["y"])), z=_m(zf(fi["storey"])), ang=fi["ang"], storey=fi["storey"]))
    spec["report"] = dict(stairs={s: {k: v for k, v in D.items() if k != "hole"} for s, (D, _) in bp["stairs"].items()}, doors=bp["doors"], columns=rep.get("columns"),
                          roofs=[dict(kind=r["kind"], programme=r["programme"], classify=r["classify"]) for r in bp["roofs"]])
    return spec, bp


def _ext(el, Y):
    out = {k: v for k, v in el.items() if k not in ("b", "ring", "holes", "x", "y", "z0", "z1", "h", "D")}
    if el["t"] == "box":
        x0, y0, z0, x1, y1, z1 = el["b"]; out["b"] = [_m(x0), _m(y0), _m(z0), _m(x1), _m(y1), _m(z1)]
    elif el["t"] == "prism":
        out["ring"] = [[_m(x), _m(Y(y))] for x, y in el["ring"]]; out["holes"] = [[[_m(x), _m(Y(y))] for x, y in h] for h in el["holes"]]
        out["z0"], out["h"] = _m(el["z0"]), _m(el["h"])
    else:
        out.update(x=_m(el["x"]), y=_m(Y(el["y"])), z0=_m(el["z0"]), z1=_m(el["z1"]), D=_m(el["D"]))
    return out


if __name__ == "__main__":
    import os
    os.makedirs(_ARCH_OUT + "/spec", exist_ok=True)
    for path in sys.argv[1:]:
        p = json.load(open(path)); p.setdefault("key", path.split("plan-")[1][:-5])
        sp, bp = build_spec(p)
        json.dump(sp, open(f"{_ARCH_OUT}/spec/{p['key']}.json", "w"))
        print(p["key"], {k: len(v) for k, v in sp.items() if isinstance(v, list)}, "furniture lib", len(sp["library"]))
