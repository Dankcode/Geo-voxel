"""Checks for the high-rise module.   python test_highrise.py   (from architecture/highrise)"""
import os
import random

from highrise import codes, facade, sun
from highrise.analyze import stats
from highrise.building import assemble
from highrise.core import build_core, lifts_in_unit_frame
from highrise.plan import measure
from highrise.planner import Unit, area_targets, optimise, sample_programme
from highrise.refplans import PLANS
from highrise.score import score_plan
from highrise.walls import floor_walls

S = stats()
P = S["rooms"]
HERE = os.path.dirname(os.path.abspath(__file__))


def test_reference_tracing_is_consistent():
    for p in PLANS:
        m = measure(p)
        assert m["reachable"], p["id"]
        assert not m["infeasible_links"], (p["id"], m["infeasible_links"])
        assert 0.70 < m["efficiency"] < 0.92, (p["id"], m["efficiency"])


def test_references_pass_the_scorecard():
    for p in PLANS:
        assert score_plan(p, P)["score"] >= 8.0, p["id"]


def test_reference_lift_rule_flags_the_2017_plan():
    # Lingxiu E1 (2017) has a child's bedroom against the lift: allowed then, not under GB 55038 4.2.3
    m = measure(next(p for p in PLANS if p["id"] == "lx-E1"))
    assert m["bed_next_to_lift"] == ["ch"]


def test_height_includes_ground_offset():
    assert codes.building_height(11) == 33.3          # 11 storeys at 3.0 m cross the 33 m fire-lift line
    r10, r11 = codes.core_requirements(10), codes.core_requirements(11)
    assert not r10["fire_lift"] and r10["stair_type"] == "enclosed"
    assert r11["fire_lift"] and r11["stair_type"] == "smoke-proof"
    assert codes.core_requirements(17)["exits_per_floor"] == 1    # 51.3 m
    assert codes.core_requirements(18)["exits_per_floor"] == 2    # 54.3 m > 54 m


def test_core_rules_follow_height():
    r24 = codes.core_requirements(24, pilotis=True)
    assert (r24["lifts"], r24["fire_lift"], r24["exits_per_floor"], r24["refuge_room_per_dwelling"]) == (2, True, 2, True)
    c = build_core(r24)
    assert c["stair_kind"] == "scissor" and c["exits"] == 2
    assert c["lobby_m2"] >= 12 and c["lobby_short"] >= 2.4 and c["max_travel_m"] <= 10
    # lifts centred: what the east dwelling sees is the same for the mirrored west dwelling
    assert lifts_in_unit_frame(c) == [(0, 5200, 2400, 7700), (0, 5200, 2400, 7700)][:len(lifts_in_unit_frame(c))]


def test_refuge_floors_above_100m():
    assert codes.core_requirements(33)["refuge_floors"] == []     # 99.3 m
    assert codes.core_requirements(34)["refuge_floors"] == [17, 33]


def test_sun_hours_monotone_in_spacing():
    a = sun.sun_hours(39.9, (5, 4.2), sun.row_boxes(40, 30, 13, 72.3))
    b = sun.sun_hours(39.9, (5, 4.2), sun.row_boxes(80, 30, 13, 72.3))
    assert b >= a


def test_planner_is_deterministic():
    req = codes.core_requirements(10, pilotis=True); core = build_core(req)
    prog = sample_programme(120, random.Random(3), P)
    wn, dc = core["width"] // 2, core["depth"]
    U = Unit(10200, 11300, wn, dc, core["lobby_y"], lifts=lifts_in_unit_frame(core))
    tg, _ = area_targets(prog, U.X * U.D - wn * dc, P)
    a = optimise(prog, U, tg, 3, "t:0", iters=2000)
    b = optimise(prog, U, tg, 3, "t:0", iters=2000)
    assert a[0] == b[0] and a[1] == b[1]


