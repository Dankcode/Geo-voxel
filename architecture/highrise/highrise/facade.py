"""Exterior styles for the high-rise slabs: the same floor plan, four facades seen on Chinese residential towers.

A style only adds cladding and decoration outside the walls and recolours the envelope. Windows, doors, rooms and the
structure are untouched, so the plan scores, daylight, window-to-wall ratio and fire classification stay the same.

Styles (names as used in Chinese practice)
  modern       Modern minimalist (现代简约)   light render, a dark aluminium band at every slab edge, glass railings,
                                               an open steel frame on the roof.
  neo_chinese  Neo-Chinese (新中式)            off-white walls, dark grey window surrounds and corner lines, wood-tone
                                               AC grilles, a three-storey grey stone base, a deep flat eave and hipped
                                               roofs over the stair and lift towers.
  art_deco     Art Deco / neo-classical (ArtDeco / 新古典)   sand-coloured stone-paint, a three-storey stone base with a
                                               cornice, full-height pilasters that rise above the parapet in steps,
                                               a stepped crown over the core, bronze railings.
  public       Commercial-style (公建化)        aluminium-panel grey walls, a dark panel band across every slab edge,
                                               vertical fins beside every window, glass railings, a fin screen on the roof.

Every style is assembled from three zones (the "three-part facade", 三段式): base (ground floor plus the first
storeys), body, and top (the last storeys plus the roof crown).

Rules a facade must meet (checked by `check()`):
  F1  GB 50016-2014 (2018) 6.7.12: the decorative layer of an exterior wall shall be class A (non-combustible);
      class B1 is allowed only when the building is no higher than 50 m. So foam (EPS) mouldings, the cheap way to
      make Art Deco or neo-classical lines, are out on anything above 50 m: mouldings switch to GRC or aluminium.
  F2  Windows and doors are the plan's: a style adds no openings, so window-to-wall ratios and daylight are unchanged.
  F3  No fin, pilaster or surround covers a window or door opening.
  F4  Sunlight (GB 50180-2018 Table 4.0.9): a crown makes the block taller as an obstruction for the block to the
      north. The check re-traces the Major Cold day with the parapet, stair and lift towers and the crown on the
      block to the south, and reports the row spacing the style needs.
  F5  Building height for fire purposes is measured to the roof surface (GB 50016 Appendix A.0.1), so a crown
      does not move the 33 m / 54 m / 100 m thresholds. Planning height limits are local and may count it.
  F6  Glass: some cities bar glass curtain walls on new housing above the ground floor (Hangzhou rule of 2015), so
      the commercial style's dark bands are enamelled aluminium, not glass; real glass is limited to the windows,
      balcony doors, glass railings and the ground-floor entrance hall.

Geometry is returned as plain primitives (boxes in the plan frame: mm, x east, y south, z up from the storey's floor
surface), so this module runs without FreeCAD; highrise.bim turns them into solids.
"""
from highrise.walls import THICK, floor_walls

SLAB = 200
EXT = THICK["exterior"]

