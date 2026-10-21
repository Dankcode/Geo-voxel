// geo-voxels Place Builder — coordinates → pick an area on the map → fetch it live (OpenStreetMap, terrain, Wikidata,
// Wikipedia, Commons; no keys) → straighten and build it in a worker → inspect in 3D, read the details, export.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { toVox } from '../../src/vox.js';
import { fetchPlace, localProjection, MAX_SIDE_M } from '../../src/live/fetchPlace.js';
import { decodePNG } from '../../src/live/png.js';
import { meshGrid } from './mesher.js';
import { buildProps } from './props.js';
import { buildSigns } from './signs.js';
import { createSelector } from './selector.js';
import { renderDetails } from './details-view.js';
import './ui.css';

const $ = s => document.querySelector(s);
const CELL = 0.9;
const QUICK = [
    { name: 'Old State Capitol, Baton Rouge', lat: 30.4465932, lon: -91.1890705, w: 160, d: 160 },
    { name: 'Third Street, Baton Rouge', lat: 30.449587, lon: -91.188000, w: 142, d: 165 },
    { name: 'Sherwood & Florida, Baton Rouge', lat: 30.458197, lon: -91.058851, w: 171, d: 171 },
    { name: 'Independence Hall, Philadelphia', lat: 39.9488873, lon: -75.150026, w: 160, d: 160 }
];
const state = { result: null, source: null, cut: Infinity, layers: { signs: true, props: true, paint: true, rooms: false, cover: true, spawns: true } };

// ---- 1 · location + 2 · area ------------------------------------------------------------------------------------
const start = readHash() || { lat: QUICK[0].lat, lon: QUICK[0].lon, widthM: QUICK[0].w, depthM: QUICK[0].d };
const selector = createSelector($('#pane-map'), { ...start, onChange: s => {
    $('#area-size').innerHTML = `<b>${s.widthM} × ${s.depthM} m</b> · ${Math.round(s.widthM / CELL)} × ${Math.round(s.depthM / CELL)} cells<br><small>centre ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}</small>`;
    $('#lat').value = s.lat.toFixed(6); $('#lon').value = s.lon.toFixed(6); writeHash(s);
} });
function parseCoords() {
    const both = `${$('#lat').value} ${$('#lon').value}`.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    const [lat, lon] = both.length >= 2 ? both : [NaN, NaN];
    if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) { toast('Enter a latitude (−85…85) and a longitude (−180…180).'); return null; }
    return { lat, lon };
}
$('#goto').onclick = () => { const c = parseCoords(); if (c) selector.set(c); };
for (const id of ['#lat', '#lon']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('#goto').click(); });
for (const q of QUICK) { const a = document.createElement('a'); a.href = '#'; a.textContent = q.name; a.onclick = e => { e.preventDefault(); selector.set({ lat: q.lat, lon: q.lon, widthM: q.w, depthM: q.d }); }; $('#quick').append(a, ' '); }
for (const b of document.querySelectorAll('.presets button')) b.onclick = () => { const n = Math.min(MAX_SIDE_M, Number(b.dataset.size)); selector.set({ widthM: n, depthM: n }, { fly: false }); };

