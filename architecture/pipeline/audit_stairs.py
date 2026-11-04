"""Stair access audit: the 900 mm before the bottom step (its own floor) and past the top step (the floor above) must be
open floor inside the house: not wall, not outside, not another room walled off from the stair.
Usage: python audit_stairs.py <plan-dir> <spec-dir> <prefix>   (spec-dir holds <prefix>-<key>.bp.pkl from spec_dir.py)"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import sys, glob, json, pickle, os
sys.path.insert(0, _HERE)
from shapely.geometry import box as B, Polygon
from shapely.ops import unary_union
import stairs as STR
from styles import style_for

ZONE = 900
REV = os.environ.get("STAIR_REV", "1") == "1"


def walls_of(specs):
    """Wall solids of one storey with door/overhead openings cut out (mm)."""
    polys = []
    for sp in specs:
        if sp["axis"] == "y": w = B(sp["d0"], sp["a0"], sp["d1"], sp["a1"])
        else: w = B(sp["a0"], sp["d0"], sp["a1"], sp["d1"])
        for o in sp["openings"]:
            if o["kind"] in ("door", "overhead", "open", "bay") or o.get("ptype") in ("cased", "open"):
                a0, a1 = o["pos"] - o["w"] / 2, o["pos"] + o["w"] / 2
                cut = B(sp["d0"] - 5, a0, sp["d1"] + 5, a1) if sp["axis"] == "y" else B(a0, sp["d0"] - 5, a1, sp["d1"] + 5)
                w = w.difference(cut)
        polys.append(w)
    return unary_union(polys)


def floor_of(L, cell, rooms, exclude_open_air=True):
    cs = []
    for i, row in enumerate(L):
        for j, v in enumerate(row):
            if v > 0 and not (exclude_open_air and rooms[v - 1].get("open_air")): cs.append(B(j * cell, i * cell, (j + 1) * cell, (i + 1) * cell))
    return unary_union(cs)


def flight_zones(plan, Hs):
    """Foot zone (lower floor) and the arrival zone's exit strips (upper floor) for the plan's straight flight, mm."""
    if not plan.get("stair"): return None
    c = plan["cell"] * 1000; x0, y0, w, h = plan["stair"]
    X0, Y0, X1, Y1 = x0 * c, y0 * c, (x0 + w) * c, (y0 + h) * c
    D, parts = STR.stair_boxes(X0, Y0, X1, Y1, 0, Hs, rev=STR.ensure_rev(plan) if REV else False)
    steps = [b for role, b in parts if role == "step"]
    if not steps or D["form"] != "straight": return None
    ay = D["along_y"]; f = steps[0]; l = steps[-1]
    up = (l[1] - f[1]) if ay else (l[0] - f[0])               # walking direction along the run: + or −
    lo_b, hi_b = (f[0], f[3]) if ay else (f[1], f[4])
    R = (lambda a0, a1, b0, b1: B(b0, min(a0, a1), b1, max(a0, a1))) if ay else (lambda a0, a1, b0, b1: B(min(a0, a1), b0, max(a0, a1), b1))
    fa = (f[1] if up > 0 else f[4]) if ay else (f[0] if up > 0 else f[3])          # the foot edge of the first step
    foot = R(fa, fa - (ZONE if up > 0 else -ZONE), lo_b, hi_b)
    hole = D["hole"][0]
    ha = (hole[3] if up > 0 else hole[1]) if ay else (hole[2] if up > 0 else hole[0])  # where the floor resumes upstairs
    rend = (Y1 if up > 0 else Y0) if ay else (X1 if up > 0 else X0)                   # far end of the stair room
    rb0, rb1 = (X0, X1) if ay else (Y0, Y1)
    sgn = 1 if up > 0 else -1
    end = R(rend - sgn * 150, rend + sgn * 600, lo_b, hi_b)
    side0 = R(ha, rend, rb0 - 600, rb0 + 150); side1 = R(ha, rend, rb1 - 150, rb1 + 600)
    exits = [e for e in (end, side0, side1) if e.area > 0 and abs(rend - ha) > 300 or e is end]
    return dict(foot=foot, exits=exits, D=D)


def audit(plan, bp):
    rooms = plan["program"]["rooms"]; cell = plan["cell"] * 1000
    st = style_for(plan["theme"]); Hs = st["storey"] * 1000
    z = flight_zones(plan, Hs)
    if z is None: return None
    out = {}
    def judge(zone, s, travel=None):
        # only walls ACROSS the way count: a wall alongside the flight (an exterior wall is 250 mm thick, the steps sit
        # 60 mm in from the stair space) clips the zone's edge without blocking anyone, so the zone is narrowed SIDEWAYS
        # only — never along the direction of travel (2026-11-02 fix: narrowing it all round hid a wall straight across
        # the foot of Quail Oak design 1, which BIMCraft then found)
        x0_, y0_, x1_, y1_ = zone.bounds
        if travel in ("x", "y"):
            sh = min(260.0, 0.3 * ((y1_ - y0_) if travel == "x" else (x1_ - x0_)))
            zone = B(x0_, y0_ + sh, x1_, y1_ - sh) if travel == "x" else B(x0_ + sh, y0_, x1_ - sh, y1_)
        fl = floor_of(bp["labels"][s], cell, rooms); wl = walls_of(bp["specs"][s])
        outside = zone.difference(fl).area / zone.area; walled = zone.intersection(wl).area / zone.area
        return dict(outside=round(outside, 2), walled=round(walled, 2), ok=outside < 0.1 and walled < 0.05)
    ay_ = z["D"]["along_y"]; run_ax = "y" if ay_ else "x"; cross_ax = "x" if ay_ else "y"
    out["foot"] = judge(z["foot"], 0, run_ax)
    def judge_exit(e, s, k_=0):
        # a way off the arrival zone: any 900 mm window along the exit strip that is open floor (2026-11-02)
        x0, y0, x1, y1 = e.bounds; best = None
        long_x = (x1 - x0) >= (y1 - y0); L_ = (x1 - x0) if long_x else (y1 - y0)
        trav = run_ax if k_ == 0 else cross_ax          # the end exit continues the run; side exits leave across it
        if L_ <= 950: return judge(e, s, trav)
        for t in range(0, int(L_ - 900) + 1, 100):
            w = B(x0 + t, y0, x0 + t + 900, y1) if long_x else B(x0, y0 + t, x1, y0 + t + 900)
            j = judge(w, s, trav)
            if j["ok"]: return j
            best = best or j
        return best
    ex = [judge_exit(e, 1, k_) for k_, e in enumerate(z["exits"])]
    out["head"] = dict(ok=any(e["ok"] for e in ex), exits=ex)
    out["rev"] = bool(z["D"].get("rev"))
    return out


if __name__ == "__main__":
    pdir, sdir, pre = sys.argv[1:4]
    res = {}
    for f in sorted(glob.glob(f"{pdir}/plan-*.json")):
        k = f.split("plan-")[1][:-5]; p = json.load(open(f)); p["key"] = k
        pk = f"{sdir}/{pre}-{k}.bp.pkl"
        if not os.path.exists(pk): continue
        r = audit(p, pickle.load(open(pk, "rb")))
        if r is None: continue
        res[k] = r
        print(k, "foot", r["foot"], "head", r["head"])
    bad = [k for k, r in res.items() if not (r["foot"]["ok"] and r["head"]["ok"])]
    print(f"{len(bad)} of {len(res)} stairs blocked at the foot or head:", bad)
