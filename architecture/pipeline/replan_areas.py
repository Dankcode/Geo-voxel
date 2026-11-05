"""Replan every house of the given areas with the current planner (same seeds), then rebuild them.
Usage: python replan_areas.py <area id> ..."""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, os, subprocess, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import generate_area as GA
PY = GA.PY
ONLY = set(filter(None, os.environ.get("ONLY", "").split(",")))
for aid in sys.argv[1:]:
    d = os.path.join(HERE, "..", "areas", aid); A = json.load(open(os.path.join(d, "area.json")))
    procs = []
    for h in A["houses"]:
        if h.get("restyled_from"): continue
        if ONLY and h["key"] not in ONLY: continue
        key, seed = h["key"].rsplit("-s", 1)
        p0 = json.load(open(os.path.join(d, "plans", f"plan-{h['key']}.json")))
        data = GA.absd(A.get("data")) or GA.DATA_DIRS[0]
        style = p0["theme"]["style"]
        env = dict(os.environ, GEO_DATA=data, PAPER="1", MERGE="1", MOVES="v2", STYLE_OVERRIDE=h.get("style_chosen") or "auto", PLAN_LOG="1")
        while len([p for p in procs if p.poll() is None]) >= 2: time.sleep(2)
        procs.append(subprocess.Popen([PY, "test_br.py", str(h["osm_id"]), key, seed, os.path.join(d, "plans")], cwd=HERE, env=env,
                                      stdout=open(os.path.join(d, "replan.log"), "a"), stderr=open(os.path.join(d, f"replan-{h['key']}.log"), "w")))
        print(aid, h["key"], "planning", flush=True)
    for p in procs: p.wait()
    GA.build(d, A["houses"], A.get("skipped", []), {k: v for k, v in A.items() if k not in ("houses", "skipped")}, only=ONLY or None)
    print(aid, "rebuilt", flush=True)
