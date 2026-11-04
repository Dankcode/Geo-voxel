"""Roofs from the weighted straight skeleton (CGAL >= 6.0 extrude_skeleton, via roofgen/roofgen).

Merrell et al. (2010, §6) build roofs from the unweighted straight skeleton (Aichholzer et al. 1995), which yields a
hipped roof, and then make gables by projecting the vertices of the hip faces onto the facade plane. We use the
*weighted* straight skeleton instead (Held & Palfrader; Cacciola, Loriot & Rouxel-Labbé in CGAL 6): every footprint
edge e gets its own pitch α_e, i.e. weight w_e = tan α_e, and its wavefront moves inward so that the roof face of e is

        z(p) = z_0 + tan(α_e) · d(p, ē)          (p in the face of e, ē the edge's supporting line).

α_e = 90° (w_e → ∞) keeps the edge in place: its face is vertical, i.e. a gable wall. A roof *programme* is a list of
stages; stage k extrudes the polygon left by stage k-1 with its own angles up to a height limit h_k, which gives
mansard, gambrel, Dutch-gable and clipped-gable roofs from one algorithm (cf. Kelly & Wonka's procedural extrusions).

All coordinates are in mm in the plan frame (x along the street, y front → back, z up).
"""
import math, os, subprocess
import numpy as np
from shapely.geometry import Point
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

ROOFGEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roofgen", "roofgen")
ROOFGEN_EXACT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "roofgen", "roofgen_exact")   # exact kernel (audit fix R1)

# roof-covering minimum slopes (rise per 12 run): IBC 2018 minimum / NRCA recommended
MIN_SLOPE = {"membrane": (0.25, 0.25), "metal": (0.5, 3.0), "shingle": (2.0, 4.0), "tile": (2.5, 4.0), "slate": (4.0, 4.0)}
LOW_SLOPE_MAX = 3.0          # we call a roof low-slope at or below 3:12 (14.0°); "flat" = membrane at 1/4:12


def rise_per_12(deg): return 12 * math.tan(math.radians(deg))
def deg_from_rise(r): return math.degrees(math.atan(r / 12))


def classify(deg, material):
    r = rise_per_12(deg)
    lo, rec = MIN_SLOPE.get(material, (0, 0))
    family = "flat (membrane)" if r <= 0.5 else "low-slope" if r <= LOW_SLOPE_MAX else "steep-slope"
    return {"rise_per_12": round(r, 2), "family": family, "meets_code_min": r + 1e-9 >= lo, "meets_nrca": r + 1e-9 >= rec}


# ------------------------------------------------------------------------------------------------ CGAL bridge
def skeleton(rings, angles, hmax=None, tool=None):
    """rings: [outer, hole, …] lists of (x, y); angles: per ring, one per edge i → i+1 (degrees). Returns (V, F)."""
    lines = [f"{len(rings)} {hmax if hmax else 0}"]
    for ring, ang in zip(rings, angles):
        lines.append(str(len(ring)))
        lines += [f"{x:.4f} {y:.4f} {a:.6f}" for (x, y), a in zip(ring, ang)]
    p = subprocess.run([tool or ROOFGEN_EXACT], input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=60)
    if p.returncode != 0: raise RuntimeError("roofgen: " + p.stderr.strip()[:200])
    tok = p.stdout.split("\n"); i = 0
    nv = int(tok[i].split()[1]); i += 1
    V = np.array([[float(t) for t in tok[i + k].split()] for k in range(nv)]); i += nv
    nf = int(tok[i].split()[1]); i += 1
    F = [[int(t) for t in tok[i + k].split()] for k in range(nf)]
    return V, F


# ------------------------------------------------------------------------------------------------ geometry helpers
def _valid_extrusion(ring, ang, V, F, hmax=None):
    """Audit fix R1/R6: an extrusion is accepted only if its upward faces cover the footprint (±0.5 %) and it stays
    below the height the steepest sloped edge could reach over half the footprint's longer side (no spikes)."""
    P = Polygon(ring); A = P.area
    if A <= 0 or V is None or not len(V): return False
    sl, ve, bo = split_faces(V, F)
    cov = sum(Polygon(V[list(f)][:, :2]).area for f in sl if len(f) >= 3)
    if abs(cov - A) > 0.005 * A: return False
    x0, y0, x1, y1 = P.bounds
    steep = max([a for a in ang if a < 85.0] or [45.0])     # near-vertical stand-ins (89°) do not raise the bound
    reach = max(x1 - x0, y1 - y0) * (1.0 if any(a >= 85.0 for a in ang) else 0.5)   # a lean-to rises across its full depth
    bound = reach * math.tan(math.radians(min(steep, 89))) * 1.05 + 1
    if hmax: bound = min(bound, hmax + 1)
    z = V[:, 2] - V[:, 2].min()
    return bool(np.isfinite(z).all() and z.max() <= bound)


