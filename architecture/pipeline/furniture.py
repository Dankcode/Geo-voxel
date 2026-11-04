"""Our own furniture and fixture library, modelled procedurally in FreeCAD Part (no game assets).

Every item is built in a local frame: x along its back wall (0 … L), y away from the wall (0 … D), z up, units mm.
`ITEMS[name] = (L, D, builder)`; builder() → [(shape, colour)]. Placement rules per room kind live in ROOM_ITEMS.
"""
import Part
from FreeCAD import Vector as V

WOOD, OAK, WHITE, LINEN, FABRIC, DARK, METAL, CERAMIC, GLASSC, GREEN, RED, BLUEF = "#8a6446", "#b48a5e", "#f2f0ea", "#e9e4d8", "#5f7a8a", "#2e3236", "#a7adb2", "#f7f7f4", "#bcd8e0", "#4f7a46", "#9b3b32", "#3f5a7a"

def box(x, y, z, dx, dy, dz, c):
    return (Part.makeBox(dx, dy, dz, V(x, y, z)), c)

def cyl(x, y, z, r, h, c):
    return (Part.makeCylinder(r, h, V(x, y, z)), c)

def legs(L, D, h, t, c, inset=30):
    return [box(inset, inset, 0, t, t, h, c), box(L - inset - t, inset, 0, t, t, h, c), box(inset, D - inset - t, 0, t, t, h, c), box(L - inset - t, D - inset - t, 0, t, t, h, c)]

def chair(x, y, rot_back_y=True, c=WOOD):
    p = legs(450, 450, 450, 40, c, 0) + [box(0, 0, 450, 450, 450, 40, c)]
    p.append(box(0, 0, 490, 450, 40, 420, c) if rot_back_y else box(0, 410, 490, 450, 40, 420, c))
    return [(s.translated(V(x, y, 0)), col) for s, col in p]

def bed(L):
    D = 2050
    return lambda: [box(0, 0, 0, L, D, 280, WOOD), box(40, 60, 280, L - 80, D - 100, 230, LINEN), box(0, 0, 0, L, 70, 1000, WOOD),
                    box(120, 140, 510, L / 2 - 180, 420, 120, WHITE), box(L / 2 + 60, 140, 510, L / 2 - 180, 420, 120, WHITE),
                    box(40, 900, 470, L - 80, D - 1000, 70, BLUEF)]

def sofa():
    L, D = 2100, 900
    return [box(0, 0, 0, L, D, 420, FABRIC), box(0, 0, 420, L, 220, 420, FABRIC), box(0, 0, 420, 200, D, 230, FABRIC), box(L - 200, 0, 420, 200, D, 230, FABRIC),
            box(220, 230, 420, (L - 440) / 2 - 10, D - 250, 120, FABRIC), box(L / 2 + 10, 230, 420, (L - 440) / 2 - 10, D - 250, 120, FABRIC)]

def kitchen_run(L, uppers=True):
    def b():
        p = [box(0, 0, 0, L, 600, 880, WHITE), box(0, 0, 880, L, 620, 40, DARK)] + ([box(0, 0, 1450, L, 350, 700, WHITE)] if uppers else [])
        if L >= 1800:
            p += [box(L * 0.35, 120, 860, 600, 420, 62, METAL), box(L * 0.7, 80, 920, 600, 520, 8, DARK)]
        return p
    return b

def table_with_chairs(L, D, n_side):
    def b():
        p = legs(L, D, 720, 60, OAK) + [box(0, 0, 720, L, D, 40, OAK)]
        step = L / n_side
        for i in range(n_side):
            cx = i * step + step / 2 - 225
            p += chair(cx, -380, rot_back_y=True) + chair(cx, D - 70, rot_back_y=False)
        return [(s.translated(V(0, 450, 0)), c) for s, c in p]
    return b

def desk_set():
    p = legs(1400, 700, 720, 50, OAK) + [box(0, 0, 720, 1400, 700, 30, OAK), box(450, 80, 750, 520, 40, 330, DARK), box(650, 120, 750, 120, 120, 20, DARK)]
    p += chair(475, 820, rot_back_y=False, c=DARK)
    return p