def test_lattice_search_is_deterministic_and_tiles_the_dwelling():
    from highrise import lattice
    from scipy import ndimage
    import numpy as np
    req = codes.core_requirements(10, pilotis=True); core = build_core(req)
    prog = sample_programme(120, random.Random(3), P)
    wn, dc = core["width"] // 2, core["depth"]
    U = Unit(10200, 11300, wn, dc, core["lobby_y"], lifts=lifts_in_unit_frame(core))
    tg, _ = area_targets(prog, U.X * U.D - wn * dc, P)
    a = lattice.optimise(prog, U, tg, 3, "t:0", iters=1500)
    b = lattice.optimise(prog, U, tg, 3, "t:0", iters=1500)
    assert a[0]["R"] == b[0]["R"] and a[1] == b[1]
    R = a[0]["R"]
    assert set(R) == {rid for rid, _ in prog}                          # no room lost
    area = sum((q[2] - q[0]) * (q[3] - q[1]) for rs in R.values() for q in rs)
    assert area == U.X * U.D - wn * dc                                  # the rooms tile the dwelling exactly
    L = np.array(a[0]["labels"])
    for k in range(1, len(prog) + 1):                                   # every room in one piece
        assert ndimage.label(L == k)[1] == 1
    for rs in R.values():                                               # nothing in the core notch
        assert all(not (q[0] < wn and q[1] < dc) for q in rs)


def test_six_flats_on_one_lobby_corridor():
    """2026-11-06: 6 flats a floor planned with the core in one whole-floor search (floorplan.py). Every flat door and
    every passenger lift opens straight onto the public corridor (no door between the lifts and the flats); the stair
    has its own fire lobby, whose Class B door is the only one on the corridor; the walk to the stair is measured."""
    from highrise.walls import floor_walls
    cfg = {"id": "t-x6", "name": "t", "storeys": 12, "gfa": 90, "depth": 11400, "seed": 17, "dwellings": 6,
           "floor_restarts": 2, "floor_iters": 6000}
    b = assemble(cfg, P, restarts=4, iters=5000, log=lambda *a: None)
    assert b["envelope"]["widened"]                 # 90 m2 is too small a footprint for 6 flats with a south room each
    fp, core = b["floor_plate"], b["core"]
    assert b["dwellings_per_floor"] == 6 and len(b["other_flats"]) == 5 and core["layout"] == "floor search"
    corr = fp["rooms"]["core.corridor"]["rects"]
    unit_doors = [d for d in fp["doors"] if d.get("role") == "unit"]
    assert len(unit_doors) == 6

    def on_edge(d, rects):                       # the door lies on an edge of the corridor
        for x0, y0, x1, y1 in rects:
            if d["orient"] == "v" and d["at"] in (x0, x1) and y0 - 1 <= d["from"] and d["to"] <= y1 + 1: return True
            if d["orient"] == "h" and d["at"] in (y0, y1) and x0 - 1 <= d["from"] and d["to"] <= x1 + 1: return True
        return False
    assert all(on_edge(d, corr) for d in unit_doors), [d for d in unit_doors if not on_edge(d, corr)]
    assert not [d for d in fp["doors"] if d.get("role") == "corridor"]          # no fire door between lifts and flats
    assert core["lobby_door"] and on_edge(core["lobby_door"], corr)           # the stair's fire lobby opens onto it
    passenger = [d for d in core["lift_doors"] if d["side"] in ("S",)]
    assert passenger and all(on_edge(d, corr) for d in passenger)
    # no flat room overlaps the corridor or the core
    from shapely.geometry import box as sbox
    from shapely.ops import unary_union
    core_area = unary_union([sbox(*q) for rid, rm in fp["rooms"].items() if rid.startswith("core.") for q in rm["rects"]])
    for rid, rm in fp["rooms"].items():
        if rid.startswith("core.") or rm["type"] in ("BL", "AC"): continue
        for q in rm["rects"]:
            assert core_area.intersection(sbox(*q)).area < 1, rid
    assert 0 < core["max_travel_m"] and "C4 Travel to stair" in b["score"]["checks"]
    assert floor_walls(fp["rooms"])
    env = b["envelope"]
    xs = [v for rid, rm in fp["rooms"].items() if rm["type"] not in ("BL", "AC") for q in rm["rects"] for v in (q[0], q[2])]
    assert max(xs) <= env["half_length_mm"] and min(xs) >= -env["half_length_mm"]


def test_core_template_forms():
    """The core block the floor search moves: both forms meet the fire-lobby rules (GB 50016 5.5.28)."""
    from highrise import floorplan
    req = codes.core_requirements(26, 3.0, 6, pilotis=True)
    for form in ("wide", "stacked"):
        T = floorplan.core_template(req, form)
        lob = T["parts"]["lobby"][1]
        area = (lob[2] - lob[0] - 200) * (lob[3] - lob[1] - 200) / 1e6
        assert area >= req["lobby_min_m2"] and min(lob[2] - lob[0], lob[3] - lob[1]) - 200 >= 2400
        assert T["lobby_door"] and len(T["stair_doors"]) == 2 and T["W"] % 300 == 0 and T["D"] % 300 == 0