def _inner_gables(ring, ang, V, F, tol=150.0):
    """Indices of 90° edges whose vertical faces reach more than tol beyond the edge segment itself."""
    from shapely.geometry import LineString as _LS
    sl, ve, bo = split_faces(V, F)
    n = len(ring); bad = set()
    for f in ve:
        P = V[list(f)][:, :2]
        for i in range(n):
            if ang[i] < 89.9: continue
            a, b = np.array(ring[i]), np.array(ring[(i + 1) % n])
            d = b - a; L = np.linalg.norm(d)
            if L < 1: continue
            u = d / L; nrm = np.array([-u[1], u[0]])
            if np.abs((P - a) @ nrm).max() > 5: continue                  # face not on this edge's line
            t = (P - a) @ u
            if t.min() < -tol or t.max() > L + tol: bad.add(i)
    return bad


def robust_skeleton(ring, ang, hmax=None, cap_h=None):
    """Weighted skeleton with validation and fallbacks: exact kernel; for wings against a taller wall, the same
    angles capped at cap_h (a flat deck under the upper wall); vertical edges at 89°; plain hip at the shallowest
    sloped angle. Returns (V, F, how)."""
    tries = [(ang, "exact")]
    if cap_h and not hmax and any(a >= 89.9 for a in ang): tries.append((ang, "capped deck"))
    if any(a >= 89.9 for a in ang): tries.append(([a if a < 89.9 else 89.0 for a in ang], "gables at 89°"))
    base = min([a for a in ang if a < 89.9] or [30.0])
    tries.append(([base] * len(ang), "hip fallback"))
    for A_, how in tries:
        hm = cap_h if how == "capped deck" else hmax
        for tool in (ROOFGEN_EXACT, ROOFGEN):
            try: V, F = skeleton([[(x, y) for x, y in ring]], [A_], hmax=hm, tool=tool)
            except (RuntimeError, ValueError, IndexError): continue
            if _valid_extrusion(ring, A_, V, F, hm):
                F = [f for f in F if len(f) < 3 or np.linalg.norm(np.cross(V[f[1]] - V[f[0]], V[f[2]] - V[f[0]])) / 2 >= 100.0]   # drop < 1 cm² slivers
                return V, F, how if tool == ROOFGEN_EXACT else how + " (inexact)"
    raise RuntimeError("no valid skeleton")


def remove_jogs(poly, T=1300.0, max_add=0.10):
    """Rectilinear jog removal for roof outlines (audit fix: fluting). A short edge (≤ T) between two parallel edges is
    a step; the recessed of the two parallel edges is pushed out to the other's line (only ever adding area). The
    cheapest step is removed first; total added area ≤ max_add of the original."""
    if poly.geom_type != "Polygon" or poly.interiors: return poly
    A0 = poly.area; P = poly
    for _ in range(30):
        pts = ring_of(P); n = len(pts)
        if n <= 4: break
        best = None
        for i in range(n):
            a, b, c_, d = (np.array(pts[(i + k) % n], float) for k in range(4))   # edges ab, bc (the step), cd
            e1, e2, e3 = b - a, c_ - b, d - c_
            L2 = np.linalg.norm(e2)
            if L2 < 1 or L2 > T or np.linalg.norm(e1) < 1 or np.linalg.norm(e3) < 1: continue
            u1, u3 = e1 / np.linalg.norm(e1), e3 / np.linalg.norm(e3)
            if u1 @ u3 < 0.999: continue                                       # not a step (ab ∥ cd, same direction)
            nrm = np.array([u1[1], -u1[0]])                                     # outward normal of a CCW ring
            off1, off3 = nrm @ a, nrm @ c_
            if off1 < off3:     # ab is recessed: push it out to cd's line
                cand = [tuple(a + (off3 - off1) * nrm), tuple(b + (off3 - off1) * nrm)]; idx = ((i) % n, (i + 1) % n); add = (off3 - off1) * np.linalg.norm(e1)
            else:               # cd is recessed: push it out to ab's line
                cand = [tuple(c_ + (off1 - off3) * nrm), tuple(d + (off1 - off3) * nrm)]; idx = ((i + 2) % n, (i + 3) % n); add = (off1 - off3) * np.linalg.norm(e3)
            if best is None or add < best[0]: best = (add, idx, cand)
        if best is None: break
        add, idx, cand = best
        q = list(pts); q[idx[0]], q[idx[1]] = cand
        Q = Polygon(q)
        if not Q.is_valid: Q = Q.buffer(0)
        if Q.geom_type != "Polygon" or Q.area < P.area - 1 or Q.area > A0 * (1 + max_add): break
        P = Q.union(P)
        if P.geom_type != "Polygon": break
        P = Polygon(_simplify(list(P.exterior.coords)[:-1]))
    return P


