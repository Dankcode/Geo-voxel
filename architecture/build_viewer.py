"""Build the house viewer bundle (2026-11-03): app/public/houses/ — served by the Place Builder app and GitHub Pages.

    python architecture/build_viewer.py

Reads every generated area (architecture/areas/<id>/area.json, with its plans, exports and FreeCAD meshes), plus the
Chinese high-rise buildings in architecture/highrise/buildings/<id>/, and writes:
  index.html, assets/          the 3D / blueprint viewer and the world-map tool (assets/worldmap.js)
  models/<vk>.mesh.json        the FreeCAD model of each built house, as triangles
  plans/<vk>.json              the in-page blueprint (rooms, walls, doors, windows, furniture outlines)
  exports/<vk>.building.json   the game export (rooms, doors and their facing, garage orientation, furniture)
  models/index.json            the building list, grouped by area (the example sample first)
  areas/index.json             the areas the world map shows (centre, radius, houses with footprints)
  map/map.json                 footprints and streets of the bundled data sets (the map draws live OSM elsewhere)
  config.json                  the GitHub repository that takes generation requests
Then prunes the large regenerable files (FreeCAD .FCStd and backups, mesh JSON) from areas/*/deliver: the bundle keeps
the meshes, the IFC files stay with each area.
"""
import glob, json, math, os, re, shutil, subprocess, sys
ROOT = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.dirname(ROOT)
PIPE = os.path.join(ROOT, "pipeline"); sys.path.insert(0, PIPE)
import blueprint as BP, plan2d as P2, layout as LAY, spec as SP, house_facts as HF

SRC = os.path.join(ROOT, "viewer"); N = os.path.join(REPO, "app", "public", "houses")
REPO_SLUG = os.environ.get("GITHUB_REPOSITORY", "Dankcode/Geo-voxel")
vkey = lambda aid, k: re.sub(r"[^A-Za-z0-9_]", "_", f"{aid}__{k}".replace("~", "__"))
sty = lambda s: str(s or "").replace("_", " ")


