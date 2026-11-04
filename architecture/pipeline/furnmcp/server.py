"""MCP server (stdio, JSON-RPC 2.0, one message per line) for AI-agent furniture edits. Off unless someone runs it.

Run:  python architecture/pipeline/furnmcp/server.py
Register it with an MCP client only when furniture needs fixing; nothing in the build pipeline starts it.

Flow: open_design → list_rooms / list_items / validate (read-only) → activate(reason) → move_item / rotate_item /
add_item / remove_item (each checked; refused if it breaks a rule unless force=true) → validate → save.
Saved edits are applied to a build only when that build runs with FURN_EDIT=1.
"""
import os as _os_p0; _HERE = _os_p0.path.dirname(_os_p0.path.abspath(__file__)); _ARCH_OUT = _os_p0.environ.get("ARCH_OUT", _os_p0.path.join(_HERE, "..", "out"))
import sys, json, os, traceback
sys.path.insert(0, _os_p0.path.dirname(_HERE))
os.environ.setdefault("MERGE", "1")

S = {"session": None}

TOOLS = [
    dict(name="open_design", description="Open a design's plan JSON (plan-<key>.json) for furniture editing. Read-only until activate().",
         inputSchema={"type": "object", "properties": {"plan_path": {"type": "string"}}, "required": ["plan_path"]}),
    dict(name="list_rooms", description="Rooms of the open design: id, kind, storey, area, bbox (mm), item count.",
         inputSchema={"type": "object", "properties": {"storey": {"type": "integer"}}}),
    dict(name="list_items", description="Furniture items: id, room, storey, name, anchor x/y (mm), angle, footprint bbox.",
         inputSchema={"type": "object", "properties": {"room": {"type": "integer"}, "storey": {"type": "integer"}}}),
    dict(name="validate", description="Check every item: inside its room, clear of other items, door approaches/swings and the stair.",
         inputSchema={"type": "object", "properties": {}}),
    dict(name="activate", description="Turn editing on for this session. Give the reason an edit is needed (it is saved with the edits).",
         inputSchema={"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}),
    dict(name="move_item", description="Move an item's anchor to x, y (mm), optionally setting its angle (multiple of 90).",
         inputSchema={"type": "object", "properties": {"id": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"},
                      "ang": {"type": "number"}, "force": {"type": "boolean"}}, "required": ["id", "x", "y"]}),
    dict(name="rotate_item", description="Rotate an item about its centre by deg (90, 180, 270).",
         inputSchema={"type": "object", "properties": {"id": {"type": "string"}, "deg": {"type": "number"}, "force": {"type": "boolean"}}, "required": ["id", "deg"]}),
    dict(name="add_item", description="Add a library item (e.g. armchair, plant, nightstand) to a room at x, y, ang.",
         inputSchema={"type": "object", "properties": {"room": {"type": "integer"}, "name": {"type": "string"}, "x": {"type": "number"},
                      "y": {"type": "number"}, "ang": {"type": "number"}, "force": {"type": "boolean"}}, "required": ["room", "name", "x", "y"]}),
    dict(name="remove_item", description="Remove an item by id.",
         inputSchema={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
    dict(name="undo", description="Undo the last edit.", inputSchema={"type": "object", "properties": {}}),
    dict(name="library", description="Item names the generator knows, with their size L × D (mm).", inputSchema={"type": "object", "properties": {}}),
    dict(name="save", description="Save the edits for this design (applied only to builds run with FURN_EDIT=1).", inputSchema={"type": "object", "properties": {}}),
]


def call(name, a):
    import furn_edit as FE
    if name == "open_design":
        S["session"] = FE.Session(a["plan_path"]); s = S["session"]
        return dict(key=s.key, rooms=len(s.rooms()), items=len(s.items), stored_edits=len(s.ops), active=False)
    s = S["session"]
    if s is None: return dict(error="open_design first")
    if name == "list_rooms": return s.rooms(a.get("storey"))
    if name == "list_items": return s.list_items(a.get("room"), a.get("storey"))
    if name == "validate": return s.validate()
    if name == "activate": return s.activate(a["reason"])
    if name == "library": return {k: [v[0], v[1]] for k, v in s.ITEMS.items()}
    if name == "undo": return s.undo()
    if name == "save": return s.save()
    if name == "move_item": return s.edit(dict(op="move", id=a["id"], x=a["x"], y=a["y"], ang=a.get("ang")), a.get("force", False))
    if name == "rotate_item": return s.edit(dict(op="rotate", id=a["id"], deg=a["deg"]), a.get("force", False))
    if name == "remove_item": return s.edit(dict(op="remove", id=a["id"]))
    if name == "add_item":
        r = next((r for r in s.plan["program"]["rooms"] if r["id"] == a["room"]), None)
        if r is None: return dict(error=f"no room {a['room']}")
        if a["name"] not in s.ITEMS: return dict(error=f"unknown item {a['name']}; see library")
        return s.edit(dict(op="add", room=a["room"], storey=r["storey"], kind=r["kind"], name=a["name"], x=a["x"], y=a["y"], ang=a.get("ang", 0)), a.get("force", False))
    return dict(error=f"unknown tool {name}")


def reply(i, result=None, error=None):
    m = {"jsonrpc": "2.0", "id": i}
    if error: m["error"] = error
    else: m["result"] = result
    sys.stdout.write(json.dumps(m, default=str) + "\n"); sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except Exception: continue
        i, method, p = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if i is None: continue                                  # notifications
        if method == "initialize":
            reply(i, {"protocolVersion": p.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "geo-voxel-furniture-editor", "version": "0.1"}})
        elif method == "tools/list": reply(i, {"tools": TOOLS})
        elif method == "tools/call":
            try:
                out = call(p["name"], p.get("arguments") or {})
                reply(i, {"content": [{"type": "text", "text": json.dumps(out, default=str)}], "isError": isinstance(out, dict) and "error" in out})
            except Exception as e:
                reply(i, {"content": [{"type": "text", "text": traceback.format_exc()[-800:]}], "isError": True})
        elif method == "ping": reply(i, {})
        else: reply(i, error={"code": -32601, "message": f"method {method} not found"})


if __name__ == "__main__":
    main()