// ---- tabs -------------------------------------------------------------------------------------------------------
function tab(name) {
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('on', p.id === `pane-${name}`);
    if (name === 'map') selector.invalidate();
    if (name === 'world') resize();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => tab(b.dataset.tab);

// ---- 3 · build: fetch (main thread, network) → generate (worker) --------------------------------------------------
const inflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
const decodeTile = bytes => decodePNG(bytes, inflate);
let worker = null, jobId = 0;
$('#build').onclick = async () => {
    const sel = selector.get(), steps = $('#progress'); steps.hidden = false; steps.innerHTML = '';
    const step = (text, cls = '') => { const li = document.createElement('li'); li.textContent = text; li.className = cls; steps.appendChild(li); steps.querySelectorAll('li').forEach(l => l !== li && l.classList.add('done')); return li; };
    busy(true, 'Fetching the place');
    try {
        const source = await fetchPlace({ ...sel, details: $('#o-details').checked }, { decodeTile, onProgress: p => step(p.text) });
        state.source = source; selector.showFetched(source);
        await buildFrom(source, step);
    } catch (e) { busy(false); step(`Failed: ${e.message}`, 'err'); toast(e.message); console.error(e); }
};
$('#open-src').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
        const source = JSON.parse(await f.text()); if (!source.buildings) throw Error('not a geo-voxels source or Blender export');
        state.source = source;
        if (source.origin?.lat != null) { const E = source.window || source.extent, [clon, clat] = localProjection(source.origin.lat, source.origin.lon).inv((E.x0 + E.x1) / 2, (E.y0 + E.y1) / 2);
            selector.set({ lat: clat, lon: clon, widthM: Math.round(E.x1 - E.x0), depthM: Math.round(E.y1 - E.y0) }); }
        const steps = $('#progress'); steps.hidden = false; steps.innerHTML = '';
        await buildFrom(source, t => { const li = document.createElement('li'); li.textContent = t; steps.appendChild(li); return li; });
    } catch (err) { busy(false); toast(`Could not open it: ${err.message}`); }
};
function buildFrom(source, step) {
    return new Promise((resolve, reject) => {
        const id = ++jobId; worker?.terminate();
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        const straighten = $('#o-straighten').checked;
        step(straighten ? 'Straightening streets and building voxels' : 'Building voxels (streets as mapped)');
        busy(true, 'Building the map');
        const t0 = performance.now();
        worker.onmessage = ({ data }) => {
            if (data.id !== id) return;
            busy(false);
            if (!data.ok) { step(`Failed: ${data.error}`, 'err'); console.error(data.stack); reject(Error(data.error)); return; }
            state.result = data.result; state.result.wallMs = Math.round(performance.now() - t0); state.cut = Infinity;
            step(`Done: ${data.result.grid.width} × ${data.result.grid.depth} × ${data.result.grid.height} voxels`, 'done');
            $('#tabs [data-tab=world]').disabled = false; $('#tabs [data-tab=details]').disabled = false;
            selector.showFetched(source); selector.showWarp(source, data.result.details?.warp);
            tab('world'); show(true); renderDetails($('#details'), state.result, state.source); resolve();
        };
        worker.onerror = e => { busy(false); reject(Error(e.message)); };
        worker.postMessage({ id, geo: source, seed: Math.max(0, Math.floor(Number($('#seed').value) || 1)), tactics: $('#o-tactics').checked,
            params: { name: placeName(source), straighten: straighten ? 'grid' : 'none', maxStoreys: Number($('#o-storeys').value), coverRepair: $('#o-cover').checked } });
    });
}
const placeName = src => { const lm = Object.values(src.context?.wikidata || {}).find(f => f.heritage?.length || f.style?.length); return lm?.label || src.buildings.find(b => b.tags?.name)?.tags.name || `Place at ${src.origin.lat.toFixed(4)}, ${src.origin.lon.toFixed(4)}`; };

