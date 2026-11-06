// World map tool (2026-11-03): pick any spot on Earth, highlight 1–2 blocks around it, request its houses, restyle any
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
.app>nav{grid-row:2;grid-column:1}.app>main{grid-row:2;grid-column:2}.app>aside{grid-row:2;grid-column:3}
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
@media (max-width:980px){.app>nav{grid-row:2;grid-column:1}.app>.toolbar{grid-row:3;grid-column:1}.app>main{grid-row:4;grid-column:1}.app>aside{grid-row:5;grid-column:1}#wm{grid-row:2/-1;grid-template-columns:minmax(0,1fr);grid-template-rows:62vh auto}#wm .side{border-left:0;border-top:1px solid var(--rule)}}
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

const app = document.querySelector(".app");
const header = document.querySelector("header");
header.insertAdjacentHTML("beforeend", `<button class="hbtn" id="wm-open" aria-pressed="false" aria-controls="wm">World map · generate an area</button>`);
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
  return `python architecture/pipeline/run_request.py --restyle ${shq(req.area)} ${shq(req.key)} ${req.style}`;
}
async function queue(req, msgEl) {
  await cfgReady;
  const cmd = command(req);
  msgEl.innerHTML = `Runs on your computer with FreeCAD (<a href="https://github.com/${esc(CFG.repo)}#requirements" target="_blank" rel="noopener">requirements</a>).
    In the repository folder, run this, or ask your CLI agent to run it, then reload the viewer:
    <code class="cmd" style="display:block;margin:6px 0;padding:6px 8px;font:12px/1.4 var(--mono);white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.12);border-radius:4px;user-select:all">${esc(cmd)}</code>
    <button class="wbtn" type="button" data-copy>Copy command</button> <button class="wbtn" type="button" data-close>Close</button>`;
  msgEl.querySelector("[data-close]").onclick = () => { msgEl.innerHTML = ""; };
  try { msgEl.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { }
  const b = msgEl.querySelector("[data-copy]");
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(cmd); b.textContent = "Copied"; }
    catch {
      const r = document.createRange(); r.selectNodeContents(msgEl.querySelector("code.cmd"));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = "Selected — copy it";
    }
  };
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
  return `<li><span>${esc(h.address || h.street || "OSM " + h.osm_id)}${h.restyled_from ? " (restyle)" : ""}</span>
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

// ---------- 3D view bar: restyle and game export for the building on screen ----------
const bar = document.querySelector("main .bar");
bar.insertAdjacentHTML("afterend", `<div class="seg" id="seg-x" role="group" aria-label="Style and export">
  <select id="bx-style" aria-label="Regenerate in style">${styleOptions()}</select><button id="bx-go">Regenerate</button><button id="bx-exp">Game export</button></div>`);
document.querySelector("main").insertAdjacentHTML("beforeend", `<div id="bx-msg"></div>`);
const curKey = () => document.querySelector('#list button[aria-current="true"]')?.dataset.key;
function updateExportButton() {
  const z = BY_VK[curKey()];
  document.getElementById("seg-x").hidden = !z;
  document.getElementById("bx-exp").hidden = !(z?.house.export_url);
  if (z) document.getElementById("bx-style").value = STYLE_NAME[z.house.style] ? z.house.style : "cape_cod";
}
new MutationObserver(updateExportButton).observe(document.getElementById("list"), { subtree: true, attributes: true, attributeFilter: ["aria-current"], childList: true });
document.getElementById("bx-exp").addEventListener("click", () => saveExport(curKey(), document.getElementById("bx-msg")));
document.getElementById("bx-go").addEventListener("click", async () => {
  const z = BY_VK[curKey()]; if (!z) return;
  const style = document.getElementById("bx-style").value, msg = document.getElementById("bx-msg");
  if (style === z.house.style) { msg.textContent = `It is already ${styleName(style)}.`; return; }
  await queue({ type: "restyle", area: z.area.id, key: z.house.key, label: z.house.address || z.house.street || z.house.key, style }, msg);
});

// ---------- open / close ----------
const openBtn = document.getElementById("wm-open"), wm = document.getElementById("wm");
async function setOpen(on) {
  wm.hidden = !on; openBtn.setAttribute("aria-pressed", String(on)); openBtn.textContent = on ? "Back to the 3D model" : "World map · generate an area";
  if (on) { await loadMap(); resize(); recompute(); }
}
openBtn.addEventListener("click", () => setOpen(wm.hidden));
document.addEventListener("keydown", e => { if (e.key === "Escape" && !wm.hidden) setOpen(false); });
loadAreas().then(async () => {
  renderAreas(); updateExportButton(); draw();
  const q = new URLSearchParams(location.search), la = parseFloat(q.get("lat")), lo = parseFloat(q.get("lon"));
  if (Number.isFinite(la) && Number.isFinite(lo)) {           // opened from the Place Builder: ?lat=&lon=&blocks=
    const bl = parseFloat(q.get("blocks")); if (bl >= 1 && bl <= 2) { radiusBlocks = bl; document.getElementById("wm-r").value = String(bl); }
    await setOpen(true); goTo(la, lo);
  }
});
