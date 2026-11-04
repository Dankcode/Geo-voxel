"""Exterior grammars: one entry per style key the theme step can return. Units: metres, colours as hex.

raise   – floor of the ground storey above grade (Louisiana raised cottages stand on piers)
storey  – floor-to-floor height;  ext/int – wall thickness
roof    – form for the main volume: side_gable (ridge along the street), front_gable (ridge front→back), hip, flat, steep_gable
pitch   – roof pitch in degrees;  eave – overhang
window  – w, h, sill, spacing (centre to centre), kind: sash | casement | lancet | arched | ribbon | storefront | industrial
porch   – posts kind and railing; trim – cornice / brackets / parapet / quoins / buttresses / tower
"""

STYLES = {
    "creole": dict(raise_=0.9, storey=3.6, ext=0.2, int_=0.12, roof="side_gable", pitch=42, eave=0.5, walls="#e9e1cf", trim="#f5f3ec", roofc="#7c8084", roofmat="metal",
                   window=dict(w=0.95, h=2.3, sill=0.35, spacing=2.6, kind="french"), shutters="#2f5b4a", porch=dict(posts="square", rail=False), cladding="clapboard", trimset=[]),
    "shotgun": dict(raise_=0.75, storey=3.5, ext=0.2, int_=0.12, roof="front_gable", pitch=35, eave=0.45, walls="#d9c9a8", trim="#f4f1e8", roofc="#6f7378", roofmat="metal",
                    window=dict(w=0.85, h=1.9, sill=0.75, spacing=2.8, kind="sash"), shutters="#7a3b2e", porch=dict(posts="turned", rail=True), cladding="clapboard", trimset=["brackets"]),
    "craftsman": dict(raise_=0.6, storey=3.1, ext=0.22, int_=0.12, roof="front_gable", pitch=24, eave=0.75, walls="#9aa58a", trim="#efe9da", roofc="#5a4a3d", roofmat="shingle",
                      window=dict(w=1.0, h=1.5, sill=0.8, spacing=2.4, kind="casement"), shutters=None, porch=dict(posts="tapered", rail=True), cladding="shingle", trimset=["rafter_tails"]),
    "queen_anne": dict(raise_=0.7, storey=3.4, ext=0.22, int_=0.12, roof="hip", pitch=40, eave=0.45, walls="#c9b6d0", trim="#f6f0e6", roofc="#4f4a52", roofmat="shingle",
                       window=dict(w=0.9, h=1.9, sill=0.7, spacing=2.4, kind="sash"), shutters=None, porch=dict(posts="turned", rail=True), cladding="clapboard", trimset=["brackets", "turret"]),
    "colonial_revival": dict(raise_=0.45, storey=3.0, ext=0.3, int_=0.12, roof="side_gable", pitch=35, eave=0.3, walls="#a6523c", trim="#f4f1ea", roofc="#3d3f44", roofmat="shingle",
                             window=dict(w=0.9, h=1.6, sill=0.8, spacing=2.2, kind="sash"), shutters="#1f2b38", porch=dict(posts="round", rail=False), cladding="brick", trimset=["cornice"]),
    "neoclassical": dict(raise_=0.9, storey=3.9, ext=0.4, int_=0.15, roof="hip", pitch=22, eave=0.6, walls="#e8e2d4", trim="#ffffff", roofc="#5c6166", roofmat="slate",
                         window=dict(w=1.1, h=2.4, sill=0.7, spacing=2.8, kind="sash"), shutters="#22312a", porch=dict(posts="column", rail=False), cladding="stucco", trimset=["cornice", "pediment"]),
    "italian_renaissance": dict(raise_=0.5, storey=3.6, ext=0.3, int_=0.12, roof="hip", pitch=24, eave=0.7, walls="#e6cfa3", trim="#f3eadb", roofc="#b2553a", roofmat="tile",
                                window=dict(w=1.0, h=2.1, sill=0.6, spacing=2.6, kind="arched"), shutters=None, porch=dict(posts="column", rail=False), cladding="stucco", trimset=["brackets"]),
    "italianate": dict(raise_=0.3, storey=4.0, ext=0.35, int_=0.15, roof="flat", pitch=0, eave=0.0, walls="#9c4a37", trim="#e8dfcf", roofc="#45484c", roofmat="membrane",
                       window=dict(w=1.0, h=2.3, sill=0.75, spacing=2.4, kind="arched"), shutters=None, porch=dict(posts="column", rail=False), cladding="brick", trimset=["cornice", "brackets", "storefront"]),
    "gothic_revival": dict(raise_=0.6, storey=4.2, ext=0.5, int_=0.15, roof="steep_gable", pitch=52, eave=0.3, walls="#b9b2a4", trim="#d9d3c6", roofc="#3e4248", roofmat="slate",
                           window=dict(w=1.1, h=3.2, sill=1.2, spacing=3.2, kind="lancet"), shutters=None, porch=dict(posts="column", rail=False), cladding="stone", trimset=["buttresses", "tower"]),
    "beaux_arts": dict(raise_=1.0, storey=4.5, ext=0.5, int_=0.15, roof="flat", pitch=0, eave=0, walls="#ddd3bf", trim="#f2ece0", roofc="#55595e", roofmat="membrane",
                       window=dict(w=1.3, h=2.6, sill=0.8, spacing=3.0, kind="arched"), shutters=None, porch=dict(posts="column", rail=False), cladding="stone", trimset=["cornice", "parapet", "pediment"]),
    "romanesque": dict(raise_=0.6, storey=4.2, ext=0.5, int_=0.15, roof="hip", pitch=35, eave=0.3, walls="#8b5a45", trim="#c9b49a", roofc="#4a4440", roofmat="slate",
                       window=dict(w=1.2, h=2.4, sill=0.9, spacing=3.0, kind="arched"), shutters=None, porch=dict(posts="column", rail=False), cladding="stone", trimset=["tower"]),
    "art_deco": dict(raise_=0.4, storey=4.0, ext=0.4, int_=0.15, roof="flat", pitch=0, eave=0, walls="#ddd6c8", trim="#c7b37a", roofc="#55595e", roofmat="membrane",
                     window=dict(w=1.2, h=2.4, sill=0.8, spacing=2.6, kind="ribbon"), shutters=None, porch=dict(posts="square", rail=False), cladding="stone", trimset=["parapet", "piers"]),
    "midcentury": dict(raise_=0.25, storey=2.9, ext=0.25, int_=0.12, roof="hip", pitch=20, eave=0.8, walls="#b6735a", trim="#f1ede4", roofc="#3e3c3a", roofmat="shingle",
                       window=dict(w=1.6, h=1.3, sill=0.9, spacing=3.0, kind="casement"), shutters=None, porch=dict(posts="steel", rail=False), cladding="brick", trimset=[]),
    "contemporary_house": dict(raise_=0.3, storey=3.0, ext=0.25, int_=0.12, roof="shed", pitch=10, eave=0.4, walls="#e7e5df", trim="#2d3033", roofc="#3a3d40", roofmat="metal",
                               window=dict(w=1.8, h=2.0, sill=0.5, spacing=3.2, kind="casement"), shutters=None, porch=dict(posts="steel", rail=False), cladding="render", trimset=[]),
    "modern": dict(raise_=0.15, storey=3.6, ext=0.3, int_=0.12, roof="flat", pitch=0, eave=0.2, walls="#c9c7c0", trim="#3a3e42", roofc="#5a5e62", roofmat="membrane",
                   window=dict(w=2.4, h=1.8, sill=0.8, spacing=3.0, kind="ribbon"), shutters=None, porch=dict(posts="steel", rail=False), cladding="concrete", trimset=["parapet"]),
    "contemporary_block": dict(raise_=0.15, storey=4.0, ext=0.3, int_=0.12, roof="flat", pitch=0, eave=0.1, walls="#d4cfc4", trim="#34383c", roofc="#5a5e62", roofmat="membrane",
                               window=dict(w=2.0, h=2.2, sill=0.6, spacing=3.0, kind="casement"), shutters=None, porch=dict(posts="steel", rail=False), cladding="render", trimset=["parapet", "storefront"]),
    "industrial": dict(raise_=0.1, storey=5.5, ext=0.25, int_=0.12, roof="low_gable", pitch=8, eave=0.3, walls="#8f9a9e", trim="#4b5357", roofc="#9aa1a4", roofmat="metal",
                       window=dict(w=3.0, h=1.0, sill=3.4, spacing=6.0, kind="industrial"), shutters=None, porch=dict(posts="steel", rail=False), cladding="metal", trimset=[]),
}

