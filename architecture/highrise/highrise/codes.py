"""Chinese residential code rules used by the high-rise planner, the building stack and the scorecard.

Every value carries its clause. Codes:
  GB 55038-2025  Residential Project Code (mandatory since 2025-05-01; overrides conflicting older clauses)
  GB 50096-2011  Design Code for Residential Buildings
  GB 50016-2014 (2018 edition)  Code for Fire Protection Design of Buildings; its mandatory clauses are carried
                 into GB 55037-2022 (General Code for Fire Protection of Buildings, in force 2023-06-01)
  GB 50180-2018  Standard for Urban Residential Area Planning and Design (sunlight hours)
GB 55038 values were read from the Beijing planning commission's clause digest of the code (June 2025).
"""
import math

# --- building height -----------------------------------------------------------------------------------------
GROUND_OFFSET = 0.30   # m, ground floor above outdoor grade (typical 0.15-0.45)
# Building height of a flat-roofed building runs from outdoor grade to the roof surface; parapets and roof
# stair/lift rooms covering <= 1/4 of the roof are excluded (GB 50016 Appendix A.0.1).

# --- dwelling interior (GB 55038 chapter 4.1) -----------------------------------------------------------------
STOREY_H_MIN = 3.00          # 4.1.2(1)
CLEAR_H_LIVING = 2.60        # 4.1.2(2)
CLEAR_H_WET = 2.20           # 4.1.2(4)
MIN_NET_AREA = {             # usable (net) area, m2
    "BRM": 9.0,              # GB 50096 5.2.1 double bedroom; GB 55038 4.1.1(2) bedroom used as living >= 9
    "BR": 5.0,               # GB 55038 4.1.1(1)
    "ST": 5.0,               # a study counts as a single bedroom
    "LR": 10.0,              # GB 50096 5.2.2
    "KT": 4.0,               # GB 50096 5.3.1 (GB 55038 4.1.4 floor: 3.5)
    "BA": 2.5,               # GB 55038 4.1.6: toilet + shower + basin in one room >= 2.5
    "BAM": 2.5,
}
BEDROOM_SHORT_SIDE = 1.80    # GB 55038 4.1.1(3): clear short side of a bedroom
PASSAGE_CLEAR = {"entry": 1.10, "rooms": 1.00, "service": 0.90}   # GB 55038 4.1.13
DOOR_CLEAR = {"unit": 0.90, "BR": 0.80, "BRM": 0.80, "ST": 0.80, "KT": 0.70, "BA": 0.70, "BAM": 0.70}  # 4.1.14
DOOR_FRAME = 0.10            # opening = clear width + frame/leaf allowance
RAILING_H = 1.20             # GB 55038 4.1.15(1) balconies, 4.2.8 corridors and accessible roofs
WINDOW_FLOOR_RATIO = 1 / 7   # GB 50096 7.2.2 daylight rule of thumb for bedroom, living room, kitchen
VENT_RATIO = {"habitable": 0.05, "KT": 0.10}  # GB 55038 6.3.3 openable area / floor area (kitchen also >= 0.6 m2)
DAYLIT = {"LR", "BRM", "BR", "ST", "KT"}       # GB 55038 6.2.2 direct daylight
AC_PLATFORM = True           # GB 55038: outdoor AC units on dedicated platforms (as summarised by MOHURD)
# GB 55038 6.2.1: each dwelling has >= 1 bedroom or living room meeting the sunlight standard; hours from
# GB 50180-2018 Table 4.0.9 (e.g. >= 2 h on the Major Cold day (Dahan) in zone I/II/III/VII cities of
# >= 500k people). sun.py computes the hours for a row of slabs.

# --- common parts (GB 55038 4.2, GB 50096 6) --------------------------------------------------------------------
CORRIDOR_CLEAR = 1.20        # GB 55038 4.2.1(1)
STAIR_FLIGHT_CLEAR = 1.10    # GB 55038 4.2.2(1) when the top entry floor is > 15 m above grade
STAIR_RISER_MAX = 0.175      # 4.2.2(2)
STAIR_TREAD_MIN = 0.26       # 4.2.2(2)
STAIR_LANDING_MIN = 1.20     # GB 50096 6.3.3
LIFT_CAR = ((1.60, 1.50), (1.10, 2.10))  # GB 55038 4.2.4(3): one lift per core, wide or deep car, door >= 0.9
LIFT_NOT_BY_BEDROOM = True   # GB 55038 4.2.3: lift shafts, machine rooms, pump rooms not next to bedrooms
ENTRANCE_DOOR = 1.10         # GB 55038 4.2.7: barrier-free building entrance, clear width
RAMP_SLOPE = 1 / 12          # GB 50763 / GB 55019 barrier-free ramp

