// World map tool (2026-11-03; a "Map generator" tab since 2026-11-06): pick any spot on Earth, highlight 1–2 blocks around it, request its houses, restyle any
// generated building in the paper's styles (Merrell et al. 2010, Fig. 9) and download a building's game export.
// The bundled Baton Rouge data draws at once; anywhere else the map fetches OpenStreetMap live (Overpass, keyless).
// A request runs on the user's own computer: the page shows the run_request.py command for the area or building
// picked here (FreeCAD 1.0 and the other requirements in the README must be installed); the planned algorithm, no AI.
const BLOCK_M = 110, MAX_HOUSES = 12;
const STYLE_GROUPS = [
  ["Classic styles", [["cape_cod", "Cottage"], ["italianate", "Italianate"], ["tudor_revival", "Tudor"], ["craftsman", "Craftsman"]]],
  ["Other house styles", [["colonial_revival", "Colonial Revival"], ["acadian", "Acadian"], ["creole", "Creole cottage"], ["queen_anne", "Queen Anne"],
    ["greek_revival", "Greek Revival"], ["dutch_colonial", "Dutch Colonial"], ["saltbox", "Saltbox"], ["french_eclectic", "French Eclectic"],
    ["spanish_colonial", "Spanish Colonial"], ["mission_revival", "Mission Revival"], ["prairie", "Prairie"], ["midcentury", "Mid-century"],
    ["minimal_traditional", "Minimal Traditional"], ["modern_farmhouse", "Modern farmhouse"], ["contemporary_house", "Contemporary"], ["shotgun", "Shotgun"]]],
];
const STYLE_NAME = Object.fromEntries(STYLE_GROUPS.flatMap(g => g[1]));
const styleName = s => STYLE_NAME[s] || String(s || "").replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const styleOptions = (first) => (first ? `<option value="auto">${esc(first)}</option>` : "") +
  STYLE_GROUPS.map(([g, xs]) => `<optgroup label="${esc(g)}">` + xs.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join("") + "</optgroup>").join("");

