"""Furniture layout v2: Germer & Schwarz (2009) agents generate the candidate poses, Merrell et al. (2011) cost picks them.

Germer & Schwarz, "Procedural Arrangement of Furniture for Real-Time Walkthroughs" (CGF 28(8), 2009):
  every item is an agent with an oriented box, a list of possible parents (room parts: wall, floor, corner; or
  another item) and the parent side it attaches to; agents are placed parents-first (§3.2 priority by depth), a pose
  is legal only if the box touches the parent side and collides with nothing (§3.1, separating-axis test — boxes are
  axis-aligned here because our rooms are rectilinear); styles are the per-room item lists; seeds are per room
  (§4.1 persistence). Their own evaluation lists the failures we must avoid: TV not facing the seating, blocked or
  inaccessible items, uneven distribution, bathtub in front of the toilet (§6).

Merrell, Schkufza, Li, Agrawala, Koltun, "Interactive Furniture Layout Using Interior Design Guidelines" (SIGGRAPH
2011): the cost c(F) = Σ w_i m_i over
  m_cv  clearance violation  Σ A(J_f ∩ J_g) over clearance regions J (item ⊕ Table 1 clearance) and the room's outside
  m_ci  circulation          connected components of C_free = room ⊖ person disk (r = 18 in) ∖ (items ⊕ disk)
  m_pd  pairwise distance    −Σ t(d, m, M, 2) with  t = (d/m)^α (d < m), 1 (m ≤ d ≤ M), (M/d)^α (d > M)
  m_pa  pairwise angle       −Σ cos φ for pairs that face each other
  m_cd  conversation dist.   −Σ t(d, 4 ft, 8 ft, 2) over seat pairs of a conversation group
  m_ca  conversation angle   −Σ (cos φ_fg + 1)(cos φ_gf + 1)
  m_vb  visual balance       ‖Σ A(f) p(f) / Σ A(f) − c(R)‖
  m_fa, m_wa alignment       −Σ cos 4(θ_f − θ_g),  −Σ cos 4(θ_f − θ_w)
  m_ef  emphasis             −Σ cos φ(g, focal)     (seats face the focal point: the TV unit)
  m_sy  symmetry             −Σ max s(f, g, p), s = cos(θ_p(f) − θ_p(r_p(g))) − γ d(f, r_p(g))
sampled with Metropolis, p(F) ∝ exp(−β c(F)), symmetric moves (re-pose one item, swap two items of a type).

Ours on top: terms are written as non-negative penalties (1 − t, (1 − cos)/2 …) so a perfect room scores 0; walls are
the real wall solids (backs sit flush, which the v1 formula did not do against interior walls); bathroom fixtures
follow IRC R307 (water closet 381 mm centreline to side wall, 533 mm clear in front; lavatory 533 mm; shower 610 mm
in front, tub with its long side on a wall); a garage gets a full-size sedan driven in nose first, rear to the door.
Every room's terms are kept in REPORT for the scorecard.
"""
import math, random
import numpy as np
from shapely.geometry import Polygon, box as sbox, Point, LineString
from shapely.ops import unary_union
from scipy import ndimage
import layout as LAY

IN = 25.4
REPORT = {}          # plan id → {"rooms": [...], "garages": [...]}
RES = 100.0          # raster (mm) for clearance and circulation