# ---------------------------------------------------------------------------------------------------------------
# Further style grammars (2026-10-29). Each one is a *programme*, not a picture: the roof is a weighted-straight-
# skeleton programme (roofs.PROGRAMMES), the facade a bay rhythm, the walls a cladding pattern, porches a column
# order with classical proportions, and trim a set of rules. Fields beyond the base grammar:
#   roof_program  roofs.PROGRAMMES key        facade  symmetric | picturesque | ribbon
#   order         tuscan | doric | ionic | corinthian (column height = k·diameter, k = 7 / 8 / 9 / 10, Vignola)
#   half_timber   timber grid on the upper storey and gables (Tudor)
NEW_STYLES = {
    "greek_revival": dict(raise_=0.9, storey=3.7, ext=0.25, int_=0.12, roof="front_gable", roof_program="front_gable", pitch=24, eave=0.35, walls="#f1efe8", trim="#ffffff", roofc="#55595e", roofmat="metal",
                          window=dict(w=1.0, h=2.2, sill=0.6, spacing=2.6, kind="sash"), shutters="#2c3a33", porch=dict(posts="column", rail=False), cladding="clapboard", trimset=["cornice", "pediment"], facade="symmetric", order="doric"),
    "second_empire": dict(raise_=0.6, storey=3.8, ext=0.3, int_=0.13, roof="mansard", roof_program="mansard", pitch=72, eave=0.25, walls="#c8b99a", trim="#efe8d8", roofc="#4a4d55", roofmat="slate",
                          window=dict(w=0.95, h=2.3, sill=0.65, spacing=2.4, kind="arched"), shutters=None, porch=dict(posts="column", rail=True), cladding="stucco", trimset=["cornice", "brackets"], facade="symmetric", order="ionic"),
    "dutch_colonial": dict(raise_=0.45, storey=3.0, ext=0.25, int_=0.12, roof="gambrel", roof_program="gambrel", pitch=62, eave=0.35, walls="#d9d2bf", trim="#ffffff", roofc="#3f4246", roofmat="shingle",
                           window=dict(w=0.9, h=1.6, sill=0.8, spacing=2.4, kind="sash"), shutters="#24384d", porch=dict(posts="round", rail=False), cladding="shingle", trimset=[], facade="symmetric", order="tuscan"),
    "tudor_revival": dict(raise_=0.35, storey=3.0, ext=0.3, int_=0.12, roof="cross_gable", roof_program="cross_gable", pitch=52, eave=0.25, walls="#9a5a44", trim="#f1e9d6", roofc="#3b3633", roofmat="slate",
                          window=dict(w=0.8, h=1.5, sill=0.85, spacing=2.0, kind="casement"), shutters=None, porch=dict(posts="square", rail=False), cladding="brick", trimset=[], facade="picturesque", half_timber=True),
    "spanish_colonial": dict(raise_=0.3, storey=3.2, ext=0.35, int_=0.12, roof="hip", roof_program="cross_gable", pitch=20, eave=0.3, walls="#efe3cb", trim="#7a4a2f", roofc="#b45a3c", roofmat="tile",
                             window=dict(w=1.0, h=1.8, sill=0.7, spacing=2.8, kind="arched"), shutters=None, porch=dict(posts="square", rail=False), cladding="stucco", trimset=[], facade="picturesque"),
    "mission_revival": dict(raise_=0.3, storey=3.4, ext=0.35, int_=0.12, roof="flat", roof_program="flat", pitch=0, eave=0.0, walls="#ece0c5", trim="#8a5a3a", roofc="#9a9a92", roofmat="membrane",
                            window=dict(w=1.0, h=1.9, sill=0.7, spacing=2.8, kind="arched"), shutters=None, porch=dict(posts="square", rail=False), cladding="stucco", trimset=["parapet", "shaped_parapet"], facade="symmetric"),
    "prairie": dict(raise_=0.3, storey=3.0, ext=0.3, int_=0.12, roof="hip", roof_program="hip", pitch=18.5, eave=1.4, walls="#cdbb98", trim="#5a4632", roofc="#4c4a46", roofmat="shingle",
                    window=dict(w=2.4, h=1.3, sill=0.9, spacing=3.0, kind="casement"), shutters=None, porch=dict(posts="square", rail=False), cladding="stucco", trimset=["band"], facade="ribbon"),
    "cape_cod": dict(raise_=0.4, storey=2.8, ext=0.22, int_=0.12, roof="side_gable", roof_program="side_gable", pitch=45, eave=0.2, walls="#e9e6dd", trim="#ffffff", roofc="#4b4d50", roofmat="shingle",
                     window=dict(w=0.85, h=1.45, sill=0.8, spacing=2.2, kind="sash"), shutters="#1f3a5a", porch=dict(posts="square", rail=False), cladding="shingle", trimset=[], facade="symmetric"),
    "saltbox": dict(raise_=0.4, storey=2.9, ext=0.22, int_=0.12, roof="saltbox", roof_program="saltbox", pitch=40, eave=0.25, walls="#7d3b30", trim="#efe8da", roofc="#3d3b38", roofmat="shingle",
                    window=dict(w=0.85, h=1.5, sill=0.8, spacing=2.3, kind="sash"), shutters=None, porch=dict(posts="square", rail=False), cladding="clapboard", trimset=[], facade="symmetric"),
    "minimal_traditional": dict(raise_=0.3, storey=2.8, ext=0.22, int_=0.12, roof="side_gable", roof_program="cross_gable", pitch=27, eave=0.25, walls="#d8cfbd", trim="#ffffff", roofc="#4f5052", roofmat="shingle",
                                window=dict(w=1.0, h=1.4, sill=0.85, spacing=2.6, kind="sash"), shutters="#4a5a4a", porch=dict(posts="steel", rail=False), cladding="clapboard", trimset=[], facade="picturesque"),
    "french_eclectic": dict(raise_=0.45, storey=3.2, ext=0.3, int_=0.12, roof="hip", roof_program="hip", pitch=55, eave=0.25, walls="#cbb79b", trim="#f2ece0", roofc="#3f4045", roofmat="slate",
                            window=dict(w=0.95, h=2.0, sill=0.6, spacing=2.4, kind="french"), shutters="#3c4a5a", porch=dict(posts="square", rail=False), cladding="stucco", trimset=[], facade="picturesque"),
    "acadian": dict(raise_=0.6, storey=3.2, ext=0.22, int_=0.12, roof="side_gable", roof_program="side_gable", pitch=45, eave=0.4, walls="#efe8d6", trim="#ffffff", roofc="#6f7378", roofmat="metal",
                    window=dict(w=0.95, h=2.2, sill=0.4, spacing=2.6, kind="french"), shutters="#3e5a46", porch=dict(posts="square", rail=True), cladding="clapboard", trimset=[], facade="symmetric"),
    "international": dict(raise_=0.15, storey=3.2, ext=0.25, int_=0.12, roof="flat", roof_program="flat", pitch=0, eave=0.0, walls="#f3f2ee", trim="#2a2d30", roofc="#9fa1a3", roofmat="membrane",
                          window=dict(w=3.0, h=1.4, sill=0.9, spacing=3.4, kind="ribbon"), shutters=None, porch=dict(posts="steel", rail=False), cladding="render", trimset=["parapet"], facade="ribbon"),
    "brutalist": dict(raise_=0.2, storey=3.8, ext=0.45, int_=0.15, roof="flat", roof_program="flat", pitch=0, eave=0.0, walls="#a9a7a0", trim="#7d7b75", roofc="#8a8984", roofmat="membrane",
                      window=dict(w=1.4, h=1.6, sill=0.9, spacing=2.4, kind="casement"), shutters=None, porch=dict(posts="column", rail=False), cladding="concrete", trimset=["parapet", "deep_reveals"], facade="symmetric"),
    "modern_farmhouse": dict(raise_=0.3, storey=3.0, ext=0.22, int_=0.12, roof="cross_gable", roof_program="cross_gable", pitch=42, eave=0.3, walls="#f4f3ef", trim="#1f2124", roofc="#2e3236", roofmat="metal",
                             window=dict(w=1.0, h=1.8, sill=0.6, spacing=2.4, kind="casement"), shutters=None, porch=dict(posts="square", rail=False), cladding="board_batten", trimset=[], facade="picturesque"),
    "a_frame": dict(raise_=0.3, storey=2.8, ext=0.2, int_=0.12, roof="a_frame", roof_program="a_frame", pitch=60, eave=0.4, walls="#7a5a3e", trim="#2f2a24", roofc="#3a3c3e", roofmat="shingle",
                    window=dict(w=1.6, h=2.0, sill=0.4, spacing=2.6, kind="casement"), shutters=None, porch=dict(posts="steel", rail=True), cladding="board_batten", trimset=[], facade="picturesque", knee_wall=0.6),
}
STYLES.update(NEW_STYLES)

