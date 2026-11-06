"""A whole high-rise slab: dwelling plan, core, ground floor, typical floors, refuge floors and roof.

    storey 1      ground floor: open pilotis (common in new Chinese housing) with an enclosed entrance hall that
                  wraps the core: barrier-free entrance (door >= 1.10 m clear, 1:12 ramp, GB 55038 4.2.7), mailboxes,
                  the stair's direct exit to the outside (fire discharge)
    storeys 2..N  the typical floor: two mirrored dwellings + core (or ground floor dwellings when pilotis=False)
    refuge floors above 100 m (GB 50016 5.5.31): dwellings replaced by a refuge area at 5 persons/m2
    roof          roof slab, 1.20 m parapet (GB 55038 4.2.8), stair head room (the stair reaches the roof), lift
                  machine room over the lift shafts
Heights: storey h (>= 3.00 m), ground floor + 0.30 m above grade; building height = 0.30 + N * h to the roof
surface (GB 50016 Appendix A.0.1).
"""
import os
import random

from highrise import codes, facade, lattice, sun
from highrise.compile import compile_unit, floor_plate
from highrise.core import build_core, lifts_in_unit_frame
from highrise.planner import Unit, area_targets, optimise, sample_programme
from highrise.score import score_plan

# Stage 3 search: "lattice" = the house planner's label grid, wall slides and swaps (lattice.py); "banded" = the
# earlier banded slicing layout (planner.optimise). Both use planner.cost and the same gate.
SEARCH = os.environ.get("HR_SEARCH", "lattice")
OPTIMISE = lattice.optimise if SEARCH == "lattice" else optimise
DROP_ORDER = ["NA", "SR", "CL", "ST"]   # optional rooms, lowest priority first; then a 4th bedroom
PERSONS_PER_DWELLING = 3.2


def plan_dwelling(cfg, priors, req, core, restarts=12, iters=8000, log=print):
    """Programme -> Metropolis restarts -> gate; repair the programme if fewer than half the restarts pass."""
    rng = random.Random(cfg["seed"])
    prog = sample_programme(cfg["gfa"], rng, priors)
    wn, dc = core["width"] // 2, core["depth"]
    A = cfg["gfa"] * 0.96 - core["area_m2"] / 2 - 3.5          # dwelling axis-area budget, m2
    D = cfg["depth"]
    X = int(round((A * 1e6 + wn * dc) / D / 100)) * 100
    U = Unit(X, D, wn, dc, core["lobby_y"], lifts=lifts_in_unit_frame(core))
    floor = {"requirements": req, "core": core}
    repairs = []
    while True:
        targets, _ = area_targets(prog, X * D - wn * dc, priors)
        beds = sum(t in ("BRM", "BR", "ST") for _, t in prog)
        want_south = 3 if beds >= 3 else 2
        runs = []
        for k in range(restarts):
            st, c = OPTIMISE(prog, U, targets, want_south, f"{cfg['id']}:{len(repairs)}:{k}", iters=iters)
            plan = compile_unit(st, U, prog, targets, want_south, core, f"{cfg['id']}#r{k}", cfg["gfa"], req)
            sc = score_plan(plan, priors, floor)
            clean = plan["planner"]["Ca"] == 0 and all(v == 1 for k2, v in sc["checks"].items() if k2.startswith("G"))
            runs.append({"k": k, "cost": c, "Ca": plan["planner"]["Ca"], "score": sc["score"], "clean": clean, "plan": plan, "sc": sc})
        gated = [r for r in runs if r["clean"] and r["score"] >= 8]
        drop = next((rid for t in DROP_ORDER for rid, tt in prog if tt == t), None)
        if drop is None and sum(t == "BR" for _, t in prog) >= 3:     # a 4th bedroom that does not fit
            drop = [rid for rid, t in prog if t == "BR"][-1]
        log(f"  {cfg['id']}: programme {[t for _, t in prog]} -> {len(gated)}/{restarts} restarts pass")
        if len(gated) >= restarts / 2 or drop is None:
            break
        repairs.append({"dropped": drop, "gate_pass_before": f"{len(gated)}/{restarts}"})
        prog = [(rid, t) for rid, t in prog if rid != drop]
    pick = min(gated or runs, key=lambda r: (-r["score"], r["cost"]))
    return {"prog": prog, "U": U, "runs": runs, "pick": pick, "gate_pass": len(gated), "restarts": restarts, "repairs": repairs}


