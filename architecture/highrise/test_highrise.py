"""Checks for the high-rise module.   python test_highrise.py   (from architecture/highrise)"""
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
