"""Statistics over the reference plans: the numbers the planner is calibrated on.

    python -m highrise.analyze [outdir]

Writes reference_stats.json (priors per room type, adjacency counts, programme by size)
and REFERENCE.md (a readable summary).
"""
import json
import math
import os
import sys
from collections import Counter, defaultdict

from highrise.plan import measure, NAMES
from highrise.refplans import PLANS


def _ms(xs):
    n = len(xs)
    if not n:
        return None
    mu = sum(xs) / n
    sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    return {"n": n, "mean": round(mu, 2), "sd": round(sd, 2), "min": round(min(xs), 2),
            "max": round(max(xs), 2)}


def stats(plans=PLANS):
    M = [measure(p) for p in plans]
    by_type = defaultdict(list)
    for m in M:
        for r in m["rooms"]:
            by_type[r["type"]].append((r, m))
    rooms = {}
    for t, rs in sorted(by_type.items()):
        rooms[t] = {
            "name": NAMES.get(t, t),
            "net": _ms([r["net"] for r, _ in rs]),
            "share": _ms([r["axis"] / m["axis_area"] for r, m in rs]),
            "aspect": _ms([r["aspect"] for r, _ in rs]),
            "short": _ms([r["short"] for r, _ in rs]),
            "band": dict(Counter(r["band"] for r, _ in rs)),
            "window_rate": round(sum(bool(r["win"]) for r, _ in rs) / len(rs), 2),
            "south_rate": round(sum("S" in r["win"] for r, _ in rs) / len(rs), 2),
        }
    # access: for each room type, which room types its links go to (door/open/slide)
    acc = defaultdict(Counter)
    for m in M:
        for a, b, k in m["links"]:
            acc[a][f"{b}:{k}"] += 1
            acc[b][f"{a}:{k}"] += 1
    plan_level = {k: _ms([m[k] for m in M if m.get(k) is not None]) for k in
                  ("gfa", "axis_area", "net_area", "efficiency", "frontage_m", "depth_m",
                   "south_rooms", "circulation_share", "bedrooms", "baths")}
    rates = {k: round(sum(bool(m[k]) for m in M) / len(M), 2) for k in
             ("through_strict", "through_loose", "kitchen_window", "master_ensuite",
              "living_south", "master_south", "reachable")}
    programme = [{"id": m["id"], "gfa": m["gfa"], "layout": m["layout"], "bedrooms": m["bedrooms"],
                  "studies": m["studies"], "baths": m["baths"],
                  "types": dict(Counter(r["type"] for r in m["rooms"]))} for m in M]
    return {"rooms": rooms, "access": {k: dict(v) for k, v in acc.items()},
            "plan": plan_level, "rates": rates, "programme": programme, "measures": M}


def report(S):
    L = ["# Reference plans: what the 12 traced plans say", "",
         "Areas in m². Axis area = dwelling area on wall centre lines; efficiency = (axis area + half the balconies) / printed",
         "gross floor area (GFA). Through ventilation: via the open living-dining space, or only via a kitchen slider.", "",
         "| Plan | GFA | Layout | Axis area | Efficiency | Frontage × depth (m) | South rooms | Through ventilation | Kitchen window | Master suite | Circulation |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    for m in S["measures"]:
        L.append(f"| {m['id']} | {m['gfa']} | {m['layout']} | {m['axis_area']} | {m.get('efficiency')} | "
                 f"{m['frontage_m']} × {m['depth_m']} | {m['south_rooms']} | "
                 f"{'yes' if m['through_strict'] else ('via kitchen' if m['through_loose'] else 'no')} | "
                 f"{'yes' if m['kitchen_window'] else 'no'} | {'yes' if m['master_ensuite'] else 'no'} | "
                 f"{m['circulation_share']:.0%} |")
    L += ["", "## Room priors (usable area, net of a 200 mm wall)", "",
          "| Type | n | Net m² mean ± sd (min–max) | Aspect mean ± sd | Short side min (m) | Band N/M/S | Window | South |",
          "|---|---|---|---|---|---|---|---|"]
    for t, r in S["rooms"].items():
        n, a = r["net"], r["aspect"]
        b = r["band"]
        L.append(f"| {t} {r['name']} | {n['n']} | {n['mean']} ± {n['sd']} ({n['min']}–{n['max']}) | "
                 f"{a['mean']} ± {a['sd']} | {r['short']['min']} | {b.get('N',0)}/{b.get('M',0)}/{b.get('S',0)} | "
                 f"{r['window_rate']:.0%} | {r['south_rate']:.0%} |")
    L += ["", "## Plan-level rates", ""]
    for k, v in S["rates"].items():
        L.append(f"- {k.replace('_', ' ')}: {v:.0%}")
    L += ["", "## Who opens off whom (link counts)", ""]
    for t in ("BRM", "BR", "ST", "BAM", "BA", "KT", "DR", "EN", "HL", "CL"):
        if t in S["access"]:
            L.append(f"- **{t}**: " + ", ".join(f"{k} ×{v}" for k, v in
                                                 sorted(S["access"][t].items(), key=lambda kv: -kv[1])))
    return "\n".join(L) + "\n"


def main(outdir="reference"):
    S = stats()
    os.makedirs(outdir, exist_ok=True)
    slim = {k: v for k, v in S.items() if k != "measures"}
    slim["plans"] = [{k: v for k, v in m.items() if k not in ("rooms",)} for m in S["measures"]]
    with open(os.path.join(outdir, "reference_stats.json"), "w") as f:
        json.dump(slim, f, ensure_ascii=False, indent=1)
    with open(os.path.join(outdir, "REFERENCE.md"), "w") as f:
        f.write(report(S))
    print("wrote", outdir)


if __name__ == "__main__":
    main(*sys.argv[1:])


_ASPECT = None


def aspect_model():
    """Room aspect ratios of the Chinese reference plans, per type -> {type: (mean, log-sd, hard limit)}.

    Merrell 2010 §5.2 C_d: each room's aspect is scored by its log-likelihood under the distribution the program model
    gives; here that distribution comes from the reference plans (refs/). The hard limit is the largest aspect seen
    for the type plus 10 % (living room 1.38 -> 1.52, master bedroom 1.5 -> 1.65), so no plan draws a room out further
    than a real one does (Leon, 2026-11-11: do not elongate the designs)."""
    global _ASPECT
    if _ASPECT is None:
        R = stats()["rooms"]
        _ASPECT = {}
        for t, v in R.items():
            a = v["aspect"]
            _ASPECT[t] = (a["mean"], max(0.12, a["sd"] / a["mean"]), round(max(1.3, a["max"] * 1.1), 2))
    return _ASPECT