const css = `
.hbtn{margin-left:auto;align-self:center;font:500 12.5px var(--body);color:var(--accent-ink);background:var(--accent);border:0;border-radius:6px;padding:7px 12px;cursor:pointer}
.hbtn[aria-pressed="true"]{background:var(--ink);color:var(--sheet)}
.hbtn:focus-visible,.wbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
html .app{grid-template-columns:minmax(0,1fr) 340px}
.app>main{grid-row:2;grid-column:1}.app>aside{grid-row:2;grid-column:2}
header{align-items:center}
.menu{font:500 12.5px var(--body);color:var(--ink);background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:6px 10px;cursor:pointer}
.menu span{font-size:15px;line-height:1;margin-right:4px}
.menu[aria-expanded="true"]{background:var(--ink);color:var(--sheet)}
.tabs{margin-left:auto;display:inline-flex;border:1px solid var(--rule);border-radius:6px;overflow:hidden;background:var(--sheet)}
.tabs button{font:500 12.5px var(--body);color:var(--ink);background:transparent;border:0;padding:7px 14px;cursor:pointer;min-height:32px}
.tabs button+button{border-left:1px solid var(--rule)}
.tabs button[aria-selected="true"]{background:var(--accent);color:var(--accent-ink)}
.menu:focus-visible,.tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#drawer{position:fixed;z-index:30;left:0;top:0;bottom:0;width:min(330px,88vw);display:flex;flex-direction:column;background:var(--sheet);border-right:1px solid var(--rule);box-shadow:0 10px 40px rgba(0,0,0,.18);padding-top:env(safe-area-inset-top,0px)}
#drawer .dh{display:flex;align-items:center;justify-content:space-between;padding:12px 12px 6px 18px;font:600 16px var(--display)}
#drawer nav{border:0;flex:1;overflow:auto;max-height:none;padding-bottom:max(20px,env(safe-area-inset-bottom,0px))}
#scrim{position:fixed;inset:0;z-index:29;background:rgba(0,0,0,.25)}
#rg-open{background:var(--accent)!important;color:var(--accent-ink)!important}
.rgsheet{position:absolute;right:12px;top:calc(var(--tb-h, 44px) + 20px);bottom:62px;z-index:6;width:min(360px,calc(100% - 24px));overflow:auto;background:var(--sheet);border:1px solid var(--rule);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.15);padding:4px 14px 14px}
.rgsheet[hidden]{display:none}
.rgsheet h3{font:600 15px var(--display);margin:10px 0 2px}
.rgsheet h4{font:500 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
.rgsheet .note{font-size:12px;color:var(--muted);margin:4px 0}
.rgsheet .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.rgsheet label{display:grid;gap:2px;font-size:11.5px;color:var(--muted)}
.rgsheet input,.rgsheet select{font:13px var(--body);color:var(--ink);background:var(--paper);border:1px solid var(--rule);border-radius:6px;padding:5px 6px;width:100%;min-width:0}
.rgsheet .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.rgsheet .floor{border-top:1px solid var(--rule);padding-top:6px;margin-top:8px}
.rgsheet .floor b{font-size:12.5px}
.savebar{position:absolute;left:0;right:0;bottom:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px max(8px,env(safe-area-inset-bottom,0px));background:var(--sheet);border-top:1px solid var(--rule);font-size:12.5px}
.savebar b{font:500 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-right:4px}
.savebar .msg{color:var(--muted);font:11px var(--mono)}
main .hint,#loading{bottom:58px!important}
#wm{grid-column:1/-1;grid-row:2;z-index:5;display:grid;grid-template-columns:minmax(0,1fr) 360px;background:var(--paper);min-height:0}
#wm[hidden]{display:none}
#wm .map{position:relative;background:var(--scene);min-height:0;min-width:0}
#wm canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
#wm .mtip{position:absolute;left:12px;bottom:10px;font:11px var(--mono);color:var(--muted);pointer-events:none;max-width:calc(100% - 24px)}
#wm .legend{position:absolute;left:12px;top:12px;display:flex;flex-wrap:wrap;gap:10px;font:11px var(--mono);color:var(--muted);background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:5px 9px}
#wm .legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
#wm .side{border-left:1px solid var(--rule);overflow:auto;padding:4px 14px 24px;background:var(--sheet);min-width:0}
#wm h2{font:500 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
#wm .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#wm label{font-size:12.5px}
#wm input[type=range]{flex:1;min-width:120px;accent-color:var(--accent)}
#wm input[type=search],#wm select,.toolbar select{font:12.5px var(--body);color:var(--ink);background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:5px 7px;max-width:100%}
.wbtn{font:500 12.5px var(--body);color:var(--ink);background:var(--chip);border:1px solid var(--rule);border-radius:6px;padding:5px 10px;cursor:pointer}
.wbtn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.wbtn[disabled]{opacity:.5;cursor:default}
#wm ul.hl{list-style:none;margin:0;padding:0;display:grid;gap:2px;font-size:12.5px}
#wm ul.hl li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--rule)}
#wm ul.hl li .m{grid-column:1/-1;font:11px var(--mono);color:var(--muted)}
#wm ul.hl li select{font-size:11.5px;padding:2px 4px}
#wm .note{font-size:12px;color:var(--muted);margin:6px 0}
#wm .st{font:500 10.5px var(--mono);padding:1px 7px;border-radius:99px;background:var(--chip);white-space:nowrap}
#wm .st.queued{background:var(--chip)} #wm .st.running{background:var(--ink);color:var(--sheet)} #wm .st.done{background:var(--accent);color:var(--accent-ink)}
#wm details{border-bottom:1px solid var(--rule);padding:4px 0}
#wm summary{cursor:pointer;font-weight:600;font-size:13px}
#wm .card{background:var(--chip);border-radius:8px;padding:8px 10px;margin-top:10px}
#wm .card b{font:600 14px var(--display)}
.toolbar .seg select{border:0;border-radius:0;background:transparent}
#bx-msg{position:absolute;left:12px;top:calc(var(--tb-h, 44px) + 20px);z-index:3;max-width:min(520px,calc(100% - 24px));font:11px var(--mono);color:var(--muted);background:var(--sheet);border:1px solid var(--rule);border-radius:6px;padding:4px 8px}
#bx-msg:empty{display:none}
@media (max-width:980px){html .app{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto 66vh auto}.app>.toolbar{grid-row:2;grid-column:1}.app>main{grid-row:3;grid-column:1}.app>aside{grid-row:4;grid-column:1}.tabs{margin-left:0}.rgsheet{left:12px;right:12px;width:auto;top:12px}#wm{grid-row:2/-1;grid-template-columns:minmax(0,1fr);grid-template-rows:62vh auto}#wm .side{border-left:0;border-top:1px solid var(--rule)}}
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

const app = document.querySelector(".app");
const header = document.querySelector("header");
// 2026-11-06 layout: the building list is a drawer behind ☰; "Buildings" and "Map generator" are tabs in the header
header.insertAdjacentHTML("afterbegin", `<button class="menu" id="nav-open" aria-expanded="false" aria-controls="drawer" title="Buildings list"><span aria-hidden="true">☰</span> Buildings list</button>`);
header.insertAdjacentHTML("beforeend", `<div class="tabs" role="tablist" aria-label="View">
  <button role="tab" id="tab-b" aria-selected="true" aria-controls="cv">Buildings</button>
  <button role="tab" id="tab-map" aria-selected="false" aria-controls="wm">Map generator</button></div>`);
{
  const nav = document.getElementById("list");
  const drawer = document.createElement("div");
  drawer.id = "drawer"; drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-label", "Buildings"); drawer.hidden = true;
  drawer.innerHTML = `<div class="dh"><b>Buildings</b><button class="wbtn" id="nav-close" aria-label="Close the list">✕</button></div>`;
  nav.before(drawer); drawer.append(nav);
  const scrim = document.createElement("div"); scrim.id = "scrim"; scrim.hidden = true; drawer.after(scrim);
  const btn = document.getElementById("nav-open");
  const show = on => { drawer.hidden = !on; scrim.hidden = !on; btn.setAttribute("aria-expanded", String(on));
    if (on) (nav.querySelector('button[aria-current="true"]') || nav.querySelector("button"))?.focus(); else btn.focus(); };
  btn.addEventListener("click", () => show(drawer.hidden));
  document.getElementById("nav-close").addEventListener("click", () => show(false));
  scrim.addEventListener("click", () => show(false));
  nav.addEventListener("click", e => { if (e.target.closest("button[data-key]")) setTimeout(() => show(false), 0); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !drawer.hidden) show(false); });
}
app.insertAdjacentHTML("beforeend", `
<section id="wm" hidden aria-label="World map">
  <div class="map"><canvas id="wm-cv" aria-label="Map of buildings and streets; click to centre the highlighted area"></canvas>
    <div class="legend"><span><i style="background:var(--accent)"></i>houses in the area</span><span><i style="background:var(--ink)"></i>generated</span><span><i style="background:var(--muted);opacity:.5"></i>other houses</span></div>
    <div class="mtip" id="wm-tip">drag to pan · scroll or pinch to zoom · click to centre the area</div></div>
  <div class="side" id="wm-side">
    <h2>Highlight an area</h2>
    <div class="row" id="wm-regions"></div>
    <div class="row" style="margin-top:8px"><input type="search" id="wm-find" placeholder="Address, place name, or lat, lon" aria-label="Go to an address, a place name, or a latitude and longitude" style="flex:1"><button class="wbtn" id="wm-findgo">Go</button></div>
    <div class="row" style="margin-top:10px"><label for="wm-r">Radius</label><input type="range" id="wm-r" min="1" max="2" step="0.25" value="1.5"><span id="wm-rv" style="font:12px var(--mono)"></span></div>
    <p class="note" id="wm-centre">Click the map to centre the area.</p>
    <div id="wm-sel"></div>
    <h2>Houses in the area <span id="wm-n"></span></h2>
    <div class="row"><label for="wm-style">Style for the area</label><select id="wm-style">${styleOptions("Inferred per house (auto)")}</select></div>
    <ul class="hl" id="wm-houses"></ul>
    <div class="row" style="margin-top:10px"><button class="wbtn primary" id="wm-req" disabled>Request generation</button></div>
    <div class="note" id="wm-reqmsg"></div>
    <p class="note">Up to ${MAX_HOUSES} houses per request. Generation runs on your computer with FreeCAD.</p>
    <h2>Generated areas</h2>
    <div id="wm-areas"><p class="note">Loading…</p></div>
  </div>