def test_four_flats_are_modular():
    """2026-11-11: 4 flats a floor are flat modules round the core (the footprint follows them): every flat a
    rectangle no longer than 1.8 : 1, every room one rectangle, every flat with a room that can take the sun."""
    cfg = {"id": "t-x4", "name": "t", "storeys": 12, "gfa": 120, "depth": 11400, "seed": 13, "dwellings": 4}
    b = assemble(cfg, P, restarts=4, iters=1500, log=lambda *a: None)
    fp = b["floor_plate"]
    flats = {}
    for rid, rm in fp["rooms"].items():
        if "." in rid and not rid.startswith("core.") and rm["type"] not in ("BL", "AC"):
            assert len(rm["rects"]) == 1 and not rm.get("add") and not rm.get("sub"), rid
            flats.setdefault(rid.split(".")[0], []).append(rm["rects"][0])
    assert len(flats) == 4
    for tag, qs in flats.items():
        w = max(q[2] for q in qs) - min(q[0] for q in qs)
        h = max(q[3] for q in qs) - min(q[1] for q in qs)
        assert abs(sum((q[2] - q[0]) * (q[3] - q[1]) for q in qs) - w * h) < 1, tag     # the rooms fill a rectangle
        assert max(w, h) / min(w, h) <= 1.8 + 1e-9, tag
    for sc in [b["score"]] + [o["score"] for o in b["other_flats"]]:
        assert sc["measure"]["sunny_rooms"] >= 1
        assert all(v == 1 for k, v in sc["checks"].items() if k.startswith("G"))


def test_bedroom_count_override():
    import random as _r
    from highrise.planner import sample_programme as sp
    prog = sp(140, _r.Random(1), P, beds=2, baths=1)
    assert sum(t in ("BRM", "BR") for _, t in prog) == 2 and sum(t in ("BA", "BAM") for _, t in prog) == 1


def test_building_passes_gate():
    b = assemble({"id": "t10", "name": "t", "storeys": 10, "gfa": 120, "depth": 11300, "seed": 3}, P, restarts=4, iters=4000, log=lambda *a: None)
    sc = b["score"]
    assert sc["score"] >= 8 and all(v == 1 for k, v in sc["checks"].items() if k.startswith(("G", "C")))
    assert not b["plan"]["planner"]["bed_on_lift"]
    assert {a["room"] for a in b["plan"]["ac"]} >= {r for r, rm in b["plan"]["rooms"].items() if rm["type"] in ("LR", "BRM", "BR", "ST")}
    kinds = {w[4] for w in floor_walls(b["floor_plate"]["rooms"])}
    assert {"exterior", "core", "interior"} <= kinds


def _sample(bid):
    import json, os
    return json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples", bid, "building.json")))


def _style_elements(b, st):
    env = facade.envelope(b)
    els = {}
    for f in b["floors"]:
        z = facade.zone_of(b, f["storey"], st)
        els.setdefault(f"{f['kind']}/{z}", facade.storey_elements(b, env, st, z, f["kind"]))
    els["roof"] = facade.crown(b, env, st, b["requirements"]["storey_h"] * 1000)
    return els


def test_facade_styles_pass_their_checks():
    b = _sample("hr24-140")
    for name, st in facade.STYLES.items():
        if name == "plain":
            continue
        els = _style_elements(b, st)
        assert sum(map(len, els.values())) > 100, name
        assert not any(p["role"] in ("window", "door") for v in els.values() for p in v), name
        res = facade.check(b, st, els)
        assert all(c["pass"] for c in res), (name, [c for c in res if not c["pass"]])


def test_decorative_layer_class_switches_at_50m():
    st = facade.STYLES["art_deco"]
    low, high = facade.materials(_sample("hr10-120"), st), facade.materials(_sample("hr24-140"), st)
    assert low["pilaster"][1] == "B1" and high["pilaster"][1] == "A"


def test_sun_spacing_counts_parapet_and_towers():
    b = _sample("hr10-120")
    site = {"lat": 39.9, "required_h": 2.0}
    old = facade.sun_study(b, facade.STYLES["plain"], site, spacing=46)       # spacing found without the parapet
    new = facade.sun_study(b, facade.STYLES["plain"], site)
    assert old["hours"] < 2.0 <= new["hours"] and new["row_spacing_m"] > 46


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f(); print("ok", k)