// ---- 3D view ----------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
$('#pane-world').prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x11141a); scene.fog = new THREE.Fog(0x11141a, 260, 520);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47;
scene.add(new THREE.HemisphereLight(0xa8bad6, 0x2a241f, 0.75));
const sun = new THREE.DirectionalLight(0xffe2b8, 2.1); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6; scene.add(sun, sun.target);
const world = new THREE.Group(); scene.add(world);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; floor.receiveShadow = true; scene.add(floor);
function resize() { const r = $('#pane-world').getBoundingClientRect(); if (!r.width) return; renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
addEventListener('resize', () => { resize(); selector.invalidate(); });
renderer.setAnimationLoop(() => { if ($('#pane-world').classList.contains('on')) { controls.update(); renderer.render(scene, camera); } });

const mats = { opaque: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), clear: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.42, depthWrite: false }) };
let pickMesh = null;
function show(frame = false) {
    const r = state.result; if (!r) return;
    for (const c of [...world.children]) { world.remove(c); c.traverse?.(o => o.geometry?.dispose?.()); }
    const { width: W, depth: D, height: H } = r.grid, cut = state.cut;
    const { opaque, clear } = meshGrid(r.grid, r.palette, { cut });
    const om = new THREE.Mesh(opaque, mats.opaque); om.castShadow = om.receiveShadow = true; world.add(om); pickMesh = om;
    world.add(new THREE.Mesh(clear, mats.clear));
    if (state.layers.props) world.add(buildProps(r.layers.decor, { cut }));
    if (state.layers.signs && r.layers.signs) world.add(buildSigns(r.layers.signs, { cut }));
    if (state.layers.paint && r.layers.roadPaint) world.add(roadPaint(r.layers.roadPaint.quads, cut));
    if (state.layers.rooms) world.add(roomTint(r.layers.rooms, cut));
    const t = r.plugins?.tactics;
    if (t && state.layers.cover) world.add(coverMarks(t.cover, cut));
    if (t && state.layers.spawns) world.add(spawnMarks(t.spawns));
    const span = Math.max(W, D);
    sun.position.set(W * 0.5 - span * 0.55, span * 0.9, D * 0.5 - span * 0.35); sun.target.position.set(W / 2, 0, D / 2);
    Object.assign(sun.shadow.camera, { left: -span * 0.8, right: span * 0.8, top: span * 0.8, bottom: -span * 0.8, near: 1, far: span * 3 }); sun.shadow.camera.updateProjectionMatrix();
    if (frame) { controls.target.set(W / 2, 2, D / 2); camera.position.set(W / 2 - span * 0.5, span * 0.78, D / 2 + span * 0.86); const c = $('#cut'); c.max = H; c.value = H; $('#cut-label').textContent = 'all'; }
    $('#view-opts').hidden = false; $('#export').hidden = false;
    $('#lay-cover').parentElement.hidden = $('#lay-spawns').parentElement.hidden = !t;
    $('#lay-signs').parentElement.hidden = !r.layers.signs?.length;
    stats(r);
}
function roadPaint(quads, cut) {
    const pos = [], col = [], idx = [], C = { white: [0.92, 0.92, 0.88], yellow: [0.95, 0.75, 0.2] };
    for (const q of quads) { if (q.z > cut) continue; const s = pos.length / 3, y = q.z + 1.02, c = C[q.color] || C.white; for (const [x, z] of q.c) { pos.push(x, y, z); col.push(...c); } idx.push(s, s + 2, s + 1, s, s + 3, s + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
}
const KIND_COLORS = {}, kindColor = k => (KIND_COLORS[k] ||= new THREE.Color().setHSL(([...k].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 360) / 360, 0.55, 0.55));
function roomTint(rooms, cut) {
    const pos = [], col = [];
    for (const r of rooms) { if (r.floorZ > cut || !r.cells) continue; const c = kindColor(r.kind || 'room'), y = r.floorZ + 1.04;
        for (const [x, z] of r.cells) { pos.push(x + .08, y, z + .08, x + .92, y, z + .92, x + .92, y, z + .08, x + .08, y, z + .08, x + .08, y, z + .92, x + .92, y, z + .92); for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
}
function coverMarks(tiles, cut) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]], half = [], full = [];
    for (const [x, y, z, ...c] of tiles) { if (z > cut) continue; c.forEach((v, i) => { if (v) (v === 2 ? full : half).push([x + 0.5 + dirs[i][0] * 0.38, z + 1, y + 0.5 + dirs[i][1] * 0.38, i % 2]); }); }
    const g = new THREE.Group(), box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), m4 = new THREE.Matrix4();
    for (const [list, h, color] of [[half, 0.22, 0x6fb4ff], [full, 0.5, 0x3d7fe6]]) {
        const mesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }), list.length);
        list.forEach(([x, y, z, ns], i) => { m4.makeScale(ns ? 0.05 : 0.5, h, ns ? 0.5 : 0.05); m4.setPosition(x, y + 0.02, z); mesh.setMatrixAt(i, m4); }); g.add(mesh);
    }
    return g;
}
function spawnMarks(spawns) {
    const g = new THREE.Group(), geo = new THREE.CylinderGeometry(0.35, 0.35, 1.6, 12).translate(0, 0.8, 0);
    for (const p of spawns?.player || []) { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3d8bff, emissive: 0x1d4bbf })); m.position.set(p.x + .5, p.z + 1, p.y + .5); g.add(m); }
    for (const e of spawns?.enemy || []) { const p = e.pos || e, m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe0483a, emissive: 0x8a1d12 })); m.position.set(p.x + .5, p.z + 1, p.y + .5); g.add(m); }
    return g;
}
for (const k of Object.keys(state.layers)) { const el = $(`#lay-${k}`); el.checked = state.layers[k]; el.onchange = () => { state.layers[k] = el.checked; show(); }; }
$('#cut').oninput = e => { const v = Number(e.target.value), H = state.result?.grid.height; state.cut = v >= H ? Infinity : v; $('#cut-label').textContent = v >= H ? 'all' : `z ≤ ${v}`; };
$('#cut').onchange = () => show();

