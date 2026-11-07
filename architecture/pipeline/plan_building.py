"""One building: map context → theme → program → optimised plan per storey (+ nested apartment units)."""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, math, sys, time
import numpy as np
sys.path.insert(0, _HERE)
from mapctx import City, frame, metrics, to_world
from theme import infer
from programs import program_for, Prog, _unit
from planner import site_from_polygon, finish_site, optimize, Rng, stable_seed, DIRS, neighbour


def cell_for(area):
    return 0.4 if area < 260 else 0.5 if area < 600 else 0.7 if area < 1400 else 0.9


PERSON_GEO = __import__("os").environ.get("PERSON_GEO", "1") == "1"


def person_findings(out, prog, res, site0):
    """Build the candidate plan and measure it on its real walls (circulation.routes); [] when a person fits."""
    import blueprint as BP, circulation as CI
    tmp = dict(out, program={"rooms": prog["rooms"], "edges": prog["edges"], "entry": prog["entry"], "log": [],
                             "upper_cover": prog.get("upper_cover"), "stair_size": prog.get("stair_size")},
               labels=[np.asarray(L).tolist() for L in res["labels"]], stair=res["stair"], key="probe",
               cost=res["cost"], terms=res["terms"],
               site={"H": site0["H"], "W": site0["W"], "origin": site0["origin"], "mask": site0["mask"].astype(int).tolist(),
                     "party": site0["party"].astype(int).tolist()})
    try:
        bp = BP.build(tmp)
    except Exception as e:
        return []                    # the gate will report a build failure on its own
    # the whole gate, not only the person-width rule: a plan the gate would fail earns the extra restarts too
    return [CI.summary(x) for x in CI.routes(tmp, bp)] + [c["check"] for c in bp["checks"] if not c["ok"] and not c["check"].startswith("a person fits")]


