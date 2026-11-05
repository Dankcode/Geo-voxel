"""Furniture for the high-rise dwellings (2026-11-05): the house pipeline's furnisher, room by room.

Every room of the typical floor plate goes through architecture/pipeline/furnish2.solve_room, the same solver the
houses use: Germer & Schwarz (2009) candidate poses against the room's real wall solids, Merrell et al. (2011) cost,
Metropolis. Each room gets its door clearances (the leaf width plus 150 mm either side, 915 mm deep; inside a bathroom
600 mm deep and only the leaf's width; a sliding door keeps only its 1 m passage clear), the probe points the circulation term walks between, and its windows (outside bathrooms, tall items stay out of the 900 mm
in front of a window whose sill is 900 mm). Room kinds come from viewer_export.KIND (LR living, DR dining, KT kitchen,
BR/BRM bedroom, BA/BAM bathroom, EN foyer; BL balconies get a washer, a plant and a chair). Halls, the core and AC platforms stay empty.

Coordinates: the FreeCAD frame in mm (x east, Y = -plan y), so a placed item drops straight into highrise.bim, as
pipeline/bim.py does for the houses. A floor kind is furnished once; every typical storey shows the same furniture,
which is how a typical floor is built.
"""
import os
import random
import sys

from shapely.geometry import Point, box as sbox
from shapely.ops import unary_union

PIPE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "pipeline")
if PIPE not in sys.path:
    sys.path.insert(0, PIPE)
import furnish2 as F2  # noqa: E402
import layout as LAY  # noqa: E402

from highrise.viewer_export import KIND  # noqa: E402
from highrise.walls import THICK, floor_walls  # noqa: E402

DOOR_DEPTH = 915          # 36 in landing on both sides of a door (as furnish2 does for the houses)
BLOCKED = 1e6             # furnish2.cost marks an unusable layout with 1e9
RESTARTS = 6              # seeds per room; the best layout is kept
WET_DEPTH = 600           # in a bathroom: about the 21 in fixture clearance (IRC R307) in front of the door
WIN_DEPTH = 900
WIN_SILL = 900            # highrise.bim cuts every window from 900 to 2400 mm
# A Chinese dwelling's balcony (1.4 m deep) holds the washing machine, not the porch chairs of a US house.
BALCONY = [F2.A("washer", "wall", clear=dict(front=500), sub=["washer_single"]), F2.A("plant", "corner", req=False),
           F2.A("porch_chair", "wall", req=False, seat=1, group=1, clear=dict(front=400))]


def _fc(q):
    """Plan rectangle (y south) -> shapely box in the FreeCAD frame (Y north)."""
    x0, y0, x1, y1 = q
    return sbox(min(x0, x1), -max(y0, y1), max(x0, x1), -min(y0, y1))


def _walls(rooms):
    out = []
    for o, c, lo, hi, kind, _ in floor_walls(rooms):
        t = THICK[kind]
        e = t / 2
        out.append(_fc([c - t / 2, lo - e, c + t / 2, hi + e] if o == "v" else [lo - e, c - t / 2, hi + e, c + t / 2]))
    return unary_union(out)


def _opening_zone(o, at, lo, hi, depth, pad):
    """Clear zone either side of an opening in a wall: 'v' at x = at over plan y lo..hi, 'h' at plan y = at."""
    return _fc([at - depth, lo - pad, at + depth, hi + pad] if o == "v" else [lo - pad, at - depth, hi + pad, at + depth])


def room_context(rid, rm, kind, walls, doors, windows):
    """The room as furnish2 sees it: free outline, door clearance zones, door probe points, window zones."""
    rp = unary_union([_fc(q) for q in rm["rects"]])
    side, short = rid.split(".", 1) if "." in rid else ("", rid)
    holes, door_pts, wins = [], [], []
    for d in doors:
        ends = {f"{d.get('side', '')}.{d.get('a')}", f"{d.get('side', '')}.{d.get('b')}"}
        o, at, lo, hi = d["orient"], d["at"], d["from"], d["to"]
        if d["kind"] == "slide":             # a sliding door opens half its width: keep the 1 m passage clear
            mid_ = (lo + hi) / 2
            lo, hi = mid_ - 500, mid_ + 500
        wet = kind in ("bathroom", "wc")         # a small bathroom keeps the leaf's width clear, fixtures may flank it
        Z = _opening_zone(o, at, lo, hi, WET_DEPTH if wet else DOOR_DEPTH, 0 if wet else 150)
        if Z.intersects(rp):
            holes.append(Z)
        if rid in ends:                      # probe point just inside this room, past the wall and a person's radius
            dd = 60 + F2.PERSON_R.get(kind, 457.2) + 150
            mid = (lo + hi) / 2
            for sgn in (-1, 1):
                px, py = (at + sgn * dd, -mid) if o == "v" else (mid, -(at + sgn * dd))
                if rp.contains(Point(px, py)):
                    door_pts.append((px, py))
                    break
    for w in ([] if kind in ("bathroom", "wc") else windows):   # a shower may stand under a bathroom's frosted window
        at = w.get("y", w.get("x"))
        z = _opening_zone(w["orient"], at, w["from"], w["to"], WIN_DEPTH, 0)
        if z.intersection(rp).area > 1e5:
            wins.append((z, WIN_SILL))
    R = F2.Room(rp, walls, holes, None, wins, door_pts, kind)
    return R, door_pts