STYLES = {
    "plain": {
        "name": "Plain (as generated)", "cn": "", "base": 1, "top": 0,
        "palette": {},
    },
    "modern": {
        "name": "Modern minimalist", "cn": "现代简约", "base": 2, "top": 1,
        "palette": {"ext_wall": "#efeeea", "ext_wall_base": "#c3c0b9", "ext_wall_top": "#efeeea", "band": "#4f5357",
                    "railing": "#a9c3cb", "frame": "#3e4347", "window": "#a3c0cc", "column": "#c3c0b9",
                    "ac_louver": "#7d8287", "crown": "#4f5357", "parapet": "#efeeea", "tower": "#efeeea"},
        "bands": {"h": 260, "d": 150, "every": 1},
        "railing": "glass",
        "crown": "frame",
        "materials": {"band": ("aluminium", "A"), "crown": ("steel frame, aluminium cladding", "A"),
                      "ac_louver": ("aluminium", "A")},
    },
    "neo_chinese": {
        "name": "Neo-Chinese", "cn": "新中式", "base": 3, "top": 1,
        "palette": {"ext_wall": "#f2efe8", "ext_wall_base": "#8e8c87", "ext_wall_top": "#f2efe8", "band": "#3c3e40",
                    "surround": "#3c3e40", "pilaster": "#3c3e40", "railing": "#3c3e40", "frame": "#34383b",
                    "window": "#9fb8c2", "column": "#8e8c87", "ac_louver": "#7b5b3d", "crown": "#3c3e40",
                    "roof_tile": "#4a4c4e", "parapet": "#f2efe8", "tower": "#f2efe8"},
        "surrounds": {"w": 120, "d": 100},
        "pilasters": {"corner": (300, 120), "party": (240, 120), "other": None},
        "cornice": {"h": 360, "d": 260},
        "bands": {"h": 200, "d": 100, "every": 0},
        "railing": "metal",
        "crown": "eave",
        "materials": {"surround": ("aluminium", "A"), "pilaster": ("aluminium", "A"), "band": ("aluminium", "A"),
                      "cornice": ("granite (dry-hung)", "A"), "ac_louver": ("wood-grain aluminium", "A"),
                      "crown": ("aluminium eave, metal roof tiles", "A")},
    },
    "art_deco": {
        "name": "Art Deco (neo-classical)", "cn": "ArtDeco / 新古典", "base": 3, "top": 2,
        "palette": {"ext_wall": "#e6d7ba", "ext_wall_base": "#b8a17b", "ext_wall_top": "#dcc9a6", "band": "#cdb78f",
                    "pilaster": "#d7c39d", "surround": "#cfbb93", "railing": "#4a3f31", "frame": "#4a3f31",
                    "window": "#a7bcc0", "column": "#b8a17b", "ac_louver": "#8b7b62", "crown": "#d7c39d",
                    "parapet": "#dcc9a6", "tower": "#dcc9a6", "finial": "#9c8155"},
        "surrounds": {"w": 100, "d": 80},
        "pilasters": {"corner": (700, 300), "party": (600, 300), "other": (400, 220)},
        "cornice": {"h": 450, "d": 320},
        "top_band": {"h": 300, "d": 220},
        "railing": "metal",
        "crown": "stepped",
        # mouldings: foam is class B1 at best, so it is allowed only at <= 50 m (GB 50016 6.7.12)
        "materials": {"pilaster": ("EPS foam moulding (B1 grade)", "B1", "GRC", "A"),
                      "surround": ("EPS foam moulding (B1 grade)", "B1", "GRC", "A"),
                      "cornice": ("stone (dry-hung)", "A"), "band": ("GRC", "A"),
                      "crown": ("GRC on steel frame", "A"), "ac_louver": ("aluminium", "A")},
    },
    "public": {
        "name": "Commercial-style", "cn": "公建化", "base": 2, "top": 1,
        "palette": {"ext_wall": "#d6d9dc", "ext_wall_base": "#585d61", "ext_wall_top": "#d6d9dc", "spandrel": "#2e3a42",
                    "fin": "#c4c8cc", "railing": "#9fb6bd", "frame": "#3b4246", "window": "#8daebc",
                    "column": "#585d61", "ac_louver": "#8a9095", "crown": "#c4c8cc", "parapet": "#d6d9dc",
                    "tower": "#2e3a42"},
        "spandrel": True,
        "fins": {"w": 80, "d": 450},
        "railing": "glass",
        "crown": "screen",
        "materials": {"spandrel": ("enamelled aluminium panel", "A"), "fin": ("aluminium", "A"),
                      "crown": ("aluminium fin screen", "A"), "ac_louver": ("aluminium", "A")},
    },
}


