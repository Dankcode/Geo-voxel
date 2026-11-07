"""Architectural programs (paper §4) for every archetype the map has: a hand-specified Bayesian network per family —
ordered conditional choices, each conditioned on the brief (usable area per storey, storeys, style) and on the
choices before it. Logged, so every room can be traced to a choice and its probability.

Garage (2026-10-30): min_side 3.4 m, long_min 6.4 m so a 2025 Camry (4920 × 1840 mm) parks nose-in, rear 300 mm inside the
door, 600 mm walkway in front, 400/600 mm beside it.
Room flags: tier (porch/public/semi/circulation/service/private), mu/sigma target area (m²), daylight, private, wet,
exterior_access (needs its own outside wall: garages, loading), open_air (porch: roofed, no walls), stair (pinned on
every storey), max_aspect, min_side (m).
"""
import json, math

BASE = dict(living=20, dining=12, kitchen=12, bedroom=12, master=15, bathroom=5.5, wc=3.0, study=9, utility=4.5, garage=24,
            foyer=6, hall=None, corridor=None, stair=None, sales=None, storage=14, office=11, meeting=16, open_office=None,
            lobby=18, nave=None, narthex=14, chancel=26, sacristy=10, classroom=62, library=70, staff=18, wc_block=16, unit=None,
            dining_room=None, kitchen_pro=20, stockroom=None, loading=None, warehouse=None, bay=19, chamber=90, gallery_room=60)

FLAGS = {
    "living": dict(daylight=1), "dining": dict(daylight=1), "kitchen": dict(daylight=1, wet=1), "bedroom": dict(daylight=1, private=1),
    "bathroom": dict(wet=1, private=1, max_aspect=2.4, min_side=1.6), "wc": dict(wet=1, max_aspect=3, min_side=1.1), "study": dict(daylight=1),
    "utility": dict(wet=1, min_side=1.4), "garage": dict(exterior_access=1, min_side=3.4, long_min=6.4, max_aspect=2.2), "foyer": dict(min_side=1.6),
    "hall": dict(min_side=1.1), "corridor": dict(min_side=1.5), "porch": dict(open_air=1, min_side=1.8, max_aspect=12),
    "sales": dict(daylight=1, min_side=4), "storage": dict(min_side=2), "office": dict(daylight=1), "meeting": dict(daylight=1),
    "open_office": dict(daylight=1, min_side=4, max_aspect=3), "lobby": dict(daylight=1), "nave": dict(daylight=1, min_side=7, max_aspect=3.2),
    "narthex": dict(min_side=2.4, max_aspect=5), "chancel": dict(daylight=1, min_side=4), "sacristy": dict(), "classroom": dict(daylight=1, min_side=6),
    "library": dict(daylight=1, min_side=6), "staff": dict(daylight=1), "wc_block": dict(wet=1, min_side=2.4), "dining_room": dict(daylight=1, min_side=4),
    "kitchen_pro": dict(wet=1, min_side=3), "stockroom": dict(min_side=3), "loading": dict(exterior_access=1, min_side=4),
    "warehouse": dict(min_side=6, max_aspect=4), "bay": dict(exterior_access=1, min_side=2.8, max_aspect=3), "chamber": dict(daylight=1, min_side=7),
    "gallery_room": dict(daylight=1, min_side=5), "unit": dict(daylight=1, min_side=4.5, max_aspect=2.6), "stair": dict(),
}