def _poses(R, ag, items_table, rnd):
    """Candidate poses of a wall/corner/centre agent, item by item (the first item that has poses, as furnish2 does)."""
    for name in [ag["n"]] + ag.get("sub", []):
        if name not in items_table:
            continue
        Lw, Dw = items_table[name][0], items_table[name][1]
        bb, h = LAY.item_geom(name, Lw, Dw)
        cs = F2.candidates(R, ag, Lw, Dw, bb, h, rnd)
        for c in cs:
            c["name"] = name
        if cs:
            yield from cs


def _hit(a, b):
    """Two items overlap by more than 1 mm both ways (furnish2.cost's own test)."""
    A, B = a["b"], b["b"]
    return min(A[2], B[2]) - max(A[0], B[0]) > 1 and min(A[3], B[3]) - max(A[1], B[1]) > 1


def fill_required(R, ags, sel, items_table, door_pts, rnd):
    """A required item the search left out (it never adds one that raises the cost) goes into its cheapest legal
    pose. If every pose overlaps another item, that item is moved to its own cheapest free pose first (one level of
    repair; an item that other items hang on, like the sofa its coffee table, is never moved). furnish2 itself is
    unchanged, so the houses are not affected."""
    sel = list(sel)
    parents = {ag["parent"][1] for ag in ags if isinstance(ag["parent"], tuple)}
    for i, ag in enumerate(ags):
        if sel[i] is not None or not ag.get("req") or isinstance(ag["parent"], tuple):
            continue
        best = None
        for c in _poses(R, ag, items_table, rnd):
            trial = sel[:i] + [c] + sel[i + 1:]
            hits = [k for k, p in enumerate(trial) if p is not None and k != i and _hit(c, p)]
            if any(k in parents or isinstance(ags[k]["parent"], tuple) for k in hits):
                continue
            ok = True
            for k in hits:
                trial[k] = None
                moved = None
                for ck in _poses(R, ags[k], items_table, rnd):
                    if any(p is not None and _hit(ck, p) for p in trial):
                        continue
                    cv = F2.cost(R, ags, trial[:k] + [ck] + trial[k + 1:], door_pts)[0]
                    if moved is None or cv < moved[0]:
                        moved = (cv, ck)
                if moved:
                    trial[k] = moved[1]
                elif ags[k].get("req"):
                    ok = False
                    break
            if not ok:
                continue
            cv = F2.cost(R, ags, trial, door_pts)[0]
            if cv >= BLOCKED:                    # a door cut off or an item outside the room: not a layout
                continue
            if best is None or (len(hits), cv) < best[0]:
                best = ((len(hits), cv), trial)
        if best:
            sel = best[1]
    return sel, F2.cost(R, ags, sel, door_pts)[0]


def furnish_floor(rooms, doors, windows, items_table, seed=""):
    """rooms: floor_plate['rooms'] ({'E.lr': {'type': 'LR', 'rects': [...]}, ...}); doors, windows: floor_plate's.
    items_table: name -> (L, D, ...) (pipeline/furniture.ITEMS, or spec.furniture_library()'s items).
    Returns [dict(room, kind, name, x, y, ang, fp, b)] in the FreeCAD frame, mm, and a per-room report."""
    walls = _walls(rooms)
    items, report = [], []
    for rid, rm in rooms.items():
        kind = KIND.get(rm["type"])
        ags = BALCONY if rm["type"] in ("BL", "BLN") else F2.SEM.get(kind)
        if not ags or rm["type"] == "CORE":
            continue
        R, door_pts = room_context(rid, rm, kind, walls, doors, windows)
        side, short = rid.split(".", 1) if "." in rid else ("", rid)
        best = None                              # restarts, as the planner does: fewest missing items, then cost
        for k in range(RESTARTS):
            rnd = random.Random(LAY.stable_seed(seed, short, "furnish2", k))
            res = F2.solve_room(R, ags, items_table, rnd, door_pts, walls)
            miss = sum(1 for i, p in enumerate(res[0]) if p is None and ags[i].get("req"))
            if best is None or (miss, res[1]) < best[0]:
                best = ((miss, res[1]), res)
            if miss == 0 and res[1] < 1.0:
                break
        sel, c_, T, flush = best[1]
        sel, c_ = fill_required(R, ags, sel, items_table, door_pts, random.Random(LAY.stable_seed(seed, short, "fill")))
        report.append(dict(room=rid, kind=kind, cost=round(c_, 3), placed=[p["name"] for p in sel if p],
                           missing=[ags[i]["n"] for i, p in enumerate(sel) if p is None and ags[i].get("req")],
                           flush=flush))
        for p in sel:
            if p:
                items.append(dict(room=rid, kind=kind, name=p["name"], x=p["x"], y=p["y"], ang=p["ang"], b=list(p["b"])))
    return items, report