def main():
    keep_models = {}
    if os.path.isdir(os.path.join(N, "models")):        # meshes already in the bundle (their FreeCAD source was pruned)
        for f in glob.glob(os.path.join(N, "models", "*.mesh.json")): keep_models[os.path.basename(f)] = f
    tmp = N + ".new"; shutil.rmtree(tmp, ignore_errors=True)
    for d in ("assets", "models", "plans", "exports", "map", "areas"): os.makedirs(os.path.join(tmp, d), exist_ok=True)
    lib, ITEMS, RI = SP.furniture_library()
    ids = sorted((os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(ROOT, "areas", "*", "area.json"))), key=lambda a: (a != "examples", a))
    idx, areas = [], []
    for aid in ids:
        A_DIR = os.path.join(ROOT, "areas", aid); A = json.load(open(os.path.join(A_DIR, "area.json")))
        D = os.path.join(A_DIR, "deliver")
        designs = {r["key"]: r for r in json.load(open(os.path.join(D, "designs.json")))} if os.path.exists(os.path.join(D, "designs.json")) else {}
        if A.get("title"): title = A["title"]
        elif any(h.get("address") for h in A["houses"]): title = f"Area · {A['blocks']} blocks around {next(h['address'] for h in A['houses'] if h.get('address'))}"
        else: title = f"Area · {A['blocks']} blocks at {A['center'][0]:.4f}, {A['center'][1]:.4f}"
        group = "Example buildings" if aid == "examples" else title
        ah = []
        for h in A["houses"]:
            k = h.get("key"); r = designs.get(k); vk = vkey(aid, k)
            rec = dict(key=k, vk=vk, osm_id=h["osm_id"], address=h.get("address"), street=h.get("street"), archetype=h.get("archetype"),
                       style=h.get("style"), storeys=h.get("storeys"), gate=h.get("gate"), distance_m=h.get("distance_m"),
                       restyled_from=h.get("restyled_from"), built=False, export_url=None, footprint=None)
            pf = os.path.join(A_DIR, "plans", f"plan-{k}.json")
            mesh = os.path.join(D, "bim", f"{k}.mesh.json")
            have_mesh = os.path.exists(mesh) or f"{vk}.mesh.json" in keep_models
            if not (k and r and os.path.exists(pf) and have_mesh): ah.append(rec); continue
            p = json.load(open(pf)); p["key"] = k
            m = json.load(open(mesh if os.path.exists(mesh) else keep_models[f"{vk}.mesh.json"]))
            kinds = [kind for st in r["rooms"] for kind, _ in st]; beds = kinds.count("bedroom"); storeys = len(p["labels"])
            fam = f"{beds}-bedroom {sty(m['meta']['theme']['style'])} {sty(m['meta']['theme']['archetype'])}" + (", garage" if "garage" in kinds else "") + (", porch" if "porch" in kinds else "")
            ex = os.path.join(A_DIR, "exports", f"{k}.building.json")
            if not os.path.exists(ex):
                subprocess.run([sys.executable, os.path.join(PIPE, "export_game.py"), pf, ex], cwd=PIPE, check=False)
            EX = json.load(open(ex)) if os.path.exists(ex) else {}
            stn = (EX.get("street") or {}).get("name")
            name = h.get("address") or h.get("street") or (f"{stn} · OSM {h['osm_id']}" if stn else f"House OSM {h['osm_id']}")
            rec["address"] = name
            m["meta"]["key"] = vk; m["meta"]["name"] = f"{name} — {sty(m['meta']['theme']['style'])}"
            chk = list(r["checks"])
            fct = HF.get(p.get("id"))
            if fct and fct.get("living_sqft"):
                chk.insert(0, dict(check=f"Real house — {fct['address'].split(',')[0]}: {fct['living_sqft']:,} sq ft on record", ok=True,
                                   detail="Sources: " + "; ".join(fct["source"])))
            m["meta"]["design"] = dict(seed=r["seed"], family=fam, checks=chk, rho=r["rho"], cost=r["cost"])
            json.dump(m, open(os.path.join(tmp, "models", f"{vk}.mesh.json"), "w"), separators=(",", ":"))
            bp = BP.build(p); F = LAY.furnish(p, bp["style"], bp["specs"], ITEMS, RI)
            json.dump(P2.export(bp, F), open(os.path.join(tmp, "plans", f"{vk}.json"), "w"), separators=(",", ":"))
            if EX:
                shutil.copy(ex, os.path.join(tmp, "exports", f"{vk}.building.json")); rec["export_url"] = f"exports/{vk}.building.json"
                fp = [rm["polygon_latlon"] for rm in EX.get("rooms", []) if rm.get("storey") == 0 and rm.get("polygon_latlon")]
                rec["footprint"] = [[[round(a, 6), round(b, 6)] for a, b in poly] for poly in fp]
            rec.update(built=True, style=m["meta"]["theme"]["style"], archetype=m["meta"]["theme"]["archetype"], storeys=storeys)
            idx.append(dict(key=vk, name=name + (f" · {sty(rec['style'])}" if h.get("restyled_from") else ""), archetype=rec["archetype"], style=rec["style"],
                            storeys=storeys, group=group, sub=f"{sty(rec['style'])} · {beds} bed · " + ("gate ✓" if h.get("gate") == "pass" else "gate ✗")))
            ah.append(rec); print(aid, vk, rec["style"], h.get("gate"), flush=True)
        areas.append(dict(id=aid, title=("Example buildings" if aid == "examples" else title), center=A.get("center"), radius_m=A.get("radius_m"),
                          blocks=A.get("blocks"), created=A.get("created"), style=A.get("style"), houses=ah, skipped=len(A.get("skipped", []))))
    add_highrise(tmp, idx)
    json.dump(idx, open(os.path.join(tmp, "models", "index.json"), "w"))
    json.dump(areas, open(os.path.join(tmp, "areas", "index.json"), "w"))
    json.dump(dict(repo=REPO_SLUG, issues=f"https://github.com/{REPO_SLUG}/issues", max_houses=12, block_m=110), open(os.path.join(tmp, "config.json"), "w"), indent=1)
    build_map(os.path.join(tmp, "map", "map.json"))
    for f in ("assets/index-merrell3.js", "assets/plan2d.js", "assets/worldmap.js"): shutil.copy(os.path.join(SRC, f), os.path.join(tmp, f))
    shutil.copy(os.path.join(SRC, "index.html"), os.path.join(tmp, "index.html"))
    shutil.rmtree(N, ignore_errors=True); os.rename(tmp, N)
    prune()
    print(len(idx), "buildings in", len(areas), "groups →", os.path.relpath(N, REPO))


