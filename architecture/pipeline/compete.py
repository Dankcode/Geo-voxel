"""House competition: 5 seeded designs per building, each scored on its own (score.design_scores), ranked per building.
Usage: python compete.py <plan dir> <spec dir> <prefix> <findings.json> <out.json>"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, glob, os, sys, pickle
sys.path.insert(0, _HERE)
import score as SC, final_scores as FS
SC.FIDELITY_OVERRIDES.update(FS.AFTER_FIDELITY)           # the door redesign and the §5.1 snap/align moves are implemented
plan_dir, spec_dir, prefix, findings, out = sys.argv[1:6]
F = json.load(open(findings)) if os.path.exists(findings) else {}
all_m = {}
for f in sorted(glob.glob(f"{plan_dir}/plan-*.json")):
    key = os.path.basename(f)[5:-5]; name = f"{prefix}-{key}"; pk = f"{spec_dir}/{name}.bp.pkl"
    if not os.path.exists(pk): continue
    plan = json.load(open(f)); plan.setdefault("key", key)
    spec = json.load(open(f"{spec_dir}/{name}.json")) if os.path.exists(f"{spec_dir}/{name}.json") else None
    all_m[key] = SC.building_metrics(plan, pickle.load(open(pk, "rb")), spec, F.get(name))
    print(key, "metrics", flush=True)
rows = SC.score_table(all_m)
D = SC.design_scores(all_m)
by = {}
for k, d in D.items(): by.setdefault(k.split("-s")[0], []).append((k, d))
board = {}
for b, L in by.items():
    L.sort(key=lambda kd: (not kd[1]["passed"], -kd[1]["score"]))
    board[b] = [dict(key=k, rank=i + 1, **d) for i, (k, d) in enumerate(L)]
json.dump(dict(pass_at=SC.PASS_AT, algorithms=rows, designs=D, board=board, metrics=all_m), open(out, "w"), indent=1,
          default=lambda o: o.item() if hasattr(o, "item") else str(o))
print(f"\nAlgorithms (pass at {SC.PASS_AT})")
for r in rows: print(f"{r['score']:5.1f} {'PASS' if r['passed'] else 'FAIL'}  F={r['F']:.2f} Q={r['Q']:.2f}  {r['algorithm']}")
for b, L in board.items():
    print(f"\n{b}")
    for d in L: print(f"  #{d['rank']} {d['key']:16s} {d['score']:5.2f} {'PASS' if d['passed'] else 'fail'} gate={d['gate']} low={d['low']}")
