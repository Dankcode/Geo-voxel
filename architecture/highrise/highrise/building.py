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

from highrise import codes, facade, houseplan, lattice, sun
from highrise.compile import compile_unit, corridor_plate, floor_plate
from highrise.core import build_core, lifts_in_unit_frame
from highrise.planner import Unit, area_targets, optimise, sample_programme
from highrise.score import score_plan

# Stage 3 search: "lattice" = the house planner's label grid, wall slides and swaps (lattice.py); "banded" = the
# earlier banded slicing layout (planner.optimise). Both use planner.cost and the same gate.
SEARCH = os.environ.get("HR_SEARCH", "lattice")
ROOMS = os.environ.get("HR_ROOMS", "houses")      # rooms of a 4/6-flat floor's flats: "houses" or "lattice"
OPTIMISE = lattice.optimise if SEARCH == "lattice" else optimise
DROP_ORDER = ["NA", "SR", "CL", "ST"]   # optional rooms, lowest priority first; then a 4th bedroom
PERSONS_PER_DWELLING = 3.2


def plan_dwelling(cfg, priors, req, core, restarts=12, iters=8000, log=print, U=None, tag="", beds=None):
    """Programme -> Metropolis restarts -> gate; repair the programme if fewer than half the restarts pass.
    U: the dwelling's domain (default: one of the two flats either side of the core); beds: the bedroom count for this
    flat (default: cfg's, else sampled from its size)."""
    rng = random.Random(cfg["seed"])
    compact = U is not None                                     # a flat of a 4- or 6-flat floor: sized by its domain
    beds_set = beds if beds is not None else cfg.get("bedrooms")
    if compact:
        prog = sample_programme(cfg["gfa"], rng, priors, beds_set, cfg.get("bathrooms"), compact=U.area() / 1e6)
    else:
        prog = sample_programme(cfg["gfa"], rng, priors, beds_set, cfg.get("bathrooms"))
    if U is None:
        wn, dc = core["width"] // 2, core["depth"]
        A = cfg["gfa"] * 0.96 - core["area_m2"] / 2 - 3.5          # dwelling axis-area budget, m2
        D = cfg["depth"]
        X = int(round((A * 1e6 + wn * dc) / D / 100)) * 100
        U = Unit(X, D, wn, dc, core["lobby_y"], lifts=lifts_in_unit_frame(core))
    floor = {"requirements": req, "core": core}
    repairs, best = [], None
    while True:
        targets, _ = area_targets(prog, U.area(), priors)
        beds = sum(t in ("BRM", "BR", "ST") for _, t in prog)
        want_south = 3 if beds >= 3 else 2
        if not U.north:
            want_south = beds + 1                                      # a flat with one facade faces south entirely
        elif compact:
            want_south = 1                                             # the end flat: living room south, the rest east/north
        runs = []
        packed = None
        if compact and getattr(U, "rect", None):
            # 2026-11-11: a flat module's rooms are packed as rectangles by a slicing tree (modular.pack)
            from highrise import modular
            packed = modular.pack(prog, U, targets, want_south, keep=restarts)
        for k in range(restarts):
            seed_k = f"{cfg['id']}:{len(repairs)}:{k}{tag}"
            if packed is not None:
                if k >= len(packed):
                    break
                st, c = packed[k]
            elif compact and ROOMS == "houses":
                # 2026-11-06: a flat of a 4- or 6-flat floor is planned by the houses' room planner (houseplan.py)
                st, c, _ = houseplan.plan(prog, U, targets, seed_k, want_south=want_south)
            else:
                st, c = OPTIMISE(prog, U, targets, want_south, seed_k, iters=iters)
            plan = compile_unit(st, U, prog, targets, want_south, core, f"{cfg['id']}{tag}#r{k}", cfg["gfa"], req)
            sc = score_plan(plan, priors, floor)
            clean = plan["planner"]["Ca"] == 0 and all(v == 1 for k2, v in sc["checks"].items() if k2.startswith("G"))
            runs.append({"k": k, "cost": c, "Ca": plan["planner"]["Ca"], "score": sc["score"], "clean": clean, "plan": plan, "sc": sc})
        gated = [r for r in runs if r["clean"] and r["score"] >= 8]
        drop = next((rid for t in DROP_ORDER for rid, tt in prog if tt == t), None)
        # a 4th bedroom that does not fit; in a flat with no north facade a 3rd one as well (its daylit rooms all
        # share the south face) - never when the bedroom count was set by hand
        if drop is None and sum(t == "BR" for _, t in prog) >= (1 if compact else 3 if U.north else 2) and not beds_set:
            drop = [rid for rid, t in prog if t == "BR"][-1]
        if drop is None and compact and not beds_set and any(t == "BRM" for _, t in prog):
            drop = next(rid for rid, t in prog if t == "BRM")          # last resort: a studio
        log(f"  {cfg['id']}{tag}: programme {[t for _, t in prog]} -> {len(gated)}/{restarts} restarts pass")
        if best is None or len(gated) > len(best[2]):
            best = (prog, runs, gated, list(repairs))
        # a compact flat keeps its rooms while any restart passes (its size already set the programme)
        if len(gated) >= restarts / 2 or (compact and gated) or drop is None:
            break
        repairs.append({"dropped": drop, "gate_pass_before": f"{len(gated)}/{restarts}"})
        prog = [(rid, t) for rid, t in prog if rid != drop]
        if compact and sum(t in ("BRM", "BR") for _, t in prog) < 2:
            prog = [(rid, t) for rid, t in prog if t != "HL"]          # one bedroom: it opens off the living room
    if len(gated) < len(best[2]):                               # a repair that passed fewer restarts is undone
        prog, runs, gated, repairs = best
    pick = min(gated or runs, key=lambda r: (-r["score"], r["cost"]))
    return {"prog": prog, "U": U, "runs": runs, "pick": pick, "gate_pass": len(gated), "restarts": restarts, "repairs": repairs}