class Prog:
    def __init__(self, R, brief):
        self.R, self.b, self.rooms, self.edges, self.log = R, brief, [], [], []
        self.entry = None
        self.extra = {}

    def room(self, kind, storey, tier, mu=None, **kw):
        r = {"id": len(self.rooms), "kind": kind, "storey": storey, "tier": tier, **FLAGS.get(kind, {}), **kw}
        base = BASE.get(kind)
        if mu is None and base: mu = base
        if mu: r["mu"], r["sigma"] = mu, 0.3 * mu
        self.rooms.append(r)
        return r

    def link(self, a, b, kind="door"):
        self.edges.append({"a": a["id"], "b": b["id"], "type": kind})

    def chance(self, p, what):
        v = self.R.next() < p
        self.log.append(f"{what}: p={p:.2f} → {'yes' if v else 'no'}")
        return v

    def choose(self, what, value):
        self.log.append(f"{what} → {value}")
        return value

    def scale(self, storey, usable, share=0.8):
        """Scale the sized rooms of one storey so they fill `share` of its usable area (halls/stairs/porches take the rest)."""
        rs = [r for r in self.rooms if r["storey"] == storey and r.get("mu") and not r.get("fixed")]
        tot = sum(r["mu"] for r in rs)
        if not tot: return
        f = max(0.55, min(2.2, share * usable / tot))
        for r in rs:
            cap = 1.25 if r["kind"] in ("bathroom", "wc", "utility") else 9
            r["mu"] *= min(f, cap); r["sigma"] = 0.3 * r["mu"]

    def done(self, stair_m=(2.4, 3.2), cell=0.4, **extra):
        stair_m = self.extra.pop("stair_m", stair_m)
        # 2026-11-02, Merrell 2010 §5.2: the dimension cost C_d sums over EVERY room of the programme, halls included
        # (only the shape cost exempts halls and stairs, through h_i). Our halls had no area distribution (mu=None), so
        # nothing stopped a hall absorbing what the sized rooms left (Quail Oak design 2: a 70 m², 7.5 × 21 m "hall").
        # A hall's area follows the doors it serves: ~0.9 m of hall per door with doors on both sides, plus 1.5 m of
        # ends, at a 1.1 m clear width (IRC R311.6: hallways ≥ 36 in / 914 mm; 1.1 m is the common built width).
        if HALL_RULE:
            for r in self.rooms:
                if r["kind"] in ("hall", "corridor", "landing") and not r.get("mu"):
                    n = sum(1 for e in self.edges if r["id"] in (e["a"], e["b"]))
                    r["mu"] = round(1.1 * (0.9 * n + 1.5), 1); r["sigma"] = round(0.35 * r["mu"], 1)
                    r["max_width"] = 2.0                     # corridor, not a room: ≤ 2 m clear away from the stair landing
                    self.log.append(f"hall area | serves {n} rooms → μ = {r['mu']} m² (C_d, Merrell §5.2), width ≤ 2.0 m")
        return {"rooms": self.rooms, "edges": self.edges, "entry": self.entry["id"], "log": self.log, "stair_size": (int(math.ceil(stair_m[0] / cell)), int(math.ceil(stair_m[1] / cell))), **self.extra, **extra}


import os as _os_p
HALL_RULE = _os_p.environ.get("HALL_RULE", "1") == "1"
FACTS_RULE = _os_p.environ.get("FACTS", "1") == "1"


def stair_pair(P, storeys, halls, link_kind="open"):
    st = [P.room("stair", s, "circulation", stair=1) for s in range(storeys)]
    for s, h in enumerate(halls):
        if h is not None: P.link(st[s], h, link_kind)
    return st


# ------------------------------------------------------------------------------------------------ dwellings
def garage_room(P, A, cars=None):
    """A garage is sized by its cars, not scaled with the house (revision 2026-10-30): one bay 3.4 × 6.4 m per 2025
    Camry-size sedan, two bays from 170 m² of footprint and a frontage of 12 m or more (6.0 m clear width, a 4.9 m / 16 ft door)."""
    fr = P.b.get("frontage") or 0
    cars = P.choose("garage bays | footprint m², frontage", cars or (2 if (A >= 170 and fr >= 12.0) else 1))     # two bays need ~6 m of a ≥ 12 m front
    return P.room("garage", 0, "service", mu=22.0 * cars, fixed=1, cars=cars, min_side=3.4 if cars == 1 else 6.0)


