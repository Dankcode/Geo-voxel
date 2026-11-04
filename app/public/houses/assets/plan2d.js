// Blueprint view: draws each design's floor plans as SVG from plans/<key>.json (geometry only, in metres).
// The drawing carries no text; room names, areas, sizes and notes are page text (the key in the side panel and the
// hover line under the plans).
const COL = {
  living: '#f1e2c6', dining: '#f1e2c6', kitchen: '#efd9b4', family: '#f1e2c6', foyer: '#ece4d4',
  bedroom: '#d9e4f0', chamber: '#d9e4f0',
  bathroom: '#f0d9dc', wc: '#f0d9dc', wc_block: '#f0d9dc',
  hall: '#ebe8e0', corridor: '#ebe8e0', stair: '#dcd8cd', lobby: '#ebe8e0', landing: '#ebe8e0',
  study: '#dbe8d6', office: '#dbe8d6', open_office: '#e3eddf', meeting: '#dbe8d6',
  sales: '#eee3cf', storage: '#e2dccf', stockroom: '#e2dccf',
  garage: '#dedede', utility: '#e4e1dc', porch: '#ffffff', unit: '#eeeeee',
};
const GROUPS = [['Living, dining, kitchen', ['living', 'dining', 'kitchen', 'family', 'foyer']], ['Bedrooms', ['bedroom', 'chamber']],
  ['Baths and WCs', ['bathroom', 'wc', 'wc_block']], ['Halls and stairs', ['hall', 'corridor', 'stair', 'lobby', 'landing']],
  ['Study and offices', ['study', 'office', 'open_office', 'meeting']], ['Shop', ['sales', 'storage', 'stockroom']],
  ['Garage, laundry, porch', ['garage', 'utility', 'porch']]];
const NAME = { wc: 'WC', open_office: 'Open office', wc_block: 'WC block', utility: 'Laundry / utility' };
const kname = k => NAME[k] || k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const css = document.createElement('style');
css.textContent = `
.bar2 { position: absolute; right: 12px; top: 12px; z-index: 3 }
#plan-ov { position: absolute; inset: 0; z-index: 2; overflow: auto; background: var(--scene); padding: 56px 16px 40px; display: none }
#plan-ov.on { display: block }
#plan-ov .sheets { display: flex; gap: 16px; align-items: flex-start; justify-content: center; flex-wrap: wrap }
#plan-ov figure { margin: 0; background: #fff; border: 1px solid var(--rule); border-radius: 6px; padding: 10px; flex: 1 1 320px; max-width: 640px }
#plan-ov figcaption { font: 500 10.5px var(--mono); letter-spacing: .1em; text-transform: uppercase; color: #687078; margin: 0 0 6px }
#plan-ov svg { width: 100%; height: auto; max-height: calc(100vh - 230px); display: block }
#plan-ov .street { font: 11px var(--mono); color: #687078; text-align: center; margin-top: 4px }
#plan-hover { position: absolute; left: 16px; top: 20px; right: 200px; text-align: left; font: 12.5px var(--body); color: var(--ink); min-height: 1.4em }
svg .room { stroke: none; cursor: default; transition: fill .12s }
svg .room.hl, svg .room:hover { fill: #f6c866 !important }
svg .furn { pointer-events: none }
#bp-cmp tr[data-key] { cursor: pointer } #bp-cmp tr.me td { background: var(--chip); font-weight: 600 } #bp-cmp td.ok { color: #2e7d4f } #bp-cmp td.no { color: #a33b2a }
#bp-key td.sw { width: 14px; padding-right: 0 } #bp-key td.sw i { display: block; width: 12px; height: 12px; border-radius: 2px; border: 1px solid rgba(0,0,0,.15) }
#bp-key tr.hl td { background: var(--chip) }
#bp-key tr[data-room] { cursor: default }
`;
document.head.appendChild(css);

const main = document.querySelector('main');
const bar2 = document.createElement('div'); bar2.className = 'bar2';
bar2.innerHTML = '<div class="seg" role="group" aria-label="View"><button data-m="3d" aria-pressed="true">3D model</button><button data-m="plan" aria-pressed="false">Blueprint</button></div>';
main.appendChild(bar2);
const ov = document.createElement('div'); ov.id = 'plan-ov'; main.appendChild(ov);
let mode = '3d', key = null, data = null;
bar2.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  mode = b.dataset.m;
  for (const x of bar2.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.m === mode));
  ov.classList.toggle('on', mode === 'plan');
  document.querySelector('.bar').style.visibility = mode === 'plan' ? 'hidden' : '';
});

