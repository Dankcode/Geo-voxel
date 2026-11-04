"""Blueprint geometry for the viewer: the same drawing blueprint.draw() makes, as plain data (metres), no text.
The viewer draws it as SVG in the page; names, areas and checks go in the page's own text.

plan2d = {"bounds": [x0, y0, x1, y1], "front": "bottom", "storeys": [{
            "rooms": [{"id", "kind", "tier", "area", "w", "d", "rings": [[[x, y], …], …]}],
            "ext": [rings…], "int": [rings…],                        wall poche (exterior / interior walls)
            "windows": [[x0, y0, x1, y1], …],                         glazing line, mid-wall
            "doors": [{"leaf": [[hx, hy], [tx, ty]], "arc": [[x, y], …]}], "pockets": [[x0, y0, x1, y1]],
            "cased": [[x0, y0, x1, y1]], "overhead": [[x0, y0, x1, y1]],
            "steps": [[x0, y0, x1, y1]], "landings": [[…]], "holes": [[…]], "up": [[x0, y0], [x1, y1]] | null }]}
"""
import numpy as np
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
import blueprint as BP, doorlogic as DL
import roofs as RF

R2 = lambda v: round(float(v) / 1000, 3)


def rings_of(g):
    if g is None or g.is_empty: return []
    gs = list(g.geoms) if hasattr(g, "geoms") else [g]
    out = []
    for p in gs:
        if not isinstance(p, Polygon) or p.area < 1: continue
        out.append([[R2(x), R2(y)] for x, y in list(p.exterior.coords)[:-1]])
        for h in p.interiors: out.append([[R2(x), R2(y)] for x, y in list(h.coords)[:-1]])
    return out


def seg(sp, a0, a1, d):
    return [R2(a0), R2(d), R2(a1), R2(d)] if sp["axis"] == "x" else [R2(d), R2(a0), R2(d), R2(a1)]


def export(bp, furniture=None):
    rooms = bp["rooms"]; c = bp["cell"]
    allp = unary_union([p for ps in bp["polys"] for p in ps.values()]).buffer(400)
    out = {"bounds": [R2(v) for v in allp.bounds], "front": "bottom", "storeys": []}
    for s in range(bp["S"]):
        S = {"rooms": [], "ext": [], "int": [], "windows": [], "doors": [], "pockets": [], "cased": [], "overhead": [],
             "steps": [], "landings": [], "holes": [], "up": None}
        for lab, P in bp["polys"][s].items():
            r = rooms[lab - 1]
            if r.get("subdivided"): continue
            bx0, by0, bx1, by1 = P.bounds
            S["rooms"].append(dict(id=int(lab), kind=r["kind"], tier=int(DL.RANK.get(r["kind"], 1)), open_air=bool(r.get("open_air")),
                                   area=round(P.area / 1e6, 1), w=round((bx1 - bx0) / 1000, 1), d=round((by1 - by0) / 1000, 1), rings=rings_of(P)))
        Lg = np.array(bp["labels"][s]); ind = np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(Lg)
        env = RF.cells_poly(ind, c)
        E, I = BP._wall_poche(bp["specs"][s], env)
        import bays as BAY
        bl = [g for s_, sp_, o_, g in BAY.bays_of([bp["specs"][s]])]
        if bl: E = unary_union([E] + [g["walls"] for g in bl])
        S["ext"], S["int"] = rings_of(E), rings_of(I)
        for s_, sp_, o_, g in BAY.bays_of([bp["specs"][s]]):
            S["windows"] += [[R2(a), R2(b), R2(c_), R2(d)] for a, b, c_, d in BAY.window_segments(g, o_["bay_wins"])]
        for sp in bp["specs"][s]:
            for o in sp["openings"]:
                p0, p1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
                mid = (sp["d0"] + sp["d1"]) / 2
                if o["kind"] == "window": S["windows"].append(seg(sp, p0, p1, mid)); continue
                if o["kind"] == "overhead": S["overhead"].append(seg(sp, p0, p1, mid)); continue
                if o.get("ptype") == "cased": S["cased"].append(seg(sp, p0, p1, mid)); continue
                sw = o.get("swing") or {}
                if sw.get("kind") == "pocket":
                    q0, q1 = (p0 - o["w"], p0) if sw["side"] == "a0" else (p1, p1 + o["w"])
                    S["pockets"].append(seg(sp, q0, q1, mid)); continue
                for lf, arc in zip(sw.get("leaves", []), sw.get("arcs", [])):
                    S["doors"].append({"leaf": [[R2(v) for v in lf["hinge"]], [R2(v) for v in lf["tip_open"]]],
                                       "arc": [[R2(x), R2(y)] for x, y in np.array(arc)[1:]]})
        for ss, (D, parts) in bp["stairs"].items():
            if ss == s:
                steps = [b for role, b in parts if role == "step"]
                S["steps"] += [[R2(b[0]), R2(b[1]), R2(b[3]), R2(b[4])] for b in steps]
                S["landings"] += [[R2(b[0]), R2(b[1]), R2(b[3]), R2(b[4])] for role, b in parts if role == "landing"]
                if steps:
                    k = len(steps) // 2; m = lambda b: [R2((b[0] + b[3]) / 2), R2((b[1] + b[4]) / 2)]
                    S["up"] = [m(steps[0]), m(steps[k])]
            elif ss == s - 1:
                S["holes"] += [[R2(h[0]), R2(h[1]), R2(h[2]), R2(h[3])] for h in D["hole"]]
        out["storeys"].append(S)
    # furniture footprints (layout.furnish output, mm), drawn as outlines; the car's front is marked for its direction
    if furniture:
        import math
        for f in furniture:
            x0, y0, x1, y1 = f["fp"].bounds
            d = dict(name=f["name"], room=int(f["room"]) + 1, b=[R2(x0), R2(y0), R2(x1), R2(y1)], ang=f["ang"])
            if f["name"] == "car":
                a = math.radians(f["ang"]); L, W = 4920, 1840
                d["front"] = [R2(f["x"] + math.cos(a) * L - math.sin(a) * W / 2), R2(f["y"] + math.sin(a) * L + math.cos(a) * W / 2)]
                d["rear"] = [R2(f["x"] - math.sin(a) * W / 2), R2(f["y"] + math.cos(a) * W / 2)]
            out["storeys"][f["storey"]].setdefault("furniture", []).append(d)
    # plain-text facts for the page
    fp = unary_union(list(bp["polys"][0].values()))
    x0, y0, x1, y1 = fp.bounds
    out["overall"] = [round((x1 - x0) / 1000, 2), round((y1 - y0) / 1000, 2)]
    out["roofs"] = [f"{r['kind']}: {r['programme'].replace('_', ' ')} ({r['classify']['family']})" for r in bp["roofs"]]
    out["door_note"] = f"exterior doors swing {bp['doors']['exterior_swing']} (occupant load {bp['doors']['occupant_load']})"
    out["stairs"] = [{"from": int(ss) + 1, "form": D["form"], "N": D["N"], "R": D["R"], "T": D["T"], "W": D["W"]} for ss, (D, _) in bp["stairs"].items()]
    return out


if __name__ == "__main__":
    import json, sys
    p = json.load(open(sys.argv[1])); p.setdefault("key", sys.argv[1].split("plan-")[1][:-5])
    d = export(BP.build(p))
    json.dump(d, open(sys.argv[2], "w"), separators=(",", ":"))
    print(len(json.dumps(d)), "bytes", [len(s["rooms"]) for s in d["storeys"]], d["overall"])