def ring_of(poly):
    """Exterior ring without the closing point, counter-clockwise, collinear points removed."""
    pts = list(poly.exterior.coords)[:-1]
    if not Polygon(pts).exterior.is_ccw: pts = pts[::-1]
    return _simplify(pts)


def _simplify(pts):
    out = []
    n = len(pts)
    for i in range(n):
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        if abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-6: out.append(b)
    return out


def edge_normal(a, b):
    """Outward unit normal of edge a→b of a counter-clockwise ring."""
    dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy)
    return (dy / L, -dx / L)


def side(a, b):
    """front (outward normal −y), back (+y), left (−x), right (+x), or 'oblique'."""
    nx, ny = edge_normal(a, b)
    if abs(ny) > 0.99: return "front" if ny < 0 else "back"
    if abs(nx) > 0.99: return "left" if nx < 0 else "right"
    return "oblique"


def offset_edges(ring, d):
    """Move edge i outward by d[i] and rebuild the ring from consecutive line intersections (rectilinear-safe)."""
    n = len(ring); lines = []
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]; nx, ny = edge_normal(a, b)
        lines.append(((a[0] + nx * d[i], a[1] + ny * d[i]), (b[0] - a[0], b[1] - a[1])))
    out = []
    for i in range(n):
        (p, u), (q, v) = lines[i - 1], lines[i]
        den = u[0] * v[1] - u[1] * v[0]
        if abs(den) < 1e-9: out.append((q[0], q[1])); continue
        t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den
        out.append((p[0] + u[0] * t, p[1] + u[1] * t))
    P = Polygon(out)
    if not P.is_valid or abs(P.area) < 1: return None
    # every edge must keep its direction (no edge flipped by a large neighbouring offset)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]; c, e = out[i], out[(i + 1) % n]
        if (b[0] - a[0]) * (e[0] - c[0]) + (b[1] - a[1]) * (e[1] - c[1]) <= 0: return None
    return out


def cap(V, F, h):
    """The flat polygon a height-limited extrusion leaves at z = h (input to the next stage)."""
    tris = []
    for f in F:
        P = V[f]
        if np.all(np.abs(P[:, 2] - h) < 1e-3 * max(1, h)):
            n = np.cross(P[1] - P[0], P[2] - P[0])
            if n[2] > 0 and len(f) >= 3: tris.append(Polygon(P[:, :2]))
    if not tris: return None
    u = unary_union([t.buffer(0.01) for t in tris]).buffer(-0.01)
    return u if not u.is_empty else None


# ------------------------------------------------------------------------------------------------ programmes
def stage_angles(ring, stage, abut=None):
    """Per-edge angle for one stage: base pitch, per-side overrides, gable sides at 90°, abutting edges at 90°."""
    ang = []
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        sd = side(a, b)
        x = stage.get("sides", {}).get(sd, stage["angle"])
        g = stage.get("gable")
        if g == "x" and sd in ("left", "right"): x = 90.0
        if g == "y" and sd in ("front", "back"): x = 90.0
        if g == "front" and sd != "front": x = 90.0                       # shed rising from the front
        if abut is not None and abut[i]: x = 90.0
        ang.append(float(x))
    return ang