def dwelling(P, A, S, arch, style):
    # porches (Merrell 2010 Fig. 1, 7: a programme room with outside access; C_a requires it): every style gets one, from a mapped porch when OSM has it
    # (building=porch / roof or building:part=porch touching the house), else by style — mid-century ranches get the
    # covered entry stoop they are built with, Louisiana cottages a full gallery
    porch_styles = {"creole": "full", "shotgun": "full", "craftsman": "partial", "queen_anne": "wrap", "neoclassical": "portico", "colonial_revival": "portico", "italianate": "partial", "midcentury": "stoop", "contemporary_house": "stoop", "italian_renaissance": "partial"}
    porch = porch_styles.get(style, "partial")
    mapped = P.b.get("porch_mapped")
    rooms = {}
    if mapped or P.chance({"full": 0.95, "wrap": 0.9, "partial": 0.8, "portico": 0.75, "stoop": 0.85}.get(porch, 0.6), f"front porch ({porch}) | style {style}"):
        if mapped: P.log.append(f"front porch | OSM {mapped['tag']} way {mapped['id']}, {mapped['area']:.0f} m² → yes"); porch = "partial" if porch == "stoop" else porch
        dep = 2.4 if porch in ("full", "wrap") else 1.8 if porch == "stoop" else 2.0
        span_ = {"full": 0.92, "wrap": 0.92, "partial": 0.45, "portico": 0.35, "stoop": 0.3}.get(porch, 0.4)
        # 2026-11-02 (Merrell §5.2: C_d for every room): a porch has an area too — its depth × its share of the frontage
        # (before μ = None, so a porch absorbed the leftover front of the lot: 38 m² porches with roofless columns)
        pmu = round(dep * span_ * (P.b.get("frontage") or 10.0), 1) if HALL_RULE else None
        rooms["porch"] = P.room("porch", 0, "porch", mu=pmu, span=span_, band=dep + 0.4, fixed=1)
        P.entry = rooms["porch"]
        P.extra["porch_depth"] = dep
    if arch == "shotgun":
        # rooms in a row, front to back: the defining plan of a shotgun house (no hall)
        n = P.choose("rooms in the row | depth", max(3, min(5, int(A / 14))))
        chain = [P.room("living", 0, "public")] + [P.room("bedroom", 0, "private") for _ in range(n - 2)] + [P.room("kitchen", 0, "semi")]
        for a, b in zip(chain, chain[1:]): P.link(a, b)
        bath = P.room("bathroom", 0, "private"); P.link(chain[-1], bath)
        if "porch" in rooms: P.link(rooms["porch"], chain[0])
        else: P.entry = chain[0]
        P.extra["privacy"] = False
        if S > 1:   # camelback: a second storey over the back rooms only
            st = stair_pair(P, 2, [chain[-2], None])
            up = [P.room("bedroom", 1, "private"), P.room("bathroom", 1, "private")]
            P.link(st[1], up[0]); P.link(up[0], up[1])
            P.extra["upper_cover"] = {1: 0.45}
        P.scale(0, A, 0.82)
        return
    if arch == "cottage" and style == "creole":
        # Creole cottage: four rooms two-by-two without a hall, both front rooms open onto the gallery, small rear cabinets
        salle, front_bed = P.room("living", 0, "public"), P.room("bedroom", 0, "private")
        back_bed, kitchen = P.room("bedroom", 0, "private"), P.room("kitchen", 0, "semi")
        P.link(salle, front_bed); P.link(salle, kitchen); P.link(front_bed, back_bed); P.link(kitchen, back_bed)
        bath = P.room("bathroom", 0, "private"); P.link(back_bed, bath)
        if "porch" in rooms: P.link(rooms["porch"], salle); P.link(rooms["porch"], front_bed)
        else: P.entry = salle
        P.extra["privacy"] = False
        if P.chance(0.45 if A > 90 else 0.15, "rear cabinet (utility) | area"): u = P.room("utility", 0, "service"); P.link(kitchen, u)
        P.scale(0, A, 0.85)
        return
    # hall-plan houses: bungalow, craftsman/Queen Anne cottage, ranch, two-storey, townhouse
    up = S > 1
    living = P.room("living", 0, "public")
    if "porch" in rooms: P.link(rooms["porch"], living if not up else (foyer := P.room("foyer", 0, "circulation")))
    else:
        if up: foyer = P.room("foyer", 0, "circulation"); P.entry = foyer
        else: P.entry = living
    if up: P.link(foyer, living, "open")
    kitchen = P.room("kitchen", 0, "semi")
    P.link(living, kitchen, "open" if P.chance(0.55 if style in ("midcentury", "contemporary_house") else 0.3, "living–kitchen open plan | style") else "door")
    # bedrooms from gross living area (garage wing excluded): ~55 m² of single-storey house per bedroom (halls, porch and wet rooms included),
    # ~40 m² of upper floor per bedroom — the usual 3–4 bedrooms for a 150–220 m² suburban house
    gross = A - (40 if P.b.get("gen_shape") == "L" else 0)
    F = P.b.get("facts") if FACTS_RULE else None
    if F is not None:
        # 2026-11-02: the real house (house_facts.py) — recorded living area and room counts, else the street's own
        # listings — instead of the footprint alone (the footprint-only rule gave Quail Oak 5 bedrooms and 4,736 sq ft
        # against a recorded 1,838 sq ft and 3-bed street comps)
        import house_facts as HF
        cars_ = F.get("garage_cars") or 0
        porch_m2 = 0.0
        if "porch" in rooms: porch_m2 = rooms["porch"].get("span", 0.4) * (P.b.get("frontage") or 10) * P.extra.get("porch_depth", 2.0)
        ground_living = max(40.0, gross - porch_m2 - (22.0 * cars_ if cars_ else 0.0))
        if up:
            if F.get("living_sqft"):
                cover = (F["living_sqft"] / HF.SQFT_M2 - ground_living) / ground_living
                P.extra["upper_cover_real"] = round(cover, 2)
                cover = min(1.0, max(0.45, cover))
                why = f"recorded {F['living_sqft']} sq ft − ground floor {ground_living:.0f} m²"
            else: cover = HF.UPPER_DEFAULT; why = "no record → regional default"
            P.extra["upper_cover_rule"] = (round(cover, 2), why)
        living_est = F.get("living_sqft") or round((ground_living * (1 + (P.extra["upper_cover_rule"][0] if up else 0))) * HF.SQFT_M2)
        nb = P.choose("bedrooms | public record or street listings", F.get("beds") or HF.beds_for(living_est))
        P.log.append(f"real house | {F['address']}: " + "; ".join(F["source"][:2]))
    else:
        per = 40 if up else 55
        beds_area = gross * 0.9 if up else gross
        nb = P.choose("bedrooms | gross area", max(1, min(5, int(round(beds_area / per + P.R.next() * 0.6 - 0.3)))))
    if P.chance(0.8 if nb >= 3 else 0.35, "dining room | bedrooms"):
        dining = P.room("dining", 0, "public"); P.link(dining, kitchen, "open" if P.chance(0.4, "dining–kitchen open") else "door"); P.link(living, dining, "open")
        # round 5 (2026-11-02): living, dining and kitchen form one public group — any two of the three links join it
        # (Merrell's programme graphs are near-trees; a required triangle over-constrains narrow lots: Quail Oak 1–3)
        for e in P.edges:
            if {e["a"], e["b"]} <= {living["id"], dining["id"], kitchen["id"]}: e["cluster"] = "public"
    if F is not None and F.get("garage_cars"):
        P.log.append(f"attached garage | street listings: {F['garage_cars']}-car garage")
        g = garage_room(P, A, cars=F["garage_cars"]); P.link(kitchen, g)
    elif P.b.get("gen_shape") == "L":
        P.log.append("attached garage → yes (the lot generator drew a garage wing and driveway)")
        g = garage_room(P, A); P.link(kitchen, g)
    elif arch == "ranch" and P.chance(0.75, "attached garage | ranch"):
        g = garage_room(P, A); P.link(kitchen, g)
    elif arch == "two_storey_house" and A >= 110 and P.chance(0.5, "attached garage | two-storey house, footprint ≥ 110 m²"):
        g = garage_room(P, A); P.link(kitchen, g)
    if P.chance(0.55 if A > 110 else 0.2, "laundry | area"): u = P.room("utility", 0, "service"); P.link(kitchen, u)
    S_b = 1 if up else 0
    hall = P.room("hall", S_b, "circulation", mu=None)
    if not up: P.link(living, hall, "open")
    beds = [P.room("bedroom", S_b, "private", mu=BASE["master"] if i == 0 else None) for i in range(nb)]
    for b in beds: P.link(hall, b)
    bath = P.room("bathroom", S_b, "private"); P.link(hall, bath)
    if F is not None and F.get("baths_full"):
        if F["baths_full"] >= 2 and nb >= 2: en = P.room("bathroom", S_b, "private"); P.link(beds[0], en); P.log.append("ensuite | record: 2 full baths")
    elif nb >= 3 and P.chance(0.7, "ensuite | bedrooms ≥ 3"): en = P.room("bathroom", S_b, "private"); P.link(beds[0], en)
    if up:
        # revision (2026-10-30, Merrell 2010 §5.2 / §6): the upper floor fills the whole floor below (the map says the
        # footprint is two storeys), and the stair space is a narrow rectangle, so §6 lays out one straight flight
        cov = P.extra.pop("upper_cover_rule", None)
        if cov:
            # 2026-11-02: the upper floor is as big as the recorded living area says (a 1.5-storey Louisiana house
            # often has its upper floor over part of the ground floor), never less than 45 % for a mapped 2-storey
            P.extra["upper_cover"] = {1: cov[0]}
            P.log.append(f"upper floor | {cov[1]} → covers {cov[0]:.0%} of the floor below")
        else:
            P.extra["upper_cover"] = {1: 1.0}
            P.log.append("upper floor | building:levels = 2 → covers the whole floor below")
        P.extra["stair_m"] = (1.2, 4.8)
        P.log.append("stair space | two storeys → 1.2 × 4.8 m, one straight flight (§6)")
        up_m2 = A * P.extra["upper_cover"][1]
        if up_m2 > 150 and P.chance(0.7, "upstairs family room | upper floor > 150 m²"): fam = P.room("living", 1, "semi"); P.link(hall, fam, "open")
        if F is not None and F.get("baths_full") is not None:
            if F["baths_full"] >= 3: b2 = P.room("bathroom", 1, "private"); P.link(hall, b2)
        elif nb >= 3 and A > 130: b2 = P.room("bathroom", 1, "private"); P.link(hall, b2)
        if F is None or F.get("baths_half", 1): wc = P.room("wc", 0, "service"); P.link(foyer, wc)
        if P.chance(0.5 if A > 80 else 0.2, "study | area"): st_ = P.room("study", 0, "semi"); P.link(foyer, st_)
        stair_pair(P, 2, [foyer, hall])
        P.scale(1, A * P.extra["upper_cover"][1], 0.8)
    elif P.chance(0.4 if A > 150 else 0.1, "study | area"): st_ = P.room("study", 0, "semi"); P.link(living, st_)
    P.scale(0, A, 0.8)


