"""1-10 scorecard for an apartment plan (8 = pass), applied the same way to traced reference plans and to
generated ones.

    S = 1 + 9 * sum(w_i * q_i) / sum(w_i)

q_i is a measured outcome in [0, 1] for check i. A check runs only when the plan carries what it measures (the
traced references have no door widths, AC platforms or storey count, so those checks skip for them). Groups:
  G  Chinese codes measured on the dwelling (GB 50096, GB 55038, GB 50016)
  C  core, height and site rules, for a whole building
  M  the Merrell et al. (2010) cost terms measured on the result
  T  the typology Chinese buyers and designers judge a dwelling by
The professional reference plans calibrate the scale: if they don't score >= 8, the card is wrong, not them.
"""
from highrise import codes
from highrise.plan import measure

W = {
    "G1 Minimum room areas": 2, "G2 Bedroom short side >= 1.8 m": 1, "G3 Direct daylight": 2,
    "G4 Sunlight room": 2, "G5 Passage widths": 1, "G6 No bedroom on a lift shaft": 2,
    "G7 Door clear widths": 1, "G8 AC platforms": 1, "G9 Openable window area": 0.5,
    "G10 Refuge room above 54 m": 1,
    "C1 Lifts": 1, "C2 Stair type and exits": 2, "C3 Lobby area": 1, "C4 Travel to stair": 1,
    "C5 Storey height": 1, "C6 Refuge floors above 100 m": 1, "C7 Winter sunlight hours": 1,
    "M1 C_a connections and reachability": 2, "M2 Privacy gradient": 1,
    "M3 C_d room sizes vs reference priors": 2, "M4 C_s room shape": 1,
    "T1 Living room faces south": 2, "T2 Master bedroom faces south": 1, "T3 North-south through ventilation": 1,
    "T4 Kitchen with window": 1, "T5 Bathrooms with windows": 0.5, "T6 Master suite": 1,
    "T7 Bedrooms kept off the entry": 1, "T8 South-facing rooms": 1, "T9 Circulation share": 1,
    "T10 Net-to-gross efficiency": 1, "T11 Living room width >= 3.6 m": 1, "T12 Dining room open to the living room": 1,
}
SOURCE = {
    "G1": "GB 50096 5.2-5.4, GB 55038 4.1.1/4.1.4/4.1.6", "G2": "GB 55038 4.1.1(3)", "G3": "GB 55038 6.2.2",
    "G4": "GB 55038 6.2.1", "G5": "GB 55038 4.1.13", "G6": "GB 55038 4.2.3", "G7": "GB 55038 4.1.14",
    "G8": "GB 55038 (dedicated AC platforms)", "G9": "GB 55038 6.3.3", "G10": "GB 50016 5.5.32",
    "C1": "GB 55038 4.2.4, GB 50016 7.3.1", "C2": "GB 50016 5.5.25-5.5.27", "C3": "GB 50016 5.5.28",
    "C4": "GB 50016 5.5.28", "C5": "GB 55038 4.1.2", "C6": "GB 50016 5.5.31", "C7": "GB 50180 Table 4.0.9",
}


def _clip(x):
    return max(0.0, min(1.0, x))