</section>`);

// ---------- data ----------
let M = null, AREAS = [], BY_VK = {}, GEN = new Map();        // GEN: osm id → [{area, house}]
let B = [];                                                   // {id, house, addr, pts Float32Array (m), cx, cy, minx..}
const GRID = 60, grid = new Map();
const gkey = (i, j) => i * 100003 + j;
const view = { cx: 0, cy: 0, s: 0.35 };                       // s: px per metre
let circle = null, radiusBlocks = 1.5, selected = null, inArea = [], perStyle = {};

async function loadAreas() {
  try { AREAS = await (await fetch("./areas/index.json")).json(); } catch { AREAS = []; }
  BY_VK = {}; GEN = new Map();
  for (const a of AREAS) for (const h of a.houses) {
    BY_VK[h.vk] = { area: a, house: h };
    const k = String(h.osm_id); if (!GEN.has(k)) GEN.set(k, []); GEN.get(k).push({ area: a, house: h });
  }
}
async function loadMap() {
  if (M) return;
  M = await (await fetch("./map/map.json")).json();
  B = M.b.map(([id, ri, house, addr, f]) => {
    const pts = new Float32Array(f.length); let cx = 0, cy = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < f.length; i += 2) {
      const x = f[i] / 10, y = f[i + 1] / 10; pts[i] = x; pts[i + 1] = y; cx += x; cy += y;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const n = f.length / 2; return { id, ri, house: !!house, addr, pts, cx: cx / n, cy: cy / n, x0, y0, x1, y1 };
  });
  B.forEach((b, idx) => {
    for (let i = Math.floor(b.x0 / GRID); i <= Math.floor(b.x1 / GRID); i++) for (let j = Math.floor(b.y0 / GRID); j <= Math.floor(b.y1 / GRID); j++) {
      const k = gkey(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx);
    }
  });
  M.roads = M.r.map(([hw, name, f]) => { const p = new Path2D(); for (let i = 0; i < f.length; i += 2) (i ? p.lineTo : p.moveTo).call(p, f[i] / 10, f[i + 1] / 10); return { hw, name, p }; });
  M.paths = { other: new Path2D(), house: new Path2D() };
  for (const b of B) { const p = b.house ? M.paths.house : M.paths.other; polyTo(p, b.pts); }
  document.getElementById("wm-regions").innerHTML = M.regions.map((r, i) => `<button class="wbtn" data-ri="${i}">${esc(r.name)}</button>`).join("");
  const r0 = M.regions[M.regions.length - 1]; const [x, y] = toXY(r0.center[0], r0.center[1]); view.cx = x; view.cy = y;
}
function setOrigin(lat, lon) {             // live mode: a local projection centred on the place, the bundled data dropped
  M.origin = [lat, lon]; M.kx = 111320 * Math.cos(lat * Math.PI / 180); M.ky = 111320; M.live = true;
  B = []; grid.clear(); M.roads = []; M.paths = { other: new Path2D(), house: new Path2D() }; FETCHED.length = 0; view.cx = 0; view.cy = 0;
}
function addBuilding(id, house, addr, pts) {
  let cx = 0, cy = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; cx += x; cy += y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const n = pts.length / 2, b = { id, house, addr, pts, cx: cx / n, cy: cy / n, x0, y0, x1, y1 }, idx = B.push(b) - 1;
  for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) for (let j = Math.floor(y0 / GRID); j <= Math.floor(y1 / GRID); j++) {
    const k = gkey(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx);
  }
  polyTo(house ? M.paths.house : M.paths.other, pts);
}
const FETCHED = [];                           // [x, y, r] circles already fetched live
const HOUSE_TAGS = new Set(["house", "detached", "residential", "semidetached_house", "bungalow", "terrace", "yes"]);
async function liveFetch(x, y, r) {
  if (FETCHED.some(([fx, fy, fr]) => Math.hypot(fx - x, fy - y) + r <= fr)) return;
  const [lat, lon] = toLL(x, y), R = r + 150, dlat = R / 111320, dlon = R / M.kx;
  const bb = `${(lat - dlat).toFixed(6)},${(lon - dlon).toFixed(6)},${(lat + dlat).toFixed(6)},${(lon + dlon).toFixed(6)}`;
  const q = `[out:json][timeout:25];(way["building"](${bb});way["highway"](${bb}););out tags geom;`;
  const tip = document.getElementById("wm-tip"); tip.textContent = "Loading OpenStreetMap…";
  for (const url of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!res.ok) continue;
      const J = await res.json(), have = new Set(B.map(b => b.id));
      for (const e of J.elements || []) {
        const g = e.geometry || []; if (!g.length) continue;
        const pts = new Float32Array(g.length * 2); g.forEach((p, i) => { const [px, py] = toXY(p.lat, p.lon); pts[2 * i] = px; pts[2 * i + 1] = py; });
        const t = e.tags || {};
        if (t.building && g.length >= 4 && !have.has(String(e.id))) {
          let a = 0; for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) a += pts[j] * pts[i + 1] - pts[i] * pts[j + 1];
          a = Math.abs(a) / 2;
          const house = (HOUSE_TAGS.has(t.building) && a >= 45 && a <= 450 && !t.amenity && !t.shop && !t.office && !t.name) || t.building === "house";
          addBuilding(String(e.id), house, [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), pts);
        } else if (t.highway && !/footway|path|steps|cycleway|track|service/.test(t.highway)) {
          const p = new Path2D(); for (let i = 0; i < pts.length; i += 2) (i ? p.lineTo : p.moveTo).call(p, pts[i], pts[i + 1]);
          M.roads.push({ hw: t.highway, name: t.name || "", p, f: Array.from(pts, v => v * 10) });
        }
      }
      FETCHED.push([x, y, R]); tip.textContent = `OpenStreetMap: ${B.length} buildings loaded around here · © OpenStreetMap contributors`;
      recompute(); return;
    } catch { }
  }
  tip.textContent = "OpenStreetMap could not be reached from this page (the server may be busy, or this view blocks it). Try again in a minute.";
}
function polyTo(p, pts) { p.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]); p.closePath(); }
const toXY = (lat, lon) => [(lon - M.origin[1]) * M.kx, (lat - M.origin[0]) * M.ky];
const toLL = (x, y) => [M.origin[0] + y / M.ky, M.origin[1] + x / M.kx];
function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function hit(x, y) {
  const c = grid.get(gkey(Math.floor(x / GRID), Math.floor(y / GRID))) || [];
  for (const i of c) { const b = B[i]; if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && inside(b.pts, x, y)) return b; }
  return null;
}

// ---------- drawing ----------
const cv = document.getElementById("wm-cv"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1, raf = 0;
function resize() {
  const r = cv.getBoundingClientRect(); DPR = window.devicePixelRatio || 1; W = r.width; H = r.height;
  cv.width = Math.max(1, Math.round(W * DPR)); cv.height = Math.max(1, Math.round(H * DPR)); draw();
}
new ResizeObserver(resize).observe(cv.parentElement);
const scr = (x, y) => [(x - view.cx) * view.s + W / 2, H / 2 - (y - view.cy) * view.s];
const wld = (px, py) => [(px - W / 2) / view.s + view.cx, view.cy - (py - H / 2) / view.s];
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); }); }
function paint() {
  if (!M || !W) return;
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = v("--scene"); ctx.fillRect(0, 0, W, H);
  ctx.setTransform(DPR * view.s, 0, 0, -DPR * view.s, DPR * (W / 2 - view.cx * view.s), DPR * (H / 2 + view.cy * view.s));
  const px = 1 / view.s;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const r of M.roads) {
    const major = /primary|secondary|trunk|tertiary/.test(r.hw);
    ctx.strokeStyle = v("--sheet"); ctx.lineWidth = Math.max(major ? 9 : 6, (major ? 4 : 2.5) * px); ctx.stroke(r.p);
  }
  ctx.fillStyle = v("--rule"); ctx.fill(M.paths.other);
  ctx.globalAlpha = .45; ctx.fillStyle = v("--muted"); ctx.fill(M.paths.house); ctx.globalAlpha = 1;
  // generated houses, then the houses in the highlighted area
  const gen = new Path2D(); for (const b of B) if (GEN.has(b.id)) polyTo(gen, b.pts);
  ctx.fillStyle = v("--ink"); ctx.fill(gen);
  const sel = new Path2D(); for (const b of inArea) polyTo(sel, b.pts);
  ctx.fillStyle = v("--accent"); ctx.fill(sel);
  if (selected) { const p = new Path2D(); polyTo(p, selected.pts); ctx.strokeStyle = v("--accent"); ctx.lineWidth = 3 * px; ctx.stroke(p); }
  // generated areas: dashed rings
  ctx.setLineDash([6 * px, 5 * px]); ctx.strokeStyle = v("--ink"); ctx.lineWidth = 1.2 * px;
  for (const a of AREAS) if (a.center && a.radius_m) { const [x, y] = toXY(a.center[0], a.center[1]); ctx.beginPath(); ctx.arc(x, y, a.radius_m, 0, 7); ctx.stroke(); }
  ctx.setLineDash([]);
  if (circle) {
    const R = radiusBlocks * BLOCK_M;
    ctx.beginPath(); ctx.arc(circle[0], circle[1], R, 0, 7); ctx.globalAlpha = .1; ctx.fillStyle = v("--accent"); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = v("--accent"); ctx.lineWidth = 2 * px; ctx.stroke();
    ctx.beginPath(); ctx.arc(circle[0], circle[1], 4 * px, 0, 7); ctx.fillStyle = v("--accent"); ctx.fill();
  }
  // street names at higher zoom
  if (view.s > 0.9) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.font = `11px ${v("--mono")}`; ctx.fillStyle = v("--muted"); ctx.textAlign = "center";
    const seen = new Set();
    for (const [hw, name, f] of (M.live ? M.roads.map(r => [r.hw, r.name, r.f]) : M.r)) {
      if (!name || seen.has(name) || f.length < 4) continue;
      const m = Math.floor(f.length / 4) * 2, [x, y] = scr(f[m] / 10, f[m + 1] / 10);
      if (x < 40 || y < 40 || x > W - 40 || y > H - 20) continue;
      seen.add(name); ctx.fillText(name, x, y - 6);
    }
  }
  // scale bar: one block
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const bw = BLOCK_M * view.s, x0 = W - bw - 16, y0 = H - 18;
  ctx.strokeStyle = v("--ink"); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + bw, y0); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4); ctx.moveTo(x0 + bw, y0 - 4); ctx.lineTo(x0 + bw, y0 + 4); ctx.stroke();
  ctx.font = `11px ${v("--mono")}`; ctx.fillStyle = v("--ink"); ctx.textAlign = "center"; ctx.fillText("1 block ≈ 110 m", x0 + bw / 2, y0 - 7);
}

// ---------- interaction ----------
const ptrs = new Map(); let drag = null;
cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
  drag = { x: e.offsetX, y: e.offsetY, cx: view.cx, cy: view.cy, moved: false, pinch: ptrs.size === 2 ? pinchState() : null };
});
function pinchState() { const [a, b] = [...ptrs.values()]; return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: view.s, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; }
cv.addEventListener("pointermove", e => {
  if (!drag) { hover(e); return; }
  ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (ptrs.size === 2 && drag.pinch) {
    const p = pinchState(); zoomAt(drag.pinch.m[0], drag.pinch.m[1], drag.pinch.s * p.d / drag.pinch.d / view.s); drag.moved = true; return;
  }
  const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (drag.moved) { view.cx = drag.cx - dx / view.s; view.cy = drag.cy + dy / view.s; draw(); }
});
cv.addEventListener("pointerup", e => {
  ptrs.delete(e.pointerId);
  if (drag && !drag.moved && ptrs.size === 0) click(e.offsetX, e.offsetY);
  if (ptrs.size === 0) drag = null;
});
cv.addEventListener("pointercancel", e => { ptrs.delete(e.pointerId); if (!ptrs.size) drag = null; });
cv.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
function zoomAt(px, py, f) {
  const [x, y] = wld(px, py); view.s = Math.min(8, Math.max(0.04, view.s * f));
  const [x2, y2] = wld(px, py); view.cx += x - x2; view.cy += y - y2; draw();
}
function hover(e) {
  if (!M) return;
  const [x, y] = wld(e.offsetX, e.offsetY), b = hit(x, y);
  const g = b && GEN.get(b.id);
  document.getElementById("wm-tip").textContent = b ? `${b.addr || "OSM " + b.id}${g ? " · generated: " + g.map(z => styleName(z.house.style)).join(", ") : b.house ? " · house" : ""}` :
    "drag to pan · scroll or pinch to zoom · click to centre the area";
}
function click(px, py) {
  const [x, y] = wld(px, py), b = hit(x, y);
  if (b && GEN.has(b.id)) { selected = b; renderSel(); draw(); return; }
  selected = null; renderSel(); setCircle(x, y);
}
function setCircle(x, y) {
  circle = [x, y];
  if (M.live || !B.some(b => Math.hypot(b.cx - x, b.cy - y) < radiusBlocks * BLOCK_M + 200)) liveFetch(x, y, radiusBlocks * BLOCK_M);
  const [lat, lon] = toLL(x, y);
  document.getElementById("wm-centre").textContent = `Centre ${lat.toFixed(5)}, ${lon.toFixed(5)} · click elsewhere to move it.`;
  recompute();
}
function recompute() {
  const R = radiusBlocks * BLOCK_M;
  document.getElementById("wm-rv").textContent = `${radiusBlocks} blocks · ${Math.round(R)} m`;
  inArea = circle ? B.filter(b => b.house && Math.hypot(b.cx - circle[0], b.cy - circle[1]) <= R)
    .map(b => (b.d = Math.hypot(b.cx - circle[0], b.cy - circle[1]), b)).sort((a, b) => a.d - b.d) : [];
  const n = inArea.length;
  document.getElementById("wm-n").textContent = circle ? `(${n}${n > MAX_HOUSES ? `, nearest ${MAX_HOUSES} generated` : ""})` : "";
  document.getElementById("wm-houses").innerHTML = circle ? (inArea.slice(0, MAX_HOUSES).map(b => `<li><span>${esc(b.addr || "OSM " + b.id)}</span>
      <select data-osm="${b.id}" aria-label="Style for ${esc(b.addr || b.id)}">${styleOptions("Area style")}</select>
      <span class="m">${Math.round(b.d)} m from centre${GEN.has(b.id) ? " · already generated" : ""}</span></li>`).join("") ||
    `<li><span class="note">No houses inside this circle. Widen the radius or move it.</span></li>`) : "";
  for (const s of document.querySelectorAll("#wm-houses select")) { if (perStyle[s.dataset.osm]) s.value = perStyle[s.dataset.osm]; }
  document.getElementById("wm-req").disabled = !(circle && n);
  draw();
}
document.getElementById("wm-houses").addEventListener("change", e => {
  const s = e.target.closest("select"); if (!s) return;
  if (s.value === "auto") delete perStyle[s.dataset.osm]; else perStyle[s.dataset.osm] = s.value;
});
document.getElementById("wm-r").addEventListener("input", e => { radiusBlocks = +e.target.value; recompute(); });
document.getElementById("wm-regions").addEventListener("click", e => {
  const bt = e.target.closest("button[data-ri]"); if (!bt) return;
  const r = M.regions[+bt.dataset.ri];
  if (M.live) { M = null; loadMap().then(() => { [view.cx, view.cy] = toXY(r.center[0], r.center[1]); view.s = 0.35; recompute(); }); return; }
  [view.cx, view.cy] = toXY(r.center[0], r.center[1]); view.s = 0.35; draw();
});
function goTo(lat, lon) {
  const near = M.regions.some(r => Math.hypot((r.center[0] - lat) * 111320, (r.center[1] - lon) * 111320 * Math.cos(lat * Math.PI / 180)) < 6000);
  if (!near || M.live) setOrigin(lat, lon);
  const [x, y] = toXY(lat, lon); view.cx = x; view.cy = y; view.s = Math.max(view.s, 1.2); setCircle(x, y);
}
async function find() {
  const raw = document.getElementById("wm-find").value.trim(), q = raw.toLowerCase(); if (!q || !M) return;
  const ll = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (ll) { goTo(+ll[1], +ll[2]); return; }
  const m = b => b.addr && b.addr.toLowerCase().includes(q), b = B.find(b => b.house && m(b)) || B.find(m);
  if (b) { view.cx = b.cx; view.cy = b.cy; view.s = Math.max(view.s, 1.2); setCircle(b.cx, b.cy); return; }
  const tip = document.getElementById("wm-tip"); tip.textContent = `Looking up "${raw}"…`;
  try {
    const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(raw)}`)).json();
    if (!r.length) { tip.textContent = `Nothing found for "${raw}".`; return; }
    goTo(+r[0].lat, +r[0].lon); tip.textContent = r[0].display_name;
  } catch { tip.textContent = "Place search isn't reachable from this view; type a latitude and longitude instead."; }
}
document.getElementById("wm-findgo").addEventListener("click", find);
document.getElementById("wm-find").addEventListener("keydown", e => { if (e.key === "Enter") find(); });