# ------------------------------------------------------------------------------------------------ the rest
def apartments(P, A, S):
    P.extra["layout"] = "double_loaded"
    unit_m2 = P.choose("unit size m² | building", 58 if A > 320 else 48)
    lobby = P.room("lobby", 0, "public", mu=14); P.entry = lobby
    halls = []
    for s in range(S):
        c = P.room("corridor", s, "circulation"); halls.append(c)
        if s == 0: P.link(lobby, c, "open")
        n = max(2, int((A - (14 if s == 0 else 0) - 18) * 0.82 / unit_m2))
        P.log.append(f"units on storey {s + 1} | {A:.0f} m² → {n}")
        for _ in range(n): u = P.room("unit", s, "private", mu=unit_m2, detached=0); P.link(c, u)
    stair_pair(P, S, halls)
    for s in range(S): P.scale(s, A, 0.8)


def storefront(P, A, S, style, use):
    flats = []
    front = P.room("dining_room" if use in ("restaurant", "cafe", "fast_food", "bar") else "sales", 0, "public", mu=A * 0.6); P.entry = front
    back = P.room("kitchen_pro" if front["kind"] == "dining_room" else "storage", 0, "service")
    P.link(front, back)
    wc = P.room("wc", 0, "service"); P.link(back if A < 120 else front, wc)
    if A > 90: o = P.room("office", 0, "semi", mu=9); P.link(back, o)
    halls = [None]
    for s in range(1, S):
        flat = P.chance(0.6 if style == "italianate" else 0.35, f"upper storey {s + 1} is a flat | style")
        ten = f"flat{s + 1}" if flat else "main"
        # audit fix (2026-10-30): the hall has an area prior (~12 % of the floor for circulation, Merrell §5.2 C_d
        # covers every room), else it absorbed whatever the sized rooms left (a 491 m² "hall" beside a 68 m² office)
        h = P.room("hall", s, "circulation", mu=0.12 * A, tenancy=ten, fixed=1); halls.append(h)
        # audit fix (2026-10-30, score A1): the upper floor's room list follows its area (it was a fixed list, so a
        # 585 m² floor got two offices and a WC and a ~500 m² corridor — Σμ / usable area 0.08–0.22)
        if flat:
            flats.append(s)
            if A * 0.8 >= 140:            # a big upper floor holds several flats off a common hall (nested unit plans)
                # every flat needs a lit facade: a deep downtown floor between party walls is lit only at front and
                # back, so at most two flats per 12 m of street frontage (one on the street, one on the rear)
                fr = P.b.get("frontage") or 10.0
                n = max(2, min(int((A - 25) * 0.8 / (72 if A > 400 else 60)), 2 * max(1, int(fr // 12.0))))
                um = P.choose("flat size m² | floor, frontage", round((A - 25) * 0.8 / n))
                P.log.append(f"flats on storey {s + 1} | {A:.0f} m², {fr} m frontage → {n}")
                for _ in range(n): u = P.room("unit", s, "private", mu=um, tenancy=ten); P.link(h, u)
            else:
                nb = P.choose("bedrooms | floor m²", max(1, min(3, int(A * 0.8 / 40))))
                for k in ("living", "kitchen") + ("bedroom",) * nb + ("bathroom",):
                    r = P.room(k, s, "private" if k in ("bedroom", "bathroom") else "public", tenancy=ten); P.link(h, r)
        else:
            # cellular offices need a window: a floor lit only at front and back holds about one office per 3.5 m of
            # its frontage beside an open-plan room, which takes the rest of the floor
            fr = P.b.get("frontage") or 10.0
            n_off = P.choose("offices | floor m², frontage", max(2, min(int(A / 70), int(fr / 3.5))))
            if A > 160: oo = P.room("open_office", s, "semi", mu=max(A * 0.35, A * 0.78 - n_off * 16 - 30)); P.link(h, oo, "open")
            for _ in range(n_off): P.link(h, P.room("office", s, "semi"))
            if A > 120 and fr >= 20: P.link(h, P.room("meeting", s, "semi"))
            for _ in range(1 if A < 400 else 2): P.link(h, P.room("wc", s, "service", mu=4))
        P.scale(s, A, 0.78)
    if S > 1:
        # audit fix (2026-10-30): the stair to the upper floors has its own street door (the usual downtown two-storey
        # commercial plan); it is reached from the shop's back room only when every upper floor belongs to the shop
        st = stair_pair(P, S, halls[:1] + halls[1:])
        if flats:
            # a separate flat: the stair has its own street vestibule (the street door needs a landing inside it,
            # IRC R311.3, which the stair room — all treads — cannot give) and no way through the shop
            st[0]["tenancy"] = "common"
            vest = P.room("foyer", 0, "circulation", mu=4.5, street_door=1, tenancy="common", fixed=1); P.link(vest, st[0], "open")
            P.choose("upper floors reached by | tenancy", "own street vestibule (separate flat)")
        else:
            P.link(st[0], back); P.choose("upper floors reached by | tenancy", "the shop's back room (offices of the shop)")
    P.scale(0, A, 0.82)


def office(P, A, S, big=False):
    P.extra["layout"] = "double_loaded" if A > 250 else None
    halls = []
    for s in range(S):
        if s == 0: lobby = P.room("lobby", 0, "public"); P.entry = lobby; h = P.room("hall", 0, "circulation"); P.link(lobby, h, "open")
        else: h = P.room("hall", s, "circulation")
        halls.append(h)
        n_off = max(1, int(A / 70))
        if A > 160: oo = P.room("open_office", s, "semi", mu=A * 0.35); P.link(h, oo, "open")
        for _ in range(n_off): P.link(h, P.room("office", s, "semi"))
        if A > 120: P.link(h, P.room("meeting", s, "semi"))
        for _ in range(1 if A < 400 else 2): P.link(h, P.room("wc", s, "service", mu=4))
        P.scale(s, A, 0.8)
    if S > 1: stair_pair(P, S, halls)


def big_box(P, A):
    sales = P.room("sales", 0, "public", mu=A * 0.7); P.entry = sales
    stock = P.room("stockroom", 0, "service", mu=A * 0.18); P.link(sales, stock, "open")
    load = P.room("loading", 0, "service", mu=40); P.link(stock, load, "open")
    o = P.room("office", 0, "semi", mu=14); P.link(stock, o)
    for _ in range(2): P.link(sales, P.room("wc", 0, "service", mu=8))


def church(P, A, S, style):
    # liturgical order front → back: narthex on the street, then nave, then chancel
    nar = P.room("narthex", 0, "porch", mu=A * 0.1, band=5.5); P.entry = nar
    P.extra["porch_depth"] = 3.6
    nave = P.room("nave", 0, "public", mu=A * 0.62); P.link(nar, nave, "open")
    chan = P.room("chancel", 0, "public", mu=A * 0.14); P.link(nave, chan, "open")
    sac = P.room("sacristy", 0, "service", mu=max(8, A * 0.05)); P.link(chan, sac)
    if A > 400 and P.chance(0.6, "parish office / wc | area"):
        wc = P.room("wc", 0, "service"); P.link(nar, wc)


def school(P, A, S):
    P.extra["layout"] = "double_loaded"
    halls = []
    for s in range(S):
        h = P.room("corridor", s, "circulation"); halls.append(h)
        if s == 0:
            lob = P.room("lobby", 0, "public", mu=24); P.entry = lob; P.link(lob, h, "open")
            P.link(h, P.room("staff", 0, "semi"))
            if A > 900: P.link(h, P.room("library", 0, "public"))
        n = max(2, int(A * 0.62 / 62) - (1 if s == 0 else 0))
        P.log.append(f"classrooms on storey {s + 1} | {A:.0f} m² → {n}")
        for _ in range(n): P.link(h, P.room("classroom", s, "semi"))
        for _ in range(2 if A > 600 else 1): P.link(h, P.room("wc_block", s, "service"))
        P.scale(s, A, 0.8)
    if S > 1: stair_pair(P, S, halls)


def civic(P, A, S):
    P.extra["layout"] = "double_loaded"
    halls = []
    for s in range(S):
        if s == 0: lob = P.room("lobby", 0, "public", mu=A * 0.12); P.entry = lob; h = P.room("hall", 0, "circulation"); P.link(lob, h, "open")
        else: h = P.room("hall", s, "circulation")
        halls.append(h)
        main = P.room("chamber" if s == S - 1 else "gallery_room", s, "public", mu=A * 0.3); P.link(h, main, "open" if s == 0 else "door")
        for _ in range(max(1, int(A / 140))): P.link(h, P.room("office", s, "semi"))
        P.link(h, P.room("wc", s, "service", mu=6))
        P.scale(s, A, 0.8)
    if S > 1: stair_pair(P, S, halls)


def warehouse(P, A):
    hall = P.room("warehouse", 0, "service", mu=A * 0.8); P.entry = hall
    hall["exterior_access"] = 1
    o = P.room("office", 0, "semi", mu=min(30, A * 0.08)); P.link(hall, o)
    P.link(o, P.room("wc", 0, "service"))


def garage(P, A, frontage):
    n = P.choose("bays | frontage", max(1, int(frontage / 3.2)))
    bays = [P.room("bay", 0, "service", mu=A / n) for _ in range(n)]
    P.entry = bays[0]
    for b in bays: b["detached"] = 1


# ------------------------------------------------------------------------------------------------ user room counts
# 2026-11-06: the viewer's Regenerate panel sets room counts per storey (ROOMS_OVERRIDE, JSON):
#   {"0": {"bedroom": 1, "study": 1}, "1": {"bedroom": 4, "bathroom": 2}, "garage": 0 | 1 | 2}
# The programme is sampled as usual, then each storey gets exactly the counts asked for: extra rooms open off that
# storey's circulation (hall, landing, foyer, else the living room), surplus rooms are taken off the end of the list
# (the master bedroom and the entry stay). The planner, gate and build then run unchanged.
COUNT_KINDS = {"bedroom": "private", "bathroom": "private", "wc": "service", "study": "semi", "utility": "service",
               "dining": "public", "living": "semi", "kitchen": "semi"}


def _circulation(P, s):
    for kinds in (("hall", "landing", "corridor"), ("foyer",), ("living",)):
        r = next((r for r in P.rooms if r["storey"] == s and r["kind"] in kinds), None)
        if r: return r
    return next((r for r in P.rooms if r["storey"] == s and not r.get("stair")), None)


def _fresh(P, r):
    """An id no other room has (removals leave gaps, so len(rooms) may already be taken)."""
    return 1 + max((x["id"] for x in P.rooms if x is not r), default=-1)


def apply_counts(P, counts, A):
    if not counts: return
    S = 1 + max((r["storey"] for r in P.rooms), default=0)
    for sk, want in counts.items():
        if sk == "garage" or not isinstance(want, dict): continue
        s = int(sk)
        if s >= S:
            P.log.append(f"user counts | storey {s + 1} does not exist ({S} storeys) → ignored"); continue
        for kind, n in want.items():
            if kind not in COUNT_KINDS: continue
            n = max(0, min(8, int(n)))
            have = [r for r in P.rooms if r["storey"] == s and r["kind"] == kind]
            if len(have) < n:
                hub = _circulation(P, s)
                for _ in range(n - len(have)):
                    r = P.room(kind, s, COUNT_KINDS[kind]); r["id"] = _fresh(P, r)
                    if hub is not None: P.link(hub, r, "open" if kind in ("dining", "living") else "door")
            else:
                keep = [r for r in have if r is P.entry or r.get("mu") == BASE.get("master")][:1] if kind == "bedroom" else []
                drop = [r for r in reversed(have) if r not in keep and r is not P.entry][:len(have) - n]
                for r in drop: P.rooms.remove(r)
                gone = {r["id"] for r in drop}
                P.edges = [e for e in P.edges if e["a"] not in gone and e["b"] not in gone]
            P.log.append(f"user counts | storey {s + 1}: {kind} {len(have)} → {n}")
    if "garage" in counts:
        g = [r for r in P.rooms if r["kind"] == "garage"]
        cars = max(0, min(3, int(counts["garage"])))
        if cars == 0 and g:
            P.rooms = [r for r in P.rooms if r["kind"] != "garage"]
            gone = {r["id"] for r in g}; P.edges = [e for e in P.edges if e["a"] not in gone and e["b"] not in gone]
        elif cars and not g:
            k = next((r for r in P.rooms if r["kind"] == "kitchen"), None) or _circulation(P, 0)
            gr = garage_room(P, A, cars=cars); gr["id"] = _fresh(P, gr)
            if k is not None: P.link(k, gr)
        elif cars and g:
            g[0].update(cars=cars, mu=22.0 * cars, sigma=6.6 * cars, min_side=3.4 if cars == 1 else 6.0)
        P.log.append(f"user counts | garage → {cars} car(s)")
    # renumber, and give any room the removals left unconnected a door onto its storey's circulation
    old = {id(r): r["id"] for r in P.rooms}
    for i, r in enumerate(P.rooms): r["id"] = i
    newid = {old[id(r)]: r["id"] for r in P.rooms}
    P.edges = [dict(e, a=newid[e["a"]], b=newid[e["b"]]) for e in P.edges if e["a"] in newid and e["b"] in newid]
    linked = {e["a"] for e in P.edges} | {e["b"] for e in P.edges}
    for r in P.rooms:
        if r["id"] not in linked and r is not P.entry and not r.get("stair"):
            hub = _circulation(P, r["storey"])
            if hub is not None and hub is not r: P.link(hub, r); P.log.append(f"user counts | {r['kind']} reconnected to the {hub['kind']}")


def program_for(theme, brief, R):
    P = Prog(R, brief)
    a, S, A, st = theme["archetype"], theme["storeys"], brief["usable"], theme["style"]
    if a in ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse"):
        dwelling(P, A, S, a, st)
        ov = _os_p.environ.get("ROOMS_OVERRIDE")
        if ov: apply_counts(P, json.loads(ov), A)
    elif a == "apartments": apartments(P, A, S)
    elif a == "storefront": storefront(P, A, S, st, brief.get("use"))
    elif a == "office": office(P, A, S)
    elif a == "big_box": big_box(P, A)
    elif a == "church": church(P, A, S, st)
    elif a == "school": school(P, A, S)
    elif a == "civic": civic(P, A, S)
    elif a == "warehouse": warehouse(P, A)
    elif a == "garage": garage(P, A, brief["frontage"])
    elif a in ("canopy", "tank"): return None
    return P.done(cell=brief["cell"])


UNIT = lambda P, A: _unit(P, A)

def _unit(P, A, lit_m=None):
    """Plan inside one apartment: living-kitchen, 1–2 bedrooms, bath.
    lit_m: metres of the flat's outline that can take a window (exterior, not party, not corridor). Merrell §4
    conditions the programme on the requirements; for a flat between party walls the binding requirement is its lit
    facade, so the daylit rooms are capped at one per 3.4 m of it (2.4 m min room side, walls, the hall and stair share). The living group
    (kitchen and dining open to the living room, IRC R303.2) takes one slot."""
    living = P.room("living", 0, "public"); P.entry = living
    k = P.room("kitchen", 0, "semi"); P.link(living, k, "open")
    # audit fix (2026-10-30): the flat's rooms follow its area (fixed 1–2 bedrooms left a 300 m² flat with a
    # 180 m² hall); bedrooms ≈ one per 45 m², a dining room and a study in large flats, a second bathroom from 3
    # bedrooms, then every sized room is scaled so the list fills ~85 % of the flat
    nb = max(1, min(4, int(A / 45))) if A > 60 else 1
    slots = None
    if lit_m is not None:
        slots = max(1, int(lit_m // 3.4))
        nb = max(1, min(nb, slots - 1))
    nb = P.choose("unit bedrooms | m², lit facade", nb)
    h = P.room("hall", 0, "circulation", mu=max(4.0, 0.08 * A)) if nb > 1 else None
    if h: P.link(living, h, "open")
    if A > 110: P.link(living, P.room("dining", 0, "public"), "open")
    if A > 150 and (slots is None or slots - 1 - nb >= 1): P.link(h or living, P.room("study", 0, "semi"))
    for i in range(nb): P.link(h or living, P.room("bedroom", 0, "private"))
    P.link(h or living, P.room("bathroom", 0, "private"))
    if nb >= 3: P.link(h or living, P.room("bathroom", 0, "private"))
    P.scale(0, A, 0.85)
    P.extra["privacy"] = False
    P.scale(0, A, 0.82)