def face_of_edge(V, F, A, B):
    """Vertices of the planar roof face spawned by footprint edge A→B (coplanar triangles grown from the edge)."""
    def idx(p):
        d = np.hypot(V[:, 0] - p[0], V[:, 1] - p[1]) + np.abs(V[:, 2])
        return int(np.argmin(d))
    ia, ib = idx(A), idx(B)
    tris = [tuple(f) for f in F if len(f) == 3]
    def normal(t):
        P = V[list(t)]; n = np.cross(P[1] - P[0], P[2] - P[0]); L = np.linalg.norm(n); return n / L if L else n
    seed = [t for t in tris if ia in t and ib in t and normal(t)[2] > 1e-6]
    if not seed: return None
    n0 = normal(seed[0]); group = {seed[0]}; grow = True
    while grow:
        grow = False
        verts = {v for t in group for v in t}
        for t in tris:
            if t in group: continue
            if len(set(t) & verts) >= 2 and np.dot(normal(t), n0) > 0.99999: group.add(t); grow = True
    return sorted({v for t in group for v in t})


def merrell_gables(ring, angles):
    """Merrell 2010 §6: hip faces without a horizontal top edge become gables. With the weighted skeleton that is a
    weight change instead of a vertex projection: those edges are set to 90° and the skeleton is recomputed."""
    try: V, F = skeleton([ring], [angles])
    except RuntimeError:
        try: V, F = skeleton([ring], [[a if a < 89.9 else 89.0 for a in angles]])
        except RuntimeError: return list(angles)
    out = list(angles); n = len(ring)
    cands = []
    for i in range(n):
        if angles[i] >= 89.9: continue
        L = math.dist(ring[i], ring[(i + 1) % n])
        if L < 2500: continue                          # a gable narrower than 2.5 m would be a gablet, not a gable
        f = face_of_edge(V, F, ring[i], ring[(i + 1) % n])
        if not f: continue
        z = V[f, 2]; zt = z.max()
        tops = {tuple(np.round(V[k, :2], 3)) for k in f if abs(V[k, 2] - zt) < 1e-6 * max(1, zt)}
        if len(tops) == 1: cands.append((L, i))     # the face peaks in a point: a hip end → gable candidate
    for L, i in sorted(cands, reverse=True):
        # a gable sits between two sloped eaves: both neighbours must still slope
        if out[(i - 1) % n] < 89.9 and out[(i + 1) % n] < 89.9: out[i] = 90.0
    if sum(1 for a in out if a < 89.9) < 2: return list(angles)      # a pyramid stays hipped
    return out


PROGRAMMES = {
    # name: list of stages; angle in degrees, h = stage height limit (mm), gable = which sides stay vertical
    "hip":          lambda p: [dict(angle=p)],
    "pyramid":      lambda p: [dict(angle=p)],
    "side_gable":   lambda p: [dict(angle=p, gable="x")],
    "front_gable":  lambda p: [dict(angle=p, gable="y")],
    "cross_gable":  lambda p: [dict(angle=p, gable="auto")],            # Merrell's triangle-face rule on any outline
    "steep_gable":  lambda p: [dict(angle=p, gable="auto")],
    "low_gable":    lambda p: [dict(angle=p, gable="auto")],
    "saltbox":      lambda p: [dict(angle=p, gable="x", sides={"front": p, "back": max(12, p * 0.55)})],
    "shed":         lambda p: [dict(angle=p, gable="front")],
    "dutch_gable":  lambda p: [dict(angle=p, h=1300), dict(angle=p, gable="x")],          # hip below, gablet above
    "jerkinhead":   lambda p: [dict(angle=p, gable="x", h=2200), dict(angle=p)],          # gable below, clipped hip above
    "mansard":      lambda p: [dict(angle=72, h=2600), dict(angle=12)],                   # steep lower slope, low cap
    "gambrel":      lambda p: [dict(angle=62, gable="x", h=2000), dict(angle=24, gable="x")],
    "a_frame":      lambda p: [dict(angle=max(p, 58), gable="auto")],
    "flat":         lambda p: [dict(angle=1.19)],                                         # 1/4:12 tapered insulation
}


