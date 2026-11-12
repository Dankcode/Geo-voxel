"""Run one generation request on this computer, or from a GitHub issue (2026-11-03).

    python run_request.py --lat 30.4425 --lon -91.1659 [--blocks 1.5] [--style auto] [--styles '{"<osm id>": "<style>"}']
    python run_request.py --restyle <area> <building key> <style>
    python run_request.py --regenerate <area> <building key> [--storeys 1|2] [--rooms '{"1": {"bedroom": 4}}'] [--style S] [--seed N] [--tries 3]
    python run_request.py --highrise <design id> [--storeys N] [--dwellings 2|4|6] [--gfa m2] [--bedrooms N] [--style S] [--seed N]
    python run_request.py --issue-body body.md [--issue N] --summary summary.md      (.github/workflows/generate-houses.yml)
    add --open-in-freecad to any of them to open the result in a running FreeCAD (freecad_link.py, the MCP add-on)

The house viewer runs these itself when it is served by `npm run app` (app/run-bridge.js: the Regenerate and Request
generation buttons start this script on this computer and open the result in FreeCAD); a viewer opened anywhere else
shows the command to copy.
Requirements (README → Requirements): FreeCAD 1.0, the CGAL roof tools (roofgen/build.sh), numpy, scipy, shapely.

The issue comes from one of the two issue forms (.github/ISSUE_TEMPLATE/generate-area.yml, restyle-building.yml),
which the house viewer pre-fills when someone picks a spot on its world map. Issue-form bodies are markdown:
"### <field label>\\n\\n<value>". The runner:
  area     → the data set: a bundled one when the circle lies inside it, else a fresh OpenStreetMap fetch
             (fetch_osm.py) → generate_area.py (plan, gate, FreeCAD model, blueprint, game export)
  restyle  → generate_area.py --restyle (same layout, another style template; Merrell 2010 Fig. 9)
then rebuilds the viewer bundle (build_viewer.py) and writes a markdown summary for the issue comment.
Nothing here asks an AI model anything: generation is the planned algorithm end to end.
"""
import argparse, json, math, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
PY = sys.executable
BUNDLED = {"baton-rouge-south": os.path.join(ROOT, "data", "baton-rouge-south")}
STYLES = None


def fields(body):
    out, key = {}, None
    for line in body.splitlines():
        m = re.match(r"^###\s+(.*)$", line.strip())
        if m: key = m.group(1).strip().lower(); out[key] = ""; continue
        if key is not None: out[key] += line + "\n"
    return {k: v.strip() for k, v in out.items() if v.strip() and v.strip() != "_No response_"}


def get(F, *names, default=None):
    for n in names:
        for k, v in F.items():
            if k.startswith(n): return v
    return default


def inside_bundled(lat, lon, r):
    """A bundled data set that covers the whole circle (its buildings' extent contains it) with buildings in it."""
    best = None
    for name, d in BUNDLED.items():
        try: B = json.load(open(os.path.join(d, "buildings.json")))
        except Exception: continue
        bd = [b["bounds"] for b in B if b.get("bounds")]
        if not bd: continue
        dlat = r / 111320.0; dlon = r / (111320.0 * math.cos(math.radians(lat)))
        if not (min(x["minlat"] for x in bd) <= lat - dlat and max(x["maxlat"] for x in bd) >= lat + dlat and
                min(x["minlon"] for x in bd) <= lon - dlon and max(x["maxlon"] for x in bd) >= lon + dlon): continue
        kx = 111320 * math.cos(math.radians(lat))
        n = sum(1 for x in bd if math.hypot(((x["minlon"] + x["maxlon"]) / 2 - lon) * kx, ((x["minlat"] + x["maxlat"]) / 2 - lat) * 111320) <= r)
        if n >= 3 and (best is None or n > best[0]): best = (n, d)
    return best[1] if best else None


def safe(s, pat=r"[^a-z_]"): return re.sub(pat, "", (s or "").lower())