# ---------------------------------------------------------------- envelope of the typical floor
def envelope(b):
    """Outer faces of the typical floor: [{face, orient, line, out, dir, lo, hi}], plus balconies/AC and openings."""
    fp = b["floor_plate"]
    rooms = fp["rooms"]
    body = [q for rm in rooms.values() if rm["type"] not in ("BL", "BLN", "AC") for q in rm["rects"]]
    X0, Y0 = min(q[0] for q in body), min(q[1] for q in body)
    X1, Y1 = max(q[2] for q in body), max(q[3] for q in body)
    faces = []
    for o, c, lo, hi, kind, (a, bb) in floor_walls(rooms):
        if kind != "exterior":
            continue
        d = -1 if a is None else 1                      # outside toward -x/-y (west/north) or +x/+y (east/south)
        face = {("h", -1): "N", ("h", 1): "S", ("v", -1): "W", ("v", 1): "E"}[(o, d)]
        faces.append({"face": face, "orient": o, "line": c, "out": c + d * EXT / 2, "dir": d, "lo": lo, "hi": hi})
    proj = []                                            # balconies and AC platforms in front of a face
    for rm in rooms.values():
        if rm["type"] in ("BL", "BLN"):
            proj += [{"rect": q, "kind": "BL"} for q in rm["rects"]]
    proj += [{"rect": a["rect"], "kind": "AC", "side": a["side"]} for a in fp["ac"]]
    openings = []                                        # (orient, line, lo, hi, z0, z1) on exterior walls
    for w in fp["windows"]:
        openings.append((w["orient"], w.get("y", w.get("x")), w["from"], w["to"], 900, 2400, "window"))
    ext_lines = {(f["orient"], f["line"]) for f in faces}
    for dd in fp["doors"]:
        if (dd["orient"], dd["at"]) in ext_lines and dd["kind"] != "open":
            openings.append((dd["orient"], dd["at"], dd["from"], dd["to"], 0, 2400, "door"))
    core = [q for rm in rooms.values() if rm["type"] == "CORE" for q in rm["rects"]]
    core_rects = [[min(q[0] for q in core), min(q[1] for q in core), max(q[2] for q in core), max(q[3] for q in core)]] if core else []
    return {"faces": faces, "proj": proj, "openings": openings, "bbox": (X0, Y0, X1, Y1), "core_rects": core_rects}


def _box(role, x0, y0, x1, y1, z0, z1):
    return {"role": role, "box": [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1), z0, z1]}


def _out_box(role, f, a, b_, d0, d1, z0, z1):
    """Box in front of face f, along a..b_, from d0 to d1 mm outside the outer face."""
    p0, p1 = f["out"] + f["dir"] * d0, f["out"] + f["dir"] * d1
    if f["orient"] == "h":
        return _box(role, a, p0, b_, p1, z0, z1)
    return _box(role, p0, a, p1, b_, z0, z1)


def _proj_depth(env, f, a, b_):
    """How far balconies / AC platforms stand in front of face f over a..b_ (mm beyond the outer face)."""
    dep = 0
    for p in env["proj"]:
        x0, y0, x1, y1 = p["rect"]
        if f["orient"] == "h":
            if min(x1, b_) - max(x0, a) <= 0:
                continue
            edge = y1 if f["dir"] > 0 else y0
            if (f["dir"] > 0 and y0 >= f["line"] - 1) or (f["dir"] < 0 and y1 <= f["line"] + 1):
                dep = max(dep, abs(edge - f["out"]))
        else:
            if min(y1, b_) - max(y0, a) <= 0:
                continue
            edge = x1 if f["dir"] > 0 else x0
            if (f["dir"] > 0 and x0 >= f["line"] - 1) or (f["dir"] < 0 and x1 <= f["line"] + 1):
                dep = max(dep, abs(edge - f["out"]))
    return dep


def _face_openings(env, f):
    return [(lo, hi, z0, z1, k) for o, c, lo, hi, z0, z1, k in env["openings"] if o == f["orient"] and abs(c - f["line"]) < 5]


def _clear(env, f, a, b_, gap=50):
    return all(b_ + gap <= lo or a - gap >= hi for lo, hi, *_ in _face_openings(env, f))


def _merge_faces(env):
    """Faces merged into one run per (face, outer line): [(face_dict, lo, hi)]."""
    runs = {}
    for f in env["faces"]:
        runs.setdefault((f["face"], f["out"]), []).append(f)
    out = []
    for (_, _), fs in runs.items():
        fs = sorted(fs, key=lambda f: f["lo"])
        cur = dict(fs[0])
        for f in fs[1:]:
            if f["lo"] <= cur["hi"] + 1:
                cur["hi"] = max(cur["hi"], f["hi"])
            else:
                out.append(cur)
                cur = dict(f)
        out.append(cur)
    return out