def plan_building(city, b, seed=1, restarts=int(__import__("os").environ.get("RESTARTS", 3)), log=print):
    ctx = city.context(b)
    loc, T, front = frame(b["poly"], ctx["roads"])
    m = metrics(loc)
    th = infer(b, ctx, m)
    # 2026-11-03: a style chosen in the map tool (Merrell 2010 Fig. 9: one layout, several style templates). STYLE_OVERRIDE
    # is a style key, or JSON {osm id: style key}; "auto" keeps what the map evidence says
    _ov = __import__("os").environ.get("STYLE_OVERRIDE")
    if _ov:
        try: _ovd = json.loads(_ov); _st = _ovd.get(str(b["id"])) if isinstance(_ovd, dict) else _ovd
        except Exception: _st = _ov
        if _st and _st != "auto":
            th = dict(th, style=_st, evidence=list(th.get("evidence", [])) + [{"source": "map tool", "says": f"style chosen: {_st}"}])
    # 2026-11-06: storeys set in the viewer's Regenerate panel (houses: 1 or 2)
    _so = __import__("os").environ.get("STOREYS_OVERRIDE")
    if _so and th["archetype"] in ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse"):
        _n = max(1, min(2, int(_so)))
        if _n != th["storeys"]:
            th = dict(th, storeys=_n, evidence=list(th.get("evidence", [])) + [{"source": "regenerate", "says": f"storeys set: {_n}"}])
    cell = cell_for(m["area"])
    from shapely.affinity import affine_transform
    # neighbours in the local frame → party edges
    party_local = []
    for n in ctx["party"]:
        pts = []
        for x, y in n["poly"].exterior.coords:
            dx, dy = x - T["origin"][0], y - T["origin"][1]
            th_ = -T["theta"]
            lx, ly = dx * math.cos(th_) - dy * math.sin(th_), dx * math.sin(th_) + dy * math.cos(th_)
            t = T["turn"]
            lx, ly = lx * math.cos(t) - ly * math.sin(t), lx * math.sin(t) + ly * math.cos(t)
            pts.append((lx - T["shift"][0], ly - T["shift"][1]))
        from shapely.geometry import Polygon
        party_local.append(Polygon(pts).buffer(0))
    site0 = site_from_polygon(loc, cell, party_local)
    S = th["storeys"]
    usable = site0["mask"].sum() * cell * cell
    use = b["tags"].get("amenity") or b["tags"].get("shop")
    brief = {"usable": usable, "frontage": m["frontage"], "cell": cell, "use": use}
    import house_facts as HF_                              # 2026-11-02: what public records say about this house
    if HF_.get(b["id"]): brief["facts"] = HF_.get(b["id"])
    # porches in the data (ours): a mapped porch or porch roof touching the house decides the porch
    for n in ctx["neighbours"]:
        tg = n["tags"]
        if tg.get("building") in ("porch", "roof", "veranda") or tg.get("building:part") in ("porch", "veranda") or "porch" in str(tg.get("description", "")).lower():
            if n["poly"].area < 0.6 * b["poly"].area:
                brief["porch_mapped"] = {"id": n["id"], "tag": "building=" + str(tg.get("building") or tg.get("building:part")), "area": n["poly"].area}; break
    # porches tagged on the house itself (porch=yes / building:porch)
    if not brief.get("porch_mapped") and (b["tags"].get("porch") in ("yes", "front") or b["tags"].get("building:porch")):
        brief["porch_mapped"] = {"id": b["id"], "tag": "porch=" + str(b["tags"].get("porch") or b["tags"].get("building:porch")), "area": 0.0}
    # 2026-11-06: a regenerated house keeps the programme choices of the house it came from (PROGRAM_SEED: that
    # house's seed), so only the counts set in the viewer change; the layout search still uses the new seed
    R = Rng(stable_seed(f"program:{b['id']}:{__import__('os').environ.get('PROGRAM_SEED') or seed}"))
    prog = program_for(th, brief, R)
    import mapctx as _MC
    out = {"geo_origin": [_MC.LAT0, _MC.LON0], "id": b["id"], "name": b["tags"].get("name"), "tags": b["tags"], "theme": th, "metrics": m, "front": front, "frame": T, "cell": cell,
           "local_outline": list(loc.exterior.coords), "context": {"district": ctx["district"]["name"] if ctx["district"] else None,
           "district_nrhp": ctx["district"]["tags"].get("ref:nrhp") if ctx["district"] else None, "hood": ctx["hood"]["name"] if ctx["hood"] else None,
           "landuse": ctx["landuse"], "party": len(ctx["party"]), "street": front.get("street")}}
    if prog is None:
        out.update(program=None, storeys=[]); return out
    # houses may pull their outline in from the mapped footprint (yards, porches, set-back upper floors — the paper's
    # outline freedom); commercial, civic and industrial outlines are mapped as built and stay fixed
    house = th["archetype"] in ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse")
    # revision 2026-10-30: a two-storey house keeps the mapped outline on the ground floor (building:levels = 2 means the
    # whole footprint is two storeys); single-storey houses may still pull in for yards and porches
    site0["carve"] = house and S == 1
    sites = [site0] + [finish_site(site0["mask"], cell, site0["party"], origin=site0["origin"], carve=house or True) for _ in range(1, S)]
    t0 = time.time(); best = None
    if S > 1: restarts = max(restarts, 5)          # two storeys couple through the stair (paper §7: ~1 in 20 fail)
    if th["archetype"] in ("shotgun", "cottage", "bungalow", "two_storey_house", "ranch", "townhouse"):
        restarts = max(restarts, 7 if S > 1 else 5)  # round 3 (2026-11-02): more terms, more restarts; stops at the first clean plan
    # 2026-11-03 person-width rule: the annealer works on the room grid (person_narrow in the cost); a plan that is
    # clean there is then built and measured on its real walls (circulation.routes: a 914 mm disc from doorway to
    # doorway). A plan a person cannot walk through earns another restart, up to PERSON_EXTRA more than the budget.
    extra = int(__import__("os").environ.get("PERSON_EXTRA", 3)) if PERSON_GEO else 0
    rank = lambda x: (0 if x["_clean"] and not x.get("person_fail") else 1 if x["_clean"] else 2, x["cost"])
    r, budget = 0, restarts
    while r < budget:
        res = optimize(prog, sites, f"plan:{b['id']}:{seed}:r{r}")
        log(f"  restart {r}: cost {res['cost']:.2f} a={res['terms']['a']:.0f} v={res['terms']['v']:.0f} ({res['iterations']} it)")
        r += 1
        # fix (2026-10-30, score A14): a dark habitable room also fails the gate, so it also earns a restart
        res["_clean"] = res["terms"]["a"] == 0 and res["terms"]["v"] == 0 and res["terms"]["l"] == 0
        if res["_clean"] and PERSON_GEO:
            f = person_findings(out, prog, res, site0)
            log(f"    gate on the built walls (person width and the rest): {'clear' if not f else '; '.join(f)[:300]}")
            if f:
                res["person_fail"] = f
                if budget == restarts: budget += extra            # once: a few more tries for a walkable plan
        if best is None or rank(res) < rank(best): best = res
        if rank(best)[0] == 0: break
    if best.get("person_fail"): log(f"  no walkable plan in {r} restarts; kept the cheapest: {'; '.join(best['person_fail'])[:200]}")
    out["plan_s"] = round(time.time() - t0, 1)
    labels = [L.copy() for L in best["labels"]]
    rooms = [dict(r) for r in prog["rooms"]]
    edges = list(prog["edges"])
    # nested plans: each apartment unit is planned inside its own cells (outline fixed, entry from the corridor)
    unit_terms = {}
    for u in [r for r in prog["rooms"] if r["kind"] == "unit"]:
        s, lab = u["storey"], u["id"] + 1
        L = labels[s]
        um = L == lab
        if um.sum() < 20: continue
        corridor = np.zeros(L.shape + (4,), bool); light = np.zeros(L.shape + (4,), bool)
        corr_ids = [r["id"] + 1 for r in prog["rooms"] if r["storey"] == s and r["kind"] in ("corridor", "hall", "stair", "lobby")]
        for k in range(4):
            nb = neighbour(L, k)
            corridor[..., k] = um & np.isin(nb, corr_ids)
            light[..., k] = um & (nb <= 0) & sites[s]["light"][..., k]
        usite = finish_site(um, cell, None, carve=False, entry_edges=corridor, light_edges=light)
        lit_m = float(light.sum()) * cell            # window-capable outline of this flat
        Pu = Prog(Rng(stable_seed(f"unit:{b['id']}:{u['id']}")), {}); _unit(Pu, um.sum() * cell * cell, lit_m)
        uprog = Pu.done(cell=cell); uprog["cover"] = 1.0; uprog["lit_strip"] = True
        # fix (2026-10-30, score A14): the flat's plan is gated like the building's — restart on a fresh seed while
        # it misses a connection, a room or daylight, and its terms are reported with the building's (they were
        # only logged, so a plan reported C_a = 0 while the gate found the flat's hall–living door missing)
        ures = None
        for ur_ in range(4):
            rr = optimize(uprog, [usite], f"unit:{b['id']}:{u['id']}:{seed}:r{ur_}", iterations=14000)
            if ures is None or rr["cost"] < ures["cost"]: ures = rr
            if rr["terms"]["a"] == 0 and rr["terms"]["v"] == 0 and rr["terms"]["l"] == 0: break
        for k_ in ("a", "v", "l"): unit_terms[k_] = unit_terms.get(k_, 0.0) + ures["terms"][k_]
        prog["log"].append(f"flat {u['id']}: {lit_m:.1f} m lit facade → {sum(1 for r in uprog['rooms'] if r['kind'] == 'bedroom')} bedrooms, a={ures['terms']['a']:.0f} l={ures['terms']['l']:.2f}")
        base = len(rooms)
        for ur in uprog["rooms"]:
            nr = dict(ur, id=base + ur["id"], storey=s, unit=u["id"]); rooms.append(nr)
        for e in uprog["edges"]: edges.append({"a": base + e["a"], "b": base + e["b"], "type": e["type"]})
        UL = ures["labels"][0]
        L[um] = (UL[um] + base).astype(np.int16)    # sub-room k → building room base+k-1 (label = id+1)
        edges.append({"a": u["id"], "b": base + uprog["entry"], "type": "door", "unit_entry": True})
        rooms[u["id"]]["subdivided"] = True
        log(f"  unit {u['id']}: {len(uprog['rooms'])} rooms, cost {ures['cost']:.1f}")
    out.update(program={"rooms": rooms, "edges": edges, "entry": prog["entry"], "log": prog["log"], "upper_cover": prog.get("upper_cover"), "stair_size": prog.get("stair_size")}, labels=[L.tolist() for L in labels],
               cost=round(best["cost"], 2), terms={k: round(v + unit_terms.get(k, 0.0), 3) for k, v in best["terms"].items()},
               unit_terms={k: round(v, 3) for k, v in unit_terms.items()}, stair=best["stair"],
               site={"H": site0["H"], "W": site0["W"], "origin": site0["origin"], "mask": site0["mask"].astype(int).tolist(),
                     "party": site0["party"].astype(int).tolist()})
    return out