# --- fire (GB 50016-2014/2018, carried into GB 55037-2022) ---------------------------------------------------------
SHARED_LOBBY_MIN = 6.0       # 5.5.28: shared stair lobby >= 6 m2
COMBINED_LOBBY_MIN = 12.0    # 5.5.28: stair lobby combined with the fire-lift lobby >= 12 m2 ...
COMBINED_LOBBY_SHORT = 2.4   # ... short side >= 2.4 m
SCISSOR_MAX_TRAVEL = 10.0    # 5.5.28: unit door -> stair entrance <= 10 m for a scissor stair
REFUGE_FLOOR_FIRST = 50.0    # 5.5.31 -> 5.5.23: first refuge floor <= 50 m above the fire-appliance ground
REFUGE_FLOOR_SPACING = 50.0  # ... and <= 50 m between refuge floors
REFUGE_PERSONS_M2 = 5.0      # refuge area at 5 persons/m2


def building_height(storeys, storey_h=3.0, ground=GROUND_OFFSET):
    return round(ground + storeys * storey_h, 2)


def core_requirements(storeys, storey_h=3.0, units_per_floor=2, ground=GROUND_OFFSET, pilotis=False):
    """What the codes ask of one residential core for a building of this height."""
    H = building_height(storeys, storey_h, ground)
    top_entry = ground + (storeys - 1) * storey_h          # floor level of the highest entry storey
    res_floors = storeys - (1 if pilotis else 0)
    req = {"storeys": storeys, "height_m": H, "top_entry_m": round(top_entry, 2), "storey_h": storey_h,
           "units_per_floor": units_per_floor, "ground_offset": ground, "notes": []}
    if storey_h < STOREY_H_MIN:
        req["notes"].append("storey height below GB 55038 4.1.2 (3.00 m)")
    # classification (GB 50016 Table 5.1.1): residential > 54 m class I high-rise, 27-54 m class II
    req["class"] = "high-rise I" if H > 54 else ("high-rise II" if H > 27 else "multi-storey")
    # lifts (GB 55038 4.2.4)
    lifts = 0
    if storeys >= 4 or top_entry > 9:
        lifts = 1
    if storeys >= 12 or top_entry > 33:
        lifts = 2
    households = res_floors * units_per_floor
    if lifts:
        lifts = max(lifts, math.ceil(households / 90))     # planning rule of thumb: <= ~90 households per lift
    req["lifts"] = lifts
    req["fire_lift"] = H > 33                              # GB 50016 7.3.1
    # stairs (GB 50016 5.5.27, 5.5.25, 5.5.26, 5.5.28)
    req["stair_type"] = "open" if H <= 21 else ("enclosed" if H <= 33 else "smoke-proof")
    req["exits_per_floor"] = 2 if H > 54 else 1
    req["stair_to_roof"] = H > 27                          # 5.5.26 (single stair 27-54 m); usual practice above
    req["scissor_ok"] = H > 54
    if req["stair_type"] == "smoke-proof":
        req["unit_doors_on_lobby_max"] = 3                 # 5.5.27-3, Class B fire doors
    req["lobby_min_m2"] = (COMBINED_LOBBY_MIN if req["fire_lift"] and req["stair_type"] == "smoke-proof"
                           else (SHARED_LOBBY_MIN if req["stair_type"] == "smoke-proof" else 0))
    req["refuge_room_per_dwelling"] = H > 54               # 5.5.32
    req["refuge_floors"] = refuge_floors(storeys, storey_h, ground) if H > 100 else []   # 5.5.31
    risers = math.ceil(storey_h / STAIR_RISER_MAX)
    req["risers_per_storey"] = risers
    req["riser_mm"] = round(storey_h / risers * 1000, 1)
    return req


def refuge_floors(storeys, storey_h=3.0, ground=GROUND_OFFSET):
    """Storeys (1-based) that become refuge floors: the highest storey whose floor is <= 50 m above the last one."""
    out, base = [], 0.0
    while True:
        cands = [k for k in range(2, storeys + 1) if ground + (k - 1) * storey_h - base <= REFUGE_FLOOR_FIRST]
        if not cands:
            break
        k = max(cands)
        if k >= storeys:          # nothing above that would need one
            break
        top_left = building_height(storeys, storey_h, ground) - (ground + (k - 1) * storey_h)
        out.append(k)
        base = ground + (k - 1) * storey_h
        if top_left <= REFUGE_FLOOR_SPACING:
            break
    return out
