"""Furniture placement — the current formula (kept after the Merrell 2011 compute test), shared by every builder.

For each furnished room, in the order ROOM_ITEMS lists the items:
  free region  Φ = (room ⊖ wall faces) ∖ (door zones ⊕ 1.1 m) ∖ (stair ⊕ 0.6 m)
  wall   item's back on the longest edge of Φ that fits, at a seeded offset along it (150 mm steps)
  corner item at either end of the longest edge;   centre  item at Φ's centroid, long axis along the room
  grid   rows of items with 600 × 900 mm gaps (classrooms, shops, warehouses)
An item is accepted when its footprint lies in Φ and keeps 40 mm from every placed item. Seeds are stable
(FNV-1a of building, room and item), so a rebuilt room is identical (Germer & Schwarz's persistence rule).
"""
import math
import numpy as np
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union


def stable_seed(*parts):
    h = 2166136261
    for ch in "|".join(map(str, parts)):
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h & 0xFFFF


def cells_poly(mask, c):
    ys, xs = np.nonzero(mask)
    if not len(ys): return None
    return unary_union([sbox(x * c, y * c, (x + 1) * c, (y + 1) * c) for y, x in zip(ys, xs)]).buffer(0.5).buffer(-0.5)


# ---- audit fixes (D3): the footprint reserved is the modelled one; tall items keep clear of windows; an item that
# does not fit is replaced by a smaller one rather than dropped
SUBSTITUTE = {"bed_double": ["bed_single"], "kitchen_run": ["kitchen_short", "kitchen_short_low"], "kitchen_short": ["kitchen_short_low"],
              "dining_table": ["cafe_table"], "sofa": ["armchair"], "wardrobe": ["bookshelf"], "desk": [], "bathtub": ["shower"]}
LOW_VARIANT = {"kitchen_run": "kitchen_run_low", "kitchen_short": "kitchen_short_low"}
_GEOM = {}


def item_geom(name, L, D):
    """Local plan bbox (x0, y0, x1, y1) and height of the modelled item (mm), from the furniture library."""
    if not _GEOM:
        try:
            import spec as _SP
            lib, _, _ = _SP.furniture_library()
            for n, parts in lib.items():
                xs, ys, zs = [0.0], [0.0], [0.0]
                for d in parts:
                    off = d.get("off", (0, 0, 0)); t = d["t"]
                    if t == "box": p, sz = d["p"], d["s"]; xs += [p[0] + off[0], p[0] + off[0] + sz[0]]; ys += [p[1] + off[1], p[1] + off[1] + sz[1]]; zs += [p[2] + off[2] + sz[2]]
                    elif t == "cyl": p, r = d["p"], d["r"]; xs += [p[0] + off[0] - r, p[0] + off[0] + r]; ys += [p[1] + off[1] - r, p[1] + off[1] + r]; zs += [p[2] + d["h"]]
                    elif t == "sph": p, r = d["p"], d["r"]; xs += [p[0] - r, p[0] + r]; ys += [p[1] - r, p[1] + r]; zs += [p[2] + r]
                    elif t == "cut": A = d["a"]; p, sz = A["p"], A["s"]; xs += [p[0], p[0] + sz[0]]; ys += [p[1], p[1] + sz[1]]; zs += [p[2] + sz[2]]
                _GEOM[n] = (min(xs), min(ys), max(xs), max(ys), max(zs))
        except Exception:
            _GEOM["_failed"] = True
    g = _GEOM.get(name)
    if g is None: return (0, 0, L, D), 0
    return (min(0, g[0]), min(0, g[1]), max(L, g[2]), max(D, g[3])), g[4]


