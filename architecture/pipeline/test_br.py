"""Plan one Baton Rouge building with one seed (and one move-set version), build its blueprint, run the gate.
Usage: MOVES=v2 python test_br.py <osm id> <key> <seed> <outdir>"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, os, sys, time
sys.path.insert(0, _HERE)
from mapctx import City
from plan_building import plan_building
import blueprint as BP

osm, key, seed, outdir = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
os.makedirs(outdir, exist_ok=True)
city = City()
b = next(x for x in city.buildings if str(x["id"]) == osm)
t = time.time()
p = plan_building(city, b, seed=seed, log=(lambda *a: print(*a, file=sys.stderr, flush=True)) if os.environ.get("PLAN_LOG") else (lambda *a: None)); p["key"] = f"{key}-s{seed}"
p["moves"] = os.environ.get("MOVES", "v2"); p["seed"] = seed
plan_s = round(time.time() - t, 1)
bp = BP.build(p)
fails = [c["check"] for c in bp["checks"] if not c["ok"]]
json.dump(p, open(f"{outdir}/plan-{key}-s{seed}.json", "w"), default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
rec = dict(key=key, seed=seed, moves=p["moves"], plan_s=plan_s, cost=p.get("cost"), terms=p.get("terms"), fails=fails,
           rooms=[r["kind"] for r in p["program"]["rooms"]], storeys=len(p["labels"]), theme={k: p["theme"][k] for k in ("archetype", "style", "storeys", "era")},
           doors_v2=bp["doors"].get("v2"), rho=bp.get("privacy_rho"))
json.dump(rec, open(f"{outdir}/rec-{key}-s{seed}.json", "w"), default=lambda o: o.item() if hasattr(o, "item") else str(o))
print(key, seed, p["moves"], plan_s, "s", "a", p["terms"]["a"], "fails", fails, flush=True)