# ---------------------------------------------------------------- element generators (one storey, z from its floor)
def bands(env, h, d, role="band", z_mid=-SLAB / 2):
    """Horizontal band wrapping every face and every balcony / AC front at height z_mid."""
    z0, z1 = z_mid - h / 2, z_mid + h / 2
    out = []
    for f in _merge_faces(env):
        out.append(_out_box(role, f, f["lo"] - d, f["hi"] + d, 0, d, z0, z1))
    for p in env["proj"]:
        x0, y0, x1, y1 = p["rect"]
        sides = "SEW" if p["kind"] == "BL" else {"N": "NEW", "S": "SEW", "E": "NSE"}[p.get("side", "S")]
        if "S" in sides:
            out.append(_box(role, x0 - d, y1, x1 + d, y1 + d, z0, z1))
        if "N" in sides:
            out.append(_box(role, x0 - d, y0 - d, x1 + d, y0, z0, z1))
        if "E" in sides:
            out.append(_box(role, x1, y0, x1 + d, y1, z0, z1))
        if "W" in sides:
            out.append(_box(role, x0 - d, y0, x0, y1, z0, z1))
    return out


def surrounds(env, w, d, role="surround"):
    """A frame round every window on the outer face (jambs, head, sill)."""
    out = []
    for f in env["faces"]:
        for lo, hi, z0, z1, k in _face_openings(env, f):
            if k != "window" or lo < f["lo"] - 1 or hi > f["hi"] + 1:
                continue
            out += [_out_box(role, f, lo - w, lo, 0, d, z0 - w, z1 + w),
                    _out_box(role, f, hi, hi + w, 0, d, z0 - w, z1 + w),
                    _out_box(role, f, lo, hi, 0, d, z1, z1 + w),
                    _out_box(role, f, lo, hi, 0, d * 1.6, z0 - w, z0)]
    return out


def pilaster_positions(env, spec):
    """Where vertical pilasters go: building corners, the party line between the two dwellings / the core edges,
    and (if spec['other']) every junction of rooms along a face that is clear of openings."""
    X0, Y0, X1, Y1 = env["bbox"]
    pos = []                                               # (face_run, centre, (w, d), kind)
    for f in _merge_faces(env):
        if f["face"] not in ("N", "S"):
            continue
        cands = {}
        if spec.get("corner"):
            if abs(f["lo"] - X0) < 1:
                cands[X0 + spec["corner"][0] / 2] = (spec["corner"], "corner")
            if abs(f["hi"] - X1) < 1:
                cands[X1 - spec["corner"][0] / 2] = (spec["corner"], "corner")
        if spec.get("party"):
            party = [0.0] if f["face"] == "S" else []
            core = [rm for rm in env.get("core_rects", [])]
            party += [x for q in core for x in (q[0], q[2])] if f["face"] == "N" else []
            for x in party:
                if f["lo"] < x < f["hi"]:
                    cands[x] = (spec["party"], "party")
        if spec.get("other"):
            for g in env["faces"]:
                if g["face"] == f["face"] and abs(g["out"] - f["out"]) < 1:
                    for x in (g["lo"], g["hi"]):
                        if f["lo"] + 400 < x < f["hi"] - 400 and all(abs(x - c) > 900 for c in cands):
                            cands.setdefault(x, (spec["other"], "other"))
        for x, ((w, d), kind) in sorted(cands.items()):
            if _clear(env, f, x - w / 2, x + w / 2):
                pos.append((f, x, (w, d), kind))
    return pos


def pilasters(env, spec, H, role="pilaster", z0=-SLAB, z1=None):
    z1 = H - SLAB if z1 is None else z1
    out = []
    for f, x, (w, d), kind in pilaster_positions(env, spec):
        dd = _proj_depth(env, f, x - w / 2, x + w / 2) + d
        out.append(_out_box(role, f, x - w / 2, x + w / 2, 0, dd, z0, z1))
    return out


def fin_positions(env, w):
    """Fins just outside both jambs of every window and balcony door on the long faces, and at balcony ends."""
    pos = []
    for f in env["faces"]:
        if f["face"] not in ("N", "S"):
            continue
        for lo, hi, z0, z1, k in _face_openings(env, f):
            if lo < f["lo"] - 1 or hi > f["hi"] + 1:
                continue
            for x in (lo - 40 - w / 2, hi + 40 + w / 2):
                if f["lo"] - 1 <= x - w / 2 and x + w / 2 <= f["hi"] + 1 and _clear(env, f, x - w / 2, x + w / 2, 10):
                    pos.append((f, x))
    seen, out = set(), []
    for f, x in pos:
        k = (f["face"], round(x))
        if k not in seen:
            seen.add(k)
            out.append((f, x))
    return out