def poses(free, placed, Lw, Dw, mode, seed=0, bb=None):
    """Positions for one item in a free region: yields (x, y, angle°, footprint polygon)."""
    import random
    rnd = random.Random(seed)
    occupied = unary_union(placed) if placed else None
    def ok(fp):
        if not free.contains(fp): return False
        if occupied is not None and fp.buffer(40).intersects(occupied): return False
        return True
    bx0, by0, bx1, by1 = bb if bb else (0, 0, Lw, Dw)
    def rect(x, y, ang):
        a = math.radians(ang); ca, sa = math.cos(a), math.sin(a)
        return Polygon([(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in [(bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)]])
    if mode in ("wall", "corner"):
        polys = [free] if isinstance(free, Polygon) else sorted(free.geoms, key=lambda p: -p.area)
        for P in polys:
            ring = list(P.exterior.coords)
            if not P.exterior.is_ccw: ring = ring[::-1]
            for (x1, y1), (x2, y2) in sorted(zip(ring, ring[1:]), key=lambda s: -math.dist(*s)):
                Ls = math.dist((x1, y1), (x2, y2))
                if Ls < (bx1 - bx0): continue
                ang = math.degrees(math.atan2(y2 - y1, x2 - x1)); ux, uy = (x2 - x1) / Ls, (y2 - y1) / Ls
                span = bx1 - bx0
                offs = list(np.arange(0, Ls - span + 1, 150)) if mode == "wall" else [0, Ls - span]
                if mode == "wall": rnd.shuffle(offs)
                for t in offs:
                    sx, sy = -min(0, bx0), -min(0, by0)          # modelled overhang behind / beside the origin
                    x, y = x1 + ux * (t + sx) - uy * sy, y1 + uy * (t + sx) + ux * sy; fp = rect(x, y, ang)
                    if ok(fp): yield (x, y, ang, fp); return
        return
    if mode == "centre":
        minx, miny, maxx, maxy = free.bounds
        longx = (maxx - minx) >= (maxy - miny)
        p = free.representative_point() if not isinstance(free, Polygon) else free.centroid
        if not free.contains(p): p = free.representative_point()
        for ang in ((0, 90) if longx else (90, 0)):
            a = math.radians(ang)
            x = p.x - (Lw / 2 * math.cos(a) - Dw / 2 * math.sin(a)); y = p.y - (Lw / 2 * math.sin(a) + Dw / 2 * math.cos(a))
            fp = rect(x, y, ang)
            if ok(fp): yield (x, y, ang, fp); return
        return
    if mode == "grid":
        minx, miny, maxx, maxy = free.bounds
        gapx, gapy = (600, 900) if Lw < 3000 else (1500, 900)
        n = 0
        for y in np.arange(miny + 300, maxy - Dw, Dw + gapy):
            for x in np.arange(minx + 300, maxx - Lw, Lw + gapx):
                fp = rect(x, y, 0)
                if ok(fp):
                    yield (x, y, 0, fp); n += 1
                    occupied = unary_union([occupied, fp]) if occupied is not None else fp
                    if n > 60: return
        return


def furnish(plan, st, specs_by_storey, items_table, room_items):
    """All furniture of a building: list of dict(storey, room, name, x, y, ang, fp). items_table: name → (L, D, …)."""
    rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000; te = st["ext"] * 1000
    out = []
    for s, specs in enumerate(specs_by_storey):
        L = np.array(plan["labels"][s])
        for r in [r for r in rooms if r["storey"] == s]:
            items = room_items.get(r["kind"]); lab = r["id"] + 1; m = L == lab
            if not items or m.sum() < 2 or r.get("subdivided") or r.get("stair") or r["kind"] == "stair": continue
            rp = cells_poly(m, c)
            if rp is None: continue
            free = rp.buffer(-(te + 30))
            if free.is_empty: continue
            holes = []
            for sp in specs:
                own = lab in (sp["inner"], sp["outer"])
                for o in sp["openings"]:
                    if not own:
                        # audit fix: a neighbour's door whose approach reaches into this room (open plan) is kept clear too
                        if o["kind"] not in ("door", "overhead"): continue
                        p_ = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
                        Z = sbox(p_[0] - o["w"] / 2 - 150, p_[1] - 915, p_[0] + o["w"] / 2 + 150, p_[1] + 915) if sp["axis"] == "x" else sbox(p_[0] - 915, p_[1] - o["w"] / 2 - 150, p_[0] + 915, p_[1] + o["w"] / 2 + 150)
                        if Z.intersects(rp): holes.append(Z)
                        continue
                    if o["kind"] in ("door", "overhead"):
                        p = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
                        dz = 1100 if plan["theme"].get("archetype") in ("church", "civic", "school", "big_box", "office", "storefront") else 915   # audit: 36 in residential clear floor
                        holes.append(sbox(p[0] - o["w"] / 2 - 150, p[1] - dz, p[0] + o["w"] / 2 + 150, p[1] + dz) if sp["axis"] == "x" else sbox(p[0] - dz, p[1] - o["w"] / 2 - 150, p[0] + dz, p[1] + o["w"] / 2 + 150))
                    for a in (o.get("swing") or {}).get("arcs", []): holes.append(Polygon(a).buffer(80))     # keep every swing clear
            if plan.get("stair") and any(rr.get("stair") for rr in rooms if rr["storey"] == s):
                x0, y0, w, h = plan["stair"]; holes.append(sbox(x0 * c - 600, y0 * c - 600, (x0 + w) * c + 600, (y0 + h) * c + 600))
            free = free.difference(unary_union(holes)) if holes else free
            # windows of this room: tall items (above the sill) keep a 700 mm zone in front of each one clear
            wins = []
            for sp in specs:
                if not sp["ext"] or lab != sp["inner"]: continue
                for o in sp["openings"]:
                    if o["kind"] != "window": continue
                    p = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
                    z = sbox(p[0] - o["w"] / 2, p[1] - 900, p[0] + o["w"] / 2, p[1] + 900) if sp["axis"] == "x" else sbox(p[0] - 900, p[1] - o["w"] / 2, p[0] + 900, p[1] + o["w"] / 2)
                    wins.append((z, o["win"]["sill"]))
            placed = []
            for name, mode in items:
                for cand in [name] + SUBSTITUTE.get(name, []):
                    if cand not in items_table: continue
                    Lw, Dw = items_table[cand][0], items_table[cand][1]
                    bb, h = item_geom(cand, Lw, Dw)
                    blocked = [z for z, sill in wins if h > max(sill + 300, 1200)]
                    region = free.difference(unary_union(blocked)) if blocked else free
                    got = False
                    for x, y, ang, fp in poses(region, placed, Lw, Dw, mode, seed=stable_seed(plan.get("id"), r["id"], name), bb=bb):
                        out.append(dict(storey=s, room=r["id"], kind=r["kind"], name=cand, x=x, y=y, ang=ang, fp=fp)); placed.append(fp); got = True
                        if mode != "grid": break
                    if not got and blocked and cand in LOW_VARIANT and LOW_VARIANT[cand] in items_table:
                        low = LOW_VARIANT[cand]; bb2, _ = item_geom(low, Lw, Dw)        # same counter without wall cabinets, under the window
                        for x, y, ang, fp in poses(free, placed, Lw, Dw, mode, seed=stable_seed(plan.get("id"), r["id"], name), bb=bb2):
                            out.append(dict(storey=s, room=r["id"], kind=r["kind"], name=low, x=x, y=y, ang=ang, fp=fp)); placed.append(fp); got = True
                            break
                    if got: break
                if not got and name in ("kitchen_run", "kitchen_short") and "kitchen_short_low" in items_table and not any(o_["room"] == r["id"] and o_["name"].startswith("kitchen") for o_ in out):
                    # open-plan kitchen with no free wall: an island counter
                    Lw, Dw = items_table["kitchen_short_low"][0], items_table["kitchen_short_low"][1]; bb, _ = item_geom("kitchen_short_low", Lw, Dw)
                    for x, y, ang, fp in poses(free, placed, Lw, Dw, "centre", seed=1, bb=bb):
                        out.append(dict(storey=s, room=r["id"], kind=r["kind"], name="kitchen_short_low", x=x, y=y, ang=ang, fp=fp)); placed.append(fp); break
    return out


# v2 (2026-10-30): Germer & Schwarz agents + Merrell 2011 cost (furnish2.py). Room kinds furnish2 does not cover keep
# the v1 formula above. FURN=v1 restores v1 everywhere.
import os as _os
_furnish_v1 = furnish
if _os.environ.get("FURN", "v2") == "v2":
    def furnish(plan, st, specs_by_storey, items_table, room_items):
        import furnish2
        v2 = furnish2.furnish(plan, st, specs_by_storey, items_table, room_items)
        kinds = {r["id"]: r["kind"] for r in plan["program"]["rooms"]}
        v1 = [f for f in _furnish_v1(plan, st, specs_by_storey, items_table, room_items) if kinds.get(f["room"]) not in furnish2.SEM]
        return v2 + v1

# 2026-11-02: AI-agent furniture edits (furn_edit.py, furnmcp/server.py). Off unless FURN_EDIT=1: competition and test
# builds never set it, so they always show the generator's own layout. _furnish_base is what the editor starts from.
_furnish_base = furnish
if _os.environ.get("FURN_EDIT") == "1":
    def furnish(plan, st, specs_by_storey, items_table, room_items):
        import furn_edit
        return furn_edit.apply(plan, _furnish_base(plan, st, specs_by_storey, items_table, room_items), items_table)