def ascii_plan(p):
    rooms = p["program"]["rooms"]
    for s, L in enumerate(p["labels"]):
        L = np.array(L)
        chars = {}
        lines = []
        for y in range(L.shape[0]):
            row = ""
            for x in range(L.shape[1]):
                v = L[y, x]
                row += " " if v < 0 else "." if v == 0 else "#" if rooms[v - 1]["kind"] == "stair" else "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[(v - 1) % 62]
            lines.append(row)
        print(f"storey {s + 1}: " + ", ".join(f"{'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[r['id'] % 62]}={r['kind']}" for r in rooms if r['storey'] == s) + "\n" + "\n".join(lines))


if __name__ == "__main__":
    city = City()
    picks = json.load(open(_ARCH_OUT + "/picks.json"))
    import os
    keys = [k for k in picks if not os.path.exists(f"{_ARCH_OUT}/plan-{k}.json")] if sys.argv[1:] == ["all"] else sys.argv[1:]
    for key in keys:
        r = picks[key]
        b = next(x for x in city.buildings if x["id"] == r["id"])
        print(f"== {key} {r['id']} {r['name'] or ''} {r['theme']['style']}")
        try: p = plan_building(city, b)
        except Exception as e: print("  FAILED", repr(e)); continue
        print(" ", p["theme"]["archetype"], p["theme"]["style"], p["theme"]["storeys"], "F; rooms", len(p["program"]["rooms"]) if p["program"] else 0, "plan", p.get("plan_s"), "s", p.get("terms"))
        if p["program"]: print("  ", "; ".join(p["program"]["log"][:8])); ascii_plan(p)
        json.dump(p, open(f"{_ARCH_OUT}/plan-{key}.json", "w"))