def fins(env, w, d, H, role="fin", z0=-SLAB, z1=None):
    z1 = H - SLAB if z1 is None else z1
    out = []
    for f, x in fin_positions(env, w):
        dd = max(d, _proj_depth(env, f, x - w / 2, x + w / 2) + 150)
        out.append(_out_box(role, f, x - w / 2, x + w / 2, 0, dd, z0, z1))
    return out


def spandrels(env, H, role="spandrel", t=40, gap=20):
    """Dark panel strips over the slab zone (head of this storey's windows up to the next storey's sills), cut
    round door openings, on every face: from the outside the floors read as continuous dark bands."""
    out = []
    for f in _merge_faces(env):
        strips = [(2400, H - SLAB), (-SLAB, 900)]
        for z0, z1 in strips:
            spans = [(f["lo"] - t - gap, f["hi"] + t + gap)]
            for lo, hi, oz0, oz1, k in _face_openings(env, f):
                if min(oz1, z1) - max(oz0, z0) > 0:          # opening reaches into this strip: cut it out
                    nxt = []
                    for a, b_ in spans:
                        if hi <= a or lo >= b_:
                            nxt.append((a, b_))
                            continue
                        if lo > a:
                            nxt.append((a, lo))
                        if hi < b_:
                            nxt.append((hi, b_))
                    spans = nxt
            for a, b_ in spans:
                if b_ - a > 50:
                    out.append(_out_box(role, f, a, b_, gap, gap + t, z0, z1))
    return out


def ac_louvers(env, H, role="ac_louver", pitch=200, t=25):
    """Horizontal louvre slats on the open sides of every AC platform, from the rail to the slab above."""
    out = []
    for p in env["proj"]:
        if p["kind"] != "AC":
            continue
        x0, y0, x1, y1 = p["rect"]
        sides = {"N": "NEW", "S": "SEW", "E": "NSE"}[p.get("side", "S")]
        z = 1300
        while z < H - SLAB - 100:
            if "S" in sides:
                out.append(_box(role, x0, y1 - 60, x1, y1, z, z + t))
            if "N" in sides:
                out.append(_box(role, x0, y0, x1, y0 + 60, z, z + t))
            if "E" in sides:
                out.append(_box(role, x1 - 60, y0, x1, y1, z, z + t))
            if "W" in sides:
                out.append(_box(role, x0, y0, x0 + 60, y1, z, z + t))
            z += pitch
    return out


# ---------------------------------------------------------------- roof crowns (z from the roof slab surface)
def _towers(b):
    r = b["roof"]
    xs = [r["stair_head"][0], r["stair_head"][2], r["machine_room"][0], r["machine_room"][2]]
    ys = [r["stair_head"][1], r["stair_head"][3], r["machine_room"][1], r["machine_room"][3]]
    return [min(xs), min(ys), max(xs), max(ys)], r["head_h"]


