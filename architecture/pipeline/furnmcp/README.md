# Furniture editor MCP (off by default)

An MCP server an AI agent can use to fix furniture placement in one design, only when needed. Nothing in the build
pipeline starts it, and saved edits are ignored by every build unless `FURN_EDIT=1` is set.

## Run

```
python architecture/pipeline/furnmcp/server.py
```

Register it with an MCP client (stdio) only for an editing session. Optional: `FURN_EDIT_DIR` (default
`architecture/out/furniture-edits`) is where edits are saved.

## Tools

| Tool | What it does |
|---|---|
| `open_design(plan_path)` | Open `plan-<key>.json`. Read-only until `activate`. |
| `list_rooms(storey?)` | Rooms with id, kind, storey, area, bbox (mm), item count. |
| `list_items(room?, storey?)` | Items: stable id, name, anchor x/y (mm), angle, footprint. |
| `validate()` | Every item checked: inside its room, clear of other items, door approaches (915 mm) and swings, stair. |
| `activate(reason)` | Turns editing on; the reason is saved with the edits. |
| `move_item(id, x, y, ang?, force?)` | Move (and turn) an item. Refused with the broken rule unless `force`. |
| `rotate_item(id, deg, force?)` | Turn about its centre (90/180/270). |
| `add_item(room, name, x, y, ang?, force?)` | Add a library item (`library()` lists names and sizes). |
| `remove_item(id)` / `undo()` | Remove an item / take back the last edit. |
| `save()` | Write `<FURN_EDIT_DIR>/<key>.json` (a replayable list of operations). |

## Using the edits in a build

```
FURN_EDIT=1 python make_designs.py <plan-dir> <out-dir> <key>
```

`layout.furnish` then replays the saved operations over the generator's layout (`furn_edit.apply`). Competition and
test builds never set `FURN_EDIT`, so they always show the generator's own layout.
