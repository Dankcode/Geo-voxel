"""Generate and score high-rise slabs.

    python -m highrise.generate [outdir] [--quick]

For each design: storeys + dwelling size -> code requirements -> core -> programme -> Metropolis restarts ->
gate (C_a = 0, every code check met, score >= 8) -> building stack (pilotis ground floor, typical floors,
refuge floors, roof) -> sunlight check against the next row of slabs -> drawings + building.json.
"""
import json
import os
import sys

from highrise.analyze import stats
from highrise.building import assemble
from highrise.refplans import PLANS
from highrise.render import floor_svg, ground_svg, roof_svg, unit_svg
from highrise.score import score_plan

DESIGNS = [
    {"id": "hr10-120", "name": "10-storey slab, 1 lift, 2 dwellings per floor, 120 m²", "storeys": 10, "gfa": 120,
     "depth": 11300, "seed": 3},
    {"id": "hr17-125", "name": "17-storey slab, 2 lifts, 2 dwellings per floor, 125 m²", "storeys": 17, "gfa": 125,
     "depth": 12000, "seed": 5},
    {"id": "hr24-140", "name": "24-storey slab, 2 lifts, 2 dwellings per floor, 140 m² (test building)", "storeys": 24,
     "gfa": 140, "depth": 12200, "seed": 7},
    {"id": "hr33-125", "name": "33-storey slab, 2 lifts, 2 dwellings per floor, 125 m²", "storeys": 33, "gfa": 125,
     "depth": 12200, "seed": 11},
    {"id": "hr34-125", "name": "34-storey slab over 100 m, refuge floors, 125 m²", "storeys": 34, "gfa": 125,
     "depth": 12200, "seed": 11},
    # 2026-11-06: one core with 4 or 6 compact flats a floor in the 2-flat footprint, every door on one lobby corridor
    {"id": "hr18-120-x4", "name": "18-storey slab, one core, 4 modular dwellings per floor", "storeys": 18,
     "gfa": 120, "depth": 11400, "seed": 13, "dwellings": 4, "floor_restarts": 6, "floor_iters": 14000},
    {"id": "hr26-190-x6", "name": "26-storey slab, one core, 6 modular dwellings per floor", "storeys": 26,
     "gfa": 190, "depth": 11400, "seed": 17, "dwellings": 6, "floor_restarts": 6, "floor_iters": 16000},
]


def describe(b):
    req, core, plan, sc, m = b["requirements"], b["core"], b["plan"], b["score"], b["score"]["measure"]
    stair = ("scissor stair, 2 exits" if core["stair_kind"] == "scissor" else f"{core['stair_type']} stair, 1 exit")
    ref = f" · refuge floors at storeys {', '.join(map(str, req['refuge_floors']))}" if req["refuge_floors"] else ""
    return [
        f"{req['storeys']} storeys × {req['storey_h']:.2f} m · height {req['height_m']} m ({req['class']}) · "
        f"{core['lifts']} lift{'s' if core['lifts'] > 1 else ''}{' incl. fire lift' if core['fire_lift'] else ''} · {stair}{ref}",
        f"Dwelling {m['layout']} · GFA {plan['gfa']} m²" + ("" if b.get("other_flats") else f" (target {b['cfg']['gfa']})") + f" · usable axis area {m['axis_area']} m² · "
        f"efficiency {m.get('efficiency', 0):.1%} · {m['frontage_m']} × {m['depth_m']} m · {b.get('dwellings_per_floor', 2)} dwellings a floor"
        + (" on one lobby corridor" if b.get("dwellings_per_floor", 2) > 2 else "") + f" · {b['dwellings']} dwellings",
        f"South-facing rooms {m['south_rooms']} · through ventilation {'yes' if m['through_strict'] else ('via kitchen' if m['through_loose'] else 'no')} · "
        f"kitchen window {'yes' if m['kitchen_window'] else 'no'} · master suite {'yes' if m['master_ensuite'] else 'no'} · "
        f"circulation {m['circulation_share']:.0%}" + (f" · refuge room: {plan['refuge_room']}" if plan.get("refuge_room") else ""),
        f"Sunlight ({b['sun']['site']}, {b['sun']['day']}): {b['sun']['hours']:.1f} h at the lowest dwelling with the next row "
        f"{b['sun']['row_spacing_m']} m south (needs {b['sun']['required']} h)",
        f"Score {sc['score']} / 10 (pass 8) · G {sc['groups'].get('G')} · C {sc['groups'].get('C')} · M {sc['groups'].get('M')} · "
        f"T {sc['groups'].get('T')} · {b['dwelling']['gate_pass']}/{b['dwelling']['restarts']} restarts passed"
        + "".join(f" · {o['name'].lower()}: score {o['score']['score']}, {o['gate_pass']}/{o['restarts']} passed"
                  for o in b.get("other_flats") or [])
        + (f" · longest walk from a flat door to the stair {b['core']['max_travel_m']} m" if b.get("other_flats") else "")
        + (f" · footprint {b['envelope']['length_m']} × {b['envelope']['depth_m']} m"
           + (" (widened from the 2-flat slab's so every flat has a south room)" if b['envelope']['widened'] else " (the 2-flat slab's)")
           if b.get("envelope") else "")
        + (f" · programme repair dropped {', '.join(r['dropped'] for r in b['dwelling']['repairs'])}" if b["dwelling"]["repairs"] else ""),
    ]


