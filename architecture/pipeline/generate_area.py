"""Generate the houses inside a highlighted map area (2026-11-03).

    python generate_area.py --lat 30.4056 --lon -91.1278 --blocks 1.5 [--radius-m R] [--style auto|<style>]
                            [--styles '{"905235809": "tudor_revival"}'] [--max 12] [--seed 1] [--id NAME]
    python generate_area.py --restyle <area-dir> <key> <style>      # same layout, another style (Merrell Fig. 9)

1 block = BLOCK_M metres (a Baton Rouge residential block face is ~300–400 ft; we use 110 m). The default radius is
1.5 blocks; the map tool offers 1–2. Houses are the buildings the theme inference calls a house (shotgun, cottage,
bungalow, ranch, two-storey house, townhouse); others in the area are listed as skipped. Nearest first, at most --max.

Each house: plan (test_br.py, the competition planner, one seed) → gate (spec_dir) → FreeCAD model, blueprint,
spec (make_designs) → game export (export_game.py). Writes architecture/areas/<id>/area.json, the manifest the viewer reads.
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import argparse, json, math, os, re, shutil, subprocess, sys, time, glob
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
rel = lambda p: os.path.relpath(p, ROOT) if p and os.path.isabs(p) else p          # area.json keeps repo-relative paths
absd = lambda p: (p if os.path.isabs(p) else os.path.join(ROOT, p)) if p else p
PY = sys.executable
BLOCK_M = 110.0
DATA_DIRS = [_os_p0.path.join(_HERE, "..", "data", "baton-rouge-south")]
HOUSES = ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse")
PAPER_STYLES = {"cottage": "cape_cod", "italianate": "italianate", "tudor": "tudor_revival", "craftsman": "craftsman"}


def pick_data(lat, lon):
    """The data set whose buildings lie nearest the point."""
    best = None
    for d in DATA_DIRS:
        try: B = json.load(open(os.path.join(d, "buildings.json")))
        except Exception: continue
        dm = min(abs(b["bounds"]["minlat"] - lat) + abs(b["bounds"]["minlon"] - lon) for b in B if "bounds" in b)
        if best is None or dm < best[0]: best = (dm, d)
    return best[1]


def select(lat, lon, radius_m, data, max_n):
    os.environ["GEO_DATA"] = data
    sys.path.insert(0, HERE)
    import mapctx as MC
    from theme import infer
    MC.set_data(data)                    # the module reads GEO_DATA once at import; point it at this area's data
    city = MC.City()
    X, Y = MC.xy(lon, lat)
    near = []
    for b in city.buildings:
        c = b["poly"].centroid; d = math.hypot(c.x - X, c.y - Y)
        if d <= radius_m: near.append((d, b))
    near.sort(key=lambda t: t[0])
    houses, skipped = [], []
    for d, b in near:
        try:
            ctx = city.context(b); loc, T, front = MC.frame(b["poly"], ctx["roads"]); m = MC.metrics(loc)
            th = infer(b, ctx, m)
        except Exception as e:
            skipped.append(dict(osm_id=b["id"], why=f"could not read: {str(e)[:60]}")); continue
        rec = dict(osm_id=b["id"], distance_m=round(d, 1), archetype=th["archetype"], style=th["style"], storeys=th["storeys"],
                   address=" ".join(str(b["tags"].get(k, "")) for k in ("addr:housenumber", "addr:street")).strip() or None, area_m2=round(m["area"]))
        (houses if th["archetype"] in HOUSES else skipped).append(rec if th["archetype"] in HOUSES else dict(rec, why=f"{th['archetype']}, not a house"))
    return houses[:max_n], skipped + [dict(h, why="over the per-request limit") for h in houses[max_n:]]


def run(args):
    radius = args.radius_m or args.blocks * BLOCK_M
    data = args.data or pick_data(args.lat, args.lon)
    aid = args.id or f"area-{args.lat:.4f}-{args.lon:.4f}-{int(radius)}m".replace("-", "m", 1).replace(".", "_")
    out = os.path.join(HERE, "..", "areas", aid); os.makedirs(out, exist_ok=True)
    styles = json.loads(args.styles) if args.styles else {}
    houses, skipped = select(args.lat, args.lon, radius, data, args.max)
    print(f"{aid}: {len(houses)} houses within {radius:.0f} m ({radius / BLOCK_M:.1f} blocks), {len(skipped)} skipped", flush=True)
    for h in houses: h["style_chosen"] = PAPER_STYLES.get(styles.get(str(h["osm_id"]), args.style), styles.get(str(h["osm_id"]), args.style))
    # 1. plan, two at a time
    env = dict(os.environ, GEO_DATA=data, PAPER="1", MERGE="1", MOVES="v2")
    procs = []
    for h in houses:
        key = f"h{h['osm_id']}"
        e = dict(env, STYLE_OVERRIDE=h["style_chosen"] or "auto")
        while len([p for p in procs if p.poll() is None]) >= 2: time.sleep(2)
        procs.append(subprocess.Popen([PY, "test_br.py", str(h["osm_id"]), key, str(args.seed), os.path.join(out, "plans")], cwd=HERE, env=e,
                                      stdout=open(os.path.join(out, "plan.log"), "a"), stderr=subprocess.STDOUT))
        h["key"] = f"{key}-s{args.seed}"
    for p in procs: p.wait()
    build(out, houses, skipped, dict(id=aid, center=[args.lat, args.lon], radius_m=round(radius), blocks=round(radius / BLOCK_M, 2),
                                    data=data, seed=args.seed, style=args.style, created=time.strftime("%Y-%m-%dT%H:%M:%S")))


def build(out, houses, skipped, meta, only=None):
    """Gate, model, blueprint and export the planned houses; only= limits the work to those keys (a restyle), the
    other houses keep the results already in area.json."""
    out = os.path.abspath(out)           # the staging symlinks must resolve from the staging folder
    env = dict(os.environ, GEO_DATA=absd(meta.get("data")) or DATA_DIRS[0], PAPER="1", MERGE="1")
    planned = [h for h in houses if os.path.exists(os.path.join(out, "plans", f"plan-{h['key']}.json"))]
    todo = [h for h in planned if only is None or h["key"] in only]
    # 2. gate (writes <out>/chk/spec/area-<key>.bp.pkl): stage just the plans being built
    stage = os.path.join(out, "_stage"); shutil.rmtree(stage, ignore_errors=True); os.makedirs(stage)
    for h in todo: os.symlink(os.path.join(out, "plans", f"plan-{h['key']}.json"), os.path.join(stage, f"plan-{h['key']}.json"))
    subprocess.run([PY, "spec_dir.py", stage, os.path.join(out, "chk"), "area"], cwd=HERE, env=env,
                   stdout=open(os.path.join(out, "gate.log"), "a"), stderr=subprocess.STDOUT)
    gate = {}
    for line in open(os.path.join(out, "gate.log")):
        parts = line.strip().split(" ", 2)
        if len(parts) == 3 and parts[0].startswith("area-"): gate[parts[0][5:]] = parts[2]
    # 3. models, blueprints, specs (FreeCAD)
    keys = [h["key"] for h in todo]
    if keys:
        subprocess.run([PY, "make_designs.py", os.path.join(out, "plans"), os.path.join(out, "deliver")] + keys, cwd=HERE, env=dict(env, RESUME="1"),
                       stdout=open(os.path.join(out, "build.log"), "a"), stderr=subprocess.STDOUT)
    # 4. game exports
    os.makedirs(os.path.join(out, "exports"), exist_ok=True)
    for h in todo:
        subprocess.run([PY, "export_game.py", os.path.join(out, "plans", f"plan-{h['key']}.json"), os.path.join(out, "exports", f"{h['key']}.building.json")],
                       cwd=HERE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        g = gate.get(h["key"], "not built")
        h.update(gate=("pass" if g == "PASS" else "fail"), fails=([] if g == "PASS" else g), export=f"exports/{h['key']}.building.json",
                 built=os.path.exists(os.path.join(out, "deliver", "bim", f"{h['key']}.mesh.json")))
        try:
            p = json.load(open(os.path.join(out, "plans", f"plan-{h['key']}.json"))); h["style"] = p["theme"]["style"]
        except Exception: pass
    for h in houses:
        if h not in planned: h.update(gate="not planned", built=False)
    shutil.rmtree(stage, ignore_errors=True)
    json.dump(dict(meta, data=rel(meta.get("data")), houses=houses, skipped=skipped), open(os.path.join(out, "area.json"), "w"), indent=1, default=str)
    print("wrote", os.path.join(out, "area.json"), flush=True)


def restyle(area_dir, key, style):
    """Merrell 2010 Fig. 9: the same building layout decorated in another style template."""
    style = PAPER_STYLES.get(style, style)
    A = json.load(open(os.path.join(area_dir, "area.json")))
    src = os.path.join(area_dir, "plans", f"plan-{key}.json"); p = json.load(open(src))
    base = key.split("~")[0]; nk = f"{base}~{style}"
    p["theme"] = dict(p["theme"], style=style); p["key"] = nk; p.pop("stair_rev", None)
    json.dump(p, open(os.path.join(area_dir, "plans", f"plan-{nk}.json"), "w"))
    h0 = next(h for h in A["houses"] if h.get("key") == key)
    h = dict(h0, key=nk, style_chosen=style, restyled_from=key)
    A["houses"] = [x for x in A["houses"] if x.get("key") != nk] + [h]
    build(area_dir, A["houses"], A.get("skipped", []), {k: v for k, v in A.items() if k not in ("houses", "skipped")}, only={nk})
    return nk


def regenerate(area_dir, key, seed=None, storeys=None, rooms=None, style=None, tries=3):
    """Plan a house again from its map footprint, with the storeys and the room counts per storey set in the viewer
    (ROOMS_OVERRIDE, see programs.apply_counts) and a new seed, then gate, model and export it. The result is a new
    key <name>.r<n>-s<seed> next to the original, so a regenerated house can itself be regenerated again."""
    A = json.load(open(os.path.join(area_dir, "area.json")))
    h0 = next(h for h in A["houses"] if h.get("key") == key)
    name = key.split("~")[0].rsplit("-s", 1)[0].split(".r")[0]
    n = 1 + sum(1 for h in A["houses"] if str(h.get("key", "")).startswith(name + ".r"))
    seed = int(seed) if seed else 10 * n + 1
    style = PAPER_STYLES.get(style, style) if style and style != "auto" else (h0.get("style_chosen") or "auto")
    env = dict(os.environ, GEO_DATA=absd(A.get("data")) or DATA_DIRS[0], PAPER="1", MERGE="1", MOVES="v2", STYLE_OVERRIDE=style)
    if storeys: env["STOREYS_OVERRIDE"] = str(int(storeys))
    if rooms: env["ROOMS_OVERRIDE"] = rooms if isinstance(rooms, str) else json.dumps(rooms)
    m = re.search(r"-s(\d+)$", key.split("~")[0])
    env["PROGRAM_SEED"] = str(h0.get("program_seed") or (m.group(1) if m else h0.get("seed") or 1))
    karg = f"{name}.r{n}"
    plans = os.path.join(area_dir, "plans"); os.makedirs(plans, exist_ok=True)
    best = None
    for s_ in range(seed, seed + tries):                       # the first layout that passes the gate, else the fewest fails
        r = subprocess.run([PY, "test_br.py", str(h0["osm_id"]), karg, str(s_), plans], cwd=HERE, env=env,
                           stdout=open(os.path.join(area_dir, "plan.log"), "a"), stderr=subprocess.STDOUT)
        rec = os.path.join(plans, f"rec-{karg}-s{s_}.json")
        if r.returncode != 0 or not os.path.exists(rec): continue
        fails = json.load(open(rec)).get("fails") or []
        if best is None or len(fails) < best[1]: best = (s_, len(fails))
        if not fails: break
    if best is None:
        raise RuntimeError(f"planning {karg} failed; see {os.path.join(area_dir, 'plan.log')}")
    seed = best[0]; nk = f"{karg}-s{seed}"
    h = dict(h0, key=nk, regenerated_from=key, style_chosen=style, seed=seed, program_seed=int(env["PROGRAM_SEED"]),
             counts=json.loads(env["ROOMS_OVERRIDE"]) if rooms else None, storeys_set=int(storeys) if storeys else None)
    h.pop("restyled_from", None)
    A["houses"] = [x for x in A["houses"] if x.get("key") != nk] + [h]
    build(area_dir, A["houses"], A.get("skipped", []), {k: v for k, v in A.items() if k not in ("houses", "skipped")}, only={nk})
    return nk


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--restyle":
        restyle(sys.argv[2], sys.argv[3], sys.argv[4]); sys.exit()
    ap = argparse.ArgumentParser()
    ap.add_argument("--lat", type=float, required=True); ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--blocks", type=float, default=1.5); ap.add_argument("--radius-m", type=float, default=None)
    ap.add_argument("--style", default="auto"); ap.add_argument("--styles", default=None)
    ap.add_argument("--max", type=int, default=12); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--data", default=None); ap.add_argument("--id", default=None)
    run(ap.parse_args())