# roof programme for the original grammars (roof key → roofs.PROGRAMMES)
ROOF_PROGRAM = {"side_gable": "side_gable", "front_gable": "front_gable", "hip": "hip", "flat": "flat", "steep_gable": "cross_gable",
                "low_gable": "low_gable", "shed": "shed"}
FACADE = {"colonial_revival": "symmetric", "neoclassical": "symmetric", "beaux_arts": "symmetric", "creole": "symmetric", "art_deco": "symmetric",
          "modern": "ribbon", "contemporary_block": "ribbon"}
ORDER = {"neoclassical": "ionic", "colonial_revival": "tuscan", "beaux_arts": "corinthian", "italian_renaissance": "tuscan", "gothic_revival": None}
VIGNOLA_K = {"tuscan": 7, "doric": 8, "ionic": 9, "corinthian": 10}      # column height / lower diameter


def column_dims(order, height):
    """Vignola's orders: lower diameter D = H/k; entablature = H/4; intercolumniation (eustyle) ≈ 2.25 D."""
    k = VIGNOLA_K.get(order or "tuscan", 7)
    D = height / k
    return dict(D=D, entablature=height / 4, spacing=D * (2.25 + 1))


ROOM_STOREY = {"church": 7.5, "warehouse": 6.5, "big_box": 5.0, "garage": 3.0, "school": 3.9, "civic": 4.5, "canopy": 3.4}

