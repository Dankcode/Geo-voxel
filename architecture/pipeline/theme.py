"""Theme inference: which architecture a building gets, from map data only, with the evidence for every choice.

Priority (strongest first):
  1. explicit OSM tags on the building (building:architecture, roof:shape, building:material/colour, levels, start_date)
  2. the building's own Wikidata item (architectural style P149, inception P571, floors P1101) and Wikipedia lead
  3. the historic district polygon it stands in (NRHP listing, the district's Wikipedia lead → era)
  4. the nearest mapped neighbourhood (some carry a founding year), and land use
  5. the footprint itself (frontage, depth, aspect, rectangularity, reflex corners) and the building / amenity type
"""
import re
from mapctx import years_in

STYLE_WORDS = [  # Wikipedia / Wikidata / OSM wording → our style keys
    (r"tudor", "tudor_revival"), (r"second empire|mansard", "second_empire"), (r"dutch colonial", "dutch_colonial"),
    (r"spanish colonial|spanish revival|mediterranean revival", "spanish_colonial"), (r"mission revival|mission style", "mission_revival"),
    (r"prairie", "prairie"), (r"cape cod", "cape_cod"), (r"saltbox", "saltbox"), (r"minimal traditional", "minimal_traditional"),
    (r"french eclectic|chateauesque|french provincial", "french_eclectic"), (r"acadian", "acadian"), (r"greek revival", "greek_revival"),
    (r"international style", "international"), (r"brutalis", "brutalist"), (r"farmhouse", "modern_farmhouse"), (r"a-frame|a frame", "a_frame"),
    (r"gothic", "gothic_revival"), (r"art deco|moderne|streamline", "art_deco"), (r"beaux[- ]arts", "beaux_arts"),
    (r"neoclassic|classical revival", "neoclassical"), (r"italian renaissance|renaissance", "italian_renaissance"),
    (r"italianate", "italianate"), (r"romanesque", "romanesque"), (r"queen anne|victorian", "queen_anne"),
    (r"craftsman|bungalow|arts and crafts", "craftsman"), (r"colonial revival|georgian|federal", "colonial_revival"),
    (r"creole", "creole"), (r"shotgun", "shotgun"), (r"mid[- ]century|ranch", "midcentury"), (r"modernis", "modern"),
]

def style_from_text(text):
    t = (text or "").lower()
    for pat, key in STYLE_WORDS:
        if re.search(pat, t):
            return key
    return None

def era_of(year):
    if year is None: return None
    return "antebellum" if year < 1865 else "victorian" if year < 1905 else "early20" if year < 1942 else "midcentury" if year < 1975 else "contemporary"

# archetype → default style per era (used only when nothing explicit says otherwise)
ERA_STYLE = {
    "shotgun": {"*": "shotgun"},
    "cottage": {"antebellum": "creole", "victorian": "creole", "early20": "craftsman", "midcentury": "midcentury", "contemporary": "contemporary_house", "*": "craftsman"},
    "bungalow": {"victorian": "queen_anne", "early20": "craftsman", "midcentury": "midcentury", "*": "craftsman"},
    "two_storey_house": {"antebellum": "neoclassical", "victorian": "queen_anne", "early20": "colonial_revival", "midcentury": "colonial_revival", "*": "colonial_revival"},
    "ranch": {"*": "midcentury"},
    "townhouse": {"victorian": "italianate", "*": "contemporary_house"},
    "apartments": {"early20": "colonial_revival", "midcentury": "modern", "*": "contemporary_block"},
    "storefront": {"victorian": "italianate", "early20": "italianate", "midcentury": "modern", "*": "contemporary_block"},
    "office": {"early20": "art_deco", "midcentury": "modern", "*": "modern"},
    "big_box": {"*": "contemporary_block"},
    "church": {"*": "gothic_revival"},
    "school": {"early20": "colonial_revival", "*": "modern"},
    "civic": {"early20": "neoclassical", "*": "neoclassical"},
    "warehouse": {"*": "industrial"}, "garage": {"*": "industrial"}, "canopy": {"*": "industrial"}, "tank": {"*": "industrial"},
}

# Baton Rouge post-war suburbs: brick ranches, colonial-revival brick, "Acadian" (Creole-revival) cottages, a few contemporaries
REGIONAL_MIX = {
    # Baton Rouge's 1920s–30s neighbourhoods (Garden District, Roseland Terrace): revival styles beside the craftsman bungalow
    "early20": {"bungalow": [("craftsman", 0.4), ("tudor_revival", 0.2), ("spanish_colonial", 0.15), ("colonial_revival", 0.15), ("prairie", 0.1)],
                "cottage": [("craftsman", 0.5), ("tudor_revival", 0.2), ("minimal_traditional", 0.3)],
                "two_storey_house": [("colonial_revival", 0.35), ("tudor_revival", 0.25), ("dutch_colonial", 0.2), ("spanish_colonial", 0.1), ("french_eclectic", 0.1)]},
    "midcentury": {"ranch": [("midcentury", 0.45), ("colonial_revival", 0.25), ("creole", 0.18), ("contemporary_house", 0.12)],
                   "bungalow": [("midcentury", 0.4), ("creole", 0.3), ("colonial_revival", 0.2), ("contemporary_house", 0.1)],
                   "cottage": [("creole", 0.5), ("midcentury", 0.3), ("contemporary_house", 0.2)],
                   "two_storey_house": [("colonial_revival", 0.6), ("creole", 0.2), ("contemporary_house", 0.2)]},
}

