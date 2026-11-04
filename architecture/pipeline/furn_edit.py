"""Furniture edits by an AI agent (2026-11-02): the core behind furnmcp/server.py.

An agent opens a design, lists rooms and items, and moves, rotates, adds or removes items. Every edit is checked
against the same rules the generator uses: inside its room, clear of other items, clear of door approaches (915 mm,
IRC/ADA clear floor) and swings, clear of the stair. An edit that breaks a rule is refused unless the agent forces it.
Edits are stored as a list of operations in <FURN_EDIT_DIR>/<key>.json, replayable over the generated layout.

Nothing here runs in a normal build. layout.furnish applies the stored edits only when FURN_EDIT=1 is set in the
environment; the competition and test builds never set it.
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import json, os, math, time, copy
from shapely.geometry import Polygon, box as sbox
from shapely import wkt as _wkt
from shapely.affinity import translate, rotate

EDIT_DIR = os.environ.get("FURN_EDIT_DIR", _ARCH_OUT + "/furniture-edits")
OVERLAP_OK = ("rug",)
EPS_AREA = 2000.0          # mm²: 2 cm² of overlap is noise


def _poly(fp):
    if isinstance(fp, str): return _wkt.loads(fp)
    if isinstance(fp, (list, tuple)): return Polygon(fp)
    return fp


def with_ids(items):
    """Stable ids: s<storey>-r<room>-<name>-<k>, k counting that name in that room in generation order."""
    seen = {}; out = []
    for f in items:
        k = (f["storey"], f["room"], f["name"]); n = seen.get(k, 0); seen[k] = n + 1
        g = dict(f); g["id"] = f"s{f['storey']}-r{f['room']}-{f['name']}-{n}"; g["fp"] = _poly(f["fp"])
        g["x"], g["y"], g["ang"] = float(f["x"]), float(f["y"]), float(f["ang"])
        out.append(g)
    return out


def path_for(key): return os.path.join(EDIT_DIR, f"{key}.json")


def load_ops(key):
    p = path_for(key)
    return json.load(open(p)) if os.path.exists(p) else None


# ------------------------------------------------------------------------------------------------ operations
def _rotate_item(f, deg):
    c = f["fp"].centroid
    ax, ay = f["x"] - c.x, f["y"] - c.y
    t = math.radians(deg); ca, sa = round(math.cos(t)), round(math.sin(t))
    f["x"], f["y"] = c.x + ax * ca - ay * sa, c.y + ax * sa + ay * ca
    f["fp"] = rotate(f["fp"], deg, origin=c)
    f["ang"] = (f["ang"] + deg) % 360


def apply_op(items, op, items_table=None):
    """Apply one operation in place. Returns the affected item (or None)."""
    t = op["op"]
    if t == "add":
        import furnish2 as F2
        L, D = items_table[op["name"]][:2]
        bb = F2.model_bb(op["name"]) if hasattr(F2, "model_bb") else None
        b = F2.pose_box(op["x"], op["y"], op.get("ang", 0), L, D, bb)
        f = dict(id=op.get("id") or f"add-{sum(1 for i in items if str(i['id']).startswith('add-'))}", storey=op["storey"], room=op["room"],
                 kind=op.get("kind", ""), name=op["name"], x=float(op["x"]), y=float(op["y"]), ang=float(op.get("ang", 0)), fp=sbox(*b), edited=True)
        items.append(f); return f
    f = next((i for i in items if i["id"] == op["id"]), None)
    if f is None: return None
    if t == "remove": items.remove(f); return f
    if t == "move":
        dx, dy = op["x"] - f["x"], op["y"] - f["y"]
        f["fp"] = translate(f["fp"], dx, dy); f["x"], f["y"] = float(op["x"]), float(op["y"])
        if op.get("ang") is not None and (op["ang"] - f["ang"]) % 360: _rotate_item(f, (op["ang"] - f["ang"]) % 360)
    elif t == "rotate":
        _rotate_item(f, op["deg"])
    f["edited"] = True
    return f


def apply(plan, items, items_table=None):
    """Called by layout.furnish when FURN_EDIT=1: replay the stored edits for this design over the generated layout."""
    rec = load_ops(plan.get("key") or "")
    if not rec: return items
    its = with_ids(items)
    for op in rec.get("ops", []): apply_op(its, op, items_table)
    return its


# ------------------------------------------------------------------------------------------------ rules
def zones(bp, plan, s):
    """Door approaches and swings, and the stair, on storey s (mm polygons)."""
    out = []
    c = plan["cell"] * 1000
    for sp in bp["specs"][s]:
        for o in sp["openings"]:
            if o["kind"] not in ("door", "overhead"): continue
            p = (o["pos"], sp["line"]) if sp["axis"] == "x" else (sp["line"], o["pos"])
            dz = 915
            z = sbox(p[0] - o["w"] / 2 - 150, p[1] - dz, p[0] + o["w"] / 2 + 150, p[1] + dz) if sp["axis"] == "x" else \
                sbox(p[0] - dz, p[1] - o["w"] / 2 - 150, p[0] + dz, p[1] + o["w"] / 2 + 150)
            out.append(("door approach", z))
            for a in (o.get("swing") or {}).get("arcs", []): out.append(("door swing", Polygon(a)))
    if plan.get("stair") and any(r.get("stair") and r["storey"] == s for r in plan["program"]["rooms"]):
        x0, y0, w, h = plan["stair"]
        out.append(("stair and its landings", sbox(x0 * c - 600, y0 * c - 600, (x0 + w) * c + 600, (y0 + h) * c + 600)))
    return out


def check_item(f, items, bp, plan, Z=None):
    v = []
    room = bp["polys"][f["storey"]].get(f["room"] + 1)
    if room is None: v.append(dict(rule="room", detail="room not found"))
    elif not f["fp"].within(room.buffer(10)):
        out_ = f["fp"].difference(room).area
        v.append(dict(rule="inside its room", detail=f"{out_ / 1e6:.2f} m² outside the room (wall or another room)"))
    if f["name"] not in OVERLAP_OK:
        for g in items:
            if g is f or g["storey"] != f["storey"] or g["name"] in OVERLAP_OK: continue
            a = f["fp"].intersection(g["fp"]).area
            if a > EPS_AREA: v.append(dict(rule="clear of other items", detail=f"overlaps {g['id']} by {a / 1e6:.2f} m²"))
    if f["name"] != "car":
        for why, z in (Z if Z is not None else zones(bp, plan, f["storey"])):
            a = f["fp"].intersection(z).area
            if a > EPS_AREA: v.append(dict(rule=f"clear of the {why}", detail=f"{a / 1e6:.2f} m² inside it"))
    return v


def check_all(items, bp, plan):
    Zs = {s: zones(bp, plan, s) for s in range(len(bp["specs"]))}
    return {f["id"]: vv for f in items if (vv := check_item(f, items, bp, plan, Zs[f["storey"]]))}


# ------------------------------------------------------------------------------------------------ a session
class Session:
    """One design open for editing. Edits are refused until activate() is called with a reason."""
    def __init__(self, plan_path):
        import blueprint as BP, spec as SP
        import layout as LAY
        self.plan = json.load(open(plan_path)); self.plan_path = os.path.abspath(plan_path)
        self.key = self.plan.get("key") or os.path.basename(plan_path).replace("plan-", "").replace(".json", ""); self.plan["key"] = self.key
        self.bp = BP.build(self.plan)
        lib, self.ITEMS, self.RI = SP.furniture_library()
        base = getattr(LAY, "_furnish_base", LAY.furnish)          # the generator's own layout, never the edited one
        self.base = with_ids(base(self.plan, self.bp["style"], self.bp["specs"], self.ITEMS, self.RI))
        rec = load_ops(self.key)
        self.ops = list(rec["ops"]) if rec else []
        self.reason = rec.get("reason") if rec else None
        self.active = False
        self.items = copy.deepcopy(self.base)
        for op in self.ops: apply_op(self.items, op, self.ITEMS)
        self.history = []

    def rooms(self, storey=None):
        out = []
        for r in self.plan["program"]["rooms"]:
            if storey is not None and r["storey"] != storey: continue
            p = self.bp["polys"][r["storey"]].get(r["id"] + 1)
            if p is None or p.is_empty: continue
            b = p.bounds
            out.append(dict(id=r["id"], kind=r["kind"], storey=r["storey"], area_m2=round(p.area / 1e6, 1),
                            bbox_mm=[round(v) for v in b], items=sum(1 for f in self.items if f["room"] == r["id"] and f["storey"] == r["storey"])))
        return out

    def list_items(self, room=None, storey=None):
        return [self.describe(f) for f in self.items if (room is None or f["room"] == room) and (storey is None or f["storey"] == storey)]

    def describe(self, f):
        b = f["fp"].bounds
        return dict(id=f["id"], room=f["room"], storey=f["storey"], name=f["name"], x=round(f["x"]), y=round(f["y"]), ang=f["ang"],
                    footprint_mm=[round(v) for v in b], edited=bool(f.get("edited")))

    def activate(self, reason):
        self.active = True; self.reason = reason
        return dict(active=True, reason=reason)

    def edit(self, op, force=False):
        if not self.active: return dict(ok=False, error="editing is off: call activate(reason) first — edits are only for when an item needs fixing")
        trial = copy.deepcopy(self.items)
        f = apply_op(trial, op, self.ITEMS)
        if f is None and op["op"] != "remove": return dict(ok=False, error=f"no item {op.get('id')}")
        if op["op"] == "remove":
            if f is None: return dict(ok=False, error=f"no item {op.get('id')}")
            self.history.append((self.items, list(self.ops))); self.items = trial; self.ops.append(op)
            return dict(ok=True, removed=op["id"])
        if op["op"] == "add": op = dict(op, id=f["id"])
        v = check_item(f, trial, self.bp, self.plan)
        if v and not force: return dict(ok=False, refused=v, hint="move it, or pass force=true to keep it anyway")
        self.history.append((self.items, list(self.ops))); self.items = trial; self.ops.append(op)
        return dict(ok=True, item=self.describe(f), violations=v)

    def undo(self):
        if not self.history: return dict(ok=False, error="nothing to undo")
        self.items, self.ops = self.history.pop(); return dict(ok=True, ops=len(self.ops))

    def validate(self):
        bad = check_all(self.items, self.bp, self.plan)
        return dict(items=len(self.items), with_problems=len(bad), problems=bad)

    def save(self):
        os.makedirs(EDIT_DIR, exist_ok=True)
        rec = dict(key=self.key, plan=self.plan_path, reason=self.reason, saved=time.strftime("%Y-%m-%dT%H:%M:%S"), ops=self.ops)
        json.dump(rec, open(path_for(self.key), "w"), indent=1)
        return dict(ok=True, path=path_for(self.key), ops=len(self.ops),
                    note="applied to builds only when FURN_EDIT=1 is set; normal and test builds ignore it")