def roof(region, programme, pitch, z_plate, eave, rake=120, abut_mask=None, material="shingle", cap_h=None):
    """Roof over one region polygon (mm). Returns dict(pieces=[(role, V, F)], stages, classify, angles)."""
    polys = [region] if isinstance(region, Polygon) else list(region.geoms)
    pieces, info, fallbacks = [], [], []
    for P in polys:
        if P.area < 1e5: continue
        ring = ring_of(P)
        prog_here = programme
        abut = abut_mask(ring) if abut_mask else None
        if abut is not None and sum(abut) >= len(ring) - 0:     # enclosed by the storey above (a void): flat roof
            prog_here = "flat"; abut = None
        stages = PROGRAMMES[prog_here](pitch if prog_here != "flat" else 0)
        z0 = z_plate; base_ring = ring; base_ang = None; first = True
        for k, stg in enumerate(stages):
            ang = stage_angles(base_ring, stg, abut if first else None)
            if stg.get("gable") == "auto": ang = merrell_gables(base_ring, ang)
            if prog_here == "flat": ang = [1.19] * len(base_ring)
            if first:
                # eaves: edge i moves out by d_i = Δz / tan α_i so every sloped plane meets the wall plate at z_plate;
                # gable (90°) edges get a small rake; abutting edges stay on the wall
                ref = min([a for a in ang if a < 89.9] or [pitch])
                dz = eave * math.tan(math.radians(min(ref, 40)))      # steep stages (mansard) keep a short overhang
                d = [0.0 if (abut is not None and abut[i]) else (rake if a >= 89.9 else dz / math.tan(math.radians(a))) for i, a in enumerate(ang)]
                eave_ring = offset_edges(base_ring, d) if eave > 0 else base_ring
                if eave_ring is None: eave_ring, dz = base_ring, 0.0
                z0 = z_plate - dz
                base_ring = eave_ring; first = False; base_ang = ang
            h = stg.get("h")
            if prog_here == "flat": h = None
            try:
                V, F, how = robust_skeleton(base_ring, ang, hmax=h, cap_h=cap_h if k == 0 else None)
            except RuntimeError:
                if k == 0 and base_ring is not ring:                 # eave offset defeated the skeleton: no eave
                    base_ring = ring; z0 = z_plate
                    V, F, how = robust_skeleton(base_ring, ang, hmax=h); how += ", no eave"
                else: raise
            if how != "exact": fallbacks.append(how)
            # audit fix R8: a gable (90°) edge whose vertical face runs beyond its own wall segment makes a cliff
            # inside the roof (the zero-speed edge's plane persists as neighbours collapse): revert it to a hip
            for _ in range(3):
                bad = _inner_gables(base_ring, ang, V, F)
                if not bad: break
                base_a = min([a for a in ang if a < 89.9] or [pitch])
                ang = [(base_a if i in bad else a) for i, a in enumerate(ang)]
                if k == 0 and eave > 0 and base_ring is not ring and len(ring) == len(ang):
                    # the reverted edges now slope: give them the sloped eave offset, not the gable rake
                    d = [0.0 if (abut is not None and abut[i]) else (rake if a >= 89.9 else dz / math.tan(math.radians(a))) for i, a in enumerate(ang)]
                    er = offset_edges(ring, d)
                    if er is not None: base_ring = er
                V, F, how = robust_skeleton(base_ring, ang, hmax=h, cap_h=cap_h if k == 0 else None); fallbacks.append("inner gable → hip")
            V = V.copy(); V[:, 2] += z0
            # audit fix R4: a void enclosed by the storey above is a flat membrane part inside a pitched roof
            role = "roof_flat" if (prog_here == "flat" and programme != "flat") else "roof"
            pieces.append((role, V, F))
            info.append({"stage": k, "angles": sorted(set(round(a, 1) for a in ang)), "h": h, "flat_void": role == "roof_flat"})
            if h is None: break
            C = cap(V - [0, 0, z0], F, h)
            if C is None: break
            nxt = C if isinstance(C, Polygon) else max(C.geoms, key=lambda g: g.area)
            base_ring = ring_of(nxt); z0 = z0 + h
    sloped = [a for st_ in info if not st_.get("flat_void") for a in st_["angles"] if a < 89.9]
    governing = min(sloped) if sloped else pitch                       # the shallowest sloped plane governs the covering
    out = {"pieces": pieces, "stages": info, "classify": classify(governing, material), "governing_angle": governing, "fallbacks": fallbacks}
    if any(st_.get("flat_void") for st_ in info): out["flat_parts"] = classify(1.19, "membrane")
    return out


