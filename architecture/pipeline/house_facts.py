"""What public records and listings say about the competition houses (gathered 2026-11-02), keyed by OSM way id.
The programme (programs.dwelling) sizes bedrooms, baths, garage bays and the upper floor from these instead of from the
footprint alone; `source` says where each figure comes from. Street comps are recent listings on the same street, used
where the house itself has no public record.

Bedroom thresholds by living area (BEDS_BY_SQFT) come from the same listings: every Quail Oak Dr listing of
1,979–2,611 sq ft is 3 bed; Beau Pré (Ducros Dr) 1,352–1,550 sq ft is 3 bed; 2,734–2,875 sq ft listings nearby are
4 bed; 2,804 and 3,626 sq ft listings are 5 bed."""

SQFT_M2 = 10.7639

BEDS_BY_SQFT = ((1100, 2), (2650, 3), (3300, 4), (10 ** 9, 5))


def beds_for(sqft):
    for top, n in BEDS_BY_SQFT:
        if sqft <= top: return n
    return 5


FACTS = {
    905235809: dict(
        address="2116 Quail Oak Dr, Baton Rouge, LA 70808",
        living_sqft=1838, beds=3, baths_full=2, baths_half=1, garage_cars=2, built="1984–1994 (street)",
        source=["Compass, 2131 Quail Oak Dr page, nearby-homes table: 2116 Quail Oak Dr 1,838 sq ft",
                "Compass, 2131 Quail Oak Dr: 3 bed, 3 bath, 2-car garage (426 sq ft), Quail Oaks subdivision",
                "Street comps 2104–2168 Quail Oak Dr (Century 21, Coldwell Banker, Compass): all 3 bed, 2–3 bath"],
        note="Living area from the record; bedrooms, baths and the two-car garage from the street's own listings "
             "(3 baths on these two-storey garden homes = 2 full upstairs + a half bath down)."),
    1488640044: dict(
        address="301 Stanford Ave, Baton Rouge, LA 70808",
        living_sqft=2184, beds=None, baths_full=2, baths_half=1, garage_cars=None, built=None,
        source=["Spokeo street listing: 301 Stanford Ave, 2,184 sq ft single family residence",
                "Street comps: 353 Stanford Ave 3 bed / 2 bath 1,815 sq ft; 482 Stanford 3 bed / 2 bath 1,783 sq ft"],
        note="Living area from the record; bedrooms from the area thresholds (→ 3), baths from the comps."),
    1430447662: dict(
        address="1170 Park Blvd, Baton Rouge, LA 70806",
        living_sqft=None, beds=None, baths_full=None, baths_half=None, garage_cars=None, built=None,
        source=["No public living area or room counts found (RE/MAX record lists the parcel without them)"],
        note="No record: sized from the footprint, the upper floor at the regional default share."),
    978042774: dict(
        address="Ducros Dr, Beau Pré, Baton Rouge, LA 70820 (house number not mapped)",
        living_sqft=1450, beds=3, baths_full=2, baths_half=0, garage_cars=None, built="1999 (street)",
        source=["Street comps: 5565 Ducros Dr 3 bed / 2 bath 1,355 sq ft built 1999 (Compass, Zillow)",
                "5526 and 5654 Ducros Dr 3 bed / 2 bath 1,415 sq ft built 1999; 5698 Ducros Dr 3 bed / 2 bath 1,550 sq ft"],
        note="The map has no house number: the street's own listings (median 1,415–1,450 sq ft, 3 bed / 2 bath) set the programme."),
    978042780: dict(
        address="Northshore Ave, Riverbend, Baton Rouge, LA 70820 (house number not mapped)",
        living_sqft=None, beds=None, baths_full=2, baths_half=0, garage_cars=None, built=None,
        source=["No house number in the map; no Northshore Ave listing with room counts found",
                "Neighbouring Beau Pré listings (Ducros Dr): 3 bed / 2 bath at 1,355–1,550 sq ft"],
        note="Sized from the footprint; the bedroom thresholds and the neighbourhood's 2 baths set the rooms."),
}

UPPER_DEFAULT = 0.6      # a two-storey house with no record: the upper floor over ~60 % of the ground floor


def get(osm_id):
    return FACTS.get(int(osm_id)) if osm_id is not None else None
