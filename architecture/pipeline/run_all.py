"""Audit stage 1: rebuild blueprint + spec for every planned building and store them for independent checks."""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, sys, glob, time, os, traceback, pickle
from multiprocessing import Pool
sys.path.insert(0, _HERE)
OUT = _ARCH_OUT + "/audit"

def plans():
    P = []
    for f in sorted(glob.glob(_ARCH_OUT + "/plan-*.json")): P.append(("arch", f))
    for f in sorted(glob.glob(_ARCH_OUT + "/block/plan-rb*.json")): P.append(("rb", f))
    for f in sorted(glob.glob(_ARCH_OUT + "/gated/plan-*.json")): P.append(("poc", f))
    return P

def one(arg):
    grp, f = arg
    key = os.path.basename(f)[5:-5]; name = f"{grp}-{key}"
    t = time.time()
    try:
        import spec as SP
        p = json.load(open(f)); p.setdefault("key", key)
        s, bp = SP.build_spec(p)
        s.pop("library", None)
        json.dump(s, open(f"{OUT}/spec/{name}.json", "w"), default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
        # keep the blueprint pieces the independent checks need
        keep = dict(specs=bp["specs"], stairs={k: v[0] for k, v in bp["stairs"].items()}, roofs=[{k: v for k, v in r.items() if k != "poly"} | {"poly_wkt": (r["poly"].wkt if r.get("poly") is not None else None)} for r in bp["roofs"]],
                    rooms=bp["rooms"], labels=bp["labels"], cell=bp["cell"], S=bp["S"], style=bp["style"], theme=bp["theme"], checks=bp["checks"], rho=bp.get("privacy_rho"), audit=bp["audit"])
        pickle.dump(keep, open(f"{OUT}/spec/{name}.bp.pkl", "wb"))
        return dict(name=name, ok=True, sec=round(time.time() - t, 2), fails=[c["check"] for c in bp["checks"] if not c["ok"]])
    except Exception as e:
        return dict(name=name, ok=False, sec=round(time.time() - t, 2), err=traceback.format_exc()[-1500:])

if __name__ == "__main__":
    P = plans()
    with Pool(min(8, os.cpu_count())) as pool: R = pool.map(one, P)
    json.dump(R, open(f"{OUT}/run.json", "w"), indent=1)
    for r in R: print(r["name"], r["sec"], "ERR" if not r["ok"] else ("PASS" if not r["fails"] else r["fails"]))