def test_walkability_and_diagonal_cut():
    """2026-11-06: a room joined by a 0.3 m neck fails; a hall that turns around a bathroom's corner too narrow to
    pass is fixed by a 45-degree cut off the bathroom, which keeps its own minimum area."""
    from highrise import walk
    # living room in two pieces joined by 300 mm
    assert not walk.room_ok(walk.geom([[0, 0, 1500, 3000], [1200, 3000, 4800, 7000]]), "LR")
    assert walk.room_ok(walk.geom([[0, 0, 3600, 4000]]), "LR")
    # an L-shaped hall 1.2 m wide (1.08 m clear) round the corner of a bathroom; the corner pinches the turn
    R = {"hl": [[0, 0, 1200, 3600], [1200, 2400, 3600, 3600]], "ba": [[1200, 0, 3600, 2400]]}
    T = {"hl": "HL", "ba": "BA"}
    g = walk.geom(R["hl"])
    assert walk.room_ok(g, "HL")             # an L of two 1.2 m legs is walkable as it is: no cut needed
    R2 = {"hl": [[0, 0, 1000, 3600], [1000, 2600, 3600, 3600]], "ba": [[1000, 0, 3600, 2600]]}
    assert not walk.room_ok(walk.geom(R2["hl"]), "HL")        # 0.88 m clear: too narrow, and no corner to cut helps
    cuts, still = walk.repair(R2, T)
    assert still == ["hl"]
    # a living room whose two parts overlap by only 0.3 m where a kitchen corner juts in: a 1.2 m cut off the
    # kitchen's corner opens the throat to over 0.9 m, and the kitchen keeps its 4 m2 and 1.8 m clear square
    R3 = {"lr": [[0, 0, 1400, 2600], [1100, 2600, 4000, 4000]], "kt": [[1400, 0, 4000, 2600]]}
    T3 = {"lr": "LR", "kt": "KT"}
    assert not walk.room_ok(walk.geom(R3["lr"]), "LR")
    cuts, still = walk.repair(R3, T3)
    assert not still and cuts[0]["from"] == "kt" and cuts[0]["to"] == "lr" and cuts[0]["leg"] == 1200
    rooms = {r: {"type": T3[r], "rects": R3[r]} for r in R3}
    walk.apply_cuts(rooms, cuts)
    from highrise.walls import diagonal_walls
    assert len(diagonal_walls(rooms)) == 1 and abs(walk.room_area(rooms["kt"]) - (2.6 * 2.6 - 0.72)) < 0.01


def test_built_designs_are_walkable():
    """Every flat of the built examples passes the door-to-door walk check after its cuts."""
    import json, glob
    from highrise import walk
    for f in glob.glob(os.path.join(HERE, "samples", "hr*", "building.json")):
        B = json.load(open(f))
        for p in [B["plan"]] + [o["plan"] for o in B.get("other_flats") or []]:
            assert not walk.door_routes(p), (B["id"], walk.door_routes(p))


def test_flat_rooms_by_the_houses_planner():
    """2026-11-06: a 4/6-flat floor's flat is planned by the houses' planner (houseplan.py): rooms keep sensible
    proportions and a person can walk through them; the public corridor is 1.5 m clear (floorplan.CORR_CLEAR)."""
    import random as _r
    from highrise import houseplan, walk, floorplan
    from highrise.planner import Unit, area_targets, sample_programme
    from highrise.compile import compile_unit
    assert floorplan.CORR_CLEAR >= 1500
    # a 6.6 x 6.0 m studio south of a corridor (door on its north side), south facade
    U = Unit(6600, 11400, 0, 0, (0, 11400), end_unit=False, lifts=[], x0=0, cuts=[(0, 0, 6600, 5400)],
             door=("h", 5400, 600, 2400), north=False)
    U.compact = True
    prog = sample_programme(40, _r.Random(1), P, 0, None, compact=U.area() / 1e6)
    targets, _ = area_targets(prog, U.area(), P)
    ok = 0
    for k in range(3):
        st, c, terms = houseplan.plan(prog, U, targets, f"test:{k}", iters=6000)
        T = dict(prog)
        for rid, rs in st["R"].items():
            g = walk.geom(rs)
            x0, y0, x1, y1 = g.bounds
            if T[rid] in ("LR", "BRM", "BR", "KT"):
                assert max(x1 - x0, y1 - y0) / min(x1 - x0, y1 - y0) <= 3.0, (rid, g.bounds)
        req = codes.core_requirements(18, 3.0, 4, pilotis=True)
        plan = compile_unit(st, U, prog, targets, 1, {"area_m2": 60}, "t", 40, req)
        ok += plan["planner"]["Ca"] == 0
    assert ok >= 1