function svgFor(S, B) {
  const [x0, y0, x1, y1] = B, w = x1 - x0, h = y1 - y0;
  const X = x => (x - x0).toFixed(3), Y = y => (y1 - y).toFixed(3);
  const path = rings => rings.map(r => 'M' + r.map(p => `${X(p[0])},${Y(p[1])}`).join('L') + 'Z').join('');
  const line = (s, st) => `<line x1="${X(s[0])}" y1="${Y(s[1])}" x2="${X(s[2])}" y2="${Y(s[3])}" ${st}/>`;
  const rect = (r, st) => `<rect x="${X(Math.min(r[0], r[2]))}" y="${Y(Math.max(r[1], r[3]))}" width="${Math.abs(r[2] - r[0]).toFixed(3)}" height="${Math.abs(r[3] - r[1]).toFixed(3)}" ${st}/>`;
  let g = `<defs><pattern id="hatch" width="0.4" height="0.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="0.4" stroke="#b9b4a8" stroke-width="0.05"/></pattern>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#b23a2a"/></marker></defs>`;
  for (const r of S.rooms) g += `<path class="room" data-room="${r.id}" d="${path(r.rings)}" fill="${r.open_air ? 'url(#hatch)' : (COL[r.kind] || '#eeeeee')}" fill-rule="evenodd"/>`;
  for (const f of (S.furniture || [])) {          // furniture outlines; the car carries a triangle at its front
    const car = f.name === 'car';
    g += rect([f.b[0], f.b[1], f.b[2], f.b[3]], `class="furn" data-room="${f.room}" fill="${car ? '#d3dfea' : '#fbf8f1'}" stroke="#5b5446" stroke-width="${car ? 0.035 : 0.025}" rx="0.06"`);
    if (car && f.front && f.rear) {
      const dx = f.front[0] - f.rear[0], dy = f.front[1] - f.rear[1], n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n, px = -uy, py = ux;
      const tip = [f.front[0] - ux * 0.25, f.front[1] - uy * 0.25], b0 = [tip[0] - ux * 0.7 + px * 0.4, tip[1] - uy * 0.7 + py * 0.4], b1 = [tip[0] - ux * 0.7 - px * 0.4, tip[1] - uy * 0.7 - py * 0.4];
      g += `<path d="M${X(tip[0])},${Y(tip[1])}L${X(b0[0])},${Y(b0[1])}L${X(b1[0])},${Y(b1[1])}Z" fill="#3d5a80"/>`;
    }
  }
  g += `<path d="${path(S.int)}" fill="#5a5a5a" fill-rule="evenodd"/><path d="${path(S.ext)}" fill="#1b1b1b" fill-rule="evenodd"/>`;
  for (const s of S.windows) g += line(s, 'stroke="#ffffff" stroke-width="0.22"') + line(s, 'stroke="#5c9fbd" stroke-width="0.08"');
  for (const s of S.overhead) g += line(s, 'stroke="#1b1b1b" stroke-width="0.05" stroke-dasharray="0.25 0.15"');
  for (const s of S.pockets) g += line(s, 'stroke="#1b1b1b" stroke-width="0.06" stroke-dasharray="0.15 0.1"');
  for (const d of S.doors) {
    g += `<polyline points="${d.arc.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="none" stroke="#1b1b1b" stroke-width="0.02"/>`;
    g += `<line x1="${X(d.leaf[0][0])}" y1="${Y(d.leaf[0][1])}" x2="${X(d.leaf[1][0])}" y2="${Y(d.leaf[1][1])}" stroke="#1b1b1b" stroke-width="0.06"/>`;
  }
  for (const r of S.steps) g += rect(r, 'fill="none" stroke="#1b1b1b" stroke-width="0.02"');
  for (const r of S.landings) g += rect(r, 'fill="none" stroke="#1b1b1b" stroke-width="0.03"');
  for (const r of S.holes) g += rect(r, 'fill="none" stroke="#1b1b1b" stroke-width="0.03" stroke-dasharray="0.3 0.15"') + line([r[0], r[1], r[2], r[3]], 'stroke="#1b1b1b" stroke-width="0.02"');
  if (S.up) g += `<line x1="${X(S.up[0][0])}" y1="${Y(S.up[0][1])}" x2="${X(S.up[1][0])}" y2="${Y(S.up[1][1])}" stroke="#b23a2a" stroke-width="0.06" marker-end="url(#arr)"/>`;
  return `<svg viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}" role="img" aria-label="Floor plan">${g}</svg>`;
}

function roomById(id) { for (const S of data.storeys) for (const r of S.rooms) if (r.id === id) return r; return null; }
function hl(id, on) {
  for (const el of document.querySelectorAll(`[data-room="${id}"]`)) el.classList.toggle('hl', on);
  const r = on ? roomById(id) : null, hv = document.getElementById('plan-hover');
  if (hv) hv.textContent = r ? `${kname(r.kind)} · ${r.area.toFixed(1)} m² · ${r.w.toFixed(1)} × ${r.d.toFixed(1)} m` : 'Point at a room to see its name and size.';
}
document.addEventListener('mouseover', e => { const t = e.target.closest('[data-room]'); if (t) hl(+t.dataset.room, true); });
document.addEventListener('mouseout', e => { const t = e.target.closest('[data-room]'); if (t) hl(+t.dataset.room, false); });

function renderOverlay() {
  const S = data.storeys;
  ov.innerHTML = `<div class="sheets">${S.map((s, i) => `<figure><figcaption>${S.length > 1 ? `Level ${i + 1}` : 'Plan'}</figcaption>${svgFor(s, data.bounds)}<div class="street">street side ↓</div></figure>`).join('')}</div><div id="plan-hover">Point at a room to see its name and size.</div>`;
}