def require():
    """Stop early, with the fix, when a requirement is missing (README → Requirements)."""
    problems = []
    try:
        import FreeCAD  # noqa: F401  (conda-forge puts FreeCAD.so in $CONDA_PREFIX/lib)
    except ImportError:
        lib = os.path.join(os.environ.get("CONDA_PREFIX", sys.prefix), "lib")
        sys.path.append(lib)
        try:
            import FreeCAD  # noqa: F401
            os.environ["PYTHONPATH"] = os.pathsep.join(x for x in (lib, os.environ.get("PYTHONPATH")) if x)
        except ImportError:
            problems.append("FreeCAD 1.0 cannot be imported by this Python: micromamba create -f architecture/environment.yml")
    for t in ("roofgen", "roofgen_exact"):
        if not os.access(os.path.join(HERE, "roofgen", t), os.X_OK):
            problems.append(f"the roof tool {t} is not built: bash architecture/pipeline/roofgen/build.sh")
    for m in ("numpy", "scipy", "shapely"):
        try: __import__(m)
        except ImportError: problems.append(f"the Python package {m} is missing: micromamba create -f architecture/environment.yml")
    if problems: sys.exit("Missing requirements (see README → Requirements):\n  - " + "\n  - ".join(problems))


def vkey(aid, k):
    """The viewer's key for a building (build_viewer.vkey)."""
    import re                                    # local: FreeCAD's start-up scripts clear names from __main__
    return re.sub(r"[^A-Za-z0-9_]", "_", f"{aid}__{k}".replace("~", "__"))


def house_files(area, key):
    import os
    d = os.path.join(ROOT, "areas", area, "deliver", "bim")
    return [p for p in (os.path.join(d, f"{key}.FCStd"), os.path.join(d, f"{key}.ifc")) if os.path.exists(p)][:1]