def shelf(L, H=2000, D=350, c=WOOD):
    def b():
        p = [box(0, 0, 0, 25, D, H, c), box(L - 25, 0, 0, 25, D, H, c), box(0, 0, 0, L, 15, H, c)]
        for k in range(5): p.append(box(0, 0, k * H / 5, L, D, 22, c))
        p.append(box(0, 0, H - 22, L, D, 22, c))
        for k in range(4): p.append(box(60, 40, k * H / 5 + 22, L - 120, D - 80, H / 5 * 0.6, [RED, BLUEF, GREEN, "#c49a4a"][k % 4]))
        return p
    return b

def gondola():
    L, D, H = 2400, 1000, 1600
    p = [box(0, 480, 0, L, 40, H, METAL)]
    for k in range(4):
        z = 150 + k * 360
        p += [box(0, 0, z, L, 480, 20, METAL), box(0, 520, z, L, 480, 20, METAL),
              box(40, 40, z + 20, L - 80, 400, 220, [RED, "#e0b23c", BLUEF, GREEN][k]), box(40, 560, z + 20, L - 80, 400, 220, [GREEN, RED, "#e0b23c", BLUEF][k])]
    return p

def pew(L):
    return lambda: [box(0, 0, 0, 60, 600, 900, WOOD), box(L - 60, 0, 0, 60, 600, 900, WOOD), box(0, 120, 430, L, 420, 50, WOOD), box(0, 480, 430, L, 60, 500, WOOD)]

def toilet():
    return [box(50, 0, 0, 300, 200, 780, CERAMIC), cyl(200, 420, 0, 180, 400, CERAMIC), box(60, 200, 380, 280, 400, 30, WHITE)]

def vanity():
    return [box(0, 0, 0, 800, 500, 820, WOOD), box(0, 0, 820, 800, 520, 40, CERAMIC), box(150, 0, 1050, 500, 20, 700, GLASSC)]

def bathtub():
    o = Part.makeBox(1700, 750, 560); i = Part.makeBox(1560, 610, 520, V(70, 70, 60))
    return [(o.cut(i), CERAMIC)]

def shower():
    """900 × 900 shower: tray, glass screens on the two open sides, head rail (audit: substitute for a bathtub)."""
    return [box(0, 0, 0, 900, 900, 60, CERAMIC), box(0, 880, 60, 900, 10, 1950, GLASSC), box(880, 0, 60, 10, 880, 1950, GLASSC), box(420, 0, 1900, 60, 120, 40, METAL)]

# Static sedan at the size of a real one: 2025 Toyota Camry (XV80), 4920 × 1840 × 1445 mm, wheelbase 2825 mm,
# front overhang 995 mm, rear overhang 1090 mm, 2120 mm across the mirrors. Local frame: x = 0 rear bumper → x = 4920
# front bumper, y across (0 … 1840, mirrors overhang 140 mm each side), z up; tail lights red at x = 0, headlights at
# the front, so the parked direction reads in the model.
CAR = dict(L=4920, W=1840, H=1445, wheelbase=2825, front_oh=995, rear_oh=1090, mirrors=2120)
def car():
    L, W, H = CAR["L"], CAR["W"], CAR["H"]; ra, fa = CAR["rear_oh"], CAR["rear_oh"] + CAR["wheelbase"]
    body = "#3d5a80"
    p = [box(0, 0, 150, L, W, 650, body),                                    # lower body, 150 mm ground clearance
         box(1250, 110, 800, 2150, W - 220, H - 800, GLASSC),                # cabin / glasshouse
         box(1350, 160, H - 40, 1950, W - 320, 40, body),                    # roof
         box(0, 160, 560, 25, 300, 140, RED), box(0, W - 460, 560, 25, 300, 140, RED),          # tail lights (rear)
         box(L - 25, 150, 600, 25, 320, 110, "#f4f1d0"), box(L - 25, W - 470, 600, 25, 320, 110, "#f4f1d0"),   # headlights (front)
         box(3200, -140, 850, 160, 140, 110, body), box(3200, W, 850, 160, 140, 110, body)]     # mirrors (2120 mm overall)
    for x in (ra, fa):
        for y in (-10, W - 220):
            p.append((Part.makeCylinder(340, 230, V(x, y, 340), V(0, 1, 0)), DARK))
    return p


