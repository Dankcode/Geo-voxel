"""Data for the house viewer (architecture/viewer): model metadata for the .mesh.json and the blueprint JSON
(plan2d format, metres, y up = north), one sheet per storey.
"""
import json
import math
import sys

from highrise.plan import NAMES, net_area
from highrise.score import SOURCE
from highrise.walls import THICK, floor_walls

KIND = {"LR": "living", "DR": "dining", "KT": "kitchen", "KW": "kitchen", "BRM": "bedroom", "BR": "bedroom",
        "ST": "study", "NA": "bedroom", "BAM": "bathroom", "BA": "bathroom", "EN": "foyer", "HL": "hall",
        "CL": "storage", "SR": "storage", "BL": "porch", "BLN": "porch", "AC": "utility"}
CORE_KIND = {"stair": "stair", "lobby": "lobby", "lift": "utility", "fire lift": "utility", "shaft": "utility"}
R3 = lambda v: round(v / 1000, 3)


def _ring(q):
    x0, y0, x1, y1 = q
    return [[R3(x0), R3(-y0)], [R3(x1), R3(-y0)], [R3(x1), R3(-y1)], [R3(x0), R3(-y1)]]


def _seg(o, at, a, b):
    return [R3(at), R3(-a), R3(at), R3(-b)] if o == "v" else [R3(a), R3(-at), R3(b), R3(-at)]


def _door(d):
    a, b, at, s = d["from"], d["to"], d["at"], d.get("swing", 1)
    w = b - a
    if d["orient"] == "v":
        hinge, tip = (at, a), (at + s * w, a)
        arc = [(at + s * w * math.cos(t), a + w * math.sin(t)) for t in [i * math.pi / 2 / 8 for i in range(9)]]
    else:
        hinge, tip = (a, at), (a, at + s * w)
        arc = [(a + w * math.sin(t), at + s * w * math.cos(t)) for t in [i * math.pi / 2 / 8 for i in range(9)]]
    return {"leaf": [[R3(hinge[0]), R3(-hinge[1])], [R3(tip[0]), R3(-tip[1])]], "arc": [[R3(x), R3(-y)] for x, y in arc]}


def _walls(rooms):
    ext, intr = [], []
    for o, c, lo, hi, kind, _ in floor_walls(rooms):
        t = THICK[kind] / 2
        q = [c - t, lo - t, c + t, hi + t] if o == "v" else [lo - t, c - t, hi + t, c + t]
        (ext if kind in ("exterior", "core", "party") else intr).append(_ring(q))
    return ext, intr


def _sheet(rooms, doors=(), windows=(), extra_rooms=(), steps=()):
    S = {"rooms": [], "ext": [], "int": [], "windows": [], "doors": [], "pockets": [], "cased": [], "overhead": [],
         "steps": [], "landings": [], "holes": [], "up": None}
    for i, (rid, rm) in enumerate(list(rooms.items()) + list(extra_rooms)):
        t = rm["type"]
        kind = CORE_KIND.get(rm.get("role"), "utility") if t == "CORE" else rm.get("kind") or KIND.get(t, "hall")
        xs = [q[0] for q in rm["rects"]] + [q[2] for q in rm["rects"]]
        ys = [q[1] for q in rm["rects"]] + [q[3] for q in rm["rects"]]
        S["rooms"].append({"id": i + 1, "kind": kind, "tier": 1, "open_air": t in ("BL", "BLN", "AC") or rm.get("open_air", False),
                           "area": round(sum((q[2] - q[0]) * (q[3] - q[1]) for q in rm["rects"]) / 1e6, 1),
                           "w": round((max(xs) - min(xs)) / 1000, 1), "d": round((max(ys) - min(ys)) / 1000, 1),
                           "rings": [_ring(q) for q in rm["rects"]]})
    S["ext"], S["int"] = _walls({k: v for k, v in rooms.items()})
    for w in windows:
        S["windows"].append(_seg(w["orient"], w.get("y", w.get("x")), w["from"], w["to"]))
    for d in doors:
        if d["kind"] == "door":
            S["doors"].append(_door(d))
        elif d["kind"] == "open":
            S["cased"].append(_seg(d["orient"], d["at"], d["from"], d["to"]))
        else:
            S["pockets"].append(_seg(d["orient"], d["at"], d["from"], d["to"]))
    S["steps"] = [[R3(q[0]), R3(-q[1]), R3(q[2]), R3(-q[3])] for q in steps]
    return S