def ground_floor(plan, core, fp):
    """Pilotis ground floor: entrance hall around the core, columns under the dwellings' structural walls."""
    W, sd, ly1, dc = core["width"], core["lobby_y"][0], core["lobby_y"][1], core["depth"]
    x0, x1 = -W // 2, W // 2
    hall = [x0 - 3000, sd, x1 + 3000, dc + 2400]                 # wraps the lobby ends and the lift row
    mail = [x1, sd, x1 + 3000, sd + 1200]                         # mailboxes along the hall's north-east wall
    D = plan["unit"]["D"]
    door_x = (x0 + x1) / 2
    entrance = {"orient": "h", "at": hall[3], "from": door_x - 900, "to": door_x + 900, "kind": "door", "role": "entrance",
                "clear_m": 1.70}
    ramp = [door_x - 900, hall[3], door_x + 900, hall[3] + int(codes.GROUND_OFFSET / codes.RAMP_SLOPE * 1000)]
    # columns: corners of the dwellings' rooms (where shear walls meet), outside the hall
    pts = set()
    for rid, rm in fp["rooms"].items():
        if rm["type"] in ("CORE", "BL", "AC"):
            continue
        for q in rm["rects"]:
            for p in ((q[0], q[1]), (q[2], q[1]), (q[0], q[3]), (q[2], q[3])):
                if not (hall[0] - 200 <= p[0] <= hall[2] + 200 and hall[1] - 200 <= p[1] <= hall[3] + 200):
                    pts.add((round(p[0] / 100) * 100, round(p[1] / 100) * 100))
    cols = []
    for p in sorted(pts):
        if all(abs(p[0] - c[0]) > 600 or abs(p[1] - c[1]) > 600 for c in cols):
            cols.append(p)
    outline = [q for rid, rm in fp["rooms"].items() if rm["type"] not in ("CORE", "BL", "AC") for q in rm["rects"]]
    return {"hall": hall, "mail": mail, "entrance": entrance, "ramp": ramp, "columns": cols,
            "stair_exit": {"orient": "h", "at": 0, "from": x0 + 1500, "to": x0 + 2500, "kind": "door", "role": "stair exit"},
            "pilotis_extent": [min(q[0] for q in outline), 0, max(q[2] for q in outline), D]}


def roof(core):
    W, sd, ly1, dc = core["width"], core["lobby_y"][0], core["lobby_y"][1], core["depth"]
    x0 = -W // 2
    return {"stair_head": [x0, 0, x0 + W, ly1], "machine_room": [x0, ly1, x0 + W, dc], "parapet_h": codes.RAILING_H,
            "head_h": 3000,
            # roof_door: the lift machine room's door (stair head south wall); roof_exit: the door out onto the roof
            "roof_door": {"orient": "h", "at": ly1, "from": x0 + W / 2 - 500, "to": x0 + W / 2 + 500},
            "roof_exit": {"orient": "v", "at": x0 + W, "from": (sd + ly1) / 2 - 500, "to": (sd + ly1) / 2 + 500}}


def assemble(cfg, priors, restarts=12, iters=8000, log=print):
    pilotis = cfg.get("pilotis", True)
    req = codes.core_requirements(cfg["storeys"], cfg.get("storey_h", 3.0), cfg.get("units", 2), pilotis=pilotis)
    core = build_core(req)
    dw = plan_dwelling(cfg, priors, req, core, restarts, iters, log)
    plan = dw["pick"]["plan"]
    fp = floor_plate(plan, core)
    h, g = req["storey_h"], req["ground_offset"]
    floors = []
    for k in range(1, cfg["storeys"] + 1):
        kind = "pilotis" if (k == 1 and pilotis) else ("refuge" if k in req["refuge_floors"] else "typical")
        floors.append({"storey": k, "level_m": round(g + (k - 1) * h, 2), "kind": kind})
    dwellings = sum(2 for f in floors if f["kind"] == "typical")
    # sunlight at the lowest dwelling's living-room window, next row of equal slabs to the south
    site = cfg.get("site", {"lat": 39.9, "name": "Beijing", "required_h": 2.0, "day": "major_cold"})
    rf = roof(core)
    # the block to the south as built: slab, parapet, stair and lift towers (they were left out before; on the
    # 10-storey block the parapet alone cut the hours from 3.1 to 1.7 at the old spacing)
    sk = facade.sun_study({"floor_plate": fp, "floors": floors, "requirements": req, "roof": rf},
                          facade.STYLES["plain"], site, cfg.get("row_spacing"))
    hours, spacing, need_L = sk["hours"], sk["row_spacing_m"], sk["min_spacing_m"]
    sunrec = {"site": site["name"], "lat": site["lat"], "day": "Major Cold day (Jan 20)" if site["day"] == "major_cold" else "winter solstice",
              "required": site["required_h"], "hours": round(hours, 2), "row_spacing_m": spacing, "min_spacing_m": need_L,
              "spacing_ratio": round(spacing / req["height_m"], 2), "window": "lowest dwelling, living room",
              "obstruction": "next row of equal slabs incl. parapet and roof towers, 13 m gaps"}
    floor_info = {"requirements": req, "core": core, "refuge_floors_built": [f["storey"] for f in floors if f["kind"] == "refuge"], "sun": sunrec}
    sc = score_plan(plan, priors, floor_info)
    return {"cfg": cfg, "requirements": req, "core": core, "dwelling": dw, "plan": plan, "floor_plate": fp,
            "ground": ground_floor(plan, core, fp) if pilotis else None, "roof": rf, "floors": floors,
            "dwellings": dwellings, "residents_est": round(dwellings * PERSONS_PER_DWELLING), "sun": sunrec,
            "score": sc}