def slim(b):
    """building.json: everything a builder needs, without the optimiser internals."""
    d = b["dwelling"]
    return {"id": b["cfg"]["id"], "name": b["cfg"]["name"], "config": b["cfg"], "requirements": b["requirements"],
            "core": b["core"], "plan": b["plan"], "floor_plate": b["floor_plate"], "ground": b["ground"], "roof": b["roof"],
            "floors": b["floors"], "dwellings": b["dwellings"], "residents_est": b["residents_est"], "sun": b["sun"],
            "score": b["score"], "programme": d["prog"], "programme_repairs": d["repairs"],
            "restarts": [{"k": r["k"], "cost": round(r["cost"], 2), "Ca": r["Ca"], "score": r["score"], "clean": r["clean"]} for r in d["runs"]],
            "gate_pass": d["gate_pass"], "picked": d["pick"]["k"],
            "dwellings_per_floor": b.get("dwellings_per_floor", 2), "envelope": b.get("envelope"),
            "other_flats": [{k: o[k] for k in ("name", "score", "gate_pass", "restarts", "repairs", "programme", "plan")}
                            for o in b.get("other_flats") or []]}


def write_design(b, outdir):
    """samples/<id>/: typical, ground and roof drawings (SVG + PNG) and building.json."""
    cfg = b["cfg"]
    d = os.path.join(outdir, cfg["id"])
    os.makedirs(d, exist_ok=True)
    lines = describe(b)
    sheets = {"typical": floor_svg(b["plan"], b["core"], b["floor_plate"], f"{cfg['name']} · typical floor", lines),
              "ground": ground_svg(b, f"{cfg['name']} · ground floor (storey 1)", lines[:1]),
              "roof": roof_svg(b, f"{cfg['name']} · roof", lines[:1])}
    for k, svg in sheets.items():
        with open(os.path.join(d, k + ".svg"), "w") as f:
            f.write(svg)
        os.system(f'rsvg-convert -z 1.5 "{d}/{k}.svg" -o "{d}/{k}.png" 2>/dev/null')
    with open(os.path.join(d, "building.json"), "w") as f:
        json.dump(slim(b), f, indent=1, default=lambda o: list(o) if isinstance(o, tuple) else str(o))
    return d