// ---------- requests: a command to run on this computer ----------
let CFG = { repo: "Dankcode/Geo-voxel" }, downloads = null;
const cfgReady = (async () => {
  try { CFG = { ...CFG, ...(await (await fetch("./config.json")).json()) }; } catch { }
  try { downloads = await window.claude?.use?.("downloads"); } catch { downloads = null; }
  updateExportButton();
})();
const shq = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
function command(req) {
  if (req.type === "area") {
    let c = `python architecture/pipeline/run_request.py --lat ${req.center[0]} --lon ${req.center[1]} --blocks ${req.blocks} --style ${req.style || "auto"}`;
    if (req.styles && Object.keys(req.styles).length) c += ` --styles ${shq(JSON.stringify(req.styles))}`;
    return c;
  }
  if (req.type === "regenerate") {
    let c = `python architecture/pipeline/run_request.py --regenerate ${shq(req.area)} ${shq(req.key)}`;
    if (req.storeys) c += ` --storeys ${req.storeys}`;
    if (req.rooms && Object.keys(req.rooms).length) c += ` --rooms ${shq(JSON.stringify(req.rooms))}`;
    if (req.style) c += ` --style ${req.style}`;
    if (req.seed) c += ` --seed ${req.seed}`;
    return c;
  }
  if (req.type === "highrise") {
    let c = `python architecture/pipeline/run_request.py --highrise ${shq(req.design)} --storeys ${req.storeys} --dwellings ${req.dwellings} --gfa ${req.gfa}`;
    if (req.bedrooms) c += ` --bedrooms ${req.bedrooms}`;
    if (req.bathrooms) c += ` --bathrooms ${req.bathrooms}`;
    if (req.style && req.style !== "plain") c += ` --style ${req.style}`;
    if (req.seed) c += ` --seed ${req.seed}`;
    return c;
  }
  return `python architecture/pipeline/run_request.py --restyle ${shq(req.area)} ${shq(req.key)} ${req.style}`;
}
// The run bridge (2026-11-12, app/run-bridge.js): under `npm run app` the buttons run the request on this computer and
// open the result in FreeCAD (its MCP add-on's RPC server); a viewer served anywhere else shows the command to copy.
let BRIDGE = null;
const bridgeReady = (async () => {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  try { const r = await fetch("/api/run/status", { cache: "no-store" }); if (r.ok) BRIDGE = await r.json(); } catch { }
})();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function showCommand(cmd, msgEl, lead) {
  msgEl.innerHTML = `${lead || `Runs on your computer with FreeCAD (<a href="https://github.com/${esc(CFG.repo)}#requirements" target="_blank" rel="noopener">requirements</a>).
    Open the viewer with <code>npm run app</code> to run it with one click, or run this in the repository folder (or ask your CLI agent to), then reload the viewer:`}
    <code class="cmd" style="display:block;margin:6px 0;padding:6px 8px;font:12px/1.4 var(--mono);white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.12);border-radius:4px;user-select:all">${esc(cmd)}</code>
    <button class="wbtn" type="button" data-copy>Copy command</button> <button class="wbtn" type="button" data-close>Close</button>`;
  msgEl.querySelector("[data-close]").onclick = () => { msgEl.innerHTML = ""; };
  const b = msgEl.querySelector("[data-copy]");
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(cmd); b.textContent = "Copied"; }
    catch {
      const r = document.createRange(); r.selectNodeContents(msgEl.querySelector("code.cmd"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = "Selected — copy it";
    }
  };
}
async function runHere(req, cmd, msgEl) {
  const st = await (await fetch("/api/run/status", { cache: "no-store" })).json().catch(() => BRIDGE);
  const fc = st?.freecad?.rpc;
  msgEl.innerHTML = `<b>Running on this computer</b> with FreeCAD (${esc(st?.python || "python")}).
    ${fc ? "The result opens in FreeCAD when it is done." : `FreeCAD's MCP add-on is not answering, so the model is built and listed here but not opened in FreeCAD
    (<a href="https://github.com/${esc(CFG.repo)}#freecad-add-on" target="_blank" rel="noopener">set it up</a>).`}
    <div class="note" data-state style="margin-top:6px">Starting…</div>
    <pre data-log style="max-height:160px;overflow:auto;margin:6px 0;padding:6px 8px;font:11px/1.35 var(--mono);white-space:pre-wrap;background:rgba(127,127,127,.12);border-radius:4px"></pre>
    <button class="wbtn" type="button" data-close>Hide</button>`;
  msgEl.querySelector("[data-close]").onclick = () => { msgEl.innerHTML = ""; };
  const stateEl = msgEl.querySelector("[data-state]"), logEl = msgEl.querySelector("[data-log]");
  const r = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json", "X-Run-Token": st?.token || BRIDGE.token },
    body: JSON.stringify({ request: req, openInFreecad: true }) });
  const started = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 409) { stateEl.textContent = "Another request is still running on this computer; wait for it, then press the button again."; return true; }
    showCommand(cmd, msgEl, `The viewer could not start it (${esc(started.error || r.status)}). Run it yourself in the repository folder:`);
    return true;
  }
  const t0 = Date.now();
  for (;;) {
    await sleep(1500);
    let j; try { j = await (await fetch("/api/run/job", { cache: "no-store" })).json(); } catch { continue; }
    if (j.id !== started.id) continue;
    logEl.textContent = j.log.split("\n").slice(-40).join("\n"); logEl.scrollTop = logEl.scrollHeight;
    const secs = Math.round((Date.now() - t0) / 1000);
    if (j.state === "running") { stateEl.textContent = `Planning, checking and modelling… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`; continue; }
    if (j.state === "done") {
      const R = j.result || {}, f = R.freecad;
      stateEl.innerHTML = `<b>Done</b> in ${Math.floor(secs / 60)} min ${secs % 60} s.` +
        (f ? (f.opened ? " Opened in FreeCAD." : ` Not opened in FreeCAD: ${esc(f.message)}.`) : "") +
        (R.key ? ` <button class="wbtn primary" type="button" data-show>Show it here</button>` : ` <button class="wbtn" type="button" data-show>Reload the viewer</button>`);
      msgEl.querySelector("[data-show]").onclick = () => {
        if (R.key) location.hash = R.key.replace(/_/g, "-");
        location.reload();
      };
    } else {
      stateEl.innerHTML = `<b>It stopped with an error</b> (the log above has the reason; README → Requirements lists what must be installed).`;
    }
    return true;
  }
}
async function queue(req, msgEl) {
  await cfgReady; await bridgeReady;
  const cmd = command(req);
  try { msgEl.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { }
  if (BRIDGE?.ok) return runHere(req, cmd, msgEl);
  showCommand(cmd, msgEl);
  return true;
}
document.getElementById("wm-req").addEventListener("click", async e => {
  const [lat, lon] = toLL(circle[0], circle[1]);
  const style = document.getElementById("wm-style").value;
  const houses = inArea.slice(0, MAX_HOUSES);
  const styles = Object.fromEntries(Object.entries(perStyle).filter(([k]) => houses.some(b => b.id === k)));
  await queue({ type: "area", center: [+lat.toFixed(6), +lon.toFixed(6)], blocks: radiusBlocks, radius_m: Math.round(radiusBlocks * BLOCK_M), style, styles,
    houses: houses.map(b => b.id), addresses: houses.map(b => b.addr || ""), max: MAX_HOUSES }, document.getElementById("wm-reqmsg"));
});
// ---------- generated areas, the selected building, exports ----------
function houseRow(a, h) {
  const g = h.gate === "pass" ? "✓ all checks pass" : h.gate === "fail" ? "✗ checks fail" : esc(h.gate || "");
  return `<li><span>${esc(h.address || h.street || "OSM " + h.osm_id)}${h.restyled_from ? " (restyle)" : h.regenerated_from ? " (regenerated)" : ""}</span>
    <span class="row" style="gap:4px">${h.built ? `<button class="wbtn" data-open="${h.vk}">3D</button>` : ""}${h.export_url ? `<button class="wbtn" data-export="${h.vk}">Export</button>` : ""}</span>
    <span class="m">${esc(styleName(h.style))} · ${esc(String(h.archetype || "").replace(/_/g, " "))} · ${h.storeys || "?"}F · ${g}</span></li>`;
}
function renderAreas() {
  document.getElementById("wm-areas").innerHTML = AREAS.length ? AREAS.map((a, i) => `<details ${i < 2 ? "open" : ""}><summary data-area="${esc(a.id)}">${esc(a.title || a.id)}</summary>
    <p class="note">${a.center ? `${a.blocks} blocks (${a.radius_m} m) at ${(+a.center[0]).toFixed(4)}, ${(+a.center[1]).toFixed(4)} · ` : ""}${a.houses.length} building${a.houses.length === 1 ? "" : "s"}${a.created ? " · " + esc(a.created.slice(0, 10)) : ""}</p>
    <ul class="hl">${a.houses.map(h => houseRow(a, h)).join("")}</ul></details>`).join("") : `<p class="note">None yet.</p>`;
}
function renderSel() {
  const el = document.getElementById("wm-sel");
  if (!selected) { el.innerHTML = ""; return; }
  const g = GEN.get(selected.id) || [];
  el.innerHTML = `<div class="card"><b>${esc(selected.addr || "OSM " + selected.id)}</b>
    <ul class="hl">${g.map(z => houseRow(z.area, z.house)).join("")}</ul>
    <div class="row" style="margin-top:8px"><select id="wm-rs" aria-label="New style">${styleOptions()}</select><button class="wbtn" id="wm-rsgo">Regenerate in this style</button></div>
    <p class="note" id="wm-rsmsg">Same rooms, new style.</p></div>`;
  document.getElementById("wm-rsgo").onclick = async () => {
    const z = g[0]; if (!z) return;
    await queue({ type: "restyle", area: z.area.id, key: z.house.key, label: z.house.address || z.house.key, style: document.getElementById("wm-rs").value }, document.getElementById("wm-rsmsg"));
  };
}
async function saveExport(vk, msgEl) {
  const z = BY_VK[vk]; if (!z?.house.export_url) return;
  await cfgReady;
  const say = t => { if (msgEl) { msgEl.textContent = t; if (t) setTimeout(() => { if (msgEl.textContent === t) msgEl.textContent = ""; }, 5000); } };
  try {
    const text = await (await fetch("./" + z.house.export_url)).text();
    if (!downloads) {                         // a normal web page: a plain download
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = `${vk}.building.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); return;
    }
    await downloads.save({ filename: `${vk}.building.json`, data: text }); say("");
  } catch (e) { if (e?.code !== "declined") say(e?.code === "rate_limited" ? "A save prompt is already open." : "Could not save the export."); }
}
function openIn3D(vk) {
  setOpen(false);
  const bt = document.querySelector(`#list button[data-key="${CSS.escape(vk)}"]`);
  if (bt) { bt.click(); bt.scrollIntoView({ block: "nearest" }); }
}
document.getElementById("wm-side").addEventListener("click", e => {
  const o = e.target.closest("[data-open]"), x = e.target.closest("[data-export]"), s = e.target.closest("summary[data-area]");
  if (o) openIn3D(o.dataset.open);
  if (x) saveExport(x.dataset.export, document.getElementById("wm-reqmsg"));
  if (s && M) {
    const a = AREAS.find(a => a.id === s.dataset.area);
    if (a?.center) { [view.cx, view.cy] = toXY(a.center[0], a.center[1]); draw(); }
    else if (a) { const b = B.find(b => b.id === String(a.houses[0]?.osm_id)); if (b) { view.cx = b.cx; view.cy = b.cy; draw(); } }
  }
});

// ---------- 3D view: Regenerate panel, and the save bar at the bottom ----------
// Regenerate (2026-11-06): every building on the list can be generated again with the planned algorithm, on this
// computer (FreeCAD): houses with their storeys, room counts per floor, garage and style; high-rises with their
// storeys, dwellings per floor (2, 4 or 6 on one core and lobby corridor), flat size, bedrooms, bathrooms and facade. A
// regenerated building is itself on the list and can be regenerated again.
const bar = document.querySelector("main .bar");
bar.insertAdjacentHTML("afterend", `<div class="seg" id="seg-x" role="group" aria-label="Regenerate"><button id="rg-open" aria-expanded="false" aria-controls="rg">Regenerate…</button></div>`);
const mainEl = document.querySelector("main");
mainEl.insertAdjacentHTML("beforeend", `<div id="bx-msg"></div><section id="rg" class="rgsheet" hidden aria-label="Regenerate"></section>
<div class="savebar" id="savebar" role="group" aria-label="Save and export"><b>Save / export</b>
  <button class="wbtn" id="sv-exp">Game export (.building.json)</button><button class="wbtn" id="sv-plan">Blueprint data (.json)</button>
  <button class="wbtn" id="sv-mesh">3D model mesh (.json)</button><span class="msg" id="sv-msg"></span></div>`);
const curKey = () => document.querySelector('#list button[aria-current="true"]')?.dataset.key;
let IDX = {};
const idxReady = (async () => { try { for (const e of await (await fetch("./models/index.json")).json()) IDX[e.key] = e; } catch { } })();
const HR_STYLES = [["plain", "Plain render"], ["modern", "Modern"], ["neo_chinese", "Neo-Chinese"], ["art_deco", "Art Deco"], ["public", "Public housing"]];
const ROOM_FIELDS = [["bedroom", "Bedrooms"], ["bathroom", "Bathrooms"], ["study", "Study"], ["wc", "WC"]];
function updateExportButton() {
  const vk = curKey(), z = BY_VK[vk];
  document.getElementById("sv-exp").hidden = !(z?.house.export_url);
  document.getElementById("seg-x").hidden = !vk;
  document.getElementById("savebar").hidden = !vk;
  const rg = document.getElementById("rg");
  if (!rg.hidden && rg.dataset.key !== vk) openPanel(false);
}
new MutationObserver(updateExportButton).observe(document.getElementById("list"), { subtree: true, attributes: true, attributeFilter: ["aria-current"], childList: true });

async function saveText(filename, url, msgEl) {
  await cfgReady;
  const say = t => { msgEl.textContent = t; if (t) setTimeout(() => { if (msgEl.textContent === t) msgEl.textContent = ""; }, 5000); };
  try {
    say("Preparing…");
    const text = await (await fetch(url)).text();
    if (!downloads) {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); say(""); return;
    }
    await downloads.save({ filename, data: text }); say("");
  } catch (e) { say(e?.code === "declined" ? "" : e?.code === "rate_limited" ? "A save prompt is already open." : "Could not save that file."); }
}
document.getElementById("sv-exp").addEventListener("click", () => { const z = BY_VK[curKey()]; if (z?.house.export_url) saveText(`${curKey()}.building.json`, "./" + z.house.export_url, document.getElementById("sv-msg")); });
document.getElementById("sv-plan").addEventListener("click", () => saveText(`${curKey()}.blueprint.json`, `./plans/${curKey()}.json`, document.getElementById("sv-msg")));
document.getElementById("sv-mesh").addEventListener("click", () => saveText(`${curKey()}.mesh.json`, `./models/${curKey()}.mesh.json`, document.getElementById("sv-msg")));

function openPanel(on) {
  const rg = document.getElementById("rg"), b = document.getElementById("rg-open");
  rg.hidden = !on; b.setAttribute("aria-expanded", String(on));
  if (on) fillPanel(); else rg.dataset.key = "";
}
document.getElementById("rg-open").addEventListener("click", e => { e.stopPropagation(); openPanel(document.getElementById("rg").hidden); });
document.getElementById("seg-x").addEventListener("click", e => e.stopPropagation());   // keep the bundle's .bar handler out
document.addEventListener("keydown", e => { if (e.key === "Escape" && !document.getElementById("rg").hidden) openPanel(false); });

const num = (id, v, lo, hi) => `<input type="number" id="${id}" value="${v ?? ""}" min="${lo}" max="${hi}" step="1" inputmode="numeric">`;
async function houseCounts(vk) {
  const out = { storeys: 1, floors: [], garage: 0 };
  try {
    const P = await (await fetch(`./plans/${vk}.json`)).json();
    out.storeys = P.storeys.length;
    for (const sh of P.storeys) {
      const c = {}; for (const r of sh.rooms) c[r.kind] = (c[r.kind] || 0) + 1;
      out.floors.push(c); out.garage += c.garage ? 1 : 0;
    }
  } catch { }
  return out;
}
async function fillPanel() {
  const rg = document.getElementById("rg"), vk = curKey(); rg.dataset.key = vk || "";
  await idxReady;
  const z = BY_VK[vk], e = IDX[vk];
  const close = `<div class="row" style="justify-content:space-between"><h3>Regenerate</h3><button class="wbtn" data-rgclose aria-label="Close">✕</button></div>`;
  if (z) {
    const h = z.house, C = await houseCounts(vk);
    const floorRows = n => Array.from({ length: n }, (_, s) => `<div class="floor"><b>Floor ${s + 1}${s === 0 ? " (ground)" : ""}</b><div class="grid">` +
      ROOM_FIELDS.map(([k, lab]) => `<label>${lab}${num(`rg-${s}-${k}`, (C.floors[s] || {})[k] || 0, 0, 8)}</label>`).join("") + `</div></div>`).join("");
    rg.innerHTML = close + `<p class="note">${esc(h.address || h.street || vk)} · ${esc(styleName(h.style))}. The plan is made again from the map footprint with the
      counts below; the original stays on the list.</p>
      <h4>Building</h4><div class="grid" style="grid-template-columns:1fr 1fr">
      <label>Storeys<select id="rg-storeys">${[1, 2].map(n => `<option ${n === C.storeys ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>Garage<select id="rg-garage"><option value="">As planned</option><option value="0">None</option><option value="1">1 car</option><option value="2">2 cars</option></select></label></div>
      <label style="margin-top:6px">Style<select id="rg-style">${styleOptions()}</select></label>
      <h4>Rooms on each floor</h4><div id="rg-floors">${floorRows(C.storeys)}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:8px"><label>Seed (blank: next)${num("rg-seed", "", 1, 9999)}</label></div>
      <div class="row"><button class="wbtn primary" id="rg-go">Regenerate</button><button class="wbtn" id="rg-restyle">Restyle only</button></div>
      <div class="note" id="rg-msg"></div>`;
    document.getElementById("rg-style").value = STYLE_NAME[h.style] ? h.style : "cape_cod";
    document.getElementById("rg-storeys").onchange = ev => { document.getElementById("rg-floors").innerHTML = floorRows(+ev.target.value); };
    document.getElementById("rg-go").onclick = () => {
      const n = +document.getElementById("rg-storeys").value, rooms = {};
      for (let s = 0; s < n; s++) { rooms[s] = {}; for (const [k] of ROOM_FIELDS) rooms[s][k] = Math.max(0, Math.min(8, +document.getElementById(`rg-${s}-${k}`).value || 0)); }
      const g = document.getElementById("rg-garage").value; if (g !== "") rooms.garage = +g;
      queue({ type: "regenerate", area: z.area.id, key: h.key, storeys: n !== C.storeys ? n : null, rooms, style: document.getElementById("rg-style").value,
        seed: +document.getElementById("rg-seed").value || null }, document.getElementById("rg-msg"));
    };
    document.getElementById("rg-restyle").onclick = () => {
      const st = document.getElementById("rg-style").value, msg = document.getElementById("rg-msg");
      if (st === h.style) { msg.textContent = `It is already ${styleName(st)}: choose another style, or Regenerate.`; return; }
      queue({ type: "restyle", area: z.area.id, key: h.key, label: h.address || h.street || h.key, style: st }, msg);
    };
  } else if (e?.hr) {
    const H = e.hr;
    rg.innerHTML = close + `<p class="note">${esc(e.name)}. One core. With 4 or 6 flats a floor the floor is built from flat modules: a corner
      flat each side of the core and a row of flats on the south face, every door on one corridor from the lifts; the slab's length follows
      the modules. Every room is a rectangle within the proportions of the reference plans, checked against the Chinese codes.</p>
      <h4>Building</h4><div class="grid" style="grid-template-columns:1fr 1fr">
      <label>Storeys (7–40)${num("rg-st", H.storeys, 7, 40)}</label>
      <label>Flats per floor<select id="rg-dw">${[2, 4, 6].map(n => `<option ${n === H.dwellings ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label>Flat size (4–6 a floor: sets the floor area), m²${num("rg-gfa", H.gfa, 60, 200)}</label>
      <label>Facade<select id="rg-fa">${HR_STYLES.map(([v, n]) => `<option value="${v}" ${v === H.style ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <h4>Rooms in each flat</h4><div class="grid" style="grid-template-columns:1fr 1fr">
      <label>Bedrooms<select id="rg-bd"><option value="">From the size</option>${[1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join("")}</select></label>
      <label>Bathrooms<select id="rg-ba"><option value="">From the size</option>${[1, 2, 3].map(n => `<option>${n}</option>`).join("")}</select></label>
      <label>Seed (blank: as before)${num("rg-seed", "", 1, 9999)}</label></div>
      <p class="note">Now: ${H.dwellings} flats a floor, ${H.bedrooms} bedrooms, ${H.gfa} m², ${H.storeys} storeys.</p>
      <div class="row"><button class="wbtn primary" id="rg-go">Regenerate</button></div><div class="note" id="rg-msg"></div>`;
    document.getElementById("rg-go").onclick = () => {
      const v = id => document.getElementById(id).value;
      queue({ type: "highrise", design: H.design, storeys: Math.max(7, Math.min(40, +v("rg-st") || H.storeys)), dwellings: +v("rg-dw"),
        gfa: Math.max(60, Math.min(200, +v("rg-gfa") || H.gfa)), bedrooms: +v("rg-bd") || null, bathrooms: +v("rg-ba") || null,
        style: v("rg-fa"), seed: +v("rg-seed") || null }, document.getElementById("rg-msg"));
    };
  } else {
    rg.innerHTML = close + `<p class="note">This building has no generator settings to change here.</p>`;
  }
  rg.querySelector("[data-rgclose]").onclick = () => openPanel(false);
}

// ---------- tabs: Buildings | Map generator ----------
const wm = document.getElementById("wm"), tabB = document.getElementById("tab-b"), tabM = document.getElementById("tab-map");
async function setOpen(on) {
  wm.hidden = !on;
  tabB.setAttribute("aria-selected", String(!on)); tabM.setAttribute("aria-selected", String(on));
  try { history.replaceState(null, "", on ? "#map-generator" : location.pathname + location.search); } catch { }
  if (on) { openPanel(false); await loadMap(); resize(); recompute(); }
}
tabB.addEventListener("click", () => setOpen(false));
tabM.addEventListener("click", () => setOpen(true));
for (const t of [tabB, tabM]) t.addEventListener("keydown", e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { (t === tabB ? tabM : tabB).focus(); (t === tabB ? tabM : tabB).click(); } });
window.addEventListener("hashchange", () => setOpen(location.hash === "#map-generator"));
if (location.hash === "#map-generator") setOpen(true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !wm.hidden && document.getElementById("drawer")?.hidden !== false) setOpen(false); });
loadAreas().then(async () => {
  renderAreas(); updateExportButton(); draw();
  const q = new URLSearchParams(location.search), la = parseFloat(q.get("lat")), lo = parseFloat(q.get("lon"));
  if (Number.isFinite(la) && Number.isFinite(lo)) {           // opened from the Place Builder: ?lat=&lon=&blocks=
    const bl = parseFloat(q.get("blocks")); if (bl >= 1 && bl <= 2) { radiusBlocks = bl; document.getElementById("wm-r").value = String(bl); }
    await setOpen(true); goTo(la, lo);
  }
});
