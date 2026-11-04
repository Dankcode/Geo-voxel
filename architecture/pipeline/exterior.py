"""Exterior elements as neutral primitives (shared by the FreeCAD and Blender builders): foundations, porch deck,
posts / classical columns, rails, entry steps, cornices, brackets, buttresses, facade piers, Prairie band.

Primitive forms (mm, plan frame):
  {"t": "box",    "b": (x0, y0, z0, x1, y1, z1)}
  {"t": "prism",  "ring": [(x, y), …], "holes": [[…]], "z0": z, "h": h}
  {"t": "column", "x": cx, "y": cy, "z0": z, "z1": z, "D": d, "order": name}   (shaft tapered to 5/6 D, base, capital)
each with "role", "colour", "ifc", "label".
"""
import math
import numpy as np
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union
from styles import column_dims

SLAB = 200


def _rings(g):
    gs = [g] if g.geom_type == "Polygon" else [x for x in getattr(g, "geoms", []) if x.geom_type == "Polygon"]
    return [(list(x.exterior.coords)[:-1], [list(h.coords)[:-1] for h in x.interiors]) for x in gs if not x.is_empty]


def prism(g, z0, h, **kw):
    return [dict(t="prism", ring=r, holes=hs, z0=z0, h=h, **kw) for r, hs in _rings(g)]