# ---------------------------------------------------------------- per-room agents (Germer & Schwarz semantics + Merrell Table 1)
# parent: "wall" (back on a wall), "corner", "centre" (floor), ("front", i, gap_min, gap_max) in front of agent i,
# ("side", i, gap_min, gap_max) beside agent i (both sides tried), "car" (garage rule).
# clear: required free space, mm, by side of the box: front / side (each side) / back / around (all sides).
A = lambda n, parent, req=True, **kw: dict(n=n, parent=parent, req=req, **kw)
SEM = {
    "living": [A("sofa", "wall", clear=dict(front=30 * IN), seat=1, group=1),
               A("coffee_table", ("front", 0, 16 * IN, 18 * IN), req=False, w=3.0, pair=(0, 16 * IN, 18 * IN, "parallel")),
               A("tv_unit", "wall", focal=1, clear=dict(front=36 * IN), pair=(0, 1800, 3600, "face")),
               A("armchair", "wall", req=False, seat=1, group=1, clear=dict(front=30 * IN)),
               A("end_table", ("side", 0, 0, 12 * IN), req=False, pair=(0, 0, 12 * IN, None)),
               A("plant", "corner", req=False)],
    "bedroom": [A("bed_double", "wall", clear=dict(side=24 * IN, front=24 * IN), sub=["bed_single"]),
                A("nightstand", ("side", 0, 0, 12 * IN), req=False, pair=(0, 0, 12 * IN, None), head=1),
                A("nightstand", ("side", 0, 0, 12 * IN), req=False, pair=(0, 0, 12 * IN, None), head=1),
                A("wardrobe", "wall", req=False, clear=dict(front=30 * IN), sub=["bookshelf"])],
    "kitchen": [A("kitchen_run", "wall", clear=dict(front=42 * IN), sub=["kitchen_short", "kitchen_short_low"]),
                A("fridge", "wall", clear=dict(front=36 * IN), pair=(0, 0, 300, None)),
                A("kitchen_short", "wall", req=False, clear=dict(front=42 * IN))],
    "dining": [A("dining_table", "centre", clear=dict(around=24 * IN), sub=["cafe_table"])],
    "bathroom": [A("vanity", "wall", clear=dict(front=21 * IN)),
                 A("toilet", "wall", clear=dict(front=21 * IN, side=381 - 200)),
                 A("bathtub", "wall", clear=dict(front=21 * IN), alcove=1, sub=["shower"])],
    "wc": [A("toilet", "wall", clear=dict(front=21 * IN, side=381 - 200)), A("vanity", "wall", req=False, clear=dict(front=21 * IN))],
    "utility": [A("washer", "wall", clear=dict(front=36 * IN)), A("wall_shelf", "wall", req=False, clear=dict(front=24 * IN))],
    "study": [A("desk", "wall", clear=dict(front=300)), A("bookshelf", "wall", req=False, clear=dict(front=30 * IN))],
    "office": [A("desk", "wall", clear=dict(front=300)), A("bookshelf", "wall", req=False, clear=dict(front=30 * IN)), A("plant", "corner", req=False)],
    "porch": [A("porch_chair", "wall", req=False, seat=1, group=1, clear=dict(front=24 * IN)),
              A("porch_chair", "wall", req=False, seat=1, group=1, clear=dict(front=24 * IN)), A("plant", "corner", req=False)],
    "foyer": [A("plant", "corner", req=False)],
    "garage": [A("car", "car")],
}
PERSON_R = {"bathroom": 250, "wc": 250, "utility": 300, "porch": 350, "garage": 300}       # Merrell: 18 in disk; small wet rooms 21–24 in aisles (IRC)
W8 = dict(cv=10.0, ci=4.0, pd=2.0, pa=1.0, cd=1.0, ca=0.5, vb=1.0, fa=0.2, wa=0.2, ef=1.0, sy=0.5, miss=20.0, opt=1.5, alcove=1.0)


def t_term(d, m, M, a=2.0):
    """Merrell 2011 plateau: 1 inside [m, M], (d/m)^α below, (M/d)^α above."""
    if d < m: return (max(d, 1e-6) / m) ** a if m > 0 else 1.0
    if d > M: return (M / d) ** a
    return 1.0