CORRIDOR_STUB = 1500     # the lobby corridor's length past the core per side when 2 flats a side share it
DOOR_SPAN = 1500         # corridor wall a flat door needs (1.0 m clear leaf + frame, GB 50096 5.8.7)
# south frontage each kind of flat needs for every daylit room to have its window (GB 50096 7.1.1, GB 55038 6.2.2) and
# one of them to face south (G4): a studio's living room and kitchen side by side; the end flat's living room
STUDIO_FRONT_CORE = 6300     # the flat south of the core: kitchen 2.4 under the lifts (a studio's living room is its
                             # bedroom, which may not adjoin a lift shaft, GB 55038 4.2.3), living room 3.9 beside it
STUDIO_FRONT_CORE_MIN = 6000 # 4 a floor: the least the search still solves (6.2 m in the 120 m2 footprint)
STUDIO_FRONT = 5400          # a middle studio: living 3.3 + kitchen 2.1
END_FRONT = 3600             # the end flat: living room 3.6 on the south, bedrooms and kitchen on the east and north


def two_flat_width(cfg, core):
    """Half-length of the 2-flats-a-floor slab for this flat size and depth (planner's U.X): the envelope that 4 and 6
    flats a floor now share."""
    wn, dc = core["width"] // 2, core["depth"]
    A = cfg["gfa"] * 0.96 - core["area_m2"] / 2 - 3.5
    return int(round((A * 1e6 + wn * dc) / cfg["depth"] / 100)) * 100