def crown(b, env, st, H):
    kind = st.get("crown")
    X0, Y0, X1, Y1 = env["bbox"]
    (tx0, ty0, tx1, ty1), hh = _towers(b)
    par = b["roof"]["parapet_h"] * 1000
    out = []
    if kind == "frame":                                   # open steel frame over the core, 2.4 m above the towers
        m = 1200
        fx0, fy0, fx1, fy1 = tx0 - m, ty0 - m, tx1 + m, ty1 + m
        top = hh + 2400
        for x in (fx0, (fx0 + fx1) / 2, fx1):
            for y in (fy0, fy1):
                out.append(_box("crown", x - 150, y - 150, x + 150, y + 150, 0, top))
        out += [_box("crown", fx0 - 150, fy0 - 150, fx1 + 150, fy0 + 150, top - 400, top),
                _box("crown", fx0 - 150, fy1 - 150, fx1 + 150, fy1 + 150, top - 400, top),
                _box("crown", fx0 - 150, fy0, fx0 + 150, fy1, top - 400, top),
                _box("crown", fx1 - 150, fy0, fx1 + 150, fy1, top - 400, top)]
        k = 6
        for i in range(1, k):
            x = fx0 + (fx1 - fx0) * i / k
            out.append(_box("crown", x - 60, fy0, x + 60, fy1, top - 300, top))
        for f in _merge_faces(env):                       # thin coping band on the parapet
            out.append(_out_box("band", f, f["lo"] - 150, f["hi"] + 150, 0, 150, par - 260, par))
    elif kind == "eave":                                  # deep flat eave on the parapet, hipped roofs on the towers
        ov = 900
        e0, e1 = par, par + 220
        out += [_box("crown", X0 - ov, Y0 - ov, X1 + ov, Y0 + 300, e0, e1),
                _box("crown", X0 - ov, Y1 - 300, X1 + ov, Y1 + ov, e0, e1),
                _box("crown", X0 - ov, Y0 + 300, X0 + 300, Y1 - 300, e0, e1),
                _box("crown", X1 - 300, Y0 + 300, X1 + ov, Y1 - 300, e0, e1)]
        for p in env["proj"]:                              # balconies too: the eave steps out over them
            x0, y0, x1, y1 = p["rect"]
            if p["kind"] == "BL":
                out.append(_box("crown", x0 - 300, Y1, x1 + 300, y1 + ov, e0, e1))
        s = 600                                            # the hip roof starts 600 mm outside the towers
        rise = 2200
        out.append({"role": "roof_tile", "frustum": [[tx0 - s, ty0 - s, tx1 + s, ty1 + s], hh + 200,
                                                      [tx0 + (tx1 - tx0) * 0.3, (ty0 + ty1) / 2 - 25,
                                                       tx1 - (tx1 - tx0) * 0.3, (ty0 + ty1) / 2 + 25], hh + 200 + rise]})
        out.append(_box("crown", tx0 - s, ty0 - s, tx1 + s, ty1 + s, hh, hh + 200))
    elif kind == "stepped":                               # Art Deco: pilasters rise in steps, stepped core tower
        spec = st["pilasters"]
        k_h = max(0.5, min(1.0, b["requirements"]["height_m"] / 60))   # a lower block gets a lower crown
        for f, x, (w, d), k in pilaster_positions(env, spec):
            extra = {"corner": 2400, "party": 4200, "other": 1500}[k] * k_h
            dd = d
            out.append(_out_box("pilaster", f, x - w / 2, x + w / 2, 0, dd, 0, par + extra))
            out.append(_out_box("finial", f, x - w / 2 - 60, x + w / 2 + 60, 0, dd + 60, par + extra, par + extra + 250))
        t1 = [tx0 - 300, ty0 - 300, tx1 + 300, ty1 + 300]
        z1 = hh + 1800 * k_h
        out.append(_box("crown", *t1, 0, z1))
        t2 = [t1[0] + 1200, t1[1] + 900, t1[2] - 1200, t1[3] - 900]
        z2 = z1 + 2400 * k_h
        out.append(_box("crown", *t2, z1, z2))
        cx, cy = (tx0 + tx1) / 2, (ty0 + ty1) / 2
        out.append(_box("finial", cx - 600, cy - 600, cx + 600, cy + 600, z2, z2 + 1500 * k_h))
        for zz in (z1 - 300, z2 - 300):
            r = t1 if zz < z1 else t2
            out.append(_box("finial", r[0] - 120, r[1] - 120, r[2] + 120, r[3] + 120, zz, zz + 300))
        for f in _merge_faces(env):
            out.append(_out_box("band", f, f["lo"] - 200, f["hi"] + 200, 0, 200, par - 350, par))
    elif kind == "screen":                                # fins carried 3.3 m above the roof, panel behind them
        st_f = st["fins"]
        top = 3300
        for f, x in fin_positions(env, st_f["w"]):
            out.append(_out_box("fin", f, x - st_f["w"] / 2, x + st_f["w"] / 2, 0, st_f["d"], 0, top))
        for f in _merge_faces(env):
            if f["face"] in ("N", "S"):
                out.append(_out_box("spandrel", f, f["lo"], f["hi"], 20, 60, par, top))
                out.append(_out_box("crown", f, f["lo"] - 100, f["hi"] + 100, 0, st_f["d"], top, top + 150))
    return out


# ---------------------------------------------------------------- per-storey assembly
def zone_of(b, storey, st):
    """base / base_top / body / top_first / top for a storey number."""
    n = len(b["floors"])
    nb, nt = st.get("base", 1), st.get("top", 0)
    if storey <= nb:
        return "base_top" if storey == nb else "base"
    if nt and storey > n - nt:
        return "top_first" if storey == n - nt + 1 else "top"
    return "body"