def plant():
    return [cyl(200, 200, 0, 170, 380, "#a05a3c"), (Part.makeSphere(330, V(200, 200, 720)), GREEN)]

def rack(L):
    def b():
        p = []
        for x in (0, L - 100): p += [box(x, 0, 0, 100, 1100, 4200, "#c9622f")]
        for k in range(4):
            z = 300 + k * 1000
            p += [box(0, 0, z, L, 1100, 120, "#30577a"), box(150, 50, z + 120, L - 300, 1000, 700, "#c9a26b")]
        return p
    return b

def counter(L, H=1080):
    return lambda: [box(0, 0, 0, L, 700, H, WOOD), box(0, -40, H, L, 780, 40, DARK)]

def classroom_desk():
    p = legs(700, 500, 720, 30, METAL) + [box(0, 0, 720, 700, 500, 25, OAK)] + chair(125, 560, rot_back_y=False, c=BLUEF)
    return p

def washer():
    return [box(0, 0, 0, 600, 600, 850, WHITE), cyl(300, 600, 300, 180, 10, DARK), box(650, 0, 0, 600, 600, 850, WHITE)]

def wardrobe():
    return [box(0, 0, 0, 1200, 600, 2000, OAK), box(598, 598, 100, 4, 4, 1800, DARK)]

def nightstand():
    return [box(0, 0, 0, 450, 400, 550, OAK)]

def tv_unit():
    return [box(0, 0, 0, 1600, 450, 500, OAK), box(250, 150, 500, 1100, 50, 650, DARK)]

def armchair():
    return [box(0, 0, 0, 850, 850, 420, FABRIC), box(0, 0, 420, 850, 200, 400, FABRIC), box(0, 0, 420, 150, 850, 220, FABRIC), box(700, 0, 420, 150, 850, 220, FABRIC)]

def coffee_table():
    return legs(1100, 600, 380, 40, OAK) + [box(0, 0, 380, 1100, 600, 40, OAK)]

def altar():
    return [box(0, 0, 0, 2200, 900, 1000, "#e9e2d0"), box(-50, -50, 1000, 2300, 1000, 40, "#c9a54c")]

def pallet_stack():
    return [box(0, 0, 0, 1200, 1000, 150, "#b48a5e"), box(50, 50, 150, 1100, 900, 1000, "#c9a26b")]

def reception():
    return counter(2600, 1100)()

def whiteboard():
    return [box(0, 0, 900, 3000, 30, 1200, WHITE), box(0, 0, 880, 3000, 80, 20, METAL)]

def fridge():
    return [box(0, 0, 0, 750, 700, 1850, METAL)]