def corridor_layout(cfg, core, k):
    """East half of a compact floor of 2k flats (k = 2 or 3) in the footprint of the 2-flats-a-floor slab of the same
    flat size and depth (2026-11-06: no longer stretched along the facade). Core frame: x >= 0 east, y south.

        lobby corridor  the lift lobby's band carried a short way past the core (x wn..xs, y ly0..ly1), behind a held-open
                        Class B fire door (GB 50016 5.5.27: at most 3 flat doors on the fire lobby itself); every flat
                        door opens off it, so the longest walk to a stair is ~4-6 m (10 m limit, GB 50016 5.5.26/5.5.28)
        flat 1          south of the core and the corridor: a studio on the south facade (kitchen under the core's
                        lifts, living room beside it); door on the corridor's south wall
        flat 2 (k = 3)  a second south-facing studio east of flat 1; door on the corridor's south wall
        end flat        the north strip behind the core and corridor, the lobby band past the corridor and the east end
                        down to the south facade: north, east and south facades (living room south, bedrooms east and
                        north, kitchen north); door at the corridor's end
    The half-length is the 2-flat slab's; with 6 flats it is widened only as far as three south-facing flats need
    (returned in env). Returns ([(tag, Unit, beds)], corridor rects, env)."""
    wn, dc, (ly0, ly1) = core["width"] // 2, core["depth"], core["lobby_y"]
    D = cfg["depth"]
    r100 = lambda v: int(round(v / 100)) * 100
    X2 = two_flat_width(cfg, core)
    need = (STUDIO_FRONT_CORE + STUDIO_FRONT if k == 3 else STUDIO_FRONT_CORE_MIN) + END_FRONT
    Xh = max(X2, need)
    lifts = lifts_in_unit_frame(core)
    if k == 2:
        xs = wn + CORRIDOR_STUB
        # flat 1 as large as the end flat's living-room frontage allows, at most an even split of the half floor
        tot = (Xh - wn) * D + wn * (D - dc) - (xs - wn) * (ly1 - ly0)
        even = wn + (tot / 2 - wn * (D - dc)) / (D - ly1)
        x1 = r100(max(STUDIO_FRONT_CORE_MIN, min(even, Xh - END_FRONT)))
        xe = x1
        f1 = Unit(x1, D, wn, dc, (ly0, ly1), end_unit=False, lifts=lifts, x0=0,
                  cuts=[(0, 0, wn, dc), (wn, 0, x1, ly1)], door=("h", ly1, wn, xs), north=False)
        flats = [("1", f1, 0)]
    else:
        x1 = STUDIO_FRONT_CORE
        xs = x1 + DOOR_SPAN
        x2 = r100(max(x1 + STUDIO_FRONT, x1 + (Xh - END_FRONT - x1) / 2 + 600))
        x2 = min(x2, Xh - END_FRONT)
        xe = x2
        f1 = Unit(x1, D, wn, dc, (ly0, ly1), end_unit=False, lifts=lifts, x0=0,
                  cuts=[(0, 0, wn, dc), (wn, 0, x1, ly1)], door=("h", ly1, wn, x1), north=False)
        f2 = Unit(x2, D, wn, 0, (ly0, ly1), end_unit=False, lifts=(), x0=x1, cuts=[(x1, 0, x2, ly1)],
                  door=("h", ly1, x1, xs), north=False)
        flats = [("1", f1, 0), ("2", f2, 0)]
    fe = Unit(Xh, D, wn, 0, (ly0, ly1), end_unit=True, lifts=(), x0=wn,
              cuts=[(wn, ly0, xs, ly1), (wn, ly1, xe, D)], door=("v", xs, ly0, ly1))
    flats.append(("", fe, None))
    for _, u, _ in flats:
        u.compact = True                                         # zoning: only the living room needs the south front
    corridor = [[wn, ly0, xs, ly1]]
    env = {"half_length_mm": Xh, "two_flat_half_length_mm": X2, "length_m": round(2 * Xh / 1000, 1),
           "depth_m": round(D / 1000, 1), "widened": Xh > X2}
    return flats, corridor, env