def storey_elements(b, env, st, zone, kind):
    """Decoration added to one storey of a given floor kind ('typical', 'refuge', 'pilotis') in a given zone."""
    H = b["requirements"]["storey_h"] * 1000
    out = []
    typical = kind == "typical"
    if typical:
        out += ac_louvers(env, H)
        if st.get("surrounds"):
            out += surrounds(env, st["surrounds"]["w"], st["surrounds"]["d"])
        if st.get("spandrel"):
            out += spandrels(env, H)
    if st.get("bands") and kind != "pilotis":
        bd = st["bands"]
        if bd.get("every", 1) == 1 or zone in ("base_top", "top_first"):
            out += bands(env, bd["h"], bd["d"])
    if st.get("pilasters") and kind != "pilotis":
        out += pilasters(env, st["pilasters"], H)
    if st.get("fins") and kind != "pilotis":
        out += fins(env, st["fins"]["w"], st["fins"]["d"], H)
    if zone == "base_top" and st.get("cornice") and kind != "pilotis":
        c = st["cornice"]
        out += bands(env, c["h"], c["d"], role="cornice", z_mid=H - SLAB - c["h"] / 2)
    if zone == "top_first" and st.get("top_band"):
        c = st["top_band"]
        out += bands(env, c["h"], c["d"], role="band", z_mid=-SLAB + c["h"] / 2)
    return out


def zone_roles(st, zone):
    """Role renames for the envelope in a zone (so the base can be stone and the top a different tone)."""
    ren = {}
    if zone in ("base", "base_top") and "ext_wall_base" in st["palette"]:
        ren["ext_wall"] = "ext_wall_base"
    if zone in ("top", "top_first") and "ext_wall_top" in st["palette"]:
        ren["ext_wall"] = "ext_wall_top"
    return ren


def materials(b, st):
    """Material and fire class of each decorative element at this building's height (rule F1)."""
    H = b["requirements"]["height_m"]
    out = {}
    for role, m in st.get("materials", {}).items():
        if len(m) == 4:                                   # (low-rise choice, class, above-50-m choice, class)
            out[role] = (m[0], m[1]) if H <= 50 else (m[2], m[3])
        else:
            out[role] = m
    return out


# ---------------------------------------------------------------- checks
def _crown_obstruction(b, env, st):
    """Boxes (plan mm, z above roof slab) that rise above the roof: parapet, towers and the style's crown."""
    X0, Y0, X1, Y1 = env["bbox"]
    par = b["roof"]["parapet_h"] * 1000
    (tx0, ty0, tx1, ty1), hh = _towers(b)
    boxes = [[X0, Y0, X1, Y1, 0, par], [tx0, ty0, tx1, ty1, 0, hh + SLAB]]
    for p in crown(b, env, st, b["requirements"]["storey_h"] * 1000):
        if "box" in p:
            boxes.append(p["box"])
        else:
            (r0, z0, r1, z1) = p["frustum"]
            boxes.append([r0[0], r0[1], r0[2], r0[3], z0, z1])
    return boxes


def sun_study(b, st, site, spacing=None):
    """Sun hours at the lowest living-room window, with the block to the south modelled as it is built: the slab, its
    parapet, the stair and lift towers and the style's crown (rule F4). b needs floor_plate, floors, requirements and
    roof. With spacing=None the row spacing is set to the smallest whole metre that meets the requirement."""
    from highrise import sun
    env = envelope(b)
    req = b["requirements"]
    X0, Y0, X1, Y1 = env["bbox"]
    L = (X1 - X0) / 1000
    lr = next(rm for rid, rm in b["floor_plate"]["rooms"].items() if rm["type"] == "LR" and rid.startswith("E"))
    q = lr["rects"][0]
    first = next(f for f in b["floors"] if f["kind"] == "typical")
    win = ((q[0] + q[2]) / 2000, first["level_m"] + 0.9)
    depth = (max([p["rect"][3] for p in env["proj"]] + [Y1]) - Y0) / 1000
    roof_z = req["height_m"]
    extra = _crown_obstruction(b, env, st)
    day = site.get("day", "major_cold")

    def boxes(sp):
        out = sun.row_boxes(sp, L, depth, roof_z)
        for k in range(-2, 3):
            dx = k * (L + 13.0)
            for x0, y0, x1, y1, z0, z1 in extra:
                out.append(((dx + x0 / 1000, sp + (y0 - Y0) / 1000, roof_z + z0 / 1000),
                            (dx + x1 / 1000, sp + (y1 - Y0) / 1000, roof_z + z1 / 1000)))
        return out

    hrs = lambda sp: sun.sun_hours(site["lat"], win, boxes(sp), day)
    lo, hi = 1.0, 6 * (roof_z + 15)
    need = None
    if hrs(hi) >= site["required_h"]:
        for _ in range(22):
            mid = (lo + hi) / 2
            if hrs(mid) >= site["required_h"]:
                hi = mid
            else:
                lo = mid
        need = round(hi, 1)
    sp = spacing or (int(need) + 1 if need else round(hi))
    hours = hrs(sp)
    top = max(z1 for *_, z1 in extra)
    return {"row_spacing_m": sp, "hours": round(hours, 2), "required": site["required_h"], "min_spacing_m": need,
            "top_above_roof_m": round(top / 1000, 2), "pass": hours >= site["required_h"] - 1e-9}


