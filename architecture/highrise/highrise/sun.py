"""Winter sunlight hours at a south window, shaded by the next slab to the south.

GB 50180-2018 Table 4.0.9 sets the hours a dwelling's sunlit room must get on the standard day (e.g. >= 2 h on
the Major Cold day (Dahan) for zone I/II/III/VII cities of >= 500k people), counted between 8:00 and 16:00
true solar time. This module traces the sun minute by minute against the obstructing block (a box) and returns
the hours, and the smallest slab spacing that meets a requirement.
Frame: x east, y south, z up (m), window on the south facade at y = 0.
"""
import math

DAYS = {"major_cold": -20.2, "winter_solstice": -23.44}   # solar declination (deg)


def sun_dir(lat, decl, hour):
    """Unit vector toward the sun (x east, y south, z up) at true solar time `hour`, or None below the horizon."""
    phi, d, w = math.radians(lat), math.radians(decl), math.radians(15 * (hour - 12))
    sa = math.sin(phi) * math.sin(d) + math.cos(phi) * math.cos(d) * math.cos(w)
    if sa <= 0:
        return None
    alt = math.asin(sa)
    # azimuth from south, positive toward west
    sA = math.cos(d) * math.sin(w) / math.cos(alt)
    cA = (sa * math.sin(phi) - math.sin(d)) / (math.cos(alt) * math.cos(phi))
    A = math.atan2(sA, cA)
    return (-math.sin(A) * math.cos(alt), math.cos(A) * math.cos(alt), sa)


def _hits(p, v, box):
    t0, t1 = 0.0, 1e9
    for i in range(3):
        if abs(v[i]) < 1e-12:
            if not (box[0][i] <= p[i] <= box[1][i]):
                return False
            continue
        a, b = (box[0][i] - p[i]) / v[i], (box[1][i] - p[i]) / v[i]
        a, b = min(a, b), max(a, b)
        t0, t1 = max(t0, a), min(t1, b)
        if t0 > t1:
            return False
    return t1 > 1e-6


def row_boxes(spacing, block_len, block_depth, block_h, gap=13.0, count=5):
    """A row of equal slabs to the south: `count` blocks of `block_len` with `gap` between ends (the fire spacing
    between high-rises is 13 m, GB 50016 Table 5.2.2), centred on the window's block."""
    out = []
    for k in range(-(count // 2), count // 2 + 1):
        x0 = k * (block_len + gap) - block_len / 2
        out.append(((x0, spacing, 0.0), (x0 + block_len, spacing + block_depth, block_h)))
    return out


def sun_hours(lat, window_xz, boxes, day="major_cold", start=8.0, end=16.0, step_min=1):
    """Hours of sun at a window (x, z) on the south facade (y = 0) between `start` and `end` true solar time."""
    p = (window_xz[0], 0.0, window_xz[1])
    n, t = 0, start
    while t < end - 1e-9:
        v = sun_dir(lat, DAYS[day], t + step_min / 120)
        if v and v[1] > 0 and not any(_hits(p, v, b) for b in boxes):
            n += 1
        t += step_min / 60
    return n * step_min / 60


def min_spacing(lat, window_xz, block_len, block_depth, block_h, required_h, gap=13.0, day="major_cold"):
    """Smallest clear distance to the next row of slabs that still gives `required_h` hours."""
    f = lambda L: sun_hours(lat, window_xz, row_boxes(L, block_len, block_depth, block_h, gap), day)
    lo, hi = 1.0, 6 * block_h
    if f(hi) < required_h:
        return None
    for _ in range(25):
        mid = (lo + hi) / 2
        if f(mid) >= required_h:
            hi = mid
        else:
            lo = mid
    return round(hi, 1)
