"""SVG drawings: typical floor (both dwellings + core), ground floor, roof, and single reference plans."""
from highrise.plan import NAMES, net_area
from highrise.walls import floor_walls, diagonal_walls, THICK

FILL = {"LR": "#f6e3c8", "DR": "#f8ecd4", "KT": "#f3d3cf", "KW": "#f3d3cf", "BRM": "#d5e1f2",
        "BR": "#e0eaf6", "ST": "#e6def2", "BAM": "#d3ecea", "BA": "#ddf1ef", "EN": "#e3efd8",
        "HL": "#edf4e6", "CL": "#eadfd2", "SR": "#e8e8e8", "NA": "#efdcea", "BL": "#dcefd6",
        "BLN": "#dcefd6", "CORE": "#e4e4e4"}
FONT = "Helvetica, Arial, sans-serif"
CORE_LABEL = {"corridor": "Corridor", "stair": "Stair", "lobby": "Lift lobby", "fire lift": "Fire lift", "lift": "Lift", "shaft": "Shaft"}


class Sheet:
    def __init__(self, rects, s=0.05, pad=(2500, 3500, 2500, 2500), extra_h=0):
        x0 = min(q[0] for q in rects) - pad[0]; y0 = min(q[1] for q in rects) - pad[1]
        x1 = max(q[2] for q in rects) + pad[2]; y1 = max(q[3] for q in rects) + pad[3] + extra_h
        self.x0, self.y0, self.s = x0, y0, s
        self.W, self.H = (x1 - x0) * s, (y1 - y0) * s
        self.bottom = max(q[3] for q in rects)
        self.out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.W:.0f}" height="{self.H:.0f}" '
                    f'viewBox="0 0 {self.W:.0f} {self.H:.0f}" font-family="{FONT}">',
                    '<rect width="100%" height="100%" fill="#fbfaf7"/>']

    def X(self, x):
        return (x - self.x0) * self.s

    def Y(self, y):
        return (y - self.y0) * self.s

    def rect(self, q, fill, stroke="none", sw=0, extra=""):
        self.out.append(f'<rect x="{self.X(q[0]):.1f}" y="{self.Y(q[1]):.1f}" width="{(q[2]-q[0])*self.s:.1f}" '
                        f'height="{(q[3]-q[1])*self.s:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>')

    def poly(self, pts, fill, stroke="none", sw=0):
        d = " ".join(f"{self.X(x):.1f},{self.Y(y):.1f}" for x, y in pts)
        self.out.append(f'<polygon points="{d}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def text(self, x, y, t, size=11, anchor="middle", fill="#222", weight="normal"):
        self.out.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" text-anchor="{anchor}" fill="{fill}" font-weight="{weight}">{t}</text>')

    def line(self, a, b, col="#777", sw=1, extra=""):
        self.out.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="{col}" stroke-width="{sw}" {extra}/>')

    def frame(self, title, lines):
        nx, ny = self.W - 60, 50
        self.out.append(f'<path d="M{nx},{ny-25} L{nx-9},{ny+8} L{nx},{ny} L{nx+9},{ny+8} Z" fill="#333"/>')
        self.text(nx, ny + 24, "N", 12)
        self.line((40, self.H - 30), (40 + 5000 * self.s, self.H - 30), "#333", 3)
        self.text(40, self.H - 38, "0", 10, "start")
        self.text(40 + 5000 * self.s, self.H - 38, "5 m", 10, "end")
        self.text(40, 34, title, 18, "start", weight="bold")
        ly = self.Y(self.bottom) + 40
        for i, l in enumerate(lines):
            self.text(40, ly + i * 17, l, 12, "start", "#333")

    def svg(self):
        return "\n".join(self.out + ["</svg>"])


def _rooms(sh, rooms, core_info=None):
    for rid, rm in rooms.items():
        for q in rm["rects"]:
            sh.rect(q, FILL.get(rm["type"], "#eee"))
    for rid, rm in rooms.items():                     # diagonal corner cuts: the triangle takes the receiving room's fill
        for t in rm.get("add", ()):
            sh.poly(t, FILL.get(rm["type"], "#eee"), FILL.get(rm["type"], "#eee"), 0.5)
    for rid, rm in rooms.items():                     # balcony edges: railings
        if rm["type"] in ("BL", "BLN"):
            for q in rm["rects"]:
                sh.rect(q, "none", "#7a8b70", 2)
    for o, c, lo, hi, kind, _ in floor_walls(rooms):  # walls only where two spaces meet
        w = max(3.0, THICK[kind] * sh.s * (1.25 if kind != "interior" else 1.0))
        col = "#2b2b2b" if kind != "interior" else "#555"
        a, b = ((sh.X(c), sh.Y(lo)), (sh.X(c), sh.Y(hi))) if o == "v" else ((sh.X(lo), sh.Y(c)), (sh.X(hi), sh.Y(c)))
        sh.line(a, b, col, w, 'stroke-linecap="square"')
    for x0, y0, x1, y1, kind in diagonal_walls(rooms):
        sh.line((sh.X(x0), sh.Y(y0)), (sh.X(x1), sh.Y(y1)), "#555", max(3.0, THICK[kind] * sh.s), 'stroke-linecap="square"')
    for rid, rm in rooms.items():
        role = rm.get("role")
        if not role:
            continue
        q = rm["rects"][0]
        if role == "stair":
            n = int((q[2] - q[0]) / 260)
            for i in range(2, n - 2):
                xx = sh.X(q[0] + i * 260 + 1200 - 260)
                if xx < sh.X(q[2] - 1300):
                    sh.line((xx, sh.Y(q[1]) + 4), (xx, sh.Y(q[3]) - 4), "#999")
            sh.line((sh.X(q[0] + 1200), sh.Y((q[1] + q[3]) / 2)), (sh.X(q[2] - 1200), sh.Y((q[1] + q[3]) / 2)), "#555", 2)
        if "lift" in role:
            sh.line((sh.X(q[0] + 200), sh.Y(q[1] + 200)), (sh.X(q[2] - 200), sh.Y(q[3] - 200)), "#888", 1.5)
            sh.line((sh.X(q[2] - 200), sh.Y(q[1] + 200)), (sh.X(q[0] + 200), sh.Y(q[3] - 200)), "#888", 1.5)
        lab = CORE_LABEL[role]
        if role == "stair" and core_info:
            lab = "Scissor stair (2 exits)" if core_info["stair_kind"] == "scissor" else f"{core_info['stair_type'].capitalize()} stair"
        if role == "lobby" and core_info:
            lab = ("Shared fire lobby " if core_info["lobby_m2"] >= 12 else "Lift lobby ") + f'{core_info["lobby_m2"]} m²'
        cx, cy = sh.X((q[0] + q[2]) / 2), sh.Y((q[1] + q[3]) / 2)
        sh.text(cx, cy + (14 if "lift" in role else 4), lab, 10 if role != "shaft" else 8, fill="#333")


def _windows(sh, windows):
    for w in windows:
        if w["orient"] == "h":
            yy = sh.Y(w["y"])
            sh.out.append(f'<rect x="{sh.X(w["from"]):.1f}" y="{yy-3:.1f}" width="{(w["to"]-w["from"])*sh.s:.1f}" height="6" fill="#fff" stroke="#4a90c8" stroke-width="1"/>')
            sh.line((sh.X(w["from"]), yy), (sh.X(w["to"]), yy), "#4a90c8")
        else:
            xx = sh.X(w["x"])
            sh.out.append(f'<rect x="{xx-3:.1f}" y="{sh.Y(w["from"]):.1f}" width="6" height="{(w["to"]-w["from"])*sh.s:.1f}" fill="#fff" stroke="#4a90c8" stroke-width="1"/>')
            sh.line((xx, sh.Y(w["from"])), (xx, sh.Y(w["to"])), "#4a90c8")


def _doors(sh, doors):
    for d in doors:
        a, b = d["from"], d["to"]
        col = "#c0392b" if d.get("fire") else "#777"
        if d["orient"] == "v":
            xx = sh.X(d["at"])
            sh.out.append(f'<rect x="{xx-4:.1f}" y="{sh.Y(a):.1f}" width="8" height="{(b-a)*sh.s:.1f}" fill="#fbfaf7"/>')
            if d["kind"] == "door":
                r = (b - a) * sh.s * d.get("swing", 1)
                sw = 1 if r > 0 else 0
                sh.out.append(f'<path d="M{xx:.1f},{sh.Y(a):.1f} L{xx + r:.1f},{sh.Y(a):.1f} A{abs(r):.1f},{abs(r):.1f} 0 0,{sw} {xx:.1f},{sh.Y(b):.1f}" fill="none" stroke="{col}" stroke-width="1"/>')
            elif d["kind"] == "slide":
                sh.line((xx - 2, sh.Y(a)), (xx - 2, sh.Y((a + b) / 2 + 100)), "#777", 2)
                sh.line((xx + 2, sh.Y((a + b) / 2 - 100)), (xx + 2, sh.Y(b)), "#777", 2)
        else:
            yy = sh.Y(d["at"])
            sh.out.append(f'<rect x="{sh.X(a):.1f}" y="{yy-4:.1f}" width="{(b-a)*sh.s:.1f}" height="8" fill="#fbfaf7"/>')
            if d["kind"] == "door":
                r = (b - a) * sh.s * d.get("swing", 1)
                sw = 0 if r > 0 else 1
                sh.out.append(f'<path d="M{sh.X(a):.1f},{yy:.1f} L{sh.X(a):.1f},{yy + r:.1f} A{abs(r):.1f},{abs(r):.1f} 0 0,{sw} {sh.X(b):.1f},{yy:.1f}" fill="none" stroke="{col}" stroke-width="1"/>')
            elif d["kind"] == "slide":
                sh.line((sh.X(a), yy - 2), (sh.X((a + b) / 2 + 100), yy - 2), "#777", 2)
                sh.line((sh.X((a + b) / 2 - 100), yy + 2), (sh.X(b), yy + 2), "#777", 2)


def _ac(sh, ac):
    for a in ac:
        q = a["rect"]
        sh.rect(q, "#eeeeee", "#8a8a8a", 1.2)
        sh.line((sh.X(q[0]), sh.Y(q[1])), (sh.X(q[2]), sh.Y(q[3])), "#aaa")
        sh.text(sh.X((q[0] + q[2]) / 2), sh.Y((q[1] + q[3]) / 2) + 3, "AC", 7, fill="#666")


def _labels(sh, rooms, labels, refuge=()):
    for rid, rm in rooms.items():
        if rm["type"] == "CORE":
            continue
        big = max(rm["rects"], key=lambda q: (q[2] - q[0]) * (q[3] - q[1]))
        cx, cy = sh.X((big[0] + big[2]) / 2), sh.Y((big[1] + big[3]) / 2)
        name = NAMES.get(rm["type"], rm["type"])
        fs = 11 if (big[2] - big[0]) > 2200 else 8
        if (big[2] - big[0]) < 1700 and " " in name:
            a, b = name.split(" ", 1)
            sh.text(cx, cy - 5, a, fs)
            sh.text(cx, cy + 5, b, fs)
            cy += 6
        else:
            sh.text(cx, cy, name, fs)
        if labels and labels.get(rid):
            sh.text(cx, cy + 13, labels[rid], 9, fill="#666")
        if rid in refuge:
            sh.text(cx, cy + 25, "refuge room", 8, fill="#c0392b")


def floor_svg(plan, core, fp, title, lines):
    rects = [q for rm in fp["rooms"].values() for q in rm["rects"]] + [a["rect"] for a in fp["ac"]]
    sh = Sheet(rects, extra_h=600 * (len(lines) + 2))
    _rooms(sh, fp["rooms"], core)
    _ac(sh, fp["ac"])
    _windows(sh, fp["windows"])
    _doors(sh, fp["doors"])
    labels, refuge = {}, set()
    groups = {}
    for key, rm in fp["rooms"].items():
        pre, rid = key.split(".", 1)
        if pre != "core":
            groups.setdefault(pre, {})[rid] = rm
    if set(groups) <= {"E", "W"}:                     # two mirrored dwellings: the planned one's areas on both
        for rid in plan["rooms"]:
            if plan["rooms"][rid]["type"] == "BL":
                continue
            a = f"{net_area(plan, rid):.1f} m²"
            labels["E." + rid] = labels["W." + rid] = a
        rr = plan.get("refuge_room")
        refuge = {"E." + rr, "W." + rr} if rr else set()
    else:                                             # flats of their own (floorplan.py): each flat's areas
        for pre, rms in groups.items():
            pseudo = {"rooms": rms}
            for rid, rm in rms.items():
                if rm["type"] != "BL":
                    labels[f"{pre}.{rid}"] = f"{net_area(pseudo, rid):.1f} m²"
        refuge = set(fp.get("refuge_rooms", []))
    _labels(sh, fp["rooms"], labels, refuge)
    sh.frame(title, lines)
    return sh.svg()


def ground_svg(b, title, lines):
    core, g = b["core"], b["ground"]
    ext = g["pilotis_extent"]
    rects = [ext, g["hall"], g["ramp"]] + [q for rm in core["rooms"].values() for q in rm["rects"]]
    sh = Sheet(rects, extra_h=600 * (len(lines) + 2))
    sh.rect(ext, "#f1efe8", "#9a958a", 1.5, 'stroke-dasharray="8 5"')
    sh.text(sh.X(ext[0] + 1500), sh.Y(ext[1] + 1500), "Open pilotis (communal space under the building)", 11, "start", "#6b665c")
    sh.rect(g["hall"], "#efe9dc", "#3b3b3b", 4)
    for q in g.get("hall_extra", []):
        sh.rect(q, "#efe9dc", "#3b3b3b", 4)
    sh.rect(g["mail"], "#dcd5c6", "#777", 1)
    sh.text(sh.X((g["mail"][0] + g["mail"][2]) / 2), sh.Y((g["mail"][1] + g["mail"][3]) / 2) + 3, "Mailboxes", 8)
    sh.text(sh.X(g["hall"][0] + 1500), sh.Y(g["hall"][3] - 800), "Entrance hall", 11, "start")
    sh.rect(g["ramp"], "#e8e3d6", "#777", 1)
    sh.text(sh.X((g["ramp"][0] + g["ramp"][2]) / 2), sh.Y((g["ramp"][1] + g["ramp"][3]) / 2) + 3, "Ramp 1:12", 8)
    _rooms(sh, core["rooms"], core)
    for c in g["columns"]:
        sh.rect([c[0] - 200, c[1] - 200, c[0] + 200, c[1] + 200], "#6f6a60")
    _doors(sh, [dict(g["entrance"], swing=-1), dict(g["stair_exit"], swing=-1)] + [{"orient": "h", "at": sy, "from": sx - 500, "to": sx + 500, "kind": "door", "fire": "B", "swing": -1} for sx, sy in core["stair_doors"]])
    sh.frame(title, lines)
    return sh.svg()


def roof_svg(b, title, lines):
    fp, r = b["floor_plate"], b["roof"]
    body = [q for rm in fp["rooms"].values() if rm["type"] not in ("BL", "AC") for q in rm["rects"]]
    sh = Sheet(body, extra_h=600 * (len(lines) + 2))
    for q in body:
        sh.rect(q, "#d9d6cf")
    for q in body:
        sh.rect(q, "none", "#d9d6cf", 6)
    x0 = min(q[0] for q in body); x1 = max(q[2] for q in body); y0 = min(q[1] for q in body); y1 = max(q[3] for q in body)
    sh.rect([x0, y0, x1, y1], "none", "#3b3b3b", 4)
    sh.rect(r["stair_head"], "#bdb7aa", "#3b3b3b", 5)
    sh.text(sh.X((r["stair_head"][0] + r["stair_head"][2]) / 2), sh.Y((r["stair_head"][1] + r["stair_head"][3]) / 2), "Stair head room", 10)
    sh.rect(r["machine_room"], "#c9c3b6", "#3b3b3b", 5)
    sh.text(sh.X((r["machine_room"][0] + r["machine_room"][2]) / 2), sh.Y((r["machine_room"][1] + r["machine_room"][3]) / 2), "Lift machine room", 10)
    sh.text(sh.X(x0 + 1500), sh.Y(y0 + 1500), f"Roof, parapet {r['parapet_h']:.2f} m", 11, "start", "#555")
    sh.frame(title, lines)
    return sh.svg()


def unit_svg(plan, title, lines=()):
    labels = {rid: f"{net_area(plan, rid):.1f} m²" for rid, rm in plan["rooms"].items()
              if rm["type"] not in ("BL", "BLN", "CORE")}
    rects = [q for rm in plan["rooms"].values() for q in rm["rects"]]
    sh = Sheet(rects, extra_h=600 * (len(lines) + 2))
    _rooms(sh, plan["rooms"])
    _labels(sh, plan["rooms"], labels)
    sh.frame(title, lines)
    return sh.svg()
