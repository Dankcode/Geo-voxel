"""Residential core for a slab block with two dwellings per floor.

Laid out from codes.core_requirements():
    north row   stair box (scissor stair above 54 m, otherwise a two-flight stair); its doors open south onto
                the lobby; on the ground floor the stair also has a door straight out to the north (discharge)
    middle row  lobby (shared fire lobby when a fire lift is required); both dwelling doors open off its ends
    south row   service shaft | lift shafts | service shaft, lifts centred so each dwelling sees as little of
                them as possible (GB 55038 4.2.3 keeps bedrooms off lift shafts)
Coordinates: mm, core centred on x = 0, y = 0 at the north face, y grows south.
"""
import math

from highrise import codes

LIFT_SHAFT = (2400, 2500)     # w x d: 1.60 x 1.50 m car (GB 55038 4.2.4(3)) in a 2.4 x 2.5 m shaft
WALL = 200


def stair_box(req):
    """Axis size (length along x, depth along y) of the stair box, and how many exits it provides."""
    risers = req["risers_per_storey"]
    tread = int(codes.STAIR_TREAD_MIN * 1000)
    flight = int(codes.STAIR_FLIGHT_CLEAR * 1000)
    land = int(codes.STAIR_LANDING_MIN * 1000)
    if req["scissor_ok"] and req["exits_per_floor"] == 2:
        # scissor stair: each run climbs a whole storey in one straight flight; two runs side by side with a
        # 1.00 h fire wall between them (GB 50016 5.5.28)
        L = (risers - 1) * tread + 2 * land + WALL
        D = 2 * flight + WALL + WALL
        return "scissor", L, D, 2
    L = (math.ceil(risers / 2) - 1) * tread + 2 * land + WALL      # two flights per storey (switchback)
    D = 2 * flight + 100 + WALL
    return "switchback", L, D, 1


def build_core(req):
    kind, sl, sd, exits = stair_box(req)
    sl = int(math.ceil(sl / 100) * 100)
    sd = int(math.ceil(sd / 100) * 100)
    n_lift = req["lifts"]
    shafts_w = 1200 + (1200 if req["stair_type"] == "smoke-proof" else 0)   # pipes/power (+ pressurisation)
    width = max(sl, n_lift * LIFT_SHAFT[0] + shafts_w)
    width = int(math.ceil(width / 200) * 200)
    lobby_d = 2000
    if req["lobby_min_m2"]:
        lobby_d = max(int(codes.COMBINED_LOBBY_SHORT * 1000) + WALL if req["lobby_min_m2"] >= 12 else 1800,
                      int(math.ceil(req["lobby_min_m2"] * 1e6 / (width - WALL) / 100) * 100) + WALL)
    x0 = -width // 2
    y1 = sd + lobby_d
    rooms = {
        "stair": {"type": "CORE", "role": "stair", "rects": [[x0, 0, x0 + width, sd]]},
        "lobby": {"type": "CORE", "role": "lobby", "rects": [[x0, sd, x0 + width, y1]]},
    }
    lw = n_lift * LIFT_SHAFT[0]
    side = (width - lw) // 2
    rooms["shaft_w"] = {"type": "CORE", "role": "shaft", "rects": [[x0, y1, x0 + side, y1 + LIFT_SHAFT[1]]]}
    x = x0 + side
    lifts = []
    for i in range(n_lift):
        r = [x, y1, x + LIFT_SHAFT[0], y1 + LIFT_SHAFT[1]]
        rooms[f"lift{i+1}"] = {"type": "CORE", "role": "fire lift" if (i == 0 and req["fire_lift"]) else "lift", "rects": [r]}
        lifts.append(r)
        x += LIFT_SHAFT[0]
    rooms["shaft_e"] = {"type": "CORE", "role": "shaft", "rects": [[x, y1, x0 + width, y1 + LIFT_SHAFT[1]]]}
    depth = y1 + LIFT_SHAFT[1]
    lobby_net = ((width - WALL) * (lobby_d - WALL)) / 1e6
    stair_doors = [(x0 + 700, sd)] + ([(x0 + width - 700, sd)] if exits == 2 else [])
    unit_doors = [(x0, sd + lobby_d / 2), (x0 + width, sd + lobby_d / 2)]
    travel = max(min(abs(ux - sx) + abs(uy - sy) for sx, sy in stair_doors) for ux, uy in unit_doors) / 1000
    return {
        "rooms": rooms, "width": width, "depth": depth, "lobby_y": (sd, y1), "lifts": n_lift, "lift_rects": lifts,
        "stair_kind": kind, "stair_type": req["stair_type"], "exits": exits, "fire_lift": req["fire_lift"] and n_lift > 0,
        "lobby_m2": round(lobby_net, 1), "lobby_short": round((min(width, lobby_d) - WALL) / 1000, 2),
        "max_travel_m": round(travel, 1), "area_m2": round(width * depth / 1e6, 1),
        "stair_box": (sl, sd), "unit_doors": unit_doors, "stair_doors": stair_doors,
        "lift_car_m": codes.LIFT_CAR[0],
    }


def lifts_in_unit_frame(core):
    """Lift shafts as the east dwelling sees them, including the mirrored ones the west dwelling sees.
    The west dwelling is the east plan mirrored, so a room may sit on neither side of a lift."""
    out = []
    for x0, y0, x1, y1 in core["lift_rects"]:
        for a, b in ((x0, x1), (-x1, -x0)):
            if b > 0:
                out.append((max(0, a), y0, b, y1))
    return out