def _stair_steps(core, H, risers):
    x0, y0, x1, y1 = core["rooms"]["stair"]["rects"][0]
    land, tread = 1300, 260
    mid = (y0 + y1) / 2
    n = risers - 1 if core["stair_kind"] == "scissor" else risers // 2
    out = [[x0 + land + k * tread, y0 + 100, x0 + land + (k + 1) * tread, mid - 50] for k in range(n)]
    out += [[x0 + land + k * tread, mid + 50, x0 + land + (k + 1) * tread, y1 - 100] for k in range(n)]
    return out


def plan2d(b):
    fp, core = b["floor_plate"], b["core"]
    H = b["requirements"]["storey_h"] * 1000
    steps = _stair_steps(core, H, b["requirements"]["risers_per_storey"])
    stair_doors = [{"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "swing": -1} for sx, sy in core["stair_doors"]]
    acs = [("ac%d" % i, {"type": "AC", "rects": [a["rect"]]}) for i, a in enumerate(fp["ac"])]
    typical = _sheet(fp["rooms"], fp["doors"], fp["windows"], acs, steps)
    core_rooms = {"core." + k: v for k, v in core["rooms"].items()}
    sheets = {"typical": typical}
    if b.get("ground"):
        g = b["ground"]
        rooms = dict(core_rooms)
        rooms["hall"] = {"type": "HL", "kind": "lobby", "rects": [g["hall"]]}
        extra = [("pilotis", {"type": "BL", "kind": "porch", "open_air": True, "rects": [g["pilotis_extent"]]}),
                 ("mail", {"type": "SR", "rects": [g["mail"]]}), ("ramp", {"type": "BL", "kind": "porch", "rects": [g["ramp"]]})]
        doors = stair_doors + [dict(g["entrance"], swing=-1), dict(g["stair_exit"], swing=-1)]
        S = _sheet(rooms, doors, [], extra, steps)
        S["int"] += [_ring([cx - 200, cy - 200, cx + 200, cy + 200]) for cx, cy in g["columns"]]
        sheets["pilotis"] = S
    if any(f["kind"] == "refuge" for f in b["floors"]):
        body = [q for rm in fp["rooms"].values() if rm["type"] not in ("CORE", "BL", "AC") for q in rm["rects"]]
        extra = [("refuge", {"type": "HL", "kind": "hall", "open_air": True, "rects": body})]
        sheets["refuge"] = _sheet(core_rooms, stair_doors, [], extra, steps)
    allr = [q for rm in fp["rooms"].values() for q in rm["rects"]] + [a["rect"] for a in fp["ac"]]
    if b.get("ground"):
        allr += [b["ground"]["ramp"], b["ground"]["pilotis_extent"]]
    x0 = min(q[0] for q in allr) - 600; x1 = max(q[2] for q in allr) + 600
    y0 = min(q[1] for q in allr) - 600; y1 = max(q[3] for q in allr) + 600
    body = [q for rm in fp["rooms"].values() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    bw = (max(q[2] for q in body) - min(q[0] for q in body)) / 1000
    bd = (max(q[3] for q in body) - min(q[1] for q in body)) / 1000
    return {"bounds": [R3(x0), R3(-y1), R3(x1), R3(-y0)], "front": "bottom",
            "storeys": [sheets[f["kind"]] for f in b["floors"]], "overall": [round(bw, 2), round(bd, 2)],
            "roofs": ["flat roof, 1.20 m parapet, stair head room and lift machine room"],
            "door_note": "fire doors (Class B) on the stair, the dwelling doors onto the fire lobby and the refuge room",
            "stairs": [{"from": 1, "form": core["stair_kind"], "N": b["requirements"]["risers_per_storey"],
                        "R": b["requirements"]["riser_mm"], "T": 260, "W": 1100}]}


def meta(b, report=None):
    req, core, plan, sc = b["requirements"], b["core"], b["plan"], b["score"]
    m = sc["measure"]
    body = [q for rm in b["floor_plate"]["rooms"].values() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    body_w = (max(q[2] for q in body) - min(q[0] for q in body)) / 1000
    ev = [
        {"says": f"{req['storeys']} storeys at {req['storey_h']:.2f} m: building height {req['height_m']} m ({req['class']})",
         "source": "GB 55038-2025 4.1.2; GB 50016 Appendix A.0.1"},
        {"says": f"{core['lifts']} lift(s){', one a fire lift' if core['fire_lift'] else ''}; one car 1.6 × 1.5 m",
         "source": "GB 55038 4.2.4; GB 50016 7.3.1"},
        {"says": ("Scissor stair: two exits on every floor" if core["stair_kind"] == "scissor" else f"{core['stair_type'].capitalize()} stair"),
         "source": "GB 50016 5.5.25-5.5.28"},
        {"says": f"Lobby {core['lobby_m2']} m², short side {core['lobby_short']} m", "source": "GB 50016 5.5.28"},
        {"says": "No bedroom against a lift shaft", "source": "GB 55038 4.2.3"},
    ]
    if req["refuge_room_per_dwelling"]:
        ev.append({"says": f"Refuge room in every dwelling ({plan.get('refuge_room')}, Class B fire door)", "source": "GB 50016 5.5.32"})
    if req["refuge_floors"]:
        ev.append({"says": f"Refuge floors at storeys {', '.join(map(str, req['refuge_floors']))}", "source": "GB 50016 5.5.31"})
    s = b["sun"]
    ev.append({"says": f"{s['hours']:.1f} h of sun on the {s['day']} at the lowest dwelling, next row {s['row_spacing_m']} m south ({s['site']})",
               "source": "GB 50180-2018 Table 4.0.9; GB 55038 6.2.1"})
    ev.append({"says": "Programme and room sizes calibrated on 12 traced Chinese apartment plans", "source": "zuobang.net reference set"})
    rooms = []
    for rid, rm in plan["rooms"].items():
        if rm["type"] in ("BL",):
            continue
        for f in b["floors"]:
            if f["kind"] == "typical":
                rooms += [{"storey": f["storey"] - 1, "kind": NAMES[rm["type"]].lower(), "area": round(net_area(plan, rid), 1)}] * 2
    checks = [{"check": f"{k} ({SOURCE.get(k.split(' ')[0], 'typology')})",
               "ok": v >= 0.999, "detail": "; ".join(sc["why"].get(k, [])) or f"{v:.2f}"} for k, v in sc["checks"].items()]
    return {
        "id": "none (generated building, not an OSM footprint)", "key": b["id"], "name": b["name"],
        "context": {"street": None, "district": None, "hood": f"{s['site']} (sunlight check)"},
        "theme": {"archetype": "apartments", "style": "chinese_highrise_slab", "era": None, "storeys": len(b["floors"]), "evidence": ev},
        "metrics": {"frontage": round(body_w, 1), "depth": m["depth_m"]},
        "design": {"seed": b.get("picked"), "family": f"{m['layout']}, {b['dwellings']} dwellings", "checks": checks,
                   "cost": plan["cost"], "rho": 0.0},
        "report": dict({"walls": None, "windows": None, "doors": None, "furniture": 0}, **(report or {})),
        "style_params": {"roof": "flat", "pitch": 0, "cladding": "rendered concrete", "roofmat": "membrane",
                         "walls": "#e7e0d1", "roofc": "#99938a"},
        "raise": req["ground_offset"], "storey_h": req["storey_h"], "rooms": rooms,
        "program_log": [f"programme: {', '.join(t for _, t in b['programme'])}"] +
                       [f"dropped {r['dropped']} ({r['gate_pass_before']} restarts passed with it)" for r in b["programme_repairs"]] +
                       [f"score {sc['score']} / 10: " + ", ".join(f"{g} {v}" for g, v in sc["groups"].items())],
        "terms": {k: v for k, v in plan["planner"].items() if isinstance(v, (int, float)) and not isinstance(v, bool)},
    }


if __name__ == "__main__":
    b = json.load(open(sys.argv[1]))
    json.dump(plan2d(b), open(sys.argv[2], "w"), separators=(",", ":"))