def infer(b, ctx, m):
    t, ev = b["tags"], []
    note = lambda src, what: ev.append({"source": src, "says": what})
    bt = t.get("building", "yes")
    # ---------------------------------------------------------------- storeys
    levels = None
    if t.get("building:levels"):
        try: levels = max(1, round(float(t["building:levels"]))); note("osm building:levels", levels)
        except ValueError: pass
    if levels is None and t.get("gen:levels"):
        levels = int(t["gen:levels"]); note("lot generator (no OSM footprint here)", f"{levels} storey{'s' if levels > 1 else ''}, drawn from the neighbourhood mix")
    if levels is None and ctx["wiki"] and ctx["wiki"].get("floors"):
        levels = round(float(ctx["wiki"]["floors"][0])); note("wikidata floors", levels)
    if levels is None and t.get("height"):
        try: levels = max(1, round(float(t["height"]) / 3.6)); note("osm height", t["height"])
        except ValueError: pass
    # ---------------------------------------------------------------- archetype (what the building is)
    amen, shop, lu, A = t.get("amenity"), t.get("shop"), ctx["landuse"], m["area"]
    # audit fix (2026-10-30): an NRHP-style name says what the building was built as ("… House" is a dwelling,
    # "… Building / Store / Block / Hotel / Bank" is commercial), and a historic district named Downtown /
    # Commercial / Main Street is commercial fabric, not residential, when no land use is mapped
    import re
    nm = t.get("name") or ""
    named_commercial = bool(re.search(r"\b(Building|Store|Block|Hotel|Bank|Exchange|Company|Press|Hardware|Arcade)\b", nm)) and not re.search(r"\b(House|Cottage|Residence|Home)\b", nm)
    dname = (ctx["district"] or {}).get("name") or "" if ctx["district"] is not None else ""
    commercial_district = bool(re.search(r"Downtown|Commercial|Main Street", dname))
    resid = (lu == "residential" or (ctx["district"] is not None and lu is None and not commercial_district)) and not named_commercial
    if named_commercial or (commercial_district and lu is None and not bt in ("house", "residential", "apartments", "detached")):
        lu = lu or "commercial"; note("osm name / historic district", f"{nm or dname}: commercial building")
    if bt == "roof": arch = "canopy"; note("osm building", "roof → open canopy")
    elif bt in ("storage_tank", "silo", "tank") or t.get("man_made") in ("storage_tank", "silo"): arch = "tank"; note("osm building", f"{bt} → cylindrical tank")
    elif amen == "place_of_worship" or bt in ("church", "chapel", "cathedral"): arch = "church"; note("osm amenity/building", amen or bt)
    elif amen in ("school", "kindergarten", "college") or bt in ("school", "college", "university") or amen == "university": arch = "school"; note("osm amenity/building", amen or bt)
    elif bt in ("government", "civic", "public", "museum") or amen in ("townhall", "courthouse", "library", "fire_station", "police", "arts_centre", "theatre") or t.get("tourism") == "museum" or (t.get("wikidata") and A > 400 and bt in ("yes", "public") and not shop): arch = "civic"; note("osm building/amenity/tourism/wikidata", bt if bt != "yes" else (amen or t.get("tourism") or "landmark with a Wikidata item"))
    elif bt == "apartments" or (resid and A > 500 and (levels or 1) >= 2): arch = "apartments"; note("osm building", bt if bt == "apartments" else f"residential, {A:.0f} m², {levels} levels")
    elif bt in ("warehouse", "industrial", "storage_tank", "hangar") or lu == "industrial": arch = "warehouse"; note("osm building/landuse", bt if bt != "yes" else lu)
    elif bt in ("garage", "garages", "shed", "carport"): arch = "garage"; note("osm building", bt)
    elif shop or amen in ("restaurant", "cafe", "fast_food", "bar", "pub", "bank", "pharmacy") or bt in ("retail", "commercial", "office") or lu in ("commercial", "retail"):
        what = shop or amen or bt if (shop or amen or bt != "yes") else lu
        if A > 1800 and (levels or 1) <= 2 and (shop or bt == "retail"): arch = "big_box"
        elif amen == "bank" or bt == "office" or t.get("office") or (A > 900): arch = "office"
        else: arch = "storefront"
        note("osm shop/amenity/building/landuse", what)
    else:
        # a dwelling: the footprint decides the house type
        if ctx["party"] and m["frontage"] < 8: arch = "townhouse"; note("footprint", f"party walls, {m['frontage']} m front")
        elif m["frontage"] <= 6.5 and m["aspect"] >= 2.0: arch = "shotgun"; note("footprint", f"{m['frontage']} m wide × {m['depth']} m deep (aspect {m['aspect']})")
        elif (levels or 1) >= 2:
            arch = "two_storey_house"
            if not t.get("gen:levels"): note("storeys", levels)
        elif m["reflex"] >= 1 and A > 140 and m["rectangularity"] < 0.93 and not ctx["district"]: arch = "ranch"; note("footprint", f"L/T outline ({m['reflex']} reflex corners), {A:.0f} m²")
        elif t.get("gen:era") and int(t["gen:era"]) >= 1945 and m["frontage"] >= m["depth"] * 1.1 and A > 120: arch = "ranch"; note("footprint", f"wide and low, {m['frontage']} × {m['depth']} m, post-war lot")
        elif A <= 170 and m["aspect"] < 1.7: arch = "cottage"; note("footprint", f"compact {m['frontage']} × {m['depth']} m")
        else: arch = "bungalow"; note("footprint", f"{m['frontage']} × {m['depth']} m, {A:.0f} m²")
    # ---------------------------------------------------------------- era
    year = None
    for src, txt in (("osm start_date", t.get("start_date")), ("wikidata inception", ((ctx["wiki"] or {}).get("inception") or [None])[0])):
        ys = years_in(str(txt)) if txt else []
        if ys: year = ys[0]; note(src, year); break
    if year is None and ctx["district_wiki"] and ctx["district_wiki"].get("extract"):
        ys = years_in(ctx["district_wiki"]["extract"])
        # buildings in a district date from its main building period: the latest year the lead names, not its founding
        if ys: year = max(y for y in ys if y < 1950) if any(y < 1950 for y in ys) else ys[0]; note(f"district Wikipedia ({ctx['district']['name']})", f"built up by ~{year}")
    if year is None and ctx["hood"] and re.match(r"^\d{4}$", ctx["hood"]["tags"].get("historic", "")):
        year = int(ctx["hood"]["tags"]["historic"]); note(f"neighbourhood {ctx['hood']['name']}", year)
    if year is None and t.get("gen:era"):
        year = int(t["gen:era"]); note("lot generator", f"subdivision period ~{year} (suburban cul-de-sac street pattern)")
    if year is None and ctx["district"]:
        year = 1900; note(f"historic district {ctx['district']['name']} (NRHP {ctx['district']['tags'].get('ref:nrhp', '?')})", "historic fabric, ~1900 assumed")
    if year is None and (t.get("ref:nrhp") or t.get("heritage:operator") == "nrhp"):
        # NRHP criteria consideration G: a listed property is normally at least 50 years old at listing; the listing
        # alone does not give a date, so take the modal NRHP commercial period (early 20th century)
        year = 1920; note("osm ref:nrhp", "listed on the National Register (normally ≥ 50 years old at listing) → early 20th century assumed")
    era = era_of(year)
    # ---------------------------------------------------------------- style
    style = None
    if t.get("building:architecture"): style = style_from_text(t["building:architecture"].replace("_", " ")) or t["building:architecture"]; note("osm building:architecture", t["building:architecture"])
    if not style and ctx["wiki"] and ctx["wiki"].get("style"): style = style_from_text(" ".join(ctx["wiki"]["style"])); style and note("wikidata style", ", ".join(ctx["wiki"]["style"]))
    if not style and ctx["wiki"] and ctx["wiki"].get("extract"): style = style_from_text(ctx["wiki"]["extract"]); style and note("Wikipedia lead", style)
    if not style and era in REGIONAL_MIX and arch in REGIONAL_MIX[era]:
        # a subdivision is never one style: draw from the period's regional mix, seeded by the building, so it is stable
        import random
        opts = REGIONAL_MIX[era][arch]
        style = random.Random(f"style:{b['id']}").choices([o for o, _ in opts], [w for _, w in opts])[0]
        note("inferred", f"{arch} in a ~{year} subdivision → {style.replace('_', ' ')} (regional mix: " + ", ".join(f"{o.replace('_', ' ')} {int(w * 100)}%" for o, w in opts) + ")")
    if not style:
        table = ERA_STYLE.get(arch, {"*": "contemporary_block"})
        style = table.get(era) or table["*"]
        note("inferred", f"{arch} + era {era or 'unknown'} → {style}")
    if levels is None:
        levels = {"two_storey_house": 2, "apartments": 3, "office": 2 if A < 1500 else 4, "school": 2 if A > 1500 else 1, "civic": 2,
                  "townhouse": 2, "church": 1}.get(arch, 1)
        note("default storeys", f"{arch} → {levels}")
    roof = t.get("roof:shape"); roof and note("osm roof:shape", roof)
    colour = t.get("building:colour"); colour and note("osm building:colour", colour)
    return {"archetype": arch, "style": style, "era": era, "year": year, "storeys": min(levels, 6), "roof": roof, "colour": colour, "evidence": ev}