def one(design, storeys=None, dwellings=None, gfa=None, bedrooms=None, bathrooms=None, seed=None, style=None,
        outdir=None, restarts=12, iters=8000, log=print):
    """Regenerate one design with the counts set in the viewer (run_request.py --highrise): plan, check, model it in
    FreeCAD (IFC4 + viewer mesh) and, with style, its facade variant. Returns the new building's id.
    design: an id from DESIGNS or of any building under buildings/ (a regenerated one too)."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = outdir or os.path.join(here, "samples")
    base = next((dict(c) for c in DESIGNS if c["id"] == design), None)
    if base is None:
        bj = os.path.join(here, "buildings", design, "building.json")
        B = json.load(open(bj))
        base = dict(B.get("config") or {}, id=B.get("style_of") or B["id"])
    cfg = dict(base)
    if storeys: cfg["storeys"] = max(7, min(40, int(storeys)))
    if dwellings: cfg["dwellings"] = max(2, min(6, int(dwellings) // 2 * 2))
    if gfa: cfg["gfa"] = max(60, min(200, int(gfa)))
    if bedrooms: cfg["bedrooms"] = int(bedrooms)
    if bathrooms: cfg["bathrooms"] = int(bathrooms)
    if seed: cfg["seed"] = int(seed)
    dflt = {"dwellings": 2}
    same = all(cfg.get(k, dflt.get(k)) == base.get(k, dflt.get(k)) for k in ("storeys", "dwellings", "gfa", "bedrooms", "bathrooms", "seed"))
    root = base["id"].split(".r")[0]
    cfg["id"] = base["id"] if same else (f"hr{cfg['storeys']}-{cfg['gfa']}-x{cfg.get('dwellings', 2)}"
                                         + (f"-b{cfg['bedrooms']}" if cfg.get("bedrooms") else "")
                                         + (f"-s{cfg['seed']}" if seed else ""))
    nd = cfg.get("dwellings", 2)
    cfg["name"] = (f"{cfg['storeys']}-storey slab, {nd} dwellings per floor"
                   + (f" on one lobby corridor in the {cfg['gfa']} m² 2-flat footprint" if nd > 2 else f", {cfg['gfa']} m²")
                   + "" + (f", {cfg['bedrooms']} bedrooms" if cfg.get("bedrooms") else "")
                   + ("" if cfg["id"] == base["id"] else f" (regenerated from {root})"))
    S = stats()
    b = assemble(cfg, S["rooms"], restarts=restarts, iters=iters, log=log)
    write_design(b, outdir)
    from highrise import bim
    bdir = os.path.join(here, "buildings", cfg["id"])
    os.makedirs(bdir, exist_ok=True)
    B = json.load(open(os.path.join(outdir, cfg["id"], "building.json")))
    json.dump(B, open(os.path.join(bdir, "building.json"), "w"), separators=(",", ":"))
    rep = bim.build(B, bdir, ifc=True)
    log(f"{cfg['id']}: score {b['score']['score']}, gate {b['dwelling']['gate_pass']}/{b['dwelling']['restarts']}, "
        f"{rep.get('triangles')} triangles")
    if style and style != "plain":
        from highrise.facade import STYLES
        sid = f"{cfg['id']}-{style.replace('_', '-')}"
        Bs = dict(B, id=sid, name=f"{B['name']} · {STYLES[style]['name']} facade", style=style, style_of=cfg["id"])
        sdir = os.path.join(here, "buildings", sid)
        os.makedirs(sdir, exist_ok=True)
        rs = bim.build(Bs, sdir, ifc=True, style=style)
        Bs["facade_checks"] = rs["facade_checks"]
        json.dump(Bs, open(os.path.join(sdir, "building.json"), "w"), separators=(",", ":"))
        return sid
    return cfg["id"]


def main(outdir="samples", quick=False):
    S = stats()
    priors = S["rooms"]
    os.makedirs(outdir, exist_ok=True)
    summary = []
    refdir = os.path.join(outdir, "reference-svg")
    os.makedirs(refdir, exist_ok=True)
    for p in PLANS:
        sc = score_plan(p, priors)
        with open(os.path.join(refdir, p["id"] + ".svg"), "w") as f:
            f.write(unit_svg(p, f'{p["project"]} · {p["name"]} · {p["gfa"]} m² (traced, rooms only)',
                             [f'score {sc["score"]} · {sc["measure"]["layout"]} · efficiency {sc["measure"].get("efficiency")}']))
        summary.append({"id": p["id"], "kind": "reference", "score": sc["score"], "groups": sc["groups"],
                        "layout": sc["measure"]["layout"], "gfa": p["gfa"]})
    for cfg in DESIGNS:
        b = assemble(cfg, priors, restarts=4 if quick else 12, iters=4000 if quick else 8000)
        write_design(b, outdir)
        sc = b["score"]
        summary.append({"id": cfg["id"], "kind": "generated", "name": cfg["name"], "score": sc["score"], "groups": sc["groups"],
                        "layout": sc["measure"]["layout"], "gfa": b["plan"]["gfa"], "height_m": b["requirements"]["height_m"],
                        "gate_pass": f"{b['dwelling']['gate_pass']}/{b['dwelling']['restarts']}",
                        "repairs": [r["dropped"] for r in b["dwelling"]["repairs"]], "sun_h": b["sun"]["hours"],
                        "row_spacing_m": b["sun"]["row_spacing_m"],
                        "below_1": {k: v for k, v in sc["checks"].items() if v < 1}})
        print(cfg["id"], sc["score"], sc["groups"], sc["measure"]["layout"], b["plan"]["gfa"],
              f"gate {b['dwelling']['gate_pass']}/{b['dwelling']['restarts']}", flush=True)
    with open(os.path.join(outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(*args, quick="--quick" in sys.argv)