// click to inspect
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !pickMesh || !state.result) return;
    const rect = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera); const hit = ray.intersectObject(pickMesh)[0]; if (!hit) return;
    const p = hit.point.clone().addScaledVector(hit.face.normal, -0.01); inspect(Math.floor(p.x), Math.floor(p.z), Math.floor(p.y));
});
function inspect(x, y, z) {
    const r = state.result, g = r.grid, m = g.data[(z * g.depth + y) * g.width + x], mat = r.palette[m];
    const room = r.layers.rooms.find(rm => rm.floorZ <= z && z <= rm.floorZ + 3 && rm.cells?.some(([cx, cy]) => cx === x && cy === y))
        || r.layers.rooms.find(rm => rm.floorZ <= z + 1 && rm.floorZ >= z - 3 && rm.cells?.some(([cx, cy]) => Math.abs(cx - x) + Math.abs(cy - y) <= 1));
    const b = (room && r.layers.buildings.find(b => b.id === room.buildingId)) || r.layers.buildings.find(b => x >= b.x0 && y >= b.y0 && x < b.x0 + b.w && y < b.y0 + b.d && z <= (b.top ?? 99));
    const info = b && r.details?.buildings.find(d => d.id === (b.group || b.id));
    const rows = [['Voxel', `${x}, ${y}, ${z}`], ['Material', mat ? `${mat.label}` : '—']];
    if (b) rows.push(['Building', info?.name || b.name || b.id], ['Use', b.program || '—'], ['Storeys', b.storeys ?? '—']);
    if (info?.type) rows.push(['OSM type', info.type]);
    if (info?.address) rows.push(['Address', info.address]);
    if (info?.tenants?.length) rows.push(['Tenants', info.tenants.join(', ')]);
    if (info?.wikidata?.style?.length) rows.push(['Style', info.wikidata.style.join(', ')]);
    if (room) rows.push(['Room', `${room.kind} · storey ${room.storey ?? 0}`]);
    $('#inspect').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join(''); $('#inspect').hidden = false;
}
const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function stats(r) {
    const c = r.details?.counts || {}, t = r.plugins?.tactics?.metrics, w = r.details?.warp;
    $('#stats').innerHTML = `<h3>${esc(r.name)}</h3><p>${r.grid.width} × ${r.grid.depth} × ${r.grid.height} cells · ${r.wallMs ?? r.ms} ms</p>
      <p>${r.layers.buildings.length} building parts · ${r.layers.rooms.length} rooms · ${r.layers.decor.length} props · ${r.layers.signs?.length || 0} signs</p>
      ${w?.straighten ? `<p>Warp: rotated ${w.rotationDeg}° · streets moved ≤ ${(w.straighten.maxShift * CELL).toFixed(1)} m (mean ${(w.straighten.meanShift * CELL).toFixed(1)} m)</p>` : w ? `<p>Rotated ${w.rotationDeg}° · streets as mapped</p>` : ''}
      ${Object.keys(c).length ? `<p class="uses">${Object.entries(c).map(([k, n]) => `<span>${k.replace('_', ' ')} ${n}</span>`).join('')}</p>` : ''}
      ${t ? `<p>Cover ${(t.coverDensity * 100).toFixed(0)}% · largest gap ${t.coverGap} · ${t.lanes} lanes</p>` : ''}`;
}

// ---- export -----------------------------------------------------------------------------------------------------
const save = (bytes, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
const base = () => (state.result?.name || 'place').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) + `-s${state.result.seed}`;
$('#ex-vox').onclick = () => { try { save(toVox(state.result.grid), `${base()}.vox`, 'application/octet-stream'); } catch (e) { toast(e.message); } };
$('#ex-map').onclick = () => { const { grid, palette, ...rest } = state.result; save(JSON.stringify({ ...rest, palette }), `${base()}.map.json`, 'application/json'); };
$('#ex-grid').onclick = () => { const g = state.result.grid, runs = []; for (let i = 0; i < g.data.length;) { let j = i + 1; while (j < g.data.length && g.data[j] === g.data[i]) j++; runs.push(j - i, g.data[i]); i = j; }
    save(JSON.stringify({ format: 'geo-voxels/grid@1', width: g.width, depth: g.depth, height: g.height, palette: g.palette.map(([n]) => n), colors: g.palette.map(([, c]) => c), runs }), `${base()}.grid.json`, 'application/json'); };
$('#ex-src').onclick = () => save(JSON.stringify(state.source), `${base()}.source.json`, 'application/json');
$('#ex-glb').onclick = () => new GLTFExporter().parse(world, glb => save(glb, `${base()}.glb`, 'model/gltf-binary'), e => toast(e.message), { binary: true });
$('#ex-png').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => save(b, `${base()}.png`, 'image/png')); };

// ---- misc -------------------------------------------------------------------------------------------------------
function busy(on, text = '') { $('#busy').hidden = !on; $('#busy-text').textContent = text; $('#build').disabled = on; }
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 7000); }
function writeHash(s) { history.replaceState(null, '', `#lat=${s.lat.toFixed(6)}&lon=${s.lon.toFixed(6)}&w=${s.widthM}&d=${s.depthM}`); }
function readHash() {
    const h = new URLSearchParams(location.hash.slice(1)), lat = Number(h.get('lat')), lon = Number(h.get('lon'));
    return h.has('lat') && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, widthM: Number(h.get('w')) || 160, depthM: Number(h.get('d')) || 160 } : null;
}
window.__pb = { camera, controls, state, show, inspect, selector, buildFrom, tab };   // scripted screenshots and debugging