ITEMS = {
    "bed_double": (1600, 2050, bed(1600)), "bed_single": (950, 2050, bed(950)), "nightstand": (450, 400, nightstand), "wardrobe": (1200, 600, wardrobe),
    "sofa": (2100, 900, sofa), "armchair": (850, 850, armchair), "coffee_table": (1100, 600, coffee_table), "tv_unit": (1600, 450, tv_unit),
    "kitchen_run": (3000, 620, kitchen_run(3000)), "kitchen_short": (1800, 620, kitchen_run(1800)), "fridge": (750, 700, fridge),
    "kitchen_run_low": (3000, 620, kitchen_run(3000, uppers=False)), "kitchen_short_low": (1800, 620, kitchen_run(1800, uppers=False)),
    "dining_table": (1600, 1800, table_with_chairs(1600, 900, 2)), "cafe_table": (800, 1600, table_with_chairs(800, 800, 1)),
    "desk": (1400, 1300, desk_set), "bookshelf": (900, 350, shelf(900)), "toilet": (400, 650, toilet), "vanity": (800, 520, vanity), "bathtub": (1700, 750, bathtub), "shower": (900, 900, shower),
    "washer": (1250, 600, washer), "gondola": (2400, 1000, gondola), "wall_shelf": (2400, 500, shelf(2400, 2100, 500, METAL)), "checkout": (1600, 820, counter(1600, 900)),
    "pew": (4000, 600, pew(4000)), "pew_short": (2600, 600, pew(2600)), "altar": (2200, 900, altar), "class_desk": (700, 1100, classroom_desk),
    "teacher_desk": (1400, 1300, desk_set), "whiteboard": (3000, 80, whiteboard), "rack": (2700, 1100, rack(2700)), "pallets": (1200, 1000, pallet_stack),
    "car": (4920, 1840, car), "end_table": (450, 450, nightstand), "porch_chair": (850, 850, armchair), "plant": (400, 400, plant), "reception": (2600, 780, reception), "meeting_table": (2400, 1900, table_with_chairs(2400, 1100, 3)),
    "service_counter": (3000, 780, counter(3000, 1000)),
}

# per room kind: (item, mode) — wall: back against a wall; centre: in the middle; grid: rows filling the room; corner
ROOM_ITEMS = {
    "living": [("sofa", "wall"), ("tv_unit", "wall"), ("armchair", "wall"), ("coffee_table", "centre"), ("plant", "corner")],
    "bedroom": [("bed_double", "wall"), ("wardrobe", "wall"), ("nightstand", "wall")],
    "kitchen": [("kitchen_run", "wall"), ("fridge", "wall"), ("kitchen_short", "wall")], "kitchen_pro": [("kitchen_run", "wall"), ("kitchen_run", "wall"), ("fridge", "wall")],
    "dining": [("dining_table", "centre")], "bathroom": [("toilet", "wall"), ("vanity", "wall"), ("bathtub", "wall")], "wc": [("toilet", "wall"), ("vanity", "wall")],
    "wc_block": [("toilet", "wall"), ("toilet", "wall"), ("vanity", "wall"), ("vanity", "wall")],
    "study": [("desk", "wall"), ("bookshelf", "wall")], "utility": [("washer", "wall"), ("wall_shelf", "wall")], "office": [("desk", "wall"), ("bookshelf", "wall"), ("plant", "corner")],
    "open_office": [("desk", "grid")], "meeting": [("meeting_table", "centre"), ("whiteboard", "wall")], "lobby": [("reception", "wall"), ("sofa", "wall"), ("plant", "corner")],
    "staff": [("dining_table", "centre"), ("kitchen_short", "wall")], "sales": [("checkout", "wall"), ("wall_shelf", "wall"), ("gondola", "grid")],
    "storage": [("wall_shelf", "wall"), ("wall_shelf", "wall"), ("pallets", "centre")], "stockroom": [("rack", "grid")], "warehouse": [("rack", "grid")],
    "loading": [("pallets", "grid")], "dining_room": [("service_counter", "wall"), ("cafe_table", "grid")], "nave": [("pew", "grid")],
    "chancel": [("altar", "centre")], "sacristy": [("wardrobe", "wall"), ("bookshelf", "wall")], "narthex": [("plant", "corner")],
    "classroom": [("whiteboard", "wall"), ("teacher_desk", "wall"), ("class_desk", "grid")], "library": [("bookshelf", "wall"), ("bookshelf", "wall"), ("dining_table", "grid")],
    "garage": [("car", "centre")], "bay": [("car", "centre")], "chamber": [("meeting_table", "centre"), ("pew_short", "grid")], "gallery_room": [("plant", "corner"), ("bookshelf", "wall")],
    "foyer": [("plant", "corner")], "porch": [("porch_chair", "wall"), ("porch_chair", "wall"), ("plant", "corner")],
}