def style_for(theme):
    s = dict(STYLES.get(theme["style"], STYLES["contemporary_block"]))
    s.setdefault("roof_program", ROOF_PROGRAM.get(s["roof"], "hip"))
    s.setdefault("facade", FACADE.get(theme["style"], "picturesque"))
    s.setdefault("order", ORDER.get(theme["style"], "tuscan" if s["porch"]["posts"] in ("column", "round") else None))
    a = theme["archetype"]
    if a in ROOM_STOREY: s["storey"] = max(s["storey"], ROOM_STOREY[a]) if a in ("church", "civic") else ROOM_STOREY[a]
    if a in ("warehouse", "garage", "canopy", "big_box"): s["raise_"] = 0.1
    if a in ("storefront", "office", "apartments", "school", "civic", "big_box") and s["roof"] in ("front_gable", "side_gable") and theme["storeys"] > 1:
        s["roof"] = "hip"
    if theme.get("era") in ("midcentury", "contemporary") and theme["style"] == "creole":
        # "Acadian" revival of the 1970s suburbs: the Creole form on a slab, brick or painted siding
        s.update(raise_=0.3, walls="#c9a58a", cladding="brick", storey=3.1)
    if theme.get("era") in ("midcentury", "contemporary") and theme["archetype"] in ("ranch", "bungalow", "two_storey_house", "cottage"):
        s["raise_"] = min(s["raise_"], 0.3)
    if a in ("storefront", "office", "apartments", "school", "civic", "big_box") and s["roof_program"] in ("front_gable", "side_gable") and theme["storeys"] > 1:
        s["roof_program"] = "hip"
    if theme.get("roof"):   # an explicit OSM roof:shape wins
        s["roof"] = {"gabled": "side_gable", "hipped": "hip", "flat": "flat", "skillion": "shed", "dome": "dome"}.get(theme["roof"], s["roof"])
        s["roof_program"] = {"gabled": "cross_gable", "hipped": "hip", "flat": "flat", "skillion": "shed", "mansard": "mansard", "gambrel": "gambrel",
                             "half-hipped": "jerkinhead", "pyramidal": "pyramid", "saltbox": "saltbox"}.get(theme["roof"], s["roof_program"])
    if theme.get("colour"):
        s["walls"] = {"grey": "#9a9da0", "yellow": "#e4cf7d", "red": "#a64a3a", "white": "#efefea", "blue": "#7f9fbf", "pink": "#e0b7b5"}.get(theme["colour"], s["walls"])
    return s