function renderKey() {
  const info = document.getElementById('info');
  if (!info || !data || document.getElementById('bp-key')) return;
  const multi = data.storeys.length > 1;
  const rows = data.storeys.flatMap((S, i) => S.rooms.filter(r => r.kind !== 'stair' || true).sort((a, b) => b.area - a.area)
    .map(r => `<tr data-room="${r.id}"><td class="sw"><i style="background:${r.open_air ? '#fff' : (COL[r.kind] || '#eee')}"></i></td><td>${esc(kname(r.kind))}</td><td>${multi ? `L${i + 1}` : ''}</td><td class="num">${r.area.toFixed(1)} m²</td><td class="num">${r.w.toFixed(1)} × ${r.d.toFixed(1)}</td></tr>`)).join('');
  const used = new Set(data.storeys.flatMap(S => S.rooms.map(r => r.kind)));
  const legend = GROUPS.filter(([, ks]) => ks.some(k => used.has(k))).map(([n, ks]) => `<span class="chip" style="background:${COL[ks.find(k => used.has(k))]};color:#22262a">${esc(n)}</span>`).join('');
  const st = (data.stairs || []).map(s => `stair L${s.from}→L${s.from + 1}: ${s.form}, ${s.N} risers of ${s.R} mm, treads ${s.T} mm, ${s.W} mm wide`).join('; ');
  const sec = document.createElement('section'); sec.id = 'bp-key';
  sec.innerHTML = `<h2>Blueprint key</h2>
    <p class="sub">Open <b>Blueprint</b> at the top right of the model to see the plans, drawn in the page from the generated geometry. Overall ${data.overall[0].toFixed(2)} × ${data.overall[1].toFixed(2)} m; the street is at the bottom of each sheet. Dark walls are exterior, grey are interior; blue lines are windows; arcs are door swings.</p>
    <div class="chips">${legend}</div>
    <table style="margin-top:8px"><tr><th></th><th>Room</th><th></th><th style="text-align:right">Area</th><th style="text-align:right">W × D (m)</th></tr>${rows}</table>
    <p class="sub" style="margin-top:6px">Roof ${esc((data.roofs || []).join('; '))} · ${esc(data.door_note || '')}${st ? ' · ' + esc(st) : ''}. Furniture is drawn as outlines; the triangle marks the car's front.</p>`;
  const C = data.contest;
  if (C) {
    const cmp = document.createElement('section'); cmp.id = 'bp-cmp';
    const per = Object.entries(C.per || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num ${v >= C.pass_at ? 'ok' : 'no'}">${(+v).toFixed(1)}</td></tr>`).join('');
    cmp.innerHTML = `<h2>Competition · ${esc(C.house)}</h2>
      <p class="sub">Design score <b>${(+C.score).toFixed(2)}</b> of 10 · rank ${C.rank} of ${C.board.length} · ${C.passed ? 'passes' : 'does not pass'} (pass at ${C.pass_at}, gate ${C.gate ? 'clean' : 'failed'}).</p>
      <table><tr><th>Rank</th><th>Design</th><th style="text-align:right">Score</th><th style="text-align:right">Result</th></tr>${C.board.map(b => `<tr ${b.vkey ? `data-key="${b.vkey}"` : ''} class="${b.vkey === key ? 'me' : ''}${b.vkey ? '' : ' hidden-design'}"><td>#${b.rank}</td><td>seed ${b.seed}</td><td class="num">${(+b.score).toFixed(2)}</td><td class="num ${b.passed ? 'ok' : 'no'}">${b.passed ? 'pass' : (b.gate ? 'below 8' : 'gate failed')}</td></tr>`).join('')}</table>
      <h2>This design, by algorithm</h2><table>${per}</table>`;
    cmp.addEventListener('click', e => { const tr = e.target.closest('tr[data-key]'); if (tr) document.querySelector(`nav button[data-key="${tr.dataset.key}"]`)?.click(); });
    const info = document.getElementById('info'), why = [...info.querySelectorAll('h2')].find(h => h.textContent === 'Why this architecture');
    info.insertBefore(cmp, document.getElementById('bp-key') || why);
  }
  const why = [...info.querySelectorAll('h2')].find(h => h.textContent === 'Why this architecture') || info.querySelector('h2');
  info.insertBefore(sec, why);
}

async function load(k) {
  key = k; data = null; ov.innerHTML = '';
  try { const r = await fetch(`./plans/${k}.json`); if (r.ok && key === k) data = await r.json(); } catch {}
  if (key !== k) return;
  bar2.style.display = data ? '' : 'none';
  if (!data) { mode = '3d'; ov.classList.remove('on'); return; }
  renderOverlay(); renderKey();
}
new MutationObserver(() => {
  const k = document.querySelector('nav button[aria-current="true"]')?.dataset.key;
  if (k && k !== key) load(k); else if (data) renderKey();
}).observe(document.getElementById('info'), { childList: true });