def finish(result, open_in_freecad):
    """Print the result line the viewer reads (RESULT {...}) and, if asked, open the model in a running FreeCAD."""
    import json, os, sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    if open_in_freecad and result.get("files"):
        import freecad_link
        ok, msg = freecad_link.open_files(result["files"])
        result["freecad"] = {"opened": ok, "message": msg}
        print(("Opened in FreeCAD: " if ok else "Not opened in FreeCAD: ") + msg)
    print("RESULT " + json.dumps(result), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--issue-body"); ap.add_argument("--issue", default="")
    ap.add_argument("--lat", type=float); ap.add_argument("--lon", type=float)
    ap.add_argument("--blocks", type=float, default=1.5); ap.add_argument("--style", default="auto"); ap.add_argument("--styles", default="")
    ap.add_argument("--restyle", nargs=3, metavar=("AREA", "KEY", "STYLE"))
    ap.add_argument("--regenerate", nargs=2, metavar=("AREA", "KEY"))
    ap.add_argument("--storeys", type=int); ap.add_argument("--rooms", default=""); ap.add_argument("--seed", type=int)
    ap.add_argument("--tries", type=int, default=3, help="layout seeds to try until one passes the gate (houses)")
    ap.add_argument("--highrise", metavar="ID"); ap.add_argument("--dwellings", type=int)
    ap.add_argument("--gfa", type=int); ap.add_argument("--bedrooms", type=int); ap.add_argument("--bathrooms", type=int)
    ap.add_argument("--summary")
    ap.add_argument("--open-in-freecad", action="store_true", help="open the result in a running FreeCAD (MCP add-on RPC server)")
    a = ap.parse_args()
    if a.regenerate or a.highrise:
        require()
        import generate_area as GA
        if a.regenerate:
            area = re.sub(r"[^A-Za-z0-9_\-]", "", a.regenerate[0]); key = re.sub(r"[^A-Za-z0-9_\-~.]", "", a.regenerate[1])
            d = os.path.join(ROOT, "areas", area)
            nk = GA.regenerate(d, key, seed=a.seed, storeys=a.storeys, rooms=a.rooms or None, style=a.style, tries=max(1, a.tries))
            A = json.load(open(os.path.join(d, "area.json"))); h = next(x for x in A["houses"] if x.get("key") == nk)
            line = f"Regenerated **{key}** in **{area}** → `{nk}` (gate: {h.get('gate')})."
            result = {"key": vkey(area, nk), "files": house_files(area, nk), "gate": h.get("gate")}
        else:
            sys.path.insert(0, os.path.join(ROOT, "highrise"))
            from highrise import generate as HG
            nid = HG.one(a.highrise, storeys=a.storeys, dwellings=a.dwellings, gfa=a.gfa, bedrooms=a.bedrooms,
                         bathrooms=a.bathrooms, seed=a.seed, style=None if a.style in (None, "", "auto") else a.style)
            line = f"Generated high-rise **{nid}** from {a.highrise}."
            bd = os.path.join(ROOT, "highrise", "buildings", nid)
            result = {"key": vkey("highrise", nid),
                      "files": [p for p in (os.path.join(bd, f"{nid}.FCStd"), os.path.join(bd, f"{nid}.ifc")) if os.path.exists(p)][:1]}
        import subprocess as sp                 # FreeCAD's start-up scripts clear names from __main__
        sp.run([PY, os.path.join(ROOT, "build_viewer.py")], check=True, cwd=ROOT)
        if a.summary: open(a.summary, "w").write(line + "\n")
        print(line); finish(result, a.open_in_freecad); return
    if a.issue_body: F = fields(open(a.issue_body).read())
    elif a.restyle: F = {"area": a.restyle[0], "building key": a.restyle[1], "new style": a.restyle[2]}
    elif a.lat is not None and a.lon is not None:
        F = {"latitude": str(a.lat), "longitude": str(a.lon), "radius in blocks": str(a.blocks), "style for the area": a.style}
        if a.styles: F["per-house styles"] = a.styles
    else: ap.error("give --lat and --lon, --restyle AREA KEY STYLE, or --issue-body")
    require()
    import generate_area as GA
    lines = []
    if get(F, "building key"):                                    # restyle form
        area = re.sub(r"[^A-Za-z0-9_\-]", "", get(F, "area", default=""))
        key = re.sub(r"[^A-Za-z0-9_\-~]", "", get(F, "building key"))
        style = safe(get(F, "new style", "style", default=""))
        d = os.path.join(ROOT, "areas", area)
        if not os.path.exists(os.path.join(d, "area.json")): sys.exit(f"no area {area}")
        nk = GA.restyle(d, key, style)
        A = json.load(open(os.path.join(d, "area.json"))); h = next(x for x in A["houses"] if x.get("key") == nk)
        lines.append(f"Restyled **{key}** in **{area}** as **{style.replace('_', ' ')}** → `{nk}` (gate: {h.get('gate')}).")
        result = {"key": vkey(area, nk), "files": house_files(area, nk), "gate": h.get("gate")}
    else:                                                          # area form
        lat = float(get(F, "latitude")); lon = float(get(F, "longitude"))
        blocks = min(2.0, max(1.0, float(get(F, "radius", "blocks", default="1.5").split()[0])))
        style = safe(get(F, "style for the area", "style", default="auto")) or "auto"
        styles = get(F, "per-house styles", default="")
        try: styles = json.loads(styles) if styles else {}
        except Exception: styles = {}
        styles = {re.sub(r"\D", "", str(k)): safe(v) for k, v in styles.items()}
        r = blocks * GA.BLOCK_M
        aid = f"area-{abs(lat):.4f}{'N' if lat >= 0 else 'S'}-{abs(lon):.4f}{'E' if lon >= 0 else 'W'}-{int(r)}m".replace(".", "_")
        data = inside_bundled(lat, lon, r)
        if data is None:
            data = os.path.join(ROOT, "data", aid)
            subprocess.run([PY, os.path.join(HERE, "fetch_osm.py"), "--lat", str(lat), "--lon", str(lon), "--radius", str(r), "--out", data], check=True)
        cmd = [PY, os.path.join(HERE, "generate_area.py"), "--lat", str(lat), "--lon", str(lon), "--blocks", str(blocks), "--style", style,
               "--max", "12", "--id", aid, "--data", data]
        if styles: cmd += ["--styles", json.dumps(styles)]
        subprocess.run(cmd, check=True, cwd=HERE)
        A = json.load(open(os.path.join(ROOT, "areas", aid, "area.json")))
        ok = [h for h in A["houses"] if h.get("gate") == "pass"]
        lines.append(f"Generated **{len(A['houses'])} houses** within {blocks} blocks ({int(r)} m) of {lat:.5f}, {lon:.5f} — "
                     f"{len(ok)} pass the design gate, {len(A['skipped'])} buildings skipped (not houses).")
        first = next((h for h in A["houses"] if h.get("gate") == "pass"), A["houses"][0] if A["houses"] else None)
        result = {"key": vkey(aid, first["key"]) if first else None, "files": house_files(aid, first["key"]) if first else [],
                  "houses": len(A["houses"]), "passed": len(ok)}
        for h in A["houses"]:
            lines.append(f"- {h.get('address') or 'OSM ' + str(h['osm_id'])}: {h.get('style', '').replace('_', ' ')} {h.get('archetype', '').replace('_', ' ')}, gate {h.get('gate')}")
    subprocess.run([PY, os.path.join(ROOT, "build_viewer.py")], check=True, cwd=ROOT)
    if a.summary: open(a.summary, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    finish(result, a.open_in_freecad)


if __name__ == "__main__":
    main()