def sun_check(b, env, st, spacing=None):
    s = b["sun"]
    return sun_study(b, st, {"lat": s["lat"], "required_h": s["required"]}, spacing or s["row_spacing_m"])


def check(b, st, elements):
    """Rules F1-F6 for one style on one building. elements: {zone_kind: [primitives]} as built."""
    env = envelope(b)
    H = b["requirements"]["height_m"]
    res = []
    mats = materials(b, st)
    bad = [f"{r}: {m} (class {c})" for r, (m, c) in mats.items() if (H > 50 and c != "A") or c not in ("A", "B1")]
    res.append({"id": "F1", "rule": "Decorative layer class A above 50 m, at least B1 below (GB 50016 6.7.12)",
                "pass": not bad, "detail": "; ".join(f"{r}: {m} ({c})" for r, (m, c) in mats.items()) or "no decoration",
                "fail": bad})
    res.append({"id": "F2", "rule": "No openings added: window-to-wall ratio and daylight as in the plan",
                "pass": not any(p["role"] in ("window", "door") for v in elements.values() for p in v),
                "detail": f"{len(b['floor_plate']['windows'])} windows per floor, unchanged"})
    hits = []
    for f in env["faces"]:
        for lo, hi, z0, z1, k in _face_openings(env, f):
            for v in elements.values():
                for p in v:
                    if "box" not in p or p["role"] in ("band", "cornice", "spandrel", "ac_louver"):
                        continue
                    x0, y0, x1, y1, pz0, pz1 = p["box"]
                    a, c = (x0, x1) if f["orient"] == "h" else (y0, y1)
                    near = (min(abs(y0 - f["out"]), abs(y1 - f["out"])) if f["orient"] == "h"
                            else min(abs(x0 - f["out"]), abs(x1 - f["out"]))) < 30
                    if near and min(c, hi) - max(a, lo) > 1 and min(pz1, z1) - max(pz0, z0) > 1 and p["role"] != "surround":
                        hits.append(f"{p['role']} over {k} at {f['face']} {lo:.0f}-{hi:.0f}")
    res.append({"id": "F3", "rule": "No fin, pilaster or surround in front of a window or door",
                "pass": not hits, "detail": f"{len(hits)} conflicts", "fail": hits[:5]})
    sc = sun_check(b, env, st)
    res.append({"id": "F4", "rule": "Sun hours with parapet, towers and crown on the block to the south (GB 50180 4.0.9)",
                "pass": sc["pass"], "detail": f"{sc['hours']} h at {sc['row_spacing_m']} m spacing (needs {sc['required']} h); "
                f"top {sc['top_above_roof_m']} m above the roof; needs {sc['min_spacing_m']} m", "sun": sc})
    res.append({"id": "F5", "rule": "Fire-code height measured to the roof surface (GB 50016 A.0.1)", "pass": True,
                "detail": f"{H} m, unchanged; the crown adds {sc['top_above_roof_m']} m to the silhouette (check local planning height limits)"})
    glass = [r for r, (m, c) in mats.items() if "glass" in m.lower()]
    res.append({"id": "F6", "rule": "No glass curtain wall above the ground floor on housing (e.g. Hangzhou 2015)",
                "pass": not glass, "detail": "glass only in windows, balcony doors, railings and the ground-floor hall"})
    return res
