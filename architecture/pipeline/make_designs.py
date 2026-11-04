"""Deliverables for every gated design of the Baton Rouge test: blueprint drawing (PNG + SVG), FreeCAD BIM model
(.FCStd + IFC4 + mesh), the neutral spec for Blender, and a row of facts for the report.
Usage: python make_designs.py <plan-dir> <out-dir> <plan keys…>"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, os, sys, time
sys.path.insert(0, _HERE); sys.path.append(_os_p0.environ.get("FREECAD_LIB", _os_p0.path.join(sys.prefix, "lib")))
import numpy as np
import blueprint as BP, spec as SP

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(f"{dst}/blueprints", exist_ok=True); os.makedirs(f"{dst}/bim", exist_ok=True); os.makedirs(f"{dst}/spec", exist_ok=True)
J = lambda o: o.tolist() if hasattr(o, "tolist") else (o.item() if hasattr(o, "item") else str(o))
rows = []
for key in sys.argv[3:]:
    p = json.load(open(f"{src}/plan-{key}.json")); p["key"] = key
    bp = BP.build(p)
    name = p.get("name") or key
    BP.draw(bp, f"{dst}/blueprints/{key}.png", f"{dst}/blueprints/{key}.svg",
            title=f"{name} — design {key.split('-s')[-1]} (seed {p.get('seed')}) — {p['theme']['archetype'].replace('_', ' ')}, {p['theme']['style'].replace('_', ' ')}, {len(p['labels'])} storeys")
    s, _ = SP.build_spec(json.load(open(f"{src}/plan-{key}.json")) | {"key": key})
    json.dump(s, open(f"{dst}/spec/{key}.json", "w"), default=J)
    t = time.time()
    import bim
    rp_ = f"{dst}/bim/{key}.rep.json"
    if os.environ.get("RESUME") and os.path.exists(f"{dst}/bim/{key}.mesh.json"): rep = json.load(open(rp_)) if os.path.exists(rp_) else {}
    else:
        rep = bim.build(json.load(open(f"{src}/plan-{key}.json")) | {"key": key}, f"{dst}/bim")
        json.dump({k: v for k, v in rep.items() if k in ("elements", "doors", "windows", "furniture", "roofs", "stairs", "door_logic", "porch_posts", "columns")}, open(rp_, "w"), default=J)
    bim_s = round(time.time() - t, 1)
    rooms = p["program"]["rooms"]; c2 = p["cell"] ** 2
    per = []
    for st_ in range(len(p["labels"])):
        L = np.array(p["labels"][st_])
        per.append([(r["kind"], round(float((L == r["id"] + 1).sum()) * c2, 1)) for r in rooms if r["storey"] == st_ and (L == r["id"] + 1).any()])
    rows.append(dict(key=key, name=name, osm=p["id"], seed=p.get("seed"), theme={k: p["theme"][k] for k in ("archetype", "style", "era", "storeys")},
                     cell=p["cell"], cost=p["cost"], terms=p["terms"], plan_s=p.get("plan_s"), checks=bp["checks"], rho=bp.get("privacy_rho"),
                     doors=bp["doors"].get("v2"), rooms=per, programme_log=p["program"]["log"], bim_s=bim_s,
                     bim={k: v for k, v in rep.items() if k in ("elements", "doors", "windows", "furniture", "roofs", "stairs", "door_logic")}))
    print(key, "gate", all(c["ok"] for c in bp["checks"]), "bim", bim_s, "s", flush=True)
# 2026-11-03: merge with the designs already in this deliver dir (a restyle builds one key; the others stay listed)
_old = json.load(open(f"{dst}/designs.json")) if os.path.exists(f"{dst}/designs.json") else []
_new = {r["key"] for r in rows}
json.dump([r for r in _old if r.get("key") not in _new] + rows, open(f"{dst}/designs.json", "w"), indent=1, default=J)
