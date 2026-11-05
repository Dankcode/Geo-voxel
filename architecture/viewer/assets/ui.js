// Viewer usability layer (2026-11-05). Loaded after the 3D bundle, plan2d.js and worldmap.js:
//  0. on phones the toolbar gets its own row above the model; tall buildings' floors are framed by the bundle;
//  1. the toolbar's height is published as --tb-h, so the blueprint and messages start below it, never under it;
//  2. buildings with more than MANY floors get a compact floor picker (▾ select ▴) instead of a row of buttons;
//  3. [ and ] (or PageDown / PageUp) step down and up through the floors; ] past the top returns to the exterior;
//  4. the side panel leads with the facts and a one-line check result; long sections fold away.
// The bundle handles every <button> click inside .bar as a view or furniture toggle, so the picker's own buttons stop
// their clicks from reaching .bar and drive the bundle's hidden floor buttons instead.
const MANY = 5;
const main = document.querySelector("main");
const toolbar = document.querySelector("main .toolbar");
const segView = document.getElementById("seg-view");
const hint = document.querySelector("main .hint");
const HINT = hint ? hint.textContent : "";

// On phones the toolbar sits in its own row above the model instead of over it (the canvas sizes itself to <main>,
// so it can't simply be pushed down); on wider screens it floats over the top of the model.
const narrow = matchMedia("(max-width: 980px)");
function placeToolbar() {
  if (!toolbar) return;
  if (narrow.matches && toolbar.parentElement === main) main.before(toolbar);
  else if (!narrow.matches && toolbar.parentElement !== main) main.prepend(toolbar);
  main.style.setProperty("--tb-h", (toolbar.parentElement === main ? toolbar.offsetHeight : 0) + "px");
}
narrow.addEventListener("change", placeToolbar);
if (toolbar) new ResizeObserver(placeToolbar).observe(toolbar);
placeToolbar();

// ---------- floor picker ----------
const picker = document.createElement("div");
picker.className = "seg floor-picker"; picker.hidden = true;
picker.setAttribute("role", "group"); picker.setAttribute("aria-label", "Floor");
picker.innerHTML = `<button type="button" data-step="-1" aria-label="Floor below" title="Floor below  [">▾</button>` +
  `<select aria-label="Floor"></select>` +
  `<button type="button" data-step="1" aria-label="Floor above" title="Floor above  ]">▴</button>`;
segView.after(picker);
const sel = picker.querySelector("select");

const levels = () => [...segView.querySelectorAll("button")].filter(b => b.dataset.v !== "out");
const current = () => segView.querySelector('button[aria-pressed="true"]')?.dataset.v ?? "out";
const go = v => segView.querySelector(`button[data-v="${v}"]`)?.click();

function step(d) {
  const L = levels().map(b => b.dataset.v); if (!L.length) return;
  const i = L.indexOf(current());
  if (i < 0) go(d < 0 ? L[L.length - 1] : L[0]);            // from the exterior: ▾ opens the top floor, ▴ the ground floor
  else if (i + d >= L.length) go("out");                     // above the top floor: back outside
  else go(L[Math.max(0, i + d)]);
}

picker.addEventListener("click", e => {
  e.stopPropagation();                                       // keep the bundle's .bar handler out of it
  const b = e.target.closest("button[data-step]"); if (b) step(+b.dataset.step);
});
sel.addEventListener("change", () => go(sel.value));

function syncPicker() {
  const L = levels(), many = L.length > MANY;
  segView.classList.toggle("many", many);
  picker.hidden = !many;
  if (hint) hint.textContent = many ? HINT + " · [ ] change floor" : HINT;
  if (!many) return;
  const want = `<option value="" disabled>Floor…</option>` + L.map(b => `<option value="${b.dataset.v}">Floor ${+b.dataset.v + 1} of ${L.length}</option>`).join("");
  if (sel.dataset.sig !== String(L.length)) { sel.innerHTML = want; sel.dataset.sig = String(L.length); }
  const c = current();
  sel.value = c === "out" ? "" : c;
  picker.classList.toggle("active", c !== "out");
}
new MutationObserver(syncPicker).observe(segView, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });

document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, select, textarea, [contenteditable]")) return;
  if (!document.getElementById("wm")?.hidden) return;        // the world map has its own keys
  if (document.getElementById("plan-ov")?.classList.contains("on")) return;
  const d = { "[": -1, PageDown: -1, "]": 1, PageUp: 1 }[e.key];
  if (d) { e.preventDefault(); step(d); }
});

// ---------- side panel ----------
const info = document.getElementById("info");
const FOLD = new Map([["Why this architecture", "why"], ["Programme choices", "log"], ["Plan cost", "cost"], ["Model", "model"]]);
let pending = false;
function tidy() {
  pending = false;
  // checks: one line, the list folded (opened when something fails)
  for (const h of [...info.querySelectorAll(":scope > h2")]) {
    if (!/^Design\b/.test(h.textContent) || h.dataset.ux) continue;
    h.dataset.ux = "1";
    const p = h.nextElementSibling?.matches("p.sub") ? h.nextElementSibling : null;
    const ul = (p || h).nextElementSibling?.matches("ul.log") ? (p || h).nextElementSibling : null;
    if (!ul) continue;
    const items = [...ul.children], bad = items.filter(li => li.textContent.trim().startsWith("✗")).length;
    h.textContent = "Design checks";
    const sum = document.createElement("p");
    sum.className = "checks-sum" + (bad ? " fail" : "");
    sum.textContent = bad ? `✗ ${bad} of ${items.length} checks fail` : `✓ All ${items.length} checks pass`;
    const d = document.createElement("details"); d.className = "ux"; d.open = bad > 0;
    d.innerHTML = `<summary>Show the checks</summary>`;
    if (p) p.remove();
    h.after(sum); sum.after(d); d.append(ul);
  }
  // fold the long sections (heading + everything up to the next heading)
  for (const h of [...info.querySelectorAll(":scope > h2")]) {
    const id = FOLD.get(h.textContent.trim()); if (!id) continue;
    const d = document.createElement("details"); d.className = "ux"; d.dataset.sec = id;
    d.innerHTML = `<summary>${h.textContent}</summary>`;
    let n = h.nextElementSibling;
    while (n && n.tagName !== "H2" && n.tagName !== "SECTION" && n.tagName !== "DETAILS") { const nx = n.nextElementSibling; d.append(n); n = nx; }
    h.replaceWith(d);
  }
  // the blueprint's room table (with sizes) replaces the bundle's shorter one
  if (document.getElementById("bp-key")) {
    const h = [...info.querySelectorAll(":scope > h2")].find(x => x.textContent.trim() === "Rooms");
    if (h) { if (h.nextElementSibling?.tagName === "TABLE") h.nextElementSibling.remove(); h.remove(); }
  }
}
new MutationObserver(() => { if (!pending) { pending = true; queueMicrotask(tidy); } }).observe(info, { childList: true });