def add_highrise(tmp, idx):
    """Chinese high-rise test buildings (architecture/highrise/buildings/<id>/, including facade variants
    <id>-<style>/): mesh, blueprint, index entry."""
    for bj in sorted(glob.glob(os.path.join(ROOT, "highrise", "buildings", "*", "building.json"))):
        d = os.path.dirname(bj); k = os.path.basename(d); vk = vkey("highrise", k)
        mesh, p2d = os.path.join(d, f"{k}.mesh.json"), os.path.join(d, f"{k}.plan2d.json")
        if not (os.path.exists(mesh) and os.path.exists(p2d)): continue
        B = json.load(open(bj)); m = json.load(open(mesh)); m["meta"]["key"] = vk
        json.dump(m, open(os.path.join(tmp, "models", f"{vk}.mesh.json"), "w"), separators=(",", ":"))
        shutil.copy(p2d, os.path.join(tmp, "plans", f"{vk}.json"))
        sty = B.get("style")                     # facade variant (highrise.facade): same plan, another exterior
        sname = m["meta"].get("style", {}).get("name") if sty else None
        ok = all(c.get("pass") for c in B.get("facade_checks", []))
        idx.append(dict(key=vk, name=B["name"], archetype="apartments", style=f"chinese_highrise_{sty}" if sty else "chinese_highrise_slab",
                        storeys=len(B["floors"]), group="High-rise apartments (China)",
                        sub=f"{sname + ' facade · ' if sname else ''}{B['score']['measure']['layout']} · score {B['score']['score']}"
                            + (" · facade checks ✓" if sty and ok else (" · facade checks ✗" if sty else ""))))
        print("highrise", vk, B["score"]["score"], flush=True)


def build_map(path):
    """Footprints and streets of the bundled data sets, in decimetres east/north of the map origin."""
    LAT0, LON0 = 30.44, -91.16
    KX = 111320 * math.cos(math.radians(LAT0)); KY = 111320
    sets = [("South Baton Rouge, LSU and downtown", os.path.join(ROOT, "data", "baton-rouge-south")), ("Riverbend", os.path.join(ROOT, "data", "riverbend"))]
    HOUSE_TAGS = {"house", "detached", "residential", "semidetached_house", "bungalow", "terrace", "yes"}
    dm = lambda lat, lon: [round((lon - LON0) * KX * 10), round((lat - LAT0) * KY * 10)]
    def area(pts):
        a = 0
        for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]): a += x1 * y2 - x2 * y1
        return abs(a) / 2 / 100.0
    out = dict(origin=[LAT0, LON0], kx=KX, ky=KY, block_m=110, regions=[], b=[], r=[]); seen = set()
    for ri, (name, d) in enumerate(sets):
        B = json.load(open(os.path.join(d, "buildings.json")))
        lat = [b["bounds"]["minlat"] for b in B if "bounds" in b]; lon = [b["bounds"]["minlon"] for b in B if "bounds" in b]
        out["regions"].append(dict(name=name, center=[sum(lat) / len(lat), sum(lon) / len(lon)]))
        for b in B:
            g = b.get("geometry")
            if not g or b["id"] in seen: continue
            seen.add(b["id"]); pts = [dm(p["lat"], p["lon"]) for p in g if p]
            if len(pts) < 3: continue
            t = b.get("tags", {}); a = area(pts)
            house = (t.get("building") in HOUSE_TAGS and 45 <= a <= 450 and not any(k in t for k in ("amenity", "shop", "office", "name"))) or t.get("building") == "house"
            addr = " ".join(str(t.get(k, "")) for k in ("addr:housenumber", "addr:street")).strip()
            out["b"].append([str(b["id"]), ri, 1 if house else 0, addr, [v for p in pts for v in p]])
        for r in json.load(open(os.path.join(d, "roads.json"))):
            g = r.get("geometry"); t = r.get("tags", {})
            if not g or "highway" not in t or t["highway"] in ("footway", "path", "steps", "cycleway", "service", "track"): continue
            out["r"].append([t["highway"], t.get("name", ""), [v for p in g if p for v in dm(p["lat"], p["lon"])]])
    json.dump(out, open(path, "w"), separators=(",", ":"))


def prune():
    """The bundle holds the meshes; drop the large regenerable FreeCAD files from the areas (IFC stays)."""
    for pat in ("*.FCStd", "*.FCBak", "*.mesh.json"):
        for f in glob.glob(os.path.join(ROOT, "areas", "*", "deliver", "bim", pat)): os.remove(f)
    for f in glob.glob(os.path.join(ROOT, "areas", "*", "chk", "spec", "*.pkl")): os.remove(f)
    for d in glob.glob(os.path.join(ROOT, "areas", "*", "_stage")): shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    main()
