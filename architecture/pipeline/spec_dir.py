"""Blueprint + spec + pickle for every plan in a directory (the inputs score.py and checks.py read).
Writes <out>/spec/<prefix>-<key>.json and .bp.pkl.  Usage: python spec_dir.py <plan-dir> <out> <prefix>"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import sys, glob, os
from multiprocessing import Pool
sys.path.insert(0, _HERE)
import run_all as RA
src, out, pre = sys.argv[1:4]
os.makedirs(f"{out}/spec", exist_ok=True)
RA.OUT = out
def one(f): return RA.one((pre, f))
if __name__ == "__main__":
    with Pool(2) as p: R = p.map(one, sorted(glob.glob(f"{src}/plan-*.json")))
    for r in R: print(r["name"], r["sec"], "ERR " + r.get("err", "")[-300:] if not r["ok"] else ("PASS" if not r["fails"] else r["fails"]), flush=True)