def elements(plan, st, specs_by_storey, cells_poly, legacy=False):
    rooms = plan["program"]["rooms"]; labels = [np.array(L) for L in plan["labels"]]; S = len(labels)
    c = plan["cell"] * 1000; Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000; te = st["ext"] * 1000
    zf = lambda s: R0 + s * Hs
    indoor = [np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(L).astype(bool) for L in labels]
    porch = [np.vectorize(lambda v: v > 0 and bool(rooms[v - 1].get("open_air")))(L).astype(bool) for L in labels]
    E = []
    report = {}
    ground, pp = cells_poly(indoor[0], c), cells_poly(porch[0], c)
    # ------------------------------------------------------------------ foundations
    if R0 > 350:
        allp = unary_union([p for p in (ground, pp) if p is not None])
        minx, miny, maxx, maxy = allp.bounds
        for x in np.arange(minx + 150, maxx - 100, 2200):
            for y in np.arange(miny + 150, maxy - 100, 2200):
                if allp.contains(sbox(x, y, x + 350, y + 350)):
                    E.append(dict(t="box", b=(x, y, 0, x + 350, y + 350, R0 - SLAB), role="pier", colour="#9b5a43", ifc="Footing", label="Pier"))
        E += prism(allp.difference(allp.buffer(-120)), 120, R0 - SLAB - 120, role="skirt", colour="#6b5546", ifc="Covering", label="Lattice skirt")
    else:
        E += prism(ground, 0, max(100, R0 - SLAB), role="plinth", colour="#8d8a84", ifc="Footing", label="Plinth")
    if pp is not None:
        E += prism(pp, R0 - 150, 150, role="deck", colour="#a08362", ifc="Slab", label="Porch deck")
    # ------------------------------------------------------------------ trim on the top storey's exterior runs
    s = S - 1; zt = zf(s) + Hs - SLAB
    for sp in specs_by_storey[s]:
        if not sp["ext"] or sp["outer"] > 0: continue
        face_out = sp["d1"] if sp["outward"] == 1 else sp["d0"]; proj = 1 if sp["outward"] == 1 else -1
        def ob(a0_, a1_, z0_, z1_, dep):
            d0_, d1_ = sorted((face_out, face_out + proj * dep))
            return (a0_, d0_, z0_, a1_, d1_, z1_) if sp["axis"] == "x" else (d0_, a0_, z0_, d1_, a1_, z1_)
        if "cornice" in st["trimset"] or st["roof"] == "flat":
            E.append(dict(t="box", b=ob(sp["a0"] - te, sp["a1"] + te, zt - 350, zt, 220), role="cornice", colour=st["trim"], ifc="Covering", label="Cornice"))
        if "brackets" in st["trimset"]:
            for a in np.arange(sp["a0"] + 300, sp["a1"] - 200, 700):
                E.append(dict(t="box", b=ob(a, a + 110, zt - 520, zt - 60, 300), role="bracket", colour=st["trim"], ifc="Covering", label="Bracket"))
        if "buttresses" in st["trimset"]:
            for a in np.arange(sp["a0"] + 600, sp["a1"] - 300, 3600):
                E.append(dict(t="box", b=ob(a, a + 500, R0, zt - 900, 650), role="buttress", colour=st["walls"], ifc="Column", label="Buttress"))
        if "piers" in st["trimset"] and sp["axis"] == "x" and sp["outward"] == -1:
            for a in np.arange(sp["a0"] + 400, sp["a1"] - 200, 3000):
                E.append(dict(t="box", b=ob(a, a + 300, R0, zt + 1300, 200), role="pier_fin", colour=st["trim"], ifc="Covering", label="Pier"))
    if "band" in st.get("trimset", []):           # Prairie: a horizontal band at sill height on every storey
        for s_, specs in enumerate(specs_by_storey):
            for sp in specs:
                if not sp["ext"] or sp["outer"] > 0: continue
                face_out = sp["d1"] if sp["outward"] == 1 else sp["d0"]; proj = 1 if sp["outward"] == 1 else -1
                d0_, d1_ = sorted((face_out, face_out + proj * 60)); z_ = zf(s_) + st["window"]["sill"] * 1000 - 120
                b = (sp["a0"], d0_, z_, sp["a1"], d1_, z_ + 120) if sp["axis"] == "x" else (d0_, sp["a0"], z_, d1_, sp["a1"], z_ + 120)
                E.append(dict(t="box", b=b, role="cornice", colour=st["trim"], ifc="Covering", label="Band"))
    # ------------------------------------------------------------------ porch posts, rails, steps
    entry = next(((sp, o) for sp in specs_by_storey[0] for o in sp["openings"] if o.get("entry") and sp["axis"] == "x"), None)
    pm = porch[0]
    if pm.any():
        L = labels[0]; H, W = L.shape
        zp, ztop = R0, zf(0) + Hs - SLAB
        posts = {"square": (150, 150), "turned": (130, 130), "tapered": (300, 300), "column": (320, 320), "steel": (90, 90), "round": (220, 220)}.get(st["porch"]["posts"], (150, 150))
        pts = set()
        for y in range(H):
            for x in range(W):
                if not pm[y, x]: continue
                for k, (du, dv) in enumerate([(0, -1), (1, 0), (0, 1), (-1, 0)]):
                    yy, xx = y + dv, x + du
                    nb = L[yy, xx] if 0 <= yy < H and 0 <= xx < W else -1
                    if nb <= 0:
                        if k == 0: pts.update({(x, y), (x + 1, y)})
                        elif k == 2: pts.update({(x, y + 1), (x + 1, y + 1)})
                        elif k == 1: pts.update({(x + 1, y), (x + 1, y + 1)})
                        else: pts.update({(x, y), (x, y + 1)})
        P = sorted(pts)
        front = [p for p in P if any(p[1] == y and pm[y, min(W - 1, max(0, p[0] - 1))] for y in [min(H - 1, p[1])]) and (p[1] == 0 or not (0 <= p[1] - 1 < H) or L[p[1] - 1, min(W - 1, p[0])] <= 0)]
        xs = sorted({p[0] for p in front}); ylin = min(p[1] for p in front) if front else 0
        keep, last = [], None
        for x in xs:
            if last is None or (x - last) * c >= 2300 or x == xs[-1]: keep.append(x); last = x
        pw, pd = posts
        order = st.get("order") if st["porch"]["posts"] in ("column", "round") and not legacy else None
        if order:
            cd = column_dims(order, ztop - zp); pw = pd = cd["D"]
            report["columns"] = {"order": order, "D_mm": round(cd["D"]), "H_mm": round(ztop - zp), "k": round((ztop - zp) / cd["D"], 2)}
        for x in keep:
            X = min(max(x * c - pw / 2, 0), W * c - pw); Y = ylin * c + 60
            if order: E.append(dict(t="column", x=X + pw / 2, y=Y + pw / 2, z0=zp, z1=ztop, D=pw, order=order, role="post", colour=st["trim"], ifc="Column", label=f"{order.title()} column"))
            else: E.append(dict(t="box", b=(X, Y, zp, X + pw, Y + pd, ztop), role="post", colour=st["trim"], ifc="Column", label="Porch post"))
        door_x = entry[1]["pos"] if entry and not legacy else None
        if st["porch"]["rail"] and len(keep) > 1:
            ent_x = door_x if door_x is not None else (keep[0] + keep[-1]) / 2 * c
            for a, b in zip(keep, keep[1:]):
                A, B = a * c + pw / 2, b * c - pw / 2
                segs = [(A, ent_x - 700), (ent_x + 700, B)] if (A < ent_x < B and B - A > 1600) else [(A, B)]
                for A_, B_ in segs:
                    if B_ - A_ < 200: continue
                    E.append(dict(t="box", b=(A_, ylin * c + 100, zp + 880, B_, ylin * c + 160, zp + 950), role="rail", colour=st["trim"], ifc="Railing", label="Porch rail"))
                    for xb in np.arange(A_ + 60, B_ - 40, 130):
                        E.append(dict(t="box", b=(xb, ylin * c + 110, zp, xb + 40, ylin * c + 150, zp + 880), role="baluster", colour=st["trim"], ifc="Railing", label="Baluster"))
        n = int(math.ceil(R0 / 175)); cx = door_x if door_x is not None else (keep[0] + keep[-1]) / 2 * c if keep else W * c / 2
        for i in range(n):
            E.append(dict(t="box", b=(cx - 750, ylin * c - 300 * (n - i) + 60, i * R0 / n, cx + 750, ylin * c + 60, (i + 1) * R0 / n), role="steps", colour="#9a948a", ifc="Stair", label="Entry steps"))
    elif R0 > 200:
        n = int(math.ceil(R0 / 175))
        if entry and not legacy and entry[0]["outward"] == -1: sx, sy = entry[1]["pos"], entry[0]["line"]
        else:
            ent = plan["program"]["entry"] + 1; ys, xs = np.nonzero(labels[0] == ent)
            sx, sy = ((xs.min() + xs.max() + 1) / 2 * c if len(xs) else labels[0].shape[1] * c / 2), 0
        E.append(dict(t="box", b=(sx - 800, sy - 300 * n, 0, sx + 800, sy, R0 - 1), role="steps", colour="#9a948a", ifc="Stair", label="Entry steps"))
    # audit fix D5: every other ground-floor exterior door on a raised floor gets a landing (IRC R311.3: at least
    # 36 in deep, as wide as the door) and steps down to grade; doors onto the porch or already served are skipped
    if R0 > 150 and not legacy:
        L0 = labels[0]; H, W = L0.shape
        served = [(e["b"][0], e["b"][1], e["b"][3], e["b"][4]) for e in E if e.get("role") == "steps"]
        for sp in specs_by_storey[0]:
            if not sp["ext"]: continue
            for o in sp["openings"]:
                if o["kind"] != "door": continue
                out_ = sp["outward"]; face = sp["d1"] if out_ == 1 else sp["d0"]
                if sp["axis"] == "x": qx, qy = o["pos"], face + out_ * 450
                else: qx, qy = face + out_ * 450, o["pos"]
                cx_, cy_ = int(qx // c), int(qy // c)
                if 0 <= cy_ < H and 0 <= cx_ < W and L0[cy_, cx_] > 0: continue          # opens onto the porch / deck
                if any(x0 - 300 <= qx <= x1 + 300 and y0 - 300 <= qy <= y1 + 300 for x0, y0, x1, y1 in served): continue
                n = int(math.ceil(R0 / 175)); hw = o["w"] / 2 + 300; land = 900
                def bx(a0, a1, b0, b1, z0, z1, role, label):
                    # a: along the wall, b: outward distance from the wall face
                    if sp["axis"] == "x": y0, y1 = sorted((face + out_ * b0, face + out_ * b1)); E.append(dict(t="box", b=(a0, y0, z0, a1, y1, z1), role=role, colour="#9a948a", ifc="Stair", label=label))
                    else: x0, x1 = sorted((face + out_ * b0, face + out_ * b1)); E.append(dict(t="box", b=(x0, a0, z0, x1, a1, z1), role=role, colour="#9a948a", ifc="Stair", label=label))
                p = o["pos"]
                bx(p - hw, p + hw, 0, land, 0, R0 - 1, "landing", "Door landing")
                for i in range(n - 1):
                    bx(p - hw, p + hw, land, land + 300 * (n - 1 - i), i * R0 / n, (i + 1) * R0 / n, "steps", "Door steps")
                served.append((qx - hw, qy - hw, qx + hw, qy + hw))
    return E, report