class Room:
    def __init__(self, rp, walls, holes, stair, wins, doors, kind):
        self.rp, self.kind = rp, kind
        self.base = rp.difference(walls.buffer(5)) if not walls.is_empty else rp
        self.base = max(list(self.base.geoms), key=lambda g: g.area) if self.base.geom_type == "MultiPolygon" else self.base
        hz = unary_union([h for h in holes + ([stair] if stair is not None else []) if h is not None]) if (holes or stair is not None) else None
        self.free = self.base.difference(hz) if hz is not None else self.base
        self.walls, self.wins, self.doors = walls, wins, doors
        x0, y0, x1, y1 = self.base.bounds
        self.ox, self.oy = x0 - RES, y0 - RES
        self.nx, self.ny = int(math.ceil((x1 - x0) / RES)) + 2, int(math.ceil((y1 - y0) / RES)) + 2
        self.M = self.raster(self.base)
        self.area = self.base.area / 1e6
        c = self.base.centroid; self.c = (c.x, c.y)
        self.wall_runs = self._wall_runs()

    def raster(self, g):
        from shapely import contains_xy
        xs = self.ox + (np.arange(self.nx) + 0.5) * RES; ys = self.oy + (np.arange(self.ny) + 0.5) * RES
        X, Y = np.meshgrid(xs, ys)
        return contains_xy(g, X, Y) if not g.is_empty else np.zeros((self.ny, self.nx), bool)

    def rect_mask(self, b):
        x0, y0, x1, y1 = b
        m = np.zeros((self.ny, self.nx), bool)
        i0, i1 = int(max(0, math.floor((x0 - self.ox) / RES))), int(min(self.nx, math.ceil((x1 - self.ox) / RES)))
        j0, j1 = int(max(0, math.floor((y0 - self.oy) / RES))), int(min(self.ny, math.ceil((y1 - self.oy) / RES)))
        if i1 > i0 and j1 > j0: m[j0:j1, i0:i1] = True
        return m

    def _wall_runs(self):
        """Edges of the room's free outline that stand against a wall solid (Germer & Schwarz: the room part 'wall');
        open-plan edges and a porch's open sides are not walls. Returns [(p0, p1, inward normal)]."""
        runs = []
        ring = list(self.base.exterior.coords)
        if not Polygon(ring).exterior.is_ccw: ring = ring[::-1]
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            L = math.dist((x1, y1), (x2, y2))
            if L < 300: continue
            ux, uy = (x2 - x1) / L, (y2 - y1) / L; nx, ny = -uy, ux          # CCW: interior to the left
            # sample the strip just outside the edge in 100 mm pieces; keep the contiguous parts touching a wall
            k = int(L // 100); cur = None
            for i in range(k + 1):
                t = min(L, i * 100 + 50)
                px, py = x1 + ux * t - nx * 40, y1 + uy * t - ny * 40
                on = (not self.walls.is_empty) and self.walls.buffer(20).contains(Point(px, py))
                if on and cur is None: cur = max(0.0, i * 100.0)
                if (not on or i == k) and cur is not None:
                    end = min(L, (i + (1 if on else 0)) * 100.0)
                    if end - cur >= 300: runs.append(((x1 + ux * cur, y1 + uy * cur), (x1 + ux * end, y1 + uy * end), (nx, ny)))
                    cur = None
        return runs


BB = {}
def pose_box(x, y, ang, L, D, bb=None):
    """Footprint of an item whose local origin is (x, y), rotated by ang (multiple of 90°): axis-aligned bounds of the
    modelled geometry (bb, local), so overhangs such as dining chairs or a bed's headboard are reserved too."""
    a = math.radians(ang); ca, sa = round(math.cos(a)), round(math.sin(a))
    x0, y0, x1, y1 = bb if bb else (0, 0, L, D)
    pts = [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def frame(ang):
    a = math.radians(ang); return (round(math.cos(a)), round(math.sin(a))), (-round(math.sin(a)), round(math.cos(a)))   # local x, local y (front)


def clear_box(b, ang, clear):
    """Clearance region J (Merrell: item ⊕ segment/disk per Table 1) as boxes in world space."""
    if not clear: return []
    (ux, uy), (fx, fy) = frame(ang)
    x0, y0, x1, y1 = b; out = []
    f = clear.get("front", 0); s = clear.get("side", 0); r = clear.get("around", 0)
    if r: out.append((x0 - r, y0 - r, x1 + r, y1 + r))
    if f:
        if fx == 1: out.append((x1, y0, x1 + f, y1))
        elif fx == -1: out.append((x0 - f, y0, x0, y1))
        elif fy == 1: out.append((x0, y1, x1, y1 + f))
        else: out.append((x0, y0 - f, x1, y0))
    if s:
        if ux != 0: out += [(x0 - s, y0, x0, y1), (x1, y0, x1 + s, y1)]
        else: out += [(x0, y0 - s, x1, y0), (x0, y1, x1, y1 + s)]
    return out


def candidates(R, ag, L, D, bb, tall, rnd):
    """Germer & Schwarz 'arrange' state, enumerated: legal poses on the agent's parent (here: a room part)."""
    out = []
    free = R.free
    if tall: free = free.difference(unary_union([z for z, sill in R.wins if tall > max(sill + 300, 1200)])) if R.wins else free
    bx0, by0, bx1, by1 = bb
    def ok(b): return free.contains(sbox(*b))
    if ag["parent"] in ("wall", "corner"):
        for (p0, p1, (nx, ny)) in R.wall_runs:
            Ls = math.dist(p0, p1); ux, uy = (p1[0] - p0[0]) / Ls, (p1[1] - p0[1]) / Ls
            ang = math.degrees(math.atan2(uy, ux)) % 360
            span = bx1 - bx0
            if Ls < span: continue
            ts = [0.0, Ls - span] if ag["parent"] == "corner" else sorted(set(list(np.arange(0, Ls - span + 1, 100)) + [Ls - span]))
            for t in ts:
                sx, sy = -min(0, bx0), -min(0, by0)
                x, y = p0[0] + ux * (t + sx) - uy * sy, p0[1] + uy * (t + sx) + ux * sy
                b = pose_box(x, y, ang, L, D, bb)
                if ok(b): out.append(dict(x=x, y=y, ang=ang, b=b, run=(p0, p1), t=t))
    elif ag["parent"] == "centre":
        x0, y0, x1, y1 = free.bounds
        for ang in (0, 90):
            for x in np.arange(x0, x1, 200):
                for y in np.arange(y0, y1, 200):
                    b = pose_box(x, y, ang, L, D, bb)
                    if ok(b): out.append(dict(x=x, y=y, ang=ang, b=b))
    if len(out) > 80: out = [out[i] for i in sorted(rnd.sample(range(len(out)), 80))]
    return out


def child_candidates(R, ag, L, D, parent, PL, PD, bb=None):
    """Poses relative to the parent's box (Germer & Schwarz: attach to a side of the parent)."""
    kind, _, g0, g1 = ag["parent"]
    (ux, uy), (fx, fy) = frame(parent["ang"])
    px, py, pa = parent["x"], parent["y"], parent["ang"]
    out = []
    for g in sorted(set([g0, (g0 + g1) / 2, g1])):
        if kind == "front":             # centred in front of the parent, same orientation
            cx = px + ux * PL / 2 + fx * (PD + g); cy = py + uy * PL / 2 + fy * (PD + g)
            x, y = cx - ux * L / 2, cy - uy * L / 2
            out.append(dict(x=x, y=y, ang=pa, b=pose_box(x, y, pa, L, D, bb)))
        else:                           # beside the parent, backs on the same line (both sides)
            for side in (-1, 1):
                off = -(L + g) if side < 0 else PL + g
                x, y = px + ux * off, py + uy * off
                out.append(dict(x=x, y=y, ang=pa, b=pose_box(x, y, pa, L, D, bb), side=side))
    return [c for c in out if R.free.contains(sbox(*c["b"]))]


def centre_of(b): return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def facing(p, q):
    """cos of the angle between p's front and the direction from p to q."""
    (_, _), (fx, fy) = frame(p["ang"])
    (cx, cy), (qx, qy) = centre_of(p["b"]), centre_of(q["b"])
    d = math.hypot(qx - cx, qy - cy) or 1.0
    return (fx * (qx - cx) + fy * (qy - cy)) / d


def box_dist(a, b):
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2])); dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def cost(R, agents, sel, door_pts, want_terms=False):
    """Merrell 2011 c(F) on the room raster; sel[i] = chosen pose or None."""
    T = dict.fromkeys(W8, 0.0)
    placed = [(i, s) for i, s in enumerate(sel) if s is not None]
    foot = {i: R.rect_mask(s["b"]) for i, s in placed}
    # hard: no overlap of footprints (separating-axis test on boxes)
    for a_ in range(len(placed)):
        for b_ in range(a_ + 1, len(placed)):
            A_, B_ = placed[a_][1]["b"], placed[b_][1]["b"]
            if min(A_[2], B_[2]) - max(A_[0], B_[0]) > 1 and min(A_[3], B_[3]) - max(A_[1], B_[1]) > 1: return 1e9, None
    # m_cv: clearance regions against other footprints (1.0), other clearances (0.25, shared aisles) and the outside
    J = {}
    for i, s in placed:
        m = np.zeros_like(R.M)
        for cb in clear_box(s["b"], s["ang"], agents[i].get("clear")): m |= R.rect_mask(cb)
        J[i] = m & ~foot[i]
    allfoot = np.zeros_like(R.M)
    for m in foot.values(): allfoot |= m
    cell = (RES / 1000) ** 2
    fam = lambda i, j: (isinstance(agents[j]["parent"], tuple) and agents[j]["parent"][1] == i) or (isinstance(agents[i]["parent"], tuple) and agents[i]["parent"][1] == j)
    for i in J:
        others = np.zeros_like(R.M)                       # a child sits in its parent's clearance by design (Table 1 pairs)
        for j in foot:
            if j != i and not fam(i, j): others |= foot[j]
        T["cv"] += (J[i] & others).sum() * cell + (J[i] & ~R.M).sum() * cell
        for j in J:
            if j > i and not fam(i, j): T["cv"] += 0.25 * (J[i] & J[j]).sum() * cell
    # m_ci: connected components of the person's free configuration space; doors and every item's front must reach it
    r = PERSON_R.get(R.kind, 457.2) / RES
    yy, xx = np.mgrid[-int(r):int(r) + 1, -int(r):int(r) + 1]; disk = (xx ** 2 + yy ** 2) <= r * r
    Cf = ndimage.binary_erosion(R.M, structure=disk) & ~ndimage.binary_dilation(allfoot, structure=disk)
    lab, n = ndimage.label(Cf)
    T["ci"] += max(0, n - 1)
    big = (np.bincount(lab.ravel())[1:].argmax() + 1) if n else 0
    for (dx, dy) in door_pts:
        j, i_ = int((dy - R.oy) // RES), int((dx - R.ox) // RES)
        if not (0 <= j < R.ny and 0 <= i_ < R.nx): continue
        win = lab[max(0, j - 3):j + 4, max(0, i_ - 3):i_ + 4]
        if n and not (win == big).any(): T["ci"] += 1          # a doorway that the free space does not reach
    for i, s in placed:                                           # accessibility: the item's clearance touches the free space
        if J[i].any() and n and not ((ndimage.binary_dilation(J[i], iterations=2)) & (lab == big)).any(): T["ci"] += 0.5
    # m_pd, m_pa: pairwise relations
    for i, s in placed:
        pr = agents[i].get("pair")
        if not pr or sel[pr[0]] is None: continue
        o = sel[pr[0]]; d = box_dist(s["b"], o["b"])
        T["pd"] += 1 - t_term(d, max(pr[1], 1e-3), pr[2], 2) if pr[1] > 0 else (0 if d <= pr[2] else 1 - (pr[2] / d) ** 2)
        if pr[3] == "face": T["pa"] += (1 - facing(s, o)) / 2 + (1 - facing(o, s)) / 2
        elif pr[3] == "parallel": T["pa"] += (1 - math.cos(math.radians(4 * (s["ang"] - o["ang"])))) / 2
    # m_cd, m_ca: conversation (seats of a group 4–8 ft apart, angled toward each other)
    seats = [(i, s) for i, s in placed if agents[i].get("seat")]
    for a_ in range(len(seats)):
        for b_ in range(a_ + 1, len(seats)):
            (i, s), (j, o) = seats[a_], seats[b_]
            d = math.dist(centre_of(s["b"]), centre_of(o["b"]))
            T["cd"] += 1 - t_term(d, 4 * 12 * IN, 8 * 12 * IN, 2)
            T["ca"] += 1 - (facing(s, o) + 1) * (facing(o, s) + 1) / 4
    # m_vb: visual balance
    if placed:
        Aw = [(s["b"][2] - s["b"][0]) * (s["b"][3] - s["b"][1]) for _, s in placed]
        cx = sum(a * centre_of(s["b"])[0] for a, (_, s) in zip(Aw, placed)) / sum(Aw); cy = sum(a * centre_of(s["b"])[1] for a, (_, s) in zip(Aw, placed)) / sum(Aw)
        diag = math.hypot(*(np.subtract(R.base.bounds[2:], R.base.bounds[:2])))
        T["vb"] += math.hypot(cx - R.c[0], cy - R.c[1]) / diag
    # m_fa, m_wa: alignment (all poses are wall-parallel, so these stay 0 unless a pose ever rotates off-grid)
    for a_ in range(len(placed)):
        for b_ in range(a_ + 1, len(placed)): T["fa"] += (1 - math.cos(math.radians(4 * (placed[a_][1]["ang"] - placed[b_][1]["ang"])))) / 2
    # m_ef: seats face the focal point; m_sy: matching seats symmetric about it
    foc = next((s for i, s in placed if agents[i].get("focal")), None)
    if foc is not None:
        for i, s in seats: T["ef"] += (1 - facing(s, foc)) / 2
        if len(seats) >= 2:
            (fxv, fyv) = frame(foc["ang"])[1]; c0 = centre_of(foc["b"])
            for a_ in range(len(seats)):
                for b_ in range(a_ + 1, len(seats)):
                    (i, s), (j, o) = seats[a_], seats[b_]
                    if agents[i]["n"] != agents[j]["n"]: continue
                    ps, po = np.subtract(centre_of(s["b"]), c0), np.subtract(centre_of(o["b"]), c0)
                    n_ = np.array([-fyv, fxv]); refl = po - 2 * np.dot(po, n_) * n_
                    T["sy"] += min(1.0, np.linalg.norm(ps - refl) / 3000)
    # ours: required items present; a tub prefers an alcove (both ends on walls)
    for i, ag in enumerate(agents):
        if sel[i] is None: T["miss" if ag.get("req") else "opt"] += ag.get("w", 1.0)   # Germer & Schwarz delete an agent only when the room is full
        if ag.get("alcove") and sel[i] is not None and sel[i].get("name") == "bathtub":
            b = sel[i]["b"]; ends = 0
            for e in ((b[0] - 30, b[1], b[0], b[3]), (b[2], b[1], b[2] + 30, b[3])) if (b[2] - b[0]) > (b[3] - b[1]) else ((b[0], b[1] - 30, b[2], b[1]), (b[0], b[3], b[2], b[3] + 30)):
                if not R.base.contains(sbox(*e)): ends += 1
            T["alcove"] += (2 - ends) / 2
    c = sum(W8[k] * v for k, v in T.items())
    return c, (T if want_terms else None)


def place_car(R, plan, specs, lab, items_table, ncars=1):
    """Full-size sedans driven straight in through the garage door, nose first, rear bumper 300 mm inside the door.
    Two bays: car centres 2600 mm apart (760 mm between the bodies to open the doors), both inside the door's width."""
    Lc, Wc = items_table["car"][0], items_table["car"][1]; mirrors = 2120
    sep = 2600.0
    best = None
    def gap(dirn, b):
        g = 0
        while g < 4000:
            if dirn == (1, 0): test = (b[2] + g, b[1], b[2] + g + 50, b[3])
            elif dirn == (-1, 0): test = (b[0] - g - 50, b[1], b[0] - g, b[3])
            elif dirn == (0, 1): test = (b[0], b[3] + g, b[2], b[3] + g + 50)
            else: test = (b[0], b[1] - g - 50, b[2], b[1] - g)
            if not R.base.contains(sbox(*test)): break
            g += 50
        return g
    for sp in specs:
        if not sp["ext"] or sp["inner"] != lab: continue
        for o in sp["openings"]:
            if o["kind"] != "overhead": continue
            inward = -sp["outward"]
            face = sp["d1"] if inward == 1 else sp["d0"]
            n = (0, inward) if sp["axis"] == "x" else (inward, 0)
            door_c = (o["pos"], face) if sp["axis"] == "x" else (face, o["pos"])
            ang = math.degrees(math.atan2(n[1], n[0])) % 360
            (ux, uy), (lx, ly) = frame(ang)
            span = (ncars - 1) * sep + mirrors
            tol = max(0.0, (o["w"] - span) / 2 - 50)
            fit = None
            for off in sorted(set(np.round(np.linspace(-tol, tol, 9), 0)), key=abs):
                cars = []
                for k in range(ncars):
                    lat_off = off + (k - (ncars - 1) / 2) * sep
                    rc = (door_c[0] + n[0] * 300 + lx * lat_off, door_c[1] + n[1] * 300 + ly * lat_off)
                    x, y = rc[0] - lx * Wc / 2, rc[1] - ly * Wc / 2
                    b = pose_box(x, y, ang, Lc, Wc)
                    bm = pose_box(x - lx * (mirrors - Wc) / 2, y - ly * (mirrors - Wc) / 2, ang, Lc, mirrors)
                    if not R.free.contains(sbox(*bm)): cars = None; break          # clear of the house door's approach and swing
                    cars.append(dict(x=x, y=y, ang=ang, b=b))
                if not cars: continue
                front = min(gap((round(ux), round(uy)), c["b"]) for c in cars)
                left = gap((round(lx), round(ly)), cars[-1]["b"]); right = gap((-round(lx), -round(ly)), cars[0]["b"])
                between = sep - Wc if ncars > 1 else None
                ok = bool(front >= 600 and min(left, right) >= 400 and (max(left, right) >= 600 or ncars > 1) and o["w"] >= span + 100)
                cand = dict(cars=cars, front=front, left=left, right=right, between=between, door_w=o["w"], off=off, ncars=ncars, ok=ok,
                            x=cars[0]["x"], y=cars[0]["y"], ang=ang, b=cars[0]["b"])
                if fit is None or (cand["ok"], min(left, right)) > (fit["ok"], min(fit["left"], fit["right"])): fit = cand
            if fit and (best is None or (fit["ok"], fit["front"]) > (best["ok"], best["front"])): best = fit
    return best


def furnish(plan, st, specs_by_storey, items_table, room_items):
    """Same output contract as layout.furnish: list of dict(storey, room, kind, name, x, y, ang, fp)."""
    rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000
    out = []; rep = {"rooms": [], "garages": []}
    import blueprint as BP
    for s, specs in enumerate(specs_by_storey):
        L = np.array(plan["labels"][s])
        walls = unary_union([(sbox(sp["a0"] - (sp["d1"] - sp["d0"]), sp["d0"], sp["a1"] + (sp["d1"] - sp["d0"]), sp["d1"]) if sp["axis"] == "x"
                              else sbox(sp["d0"], sp["a0"] - (sp["d1"] - sp["d0"]), sp["d1"], sp["a1"] + (sp["d1"] - sp["d0"]))) for sp in specs])
        import bays as BAY                                # a bay's opening is not a wall to back furniture on
        for s_, sp_, o_, g_ in BAY.bays_of([specs]): walls = walls.difference(g_["gap"].buffer(30))
        for r in [r for r in rooms if r["storey"] == s]:
            ags = SEM.get(r["kind"]); lab = r["id"] + 1; m = L == lab
            if not ags or m.sum() < 2 or r.get("subdivided") or r.get("stair"): continue
            rp = LAY.cells_poly(m, c)
            if rp is None: continue
            holes, door_pts, wins = [], [], []
            for sp in specs:
                own = lab in (sp["inner"], sp["outer"])
                for o in sp["openings"]:
                    p = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
                    if o["kind"] == "window":
                        if own and sp["ext"] and sp["inner"] == lab:
                            z = sbox(p[0] - o["w"] / 2, p[1] - 900, p[0] + o["w"] / 2, p[1] + 900) if sp["axis"] == "x" else sbox(p[0] - 900, p[1] - o["w"] / 2, p[0] + 900, p[1] + o["w"] / 2)
                            wins.append((z, o["win"]["sill"]))
                        continue
                    if o["kind"] not in ("door", "overhead"): continue
                    if r["kind"] == "garage" and o["kind"] == "overhead" and own: continue     # the car drives through its own garage door
                    dz = 600 if r["kind"] == "garage" else 915         # a garage's house door needs the 600 mm walkway, not a 36 in landing
                    Z = sbox(p[0] - o["w"] / 2 - 150, p[1] - dz, p[0] + o["w"] / 2 + 150, p[1] + dz) if sp["axis"] == "x" else sbox(p[0] - dz, p[1] - o["w"] / 2 - 150, p[0] + dz, p[1] + o["w"] / 2 + 150)
                    if Z.intersects(rp): holes.append(Z)
                    if own:      # probe point just inside this room, past the wall and the person's radius
                        sgn = (-sp["outward"]) if sp["ext"] else (-1 if sp["inner"] == lab else 1)
                        dd = (sp["d1"] - sp["d0"]) / 2 + PERSON_R.get(r["kind"], 457.2) + 150
                        door_pts.append((p[0], p[1] + sgn * dd) if sp["axis"] == "x" else (p[0] + sgn * dd, p[1]))
                    for a in (o.get("swing") or {}).get("arcs", []): holes.append(Polygon(a).buffer(80))
            stair = None
            if plan.get("stair") and any(rr.get("stair") for rr in rooms if rr["storey"] == s):
                x0, y0, w, h = plan["stair"]; stair = sbox(x0 * c - 600, y0 * c - 600, (x0 + w) * c + 600, (y0 + h) * c + 600)
            R = Room(rp, walls, holes, stair, wins, door_pts, r["kind"])
            rnd = random.Random(LAY.stable_seed(plan.get("id"), r["id"], "furnish2"))
            if r["kind"] == "garage":
                car = place_car(R, plan, specs, lab, items_table, ncars=int(r.get("cars", 1)))
                g = dict(room=r["id"], storey=s, placed=car is not None, ok=bool(car and car["ok"]), **({k: car[k] for k in ("front", "left", "right", "door_w", "off", "ncars")} if car else {}))
                rep["garages"].append(g)
                for cc in (car["cars"] if car else []):
                    out.append(dict(storey=s, room=r["id"], kind="garage", name="car", x=cc["x"], y=cc["y"], ang=cc["ang"], fp=sbox(*cc["b"])))
                rep["rooms"].append(dict(room=r["id"], kind="garage", storey=s, cost=0.0 if g["ok"] else 20.0, terms={}, placed=["car"] * (car["ncars"] if car else 0), missing=[] if car else ["car"]))
                continue
            # candidate poses per agent and item (with substitutes, Germer & Schwarz: smaller agent if the room is full)
            cand = []
            for ag in ags:
                opts = []
                for name in [ag["n"]] + ag.get("sub", []):
                    if name not in items_table: continue
                    Lw, Dw = items_table[name][0], items_table[name][1]
                    bb, h = LAY.item_geom(name, Lw, Dw)
                    opts.append((name, Lw, Dw, bb, h))
                cand.append(opts)
            sel = [None] * len(ags)
            def poses_for(i):
                ag = ags[i]; res = []
                for name, Lw, Dw, bb, h in cand[i]:
                    if isinstance(ag["parent"], tuple):
                        par = sel[ag["parent"][1]]
                        if par is None: continue
                        PL, PD = items_table[par["name"]][0], items_table[par["name"]][1]
                        cs = child_candidates(R, ag, Lw, Dw, par, PL, PD, bb)
                    else:
                        cs = candidates(R, ag, Lw, Dw, bb, h, rnd)
                    for c_ in cs: c_["name"] = name
                    res += cs
                    if cs: break                         # first item that fits; substitutes only when it does not
                return res
            # greedy start in Germer & Schwarz order (parents before children), then Metropolis (Merrell 2011)
            pool = {}
            for i in range(len(ags)):
                pool[i] = poses_for(i)
                best = (cost(R, ags, sel, door_pts)[0], None)
                for p_ in pool[i]:
                    sel[i] = p_; cv = cost(R, ags, sel, door_pts)[0]
                    if cv < best[0]: best = (cv, p_)
                sel[i] = best[1]
            cur = cost(R, ags, sel, door_pts)[0]; best_sel, best_c = list(sel), cur
            iters = min(600, 60 * len(ags))
            for k in range(iters):
                beta = 2.0 * (15 ** (k / max(1, iters - 1)))
                new = list(sel); mv = rnd.random()
                i = rnd.randrange(len(ags))
                if mv < 0.75:
                    if isinstance(ags[i]["parent"], tuple):
                        pool[i] = poses_for(i) if sel[ags[i]["parent"][1]] is not None else []
                    opts = pool.get(i) or []
                    choice = rnd.choice(opts + [None]) if (opts and not ags[i].get("req")) else (rnd.choice(opts) if opts else None)
                    sel_backup = sel; sel = new; new[i] = choice
                    for j, ag in enumerate(ags):                      # children follow their parent (Germer & Schwarz 'rest')
                        if isinstance(ag["parent"], tuple) and ag["parent"][1] == i:
                            cs = poses_for(j); new[j] = min(cs, key=lambda p_: cost(R, ags, new[:j] + [p_] + new[j + 1:], door_pts)[0]) if cs else None
                    for j, ag in enumerate(ags):                      # a pair partner re-poses with it (TV opposite the sofa)
                        if j != i and not isinstance(ag["parent"], tuple) and ag.get("pair") and ag["pair"][0] == i and pool.get(j):
                            new[j] = min(pool[j] + [None], key=lambda p_: cost(R, ags, new[:j] + [p_] + new[j + 1:], door_pts)[0])
                            for k2, ag2 in enumerate(ags):
                                if isinstance(ag2["parent"], tuple) and ag2["parent"][1] == j:
                                    cs = poses_for(k2); new[k2] = min(cs, key=lambda p_: cost(R, ags, new[:k2] + [p_] + new[k2 + 1:], door_pts)[0]) if cs else None
                    sel = sel_backup
                else:
                    js = [j for j in range(len(ags)) if j != i and ags[j]["n"] == ags[i]["n"]]
                    if not js: continue
                    j = rnd.choice(js); new[i], new[j] = new[j], new[i]
                cn = cost(R, ags, new, door_pts)[0]
                if cn <= cur or rnd.random() < math.exp(-beta * (cn - cur)):
                    sel, cur = new, cn
                    if cur < best_c: best_sel, best_c = list(sel), cur
            sel = best_sel
            c_, T = cost(R, ags, sel, door_pts, want_terms=True)
            # flush: backs of wall agents touch a wall (gap ≤ 20 mm)
            flush = []
            for i, p_ in enumerate(sel):
                if p_ is None or ags[i]["parent"] not in ("wall", "corner"): continue
                (fx, fy) = frame(p_["ang"])[1]; b = p_["b"]
                back = (b[0], b[1] - 25, b[2], b[1]) if fy == 1 else (b[0], b[3], b[2], b[3] + 25) if fy == -1 else (b[0] - 25, b[1], b[0], b[3]) if fx == 1 else (b[2], b[1], b[2] + 25, b[3])
                flush.append(bool(walls.buffer(5).intersects(sbox(*back)) and not R.base.buffer(-1).contains(sbox(*back))))
            rep["rooms"].append(dict(room=r["id"], kind=r["kind"], storey=s, cost=round(c_, 3), terms={k: round(v, 3) for k, v in (T or {}).items()},
                                     placed=[p_["name"] for p_ in sel if p_], missing=[ags[i]["n"] for i, p_ in enumerate(sel) if p_ is None and ags[i].get("req")],
                                     flush=flush, wet=r["kind"] in ("bathroom", "wc")))
            for i, p_ in enumerate(sel):
                if p_ is None: continue
                out.append(dict(storey=s, room=r["id"], kind=r["kind"], name=p_["name"], x=p_["x"], y=p_["y"], ang=p_["ang"], fp=sbox(*p_["b"])))
    REPORT[str(plan.get("id"))] = rep
    return out


def garage_fit(plan, bp):
    """Gate helper: the sedan fit of every garage, from the blueprint alone (no other furniture needed)."""
    rooms = plan["program"]["rooms"]; c = plan["cell"] * 1000; out = []
    specs = bp["specs"][0]; L = np.array(plan["labels"][0])
    walls = unary_union([(sbox(sp["a0"] - (sp["d1"] - sp["d0"]), sp["d0"], sp["a1"] + (sp["d1"] - sp["d0"]), sp["d1"]) if sp["axis"] == "x"
                          else sbox(sp["d0"], sp["a0"] - (sp["d1"] - sp["d0"]), sp["d1"], sp["a1"] + (sp["d1"] - sp["d0"]))) for sp in specs])
    for r in rooms:
        if r["kind"] != "garage" or r["storey"] != 0: continue
        m = L == r["id"] + 1
        rp = LAY.cells_poly(m, c)
        if rp is None: out.append(None); continue
        lab = r["id"] + 1; holes = []
        for sp in specs:
            if lab not in (sp["inner"], sp["outer"]): continue
            for o in sp["openings"]:
                if o["kind"] != "door": continue
                p = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
                holes.append(sbox(p[0] - o["w"] / 2 - 150, p[1] - 600, p[0] + o["w"] / 2 + 150, p[1] + 600) if sp["axis"] == "x" else sbox(p[0] - 600, p[1] - o["w"] / 2 - 150, p[0] + 600, p[1] + o["w"] / 2 + 150))
                for a in (o.get("swing") or {}).get("arcs", []): holes.append(Polygon(a).buffer(80))
        R = Room(rp, walls, holes, None, [], [], "garage")
        out.append(place_car(R, plan, specs, r["id"] + 1, {"car": (4920, 1840)}, ncars=int(r.get("cars", 1))))
    return out
