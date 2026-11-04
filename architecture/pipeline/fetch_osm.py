"""Fetch the OpenStreetMap data for any place into a data set the pipeline reads (2026-11-03).

    python fetch_osm.py --lat 30.3916 --lon -91.2061 --radius 165 --out architecture/data/area-xyz

One Overpass request (keyless, open data, © OpenStreetMap contributors, ODbL) for the circle plus a 120 m margin
(neighbours and streets just outside it shape each house's frame and party walls):
  buildings.json  closed building ways and multipolygon relations, with geometry
  roads.json      highway ways (not footways / paths / service tracks), with geometry
  landuse.json    landuse / leisure areas
  districts.json  named place nodes and neighbourhood / suburb areas
  wiki.json       {} (Wikidata facts are optional; the theme inference works without them)
  meta.json       {"origin": [lat, lon], "center", "radius_m", "fetched", "source"}: the local projection origin is
                  the circle's centre, so a place anywhere on Earth is planned in true metres.
Mirrors are tried in order; the result is the same JSON shape the bundled Baton Rouge data sets use.
"""
import argparse, json, math, os, sys, time, urllib.parse, urllib.request

MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
UA = "geo-voxels-architecture/1.0 (+https://github.com/Dankcode/Geo-voxel)"


def bbox(lat, lon, r):
    dlat = r / 111320.0; dlon = r / (111320.0 * math.cos(math.radians(lat)))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def query(lat, lon, radius_m, margin=120.0):
    s, w, n, e = bbox(lat, lon, radius_m + margin)
    b = f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"
    return f"""[out:json][timeout:90];
(
  way["building"]({b});
  relation["building"]["type"="multipolygon"]({b});
  way["highway"]({b});
  way["landuse"]({b}); way["leisure"]({b});
  node["place"~"neighbourhood|suburb|quarter"]({b});
  way["place"~"neighbourhood|suburb|quarter"]({b});
  relation["boundary"="administrative"]["admin_level"~"9|10"]({b});
);
out tags geom;"""


def fetch(q, tries=2):
    last = None
    for url in MIRRORS:
        for _ in range(tries):
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)
            except Exception as ex:
                last = ex; time.sleep(3)
    raise RuntimeError(f"Overpass failed on every mirror: {last}")


SKIP_HW = {"footway", "path", "steps", "cycleway", "track", "bridleway", "corridor", "proposed", "construction", "platform"}


def split(els):
    B, R, L, D = [], [], [], []
    for e in els:
        t = e.get("tags", {})
        if "building" in t and e["type"] in ("way", "relation"):
            if e["type"] == "way" and len(e.get("geometry") or []) >= 4: B.append(e)
            elif e["type"] == "relation" and any(m.get("role") == "outer" and m.get("geometry") for m in e.get("members", [])): B.append(e)
        elif "highway" in t and e["type"] == "way":
            if t["highway"] not in SKIP_HW and len(e.get("geometry") or []) >= 2: R.append({"id": e["id"], "tags": t, "geometry": e["geometry"]})
        elif ("landuse" in t or "leisure" in t) and e["type"] == "way" and len(e.get("geometry") or []) >= 4:
            L.append(e)
        elif "place" in t or t.get("boundary") == "administrative":
            if e["type"] == "node": D.append({"type": "node", "id": e["id"], "lat": e["lat"], "lon": e["lon"], "tags": t})
            else: D.append(e)
    return B, R, L, D


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True); ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius", type=float, default=165.0); ap.add_argument("--out", required=True)
    ap.add_argument("--from-json", default=None, help="use a saved Overpass response instead of fetching")
    a = ap.parse_args()
    data = json.load(open(a.from_json)) if a.from_json else fetch(query(a.lat, a.lon, a.radius))
    B, R, L, D = split(data.get("elements", []))
    os.makedirs(a.out, exist_ok=True)
    for name, v in (("buildings", B), ("roads", R), ("landuse", L), ("districts", D)):
        json.dump(v, open(os.path.join(a.out, f"{name}.json"), "w"))
    json.dump({}, open(os.path.join(a.out, "wiki.json"), "w"))
    json.dump(dict(origin=[a.lat, a.lon], center=[a.lat, a.lon], radius_m=a.radius, fetched=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   source="OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)"), open(os.path.join(a.out, "meta.json"), "w"), indent=1)
    print(f"{a.out}: {len(B)} buildings, {len(R)} streets, {len(L)} land-use areas, {len(D)} places")
    if not B: sys.exit("no buildings mapped here")


if __name__ == "__main__":
    main()