def split_faces(V, F):
    """Split an extrusion mesh into sloped roof faces, vertical faces (gable walls / mansard cheeks), bottom."""
    slope, vert, bottom = [], [], []
    zmin = V[:, 2].min()
    for f in F:
        P = V[f]; n = np.cross(P[1] - P[0], P[2] - P[0]); L = np.linalg.norm(n)
        if L < 1e-9: continue
        n = n / L
        if abs(n[2]) < 1e-3: vert.append(f)
        elif n[2] < 0 and np.allclose(P[:, 2], zmin, atol=1e-3): bottom.append(f)
        else: slope.append(f)
    return slope, vert, bottom


# ------------------------------------------------------------------------------------------------ whole building
def cells_poly(mask, c):
    from shapely.geometry import box as sbox
    ys, xs = np.nonzero(mask)
    if not len(ys): return None
    return unary_union([sbox(x * c, y * c, (x + 1) * c, (y + 1) * c) for y, x in zip(ys, xs)]).buffer(0.5, join_style=2).buffer(-0.5, join_style=2)


def _abut(mask, c):
    """Edges whose outside neighbour (half a cell out) is in `mask`: they stay vertical (the roof leans on a wall)."""
    H, W = mask.shape
    def f(ring):
        out = []
        for i in range(len(ring)):
            a, b = ring[i], ring[(i + 1) % len(ring)]
            nx, ny = edge_normal(a, b); mx, my = (a[0] + b[0]) / 2 + nx * c / 2, (a[1] + b[1]) / 2 + ny * c / 2
            x, y = int(mx // c), int(my // c)
            out.append(bool(0 <= y < H and 0 <= x < W and mask[y, x]))
        return out
    return f


def LOWER_CAP(slab):
    """2026-11-02: a lower roof that meets an upper wall stops 150 mm under the upper windows' sills (sill 900 mm above
    the upper floor), so the upper floor keeps its windows (Merrell §6 drops a window a lower roof obstructs; before,
    lower roofs rose 2.3 m up the upper walls and buried 5 of ~15 upper windows per design). A deep wing gets a hip
    with a flat deck at that height."""
    return slab + 900 - 150 if os.environ.get("PAPER", "1") == "1" else None


def roof_plan(plan, st, slab=200):
    """Every roof of a building: the main roof over the top storey (the style's programme), lower roofs over the
    parts of a storey the storey above does not cover (same programme, edges against the upper wall vertical), and
    porch roofs on multi-storey houses (lean-to against the house). Pure geometry, shared by both builders."""
    rooms = plan["program"]["rooms"]
    labels = [np.array(L) for L in plan["labels"]]; S = len(labels)
    c = plan["cell"] * 1000; Hs = st["storey"] * 1000; R0 = st["raise_"] * 1000
    zf = lambda s: R0 + s * Hs
    indoor = [np.vectorize(lambda v: v > 0 and not rooms[v - 1].get("open_air"))(L).astype(bool) for L in labels]
    porch = [np.vectorize(lambda v: v > 0 and bool(rooms[v - 1].get("open_air")))(L).astype(bool) for L in labels]
    prog = st.get("roof_program") or st["roof"]
    mat = st.get("roofmat", "shingle"); mat = "membrane" if prog == "flat" else ("metal" if mat == "metal" else "tile" if mat == "tile" else "slate" if mat == "slate" else "shingle")
    eave = st["eave"] * 1000; pitch = st["pitch"]
    out = []
    # audit fix R7: on multi-storey houses a porch that adjoins the single-storey wing goes under the wing's roof
    # (as on one-storey houses); only porches against two-storey walls get their own lean-to
    porch_wing = np.zeros_like(porch[0])
    if S > 1 and porch[0].any():
        from scipy import ndimage
        wing0 = indoor[0] & ~indoor[1]; op = porch[0] & ~indoor[1]
        lab_, n_ = ndimage.label(op)
        grow = ndimage.binary_dilation(wing0)
        for k in range(1, n_ + 1):
            comp = lab_ == k
            if (comp & grow).sum() >= 2: porch_wing |= comp
    for s in range(S):
        top = indoor[s] | (porch[s] if S == 1 else (porch_wing if s == 0 else False))
        above = indoor[s + 1] if s + 1 < S else np.zeros_like(top)
        region = top & ~above
        if not region.any(): continue
        poly = cells_poly(region, c)
        if poly is None: continue
        main = s == S - 1
        if prog != "flat":
            # audit fix R3: notches narrower than the two eave overhangs would be closed by the eave offset and leave
            # the notch walls poking through the roof: fill them (never into the storey above; soffit under them)
            dmax = eave * 1.6 + 200
            Pc = poly.buffer(dmax, join_style=2).buffer(-dmax, join_style=2)
            if above.any():
                Ab = cells_poly(above, c)
                if Ab is not None: Pc = Pc.difference(Ab.buffer(1, join_style=2))
            if Pc.geom_type == "Polygon" and poly.area + 1e4 < Pc.area < poly.area * 1.15: poly = Pc
            # audit fix (fluting): jogs up to 1.3 m in the outline each throw a small hip ridge up the slope; the
            # roof spans them with one plane instead (deeper eave + soffit), never over a lower roof or the storey above
            Pj = remove_jogs(poly)
            forbid = above.copy()          # a lower wing may sit under the extension: the R7 audit check guards clearance
            if forbid.any():
                Fb = cells_poly(forbid, c)
                if Fb is not None: Pj = Pj.difference(Fb.buffer(1, join_style=2))
            if Pj.geom_type == "Polygon" and poly.area + 1e4 < Pj.area < poly.area * 1.12 and len(Pj.exterior.coords) < len(poly.exterior.coords) if poly.geom_type == "Polygon" else False:
                poly = Pj
        z_plate = zf(s) + Hs - slab
        pr = prog if prog in PROGRAMMES else ("side_gable" if "gable" in prog else "hip")
        if not main and pr in ("mansard", "gambrel", "dutch_gable", "jerkinhead", "a_frame"): pr = "hip"      # lower wings: simple roof
        # fixed gable sides only make sense on a rectangle: on L / T outlines and on wings, gables come from
        # Merrell's triangle-face rule instead, so each wing gets gables on its own short ends
        rect = poly.area / max(1.0, (poly.bounds[2] - poly.bounds[0]) * (poly.bounds[3] - poly.bounds[1])) > 0.97 and poly.geom_type == "Polygon"
        if pr in ("side_gable", "front_gable", "saltbox") and (not rect or not main): pr = "cross_gable"
        r = roof(poly, pr, pitch if pr != "flat" else 0, z_plate, eave if pr != "flat" else 0, abut_mask=None if main else _abut(above, c), material=mat, cap_h=None if main else (LOWER_CAP(slab) or Hs - 600))
        # sanity cap: no roof may rise above what its narrowest span allows (h ≤ 1.6 · (w/2) · tan α_max)
        if pr != "flat":
            bx = poly.bounds; span = min(bx[2] - bx[0], bx[3] - bx[1])
            amax = max([a for st_ in r["stages"] for a in st_["angles"] if a < 89.9] or [pitch])
            hmax = 1.6 * span / 2 * math.tan(math.radians(min(amax, 75))) + eave
            if max(float(V[:, 2].max()) for _, V, _ in r["pieces"]) - z_plate > hmax:
                r = roof(poly, "hip", pitch, z_plate, eave, abut_mask=None if main else _abut(above, c), material=mat, cap_h=None if main else (LOWER_CAP(slab) or Hs - 600)); pr = "hip"; r["capped"] = True
        # proportion rule (ours): roof height ≤ 1.4 × storey height; lower the pitch, α' = atan(tan α · 1.4·H_s / H_r),
        # but never below the covering's NRCA-recommended slope
        if pr not in ("flat", "mansard", "gambrel") and not r.get("capped"):
            Hr = max(float(V[:, 2].max()) for _, V, _ in r["pieces"]) - z_plate
            if Hr > 1.4 * Hs:
                a2 = math.degrees(math.atan(math.tan(math.radians(pitch)) * 1.4 * Hs / Hr))
                a2 = max(a2, deg_from_rise(MIN_SLOPE.get(mat, (0, 4.0))[1]))
                if a2 < pitch - 0.5:
                    r = roof(poly, pr, a2, z_plate, eave, abut_mask=None if main else _abut(above, c), material=mat, cap_h=None if main else (LOWER_CAP(slab) or Hs - 600)); r["pitch_lowered"] = (pitch, round(a2, 1))
        out.append(dict(storey=s, kind="main" if main else "wing", programme=pr, poly=poly, z_plate=z_plate, **r))
    if S > 1 and porch[0].any():
        # audit fix R2: only the part of the porch the upper storey does not cover gets a roof (under an
        # overhang the upper floor is the porch ceiling), and it leans on walls of either storey
        open_porch = porch[0] & ~indoor[1] & ~porch_wing
        poly = cells_poly(open_porch, c) if open_porch.any() else None
        if poly is not None and poly.area < 1.5e6: poly = None          # slivers under 1.5 m² stay unroofed (eave covers them)
        if poly is not None:
            pp = 20.0                     # ≥ 4:12 (18.4°) so shingles meet the NRCA recommendation
            flat_style = prog == "flat"
            r = roof(poly, "flat" if flat_style else "hip", 0 if flat_style else pp, zf(0) + Hs - slab - 500, 0 if flat_style else 300,
                     abut_mask=None if flat_style else _abut(indoor[0] | indoor[1], c), material="membrane" if flat_style else mat)
            zpl = zf(0) + Hs - slab - 500; rec = dict(storey=0, kind="porch", programme="flat" if flat_style else "lean-to", poly=poly, z_plate=zpl, **r)
            # audit fix R7: the porch roof must stay ≥ 150 mm under any eave that overhangs it — first drop its
            # plate (not below door head + 300), then flatten it (≥ 3:12 standing-seam metal)
            if not flat_style:
                xs_ = np.arange(poly.bounds[0] + 150, poly.bounds[2], 300); ys_ = np.arange(poly.bounds[1] + 150, poly.bounds[3], 300)
                pts = [(x, y) for x in xs_ for y in ys_ if poly.contains(Point(x, y))]
                def excess(rr):
                    e = 0.0
                    for x, y in pts:
                        zo = height_at(out, x, y); zp_ = height_at([rr], x, y)
                        if zo is not None and zp_ is not None: e = max(e, zp_ - (zo - 150))
                    return e
                e = excess(rec); floor_z = zf(0) + 2400; pp2 = pp
                while e > 1 and (zpl - e >= floor_z or pp2 > 14.1):
                    if zpl - e >= floor_z: zpl -= e
                    else: pp2 = max(14.0, pp2 - 2.0)
                    r = roof(poly, "hip", pp2, zpl, 300, abut_mask=_abut(indoor[0] | indoor[1], c), material=mat if pp2 >= 18.4 else "metal")
                    rec = dict(storey=0, kind="porch", programme="lean-to", poly=poly, z_plate=zpl, **r); e = excess(rec)
                if pp2 < pp or zpl < zf(0) + Hs - slab - 500: rec["adjusted"] = dict(pitch=round(pp2, 1), z_plate=round(zpl), residual_mm=round(e))
                if pp2 < 18.4: rec["material"] = "metal"
            out.append(rec)
    return out


def height_at(roof_list, x, y, storey=None):
    """Highest roof surface above (x, y) (mm), or None: used to keep upper-storey windows above lower roofs."""
    best = None
    for R in roof_list:
        if storey is not None and R["storey"] != storey: continue
        for role, V, F in R["pieces"]:
            for f in F:
                if len(f) != 3: continue
                P = V[f]
                n = np.cross(P[1] - P[0], P[2] - P[0])
                if n[2] <= 1e-9: continue
                # barycentric point-in-triangle in plan
                (x1, y1), (x2, y2), (x3, y3) = P[0, :2], P[1, :2], P[2, :2]
                det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
                if abs(det) < 1e-9: continue
                l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / det
                l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / det
                l3 = 1 - l1 - l2
                if min(l1, l2, l3) < -1e-9: continue
                z = l1 * P[0, 2] + l2 * P[1, 2] + l3 * P[2, 2]
                if best is None or z > best: best = z
    return best