def score_plan(plan, priors, floor=None):
    m = measure(plan)
    q, why = {}, {}
    rooms = {r["rid"]: r for r in m["rooms"]}

    # ---- G: codes on the dwelling
    fails = [f"{r['rid']} {r['type']} {r['net']} m2 < {codes.MIN_NET_AREA[r['type']]}"
             for r in m["rooms"] if r["type"] in codes.MIN_NET_AREA and r["net"] < codes.MIN_NET_AREA[r["type"]]]
    n = sum(r["type"] in codes.MIN_NET_AREA for r in m["rooms"])
    q["G1 Minimum room areas"] = 1 - len(fails) / max(1, n)
    why["G1 Minimum room areas"] = fails
    beds = [r for r in m["rooms"] if r["type"] in ("BRM", "BR", "ST")]
    short = [f"{r['rid']} {r['short']} m" for r in beds if r["short"] < codes.BEDROOM_SHORT_SIDE]
    q["G2 Bedroom short side >= 1.8 m"] = 1 - len(short) / max(1, len(beds))
    why["G2 Bedroom short side >= 1.8 m"] = short
    dl = [r for r in m["rooms"] if r["type"] in codes.DAYLIT]
    dark = [r["rid"] for r in dl if not r["win"]]
    q["G3 Direct daylight"] = 1 - len(dark) / max(1, len(dl))
    why["G3 Direct daylight"] = dark
    q["G4 Sunlight room"] = 1.0 if m.get("sunny_rooms", m["south_rooms"]) >= 1 else 0.0
    # passages (2026-11-06): on the real room shapes, diagonal cuts included (walk.py): a person 0.90 m wide gets
    # through every room and from each door of a room to its others; the entry 1.10 m clear, halls 1.00 m
    from highrise import walk
    narrow = walk.door_routes(plan)
    nchk = sum(rm["type"] not in walk.EXEMPT for rm in plan["rooms"].values())
    q["G5 Passage widths"] = 1.0 if not narrow else max(0.0, 1 - len(narrow) / max(1, nchk))
    why["G5 Passage widths"] = narrow
    lifts_known = m["has_core"] or bool(plan.get("unit", {}).get("lifts"))
    if lifts_known:
        bad = list(m["bed_next_to_lift"]) + list(plan.get("planner", {}).get("bed_on_lift", []))
        q["G6 No bedroom on a lift shaft"] = 0.0 if bad else 1.0
        why["G6 No bedroom on a lift shaft"] = bad
    if plan.get("doors"):
        T = {rid: rm["type"] for rid, rm in plan["rooms"].items()}
        narrowd = []
        hinged = [d for d in plan["doors"] if d["kind"] == "door"]
        for d in hinged:
            t = "unit" if d.get("role") == "unit" else T.get(d["b"]) if d["b"] in T else T.get(d["a"])
            need = codes.DOOR_CLEAR.get(t)
            if need and (d["to"] - d["from"]) / 1000 - codes.DOOR_FRAME < need - 1e-6:
                narrowd.append(f"{d['a']}-{d['b']} {(d['to'] - d['from']) / 1000 - codes.DOOR_FRAME:.2f} m < {need}")
        q["G7 Door clear widths"] = 1 - len(narrowd) / max(1, len(hinged))
        why["G7 Door clear widths"] = narrowd
    if "ac" in plan:
        need_ac = [rid for rid, rm in plan["rooms"].items() if rm["type"] in ("LR", "BRM", "BR", "ST")]
        have = {a["room"] for a in plan["ac"]}
        miss = [r for r in need_ac if r not in have]
        q["G8 AC platforms"] = 1 - len(miss) / max(1, len(need_ac))
        why["G8 AC platforms"] = miss
    if plan.get("windows") is not None and "ac" in plan:
        low = []
        cnt = 0
        for rid, rm in plan["rooms"].items():
            t = rm["type"]
            if t not in ("KT", "BR", "BRM", "ST") or rid not in rooms:
                continue
            cnt += 1
            a = rooms[rid]["net"]
            open_m2 = sum((w["to"] - w["from"]) / 1000 for w in plan["windows"] if w["room"] == rid) * 1.5 * 0.5
            need = max(0.6, codes.VENT_RATIO["KT"] * a) if t == "KT" else codes.VENT_RATIO["habitable"] * a
            if open_m2 < need:
                low.append(f"{rid} {open_m2:.2f} < {need:.2f} m2")
        q["G9 Openable window area"] = 1 - len(low) / max(1, cnt)
        why["G9 Openable window area"] = low
    req = (floor or {}).get("requirements", {})
    if req.get("refuge_room_per_dwelling"):
        rr = plan.get("refuge_room")
        q["G10 Refuge room above 54 m"] = 1.0 if (rr and plan["win"].get(rr)) else 0.0
        why["G10 Refuge room above 54 m"] = [f"refuge room: {rr}"]

    # ---- C: core, height, site
    if floor:
        core = floor["core"]
        q["C1 Lifts"] = _clip(core["lifts"] / max(1, req["lifts"])) * (1.0 if (not req["fire_lift"] or core["fire_lift"]) else 0.5)
        why["C1 Lifts"] = [f"need {req['lifts']}{' incl. a fire lift' if req['fire_lift'] else ''}, have {core['lifts']}"]
        rank = {"open": 0, "enclosed": 1, "smoke-proof": 2}
        good = rank[core["stair_type"]] >= rank[req["stair_type"]] and core["exits"] >= req["exits_per_floor"]
        q["C2 Stair type and exits"] = 1.0 if good else 0.0
        why["C2 Stair type and exits"] = [f"need {req['stair_type']} x{req['exits_per_floor']}, have {core['stair_type']} x{core['exits']}"]
        short_ok = core["lobby_short"] >= (codes.COMBINED_LOBBY_SHORT if req["lobby_min_m2"] >= 12 else 0)
        q["C3 Lobby area"] = 1.0 if (core["lobby_m2"] >= req["lobby_min_m2"] and short_ok) else 0.0
        why["C3 Lobby area"] = [f"lobby {core['lobby_m2']} m2, short side {core['lobby_short']} m; need {req['lobby_min_m2']} m2"]
        lim = req.get("max_travel_m", codes.SCISSOR_MAX_TRAVEL)
        q["C4 Travel to stair"] = 1.0 if core["max_travel_m"] <= lim else _clip(1 - (core["max_travel_m"] - lim) / 10)
        why["C4 Travel to stair"] = [f"longest walk from a flat door {core['max_travel_m']} m, limit {lim} m"]
        q["C5 Storey height"] = 1.0 if req["storey_h"] >= codes.STOREY_H_MIN else 0.0
        if req.get("refuge_floors"):
            built = floor.get("refuge_floors_built", [])
            q["C6 Refuge floors above 100 m"] = 1.0 if built == req["refuge_floors"] else 0.0
            why["C6 Refuge floors above 100 m"] = [f"need {req['refuge_floors']}, built {built}"]
        if floor.get("sun"):
            s = floor["sun"]
            q["C7 Winter sunlight hours"] = _clip(s["hours"] / s["required"])
            why["C7 Winter sunlight hours"] = [f"{s['hours']:.1f} h on {s['day']} at the lowest dwelling's worst flat (best window, south or gable), need {s['required']} h"]

    # ---- M: the paper's terms
    nl = max(1, len([l for l in plan["links"] if "OUT" not in l and "CORE" not in l]))
    q["M1 C_a connections and reachability"] = (1 - len(m["infeasible_links"]) / nl) * (1.0 if m["reachable"] else 0.5)
    why["M1 C_a connections and reachability"] = [str(x) for x in m["infeasible_links"]] + ([] if m["reachable"] else ["unreachable rooms"])
    q["M2 Privacy gradient"] = 1.0 if m["privacy_violations"] == 0 else 0.0
    ok, tot, off = 0, 0, []
    for r in m["rooms"]:
        p = priors.get(r["type"])
        if not p or p["net"]["n"] < 3:
            continue
        tot += 1
        sd = max(p["net"]["sd"], 0.2 * p["net"]["mean"])
        sda = max(p["aspect"]["sd"], 0.15)
        if r["type"] in ("LR", "DR", "KT"):       # rooms that scale with the dwelling: share of its area
            sh = r["axis"] / m["axis_area"]
            good = p["share"]["min"] * 0.95 <= sh <= p["share"]["max"] * 1.05
        else:
            good = p["net"]["mean"] - 2 * sd <= r["net"] <= p["net"]["mean"] + 2 * sd
        good = good and r["aspect"] <= p["aspect"]["mean"] + 2 * sda
        ok += good
        if not good:
            off.append(f"{r['rid']} {r['type']} {r['net']} m2, aspect {r['aspect']}")
    q["M3 C_d room sizes vs reference priors"] = ok / max(1, tot)
    why["M3 C_d room sizes vs reference priors"] = off
    fills = []
    for rid, rm in plan["rooms"].items():
        if rm["type"] in ("BL", "BLN", "CORE", "HL", "AC"):   # halls exempt, as in the paper
            continue
        xs = [r[0] for r in rm["rects"]] + [r[2] for r in rm["rects"]]
        ys = [r[1] for r in rm["rects"]] + [r[3] for r in rm["rects"]]
        bb = (max(xs) - min(xs)) * (max(ys) - min(ys))
        fills.append(sum((r[2] - r[0]) * (r[3] - r[1]) for r in rm["rects"]) / bb)
    q["M4 C_s room shape"] = sum(f >= 0.85 for f in fills) / max(1, len(fills))

    # ---- T: typology
    q["T1 Living room faces south"] = 1.0 if m["living_south"] else 0.0
    q["T2 Master bedroom faces south"] = 1.0 if m["master_south"] else 0.0
    q["T3 North-south through ventilation"] = 1.0 if m["through_strict"] else (0.75 if m["through_loose"] else 0.0)
    why["T3 North-south through ventilation"] = [] if m["through_strict"] else ["only through a kitchen slider" if m["through_loose"] else "none"]
    q["T4 Kitchen with window"] = 1.0 if m["kitchen_window"] else 0.0
    q["T5 Bathrooms with windows"] = _clip(m["bath_window_share"] / 0.5)
    q["T6 Master suite"] = 1.0 if (m["master_ensuite"] or m["baths"] < 2) else 0.0
    q["T7 Bedrooms kept off the entry"] = 1.0 if m["bed_off_entry"] == 0 else 0.5 if m["bed_off_entry"] == 1 else 0.0
    want = 3 if m["bedrooms"] + m["studies"] >= 3 else 2 if m["bedrooms"] + m["studies"] >= 1 else 1
    q["T8 South-facing rooms"] = _clip(m["south_rooms"] / want)
    c = m["circulation_share"]
    q["T9 Circulation share"] = 1.0 if c <= 0.12 else _clip(1 - (c - 0.12) / 0.10)
    why["T9 Circulation share"] = [f"{c:.0%}"]
    if m.get("efficiency"):
        e = m["efficiency"]
        q["T10 Net-to-gross efficiency"] = 1.0 if 0.70 <= e <= 0.88 else _clip(1 - min(abs(e - 0.70), abs(e - 0.88)) / 0.08)
        why["T10 Net-to-gross efficiency"] = [f"{e:.1%}"]
    lr_w = [max(r[2] for r in rm["rects"]) - min(r[0] for r in rm["rects"]) for rm in plan["rooms"].values() if rm["type"] == "LR"]
    q["T11 Living room width >= 3.6 m"] = 1.0 if lr_w and min(lr_w) >= 3600 else 0.0
    why["T11 Living room width >= 3.6 m"] = [f"{min(lr_w) / 1000:.2f} m"] if lr_w else []

    q["T12 Dining room open to the living room"] = 1.0 if m["dining_joins_living"] else 0.0
    sw = sum(W[k] for k in q)
    S = 1 + 9 * sum(W[k] * q[k] for k in q) / sw
    groups = {}
    for g in "GCMT":
        ks = [k for k in q if k.startswith(g)]
        if ks:
            groups[g] = round(1 + 9 * sum(W[k] * q[k] for k in ks) / sum(W[k] for k in ks), 2)
    return {"id": plan["id"], "score": round(S, 2), "pass": S >= 8.0, "groups": groups,
            "checks": {k: round(v, 3) for k, v in q.items()},
            "why": {k: v for k, v in why.items() if v}, "measure": {k: v for k, v in m.items() if k != "rooms"}}
