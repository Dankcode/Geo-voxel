"""Map context for one building: footprint in metres, neighbours, street side, district, neighbourhood, land use, facts.

Everything here comes from OpenStreetMap (+ the Wikidata / Wikipedia items OSM links to). Coordinates: local metres
around a city origin (x east, y north).
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, math, re
from shapely.geometry import Polygon, Point, LineString
from shapely.strtree import STRtree

DATA = __import__("os").environ.get("GEO_DATA", _os_p0.path.join(_HERE, "..", "data", "baton-rouge-south"))


def _origin(data):
    """The local projection origin: <data>/meta.json "origin" (written by fetch_osm.py for any place), else
    GEO_ORIGIN="lat,lon", else Baton Rouge (the bundled data sets)."""
    try:
        o = json.load(open(_os_p0.path.join(data, "meta.json")))["origin"]; return float(o[0]), float(o[1])
    except Exception: pass
    if _os_p0.environ.get("GEO_ORIGIN"):
        a, b = _os_p0.environ["GEO_ORIGIN"].split(","); return float(a), float(b)
    return 30.44, -91.16


LAT0, LON0 = _origin(DATA)
KX = 111320 * math.cos(math.radians(LAT0))


def set_data(data):
    """Point the module at another data set (and its origin)."""
    global DATA, LAT0, LON0, KX
    DATA = data; LAT0, LON0 = _origin(data); KX = 111320 * math.cos(math.radians(LAT0))


def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * 111320)


def ring_of(geom):
    return [xy(p["lon"], p["lat"]) for p in geom]


def polys_of(el):
    """Closed ways → one polygon; relations → outer members."""
    out = []
    if el["type"] == "way" and el.get("geometry"):
        r = ring_of(el["geometry"])
        if len(r) >= 4:
            out.append(Polygon(r).buffer(0))
    elif el["type"] == "relation":
        for m in el.get("members", []):
            if m.get("role") == "outer" and m.get("geometry") and len(m["geometry"]) >= 4:
                out.append(Polygon(ring_of(m["geometry"])).buffer(0))
    return [p for p in out if p.is_valid and p.area > 0]


class City:
    def __init__(self):
        B = json.load(open(f"{DATA}/buildings.json"))
        self.buildings = []
        for e in B:
            ps = polys_of(e)
            if ps:
                self.buildings.append({"id": str(e["id"]), "tags": e.get("tags", {}), "poly": max(ps, key=lambda p: p.area)})
        self.btree = STRtree([b["poly"] for b in self.buildings])
        D = json.load(open(f"{DATA}/districts.json"))
        self.districts, self.hoods = [], []
        for e in D:
            if e["type"] == "node":
                self.hoods.append({"name": e["tags"].get("name"), "tags": e["tags"], "pt": Point(xy(e["lon"], e["lat"]))})
            else:
                for p in polys_of(e):
                    self.districts.append({"name": e["tags"].get("name"), "tags": e["tags"], "poly": p})
        L = json.load(open(f"{DATA}/landuse.json"))
        self.landuse = [{"tags": e["tags"], "poly": p} for e in L for p in polys_of(e)]
        R = json.load(open(f"{DATA}/roads.json"))
        self.roads = [{"tags": r["tags"], "line": LineString(ring_of(r["geometry"]))} for r in R if len(r.get("geometry", [])) >= 2]
        self.rtree = STRtree([r["line"] for r in self.roads])
        self.wiki = json.load(open(f"{DATA}/wiki.json"))

    def context(self, b):
        poly, c = b["poly"], b["poly"].centroid
        near = [self.buildings[i] for i in self.btree.query(poly.buffer(0.6)) if self.buildings[i] is not b]
        party = [n for n in near if n["poly"].buffer(0.6).intersection(poly.exterior).length > 2.0]
        district = next((d for d in self.districts if d["poly"].contains(c)), None)
        hood = min(self.hoods, key=lambda h: h["pt"].distance(c)) if self.hoods else None
        hood = hood if hood and hood["pt"].distance(c) < 700 else None
        lu = next((l["tags"].get("landuse") for l in self.landuse if l["poly"].contains(c)), None)
        roads = [self.roads[i] for i in self.rtree.query(poly.buffer(45))]
        roads.sort(key=lambda r: r["line"].distance(poly))
        wd = lambda q: self.wiki.get(q) if q else None
        return {"neighbours": near, "party": party, "district": district, "district_wiki": wd(district["tags"].get("wikidata")) if district else None,
                "hood": hood, "landuse": lu, "roads": roads[:6], "wiki": wd(b["tags"].get("wikidata"))}


# ------------------------------------------------------------------------------------------------ geometry
def frame(poly, roads):
    """Building frame: rotate so walls are axis-aligned; the front faces the nearest street (local −v)."""
    coords = list(poly.exterior.coords)
    # dominant wall direction: length-weighted 4θ mean (directions 90° apart vote together)
    sx = sy = 0
    for (x1, y1), (x2, y2) in zip(coords, coords[1:]):
        L = math.hypot(x2 - x1, y2 - y1); a = math.atan2(y2 - y1, x2 - x1)
        sx += L * math.cos(4 * a); sy += L * math.sin(4 * a)
    theta = math.atan2(sy, sx) / 4
    c = poly.centroid
    def to_local(x, y):
        dx, dy = x - c.x, y - c.y
        return (dx * math.cos(-theta) - dy * math.sin(-theta), dx * math.sin(-theta) + dy * math.cos(-theta))
    local = Polygon([to_local(x, y) for x, y in coords])
    # the four sides; the front is the side whose outward normal points at the nearest (biggest) street
    best = None
    minx, miny, maxx, maxy = local.bounds
    for side, (nx, ny), mid in (("s", (0, -1), (0, miny)), ("n", (0, 1), (0, maxy)), ("w", (-1, 0), (minx, 0)), ("e", (1, 0), (maxx, 0))):
        # world direction of this normal
        wx = nx * math.cos(theta) - ny * math.sin(theta); wy = nx * math.sin(theta) + ny * math.cos(theta)
        mx = c.x + mid[0] * math.cos(theta) - mid[1] * math.sin(theta); my = c.y + mid[0] * math.sin(theta) + mid[1] * math.cos(theta)
        for r in roads:
            for t in range(4, 40, 3):
                if r["line"].distance(Point(mx + wx * t, my + wy * t)) < 4:
                    cls = {"primary": 3, "secondary": 3, "tertiary": 2, "residential": 1, "unclassified": 1, "living_street": 1, "service": 0}.get(r["tags"]["highway"], 1)
                    score = t - 6 * cls
                    if not best or score < best[0]:
                        best = (score, side, r["tags"].get("name"), r["tags"]["highway"])
                    break
    side = best[1] if best else "s"
    # rotate the local frame so the front is at v = 0 (local y min); u runs along the front
    turn = {"s": 0, "e": -math.pi / 2, "n": math.pi, "w": math.pi / 2}[side]
    rot = lambda p: (p[0] * math.cos(turn) - p[1] * math.sin(turn), p[0] * math.sin(turn) + p[1] * math.cos(turn))
    # local 's' side is at min y; after the turn the front side sits at min y
    loc = Polygon([rot(p) for p in local.exterior.coords])
    minx, miny, _, _ = loc.bounds
    loc = Polygon([(x - minx, y - miny) for x, y in loc.exterior.coords])
    T = {"theta": theta, "turn": turn, "origin": (c.x, c.y), "shift": (minx, miny)}
    return loc, T, {"side": side, "street": best[2] if best else None, "highway": best[3] if best else None}


def to_world(T, u, v):
    """Local (u along the front, v from the front) metres → world metres."""
    x, y = u + T["shift"][0], v + T["shift"][1]
    t = -T["turn"]
    x, y = x * math.cos(t) - y * math.sin(t), x * math.sin(t) + y * math.cos(t)
    th = T["theta"]
    return (T["origin"][0] + x * math.cos(th) - y * math.sin(th), T["origin"][1] + x * math.sin(th) + y * math.cos(th))


def metrics(loc):
    minx, miny, maxx, maxy = loc.bounds
    w, d = maxx - minx, maxy - miny
    rect = loc.area / max(1e-6, w * d)
    simp = loc.simplify(0.6)
    reflex = max(0, (len(simp.exterior.coords) - 1 - 4) // 2)   # each reflex corner of a rectilinear outline adds two vertices
    return {"frontage": round(w, 1), "depth": round(d, 1), "area": round(loc.area, 1), "rectangularity": round(rect, 2), "reflex": reflex, "aspect": round(d / max(w, 0.1), 2)}


def years_in(text):
    if not text:
        return []
    ys = [int(y) for y in re.findall(r"\b(1[7-9]\d\d|20[0-2]\d)\b", text)]
    for word, y in (("eighteenth", 1750), ("nineteenth", 1850), ("twentieth", 1930)):
        m = re.search(r"(early|mid|late)[- ]" + word + " century", text, re.I)
        if m:
            ys.append(y + {"early": -35, "mid": 0, "late": 40}[m.group(1).lower()])
    return ys