def travel_m(fp, core):
    """Longest walk from a flat door to the nearest stair entrance (via the corridor's fire door when there is one)."""
    ly0, ly1 = core["lobby_y"]; wn = core["width"] / 2
    best = 0.0
    for d in fp["doors"]:
        if d.get("role") != "unit":
            continue
        m = (d["from"] + d["to"]) / 2
        p = (d["at"], m) if d["orient"] == "v" else (m, d["at"])
        legs = []
        if fp.get("corridor"):
            fd = (wn if p[0] > 0 else -wn, (ly0 + ly1) / 2)          # the corridor's fire door into the lobby
            legs.append(abs(p[0] - fd[0]) + abs(p[1] - fd[1])); p = fd
        best = max(best, sum(legs) + min(abs(p[0] - sx) + abs(p[1] - sy) for sx, sy in core["stair_doors"]))
    return round(best / 1000, 1)


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
    nd = max(2, min(6, int(cfg.get("dwellings", 2)) // 2 * 2))
    k = nd // 2
    req = codes.core_requirements(cfg["storeys"], cfg.get("storey_h", 3.0), nd, pilotis=pilotis)
    core = build_core(req)
    others, env = [], None
    ground_fn, roof_fn = ground_floor, roof
    if k == 1:
        dw = plan_dwelling(cfg, priors, req, core, restarts, iters, log)
        plan = dw["pick"]["plan"]
        fp = floor_plate(plan, core)
    else:
        if os.environ.get("HR_FLOOR", "modular") in ("search", "modular"):
            # 2026-11-06: the whole floor in one search, as the houses are planned (floorplan.py): the core moves along
            # the north facade, the corridor and the flats grow around it; the lifts open onto the corridor and only
            # the stair's fire lobby has a door
            from highrise import floorplan
            X2 = two_flat_width(cfg, core)
            need = (STUDIO_FRONT_CORE + STUDIO_FRONT if k == 3 else STUDIO_FRONT_CORE_MIN) + END_FRONT
            Xh = max(X2, need)
            if os.environ.get("HR_FLOOR", "modular") == "modular":
                # 2026-11-11: flat modules assembled round the core; the slab's length and depth follow the modules
                from highrise import modular
                fl_, finfo_, Xh, D_ = modular.floor(cfg, req, 2 * X2 * cfg["depth"] / 1e6, log=log)
                cfg = dict(cfg, depth=D_)
                layouts = [(fl_, finfo_)]
            else:
                layouts = floorplan.plan_floor(cfg, req, Xh, nd, restarts=cfg.get("floor_restarts", 4),
                                               iters=cfg.get("floor_iters", 14000), log=log, all_runs=True)
            # the best floor whose every flat can be planned to pass the gate (else the one with fewest that cannot)
            tried = []
            for li, (fl, finfo) in enumerate(layouts[:3]):
                res = {f["tag"]: plan_dwelling(cfg, priors, req, fl["core"], restarts, iters, log, U=f["U"],
                                               tag=f":flat{f['tag']}", beds=f["beds"]) for f in fl["flats"]}
                fails = sum(r_["gate_pass"] == 0 for r_ in res.values())
                fp_ = floorplan.plate([(f["tag"], res[f["tag"]]["pick"]["plan"], f["mirror"]) for f in fl["flats"]],
                                      fl["core"], fl["corridor"], req["stair_type"] != "open")
                walk_ = floorplan.travel(fp_, fl["core"], fl)
                fails += walk_ > req.get("max_travel_m", 10)           # the walk to the stair, measured at the doors
                tried.append((fails, li, fl, finfo, res))
                log(f"  floor layout {li}: {fails} problem(s) (flats without a passing plan, walk {walk_} m)")
                if not fails:
                    break
            fails, li, fl, finfo, res = min(tried, key=lambda t: (t[0], t[1]))
            finfo = dict(finfo, layout_rank=li, flats_failing=fails)
            core = fl["core"]
            main = max(fl["flats"], key=lambda f: f["area"])["tag"]
            dw = res[main]
            plan = dw["pick"]["plan"]
            fp = floorplan.plate([(f["tag"], res[f["tag"]]["pick"]["plan"], f["mirror"]) for f in fl["flats"]], core,
                                 fl["corridor"], req["stair_type"] != "open")
            others = [(f"Flat {f['tag']}", res[f["tag"]]) for f in fl["flats"] if f["tag"] != main]
            core = dict(core, max_travel_m=floorplan.travel(fp, core, fl))
            env = {"half_length_mm": Xh, "two_flat_half_length_mm": X2, "length_m": round(2 * Xh / 1000, 1),
                   "depth_m": round(cfg["depth"] / 1000, 1), "widened": Xh > X2, "floor_search": finfo,
                   "core_x": [core["x0"], core["x1"]], "main_flat": main,
                   "flats": [{"tag": f["tag"], "area_m2": f["area"], "mirrored": f["mirror"]} for f in fl["flats"]]}
            ground_fn = lambda plan, core, fp: floorplan.ground(fp, core, cfg["depth"])
            roof_fn = floorplan.roof
        else:
            # 4 or 6 flats a floor around the fixed centred core: every flat door on one lobby corridor from the lifts
            flats, corridor, env = corridor_layout(cfg, core, k)
            res = {tag: plan_dwelling(cfg, priors, req, core, restarts, iters, log, U=U, tag=f":flat{tag or 'end'}", beds=beds)
                   for tag, U, beds in flats}
            dw = res[""]
            plan = dw["pick"]["plan"]
            fp = corridor_plate([(tag, res[tag]["pick"]["plan"]) for tag, _, _ in flats], core, corridor)
            wn, (ly0, ly1) = core["width"] / 2, core["lobby_y"]
            for x, sw in ((wn, 1), (-wn, -1)):                       # the corridor's fire doors (held open, Class B)
                fp["doors"].append({"a": "core.lobby", "b": "core.corridor", "orient": "v", "at": x, "from": (ly0 + ly1) / 2 - 750,
                                    "to": (ly0 + ly1) / 2 + 750, "kind": "door", "role": "corridor", "swing": sw, "fire": "B"})
            names = {"1": "Flat south of the core", "2": "Middle flat"}
            others = [(names[tag], res[tag]) for tag, _, _ in flats if tag]
            core = dict(core, max_travel_m=travel_m(fp, core))
    h, g = req["storey_h"], req["ground_offset"]
    floors = []
    for n in range(1, cfg["storeys"] + 1):
        kind = "pilotis" if (n == 1 and pilotis) else ("refuge" if n in req["refuge_floors"] else "typical")
        floors.append({"storey": n, "level_m": round(g + (n - 1) * h, 2), "kind": kind})
    dwellings = sum(nd for f in floors if f["kind"] == "typical")
    # sunlight at the lowest dwelling's living-room window, next row of equal slabs to the south
    site = cfg.get("site", {"lat": 39.9, "name": "Beijing", "required_h": 2.0, "day": "major_cold"})
    rf = roof_fn(core)
    # the block to the south as built: slab, parapet, stair and lift towers (they were left out before; on the
    # 10-storey block the parapet alone cut the hours from 3.1 to 1.7 at the old spacing)
    sk = facade.sun_study({"floor_plate": fp, "floors": floors, "requirements": req, "roof": rf},
                          facade.STYLES["plain"], site, cfg.get("row_spacing"))
    hours, spacing, need_L = sk["hours"], sk["row_spacing_m"], sk["min_spacing_m"]
    sunrec = {"site": site["name"], "lat": site["lat"], "day": "Major Cold day (Jan 20)" if site["day"] == "major_cold" else "winter solstice",
              "required": site["required_h"], "hours": round(hours, 2), "row_spacing_m": spacing, "min_spacing_m": need_L,
              "spacing_ratio": round(spacing / req["height_m"], 2),
              "window": "lowest dwelling, each flat's best sunny window (south face or gable)",
              "per_flat": sk.get("per_flat"), "faces": sk.get("faces"),
              "obstruction": "next row of equal slabs incl. parapet and roof towers, 13 m gaps; the same row's slabs 13 m off each end"}
    floor_info = {"requirements": req, "core": core, "refuge_floors_built": [f["storey"] for f in floors if f["kind"] == "refuge"], "sun": sunrec}
    sc = score_plan(plan, priors, floor_info)
    other_scores = [{"name": nm, "score": score_plan(r["pick"]["plan"], priors, floor_info), "gate_pass": r["gate_pass"],
                     "restarts": r["restarts"], "repairs": r["repairs"], "programme": r["prog"], "plan": r["pick"]["plan"]}
                    for nm, r in others]
    return {"cfg": dict(cfg, dwellings=nd), "requirements": req, "core": core, "dwelling": dw, "plan": plan, "floor_plate": fp,
            "ground": ground_fn(plan, core, fp) if pilotis else None, "roof": rf, "floors": floors,
            "dwellings": dwellings, "dwellings_per_floor": nd, "residents_est": round(dwellings * PERSONS_PER_DWELLING), "sun": sunrec,
            "score": sc, "other_flats": other_scores, "envelope": env}
