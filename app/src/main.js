// geo-voxels Map Builder — pick a generator and theme (or a real place), generate in a worker, inspect the result in
// 3D (floor cutaway, rooms, props, road paint, the tactics overlay) and export it (.vox, .glb, map JSON, grid JSON).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { toVox } from '../../src/vox.js';
import { meshGrid } from './mesher.js';
import { buildProps } from './props.js';
import './ui.css';

// the generator catalogue comes from the worker, so the page itself never loads the engine
const newWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const GENERATORS = await new Promise(res => { const w = newWorker(); w.onmessage = ({ data }) => { if (data.type === 'catalog') { res(data.generators); w.terminate(); } }; w.postMessage({ type: 'catalog' }); });
const EXAMPLES = import.meta.glob('../../examples/*/blender-export.json', { query: '?url', import: 'default' });
const $ = s => document.querySelector(s);
const state = { generator: 'district', theme: 'downtown', seed: 1, params: {}, tactics: false, place: null, placeName: null, result: null, cut: Infinity, layers: { props: true, paint: true, rooms: false, cover: true, spawns: true } };

// ---- scene ----------------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
$('#view').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a);
scene.fog = new THREE.Fog(0x11141a, 260, 520);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.screenSpacePanning = false;
const hemi = new THREE.HemisphereLight(0xa8bad6, 0x2a241f, 0.75); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2b8, 2.1); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);
const world = new THREE.Group(); scene.add(world);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true; scene.add(ground);
function resize() { const r = $('#view').getBoundingClientRect(); renderer.setSize(r.width, r.height); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); }
addEventListener('resize', resize);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---- UI -------------------------------------------------------------------------------------------------------
const gens = $('#generators');
for (const [id, g] of Object.entries(GENERATORS)) {
    const b = document.createElement('button'); b.textContent = g.label; b.dataset.id = id;
    b.onclick = () => { state.generator = id; state.theme = g.themes[0].id; syncForm(); };
    gens.appendChild(b);
}
function syncForm() {
    const g = GENERATORS[state.generator];
    for (const b of gens.children) b.classList.toggle('on', b.dataset.id === state.generator);
    $('#gen-text').textContent = `${g.text} Size: ${g.size}.`;
    const sel = $('#theme'); sel.innerHTML = '';
    for (const t of g.themes) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.appendChild(o); }
    if (!g.themes.some(t => t.id === state.theme)) state.theme = g.themes[0].id;
    sel.value = state.theme;
    $('#theme-row').hidden = state.generator === 'place';
    $('#theme-text').textContent = state.generator === 'place' ? '' : g.themes.find(t => t.id === state.theme)?.text || '';
    $('#place-box').hidden = state.generator !== 'place';
    const fixed = g.themes.find(t => t.id === state.theme)?.fixedSize;
    $('#district-box').hidden = state.generator !== 'district' || fixed;
    $('#seed').value = state.seed;
    $('#tactics').checked = state.tactics;
    writeHash();
}
$('#theme').onchange = e => { state.theme = e.target.value; syncForm(); };
$('#seed').onchange = e => { state.seed = Math.max(0, Math.floor(Number(e.target.value) || 1)); writeHash(); };
$('#dice').onclick = () => { state.seed = 1 + Math.floor(Math.random() * 99999); $('#seed').value = state.seed; generateNow(); };
$('#tactics').onchange = e => { state.tactics = e.target.checked; writeHash(); };
$('#go').onclick = () => generateNow();

// district parameters
function districtParams() {
    const v = id => $(id).value, remix = {};
    if (v('#p-storeys') !== 'auto') { const [a, b] = v('#p-storeys').split('-').map(Number); remix.minStoreys = a; remix.maxStoreys = b; }
    for (const [id, key] of [['#p-traffic', 'traffic'], ['#p-wall', 'wall'], ['#p-glazing', 'glazing'], ['#p-terrain', 'terrain']]) if (v(id) !== 'auto') remix[key] = v(id);
    if (v('#p-count') !== '') remix.buildingCount = Number(v('#p-count'));
    if (!$('#p-sky').checked) remix.skybridges = false;
    if (!$('#p-furnish').checked) remix.furnish = false;
    return { width: Number(v('#p-width')), depth: Number(v('#p-depth')), shape: v('#p-shape') === 'auto' ? undefined : v('#p-shape'), ...(Object.keys(remix).length ? { remix } : {}) };
}

// real places: bundled examples + your own export
const exSel = $('#example');
for (const path of Object.keys(EXAMPLES)) { const o = document.createElement('option'); o.value = path; o.textContent = path.split('/').at(-2).replace(/-/g, ' '); exSel.appendChild(o); }
exSel.onchange = () => { state.place = null; state.placeName = null; $('#place-file-name').textContent = ''; };
$('#place-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { state.place = JSON.parse(await f.text()); state.placeName = f.name; $('#place-file-name').textContent = f.name; }
    catch (err) { toast(`Not a JSON export: ${err.message}`); }
};
async function placeGeo() {
    if (state.place) return { geo: state.place, name: $('#place-name').value || state.placeName };
    const path = exSel.value, url = await EXAMPLES[path]();
    return { geo: await (await fetch(url)).json(), name: $('#place-name').value || path.split('/').at(-2).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) };
}

// ---- generation -----------------------------------------------------------------------------------------------
let worker = null, jobId = 0;
async function generateNow() {
    const id = ++jobId;
    worker?.terminate();
    worker = newWorker();
    const job = { id, generator: state.generator, theme: state.theme, seed: state.seed, tactics: state.tactics, params: {} };
    if (state.generator === 'district' && !GENERATORS.district.themes.find(t => t.id === state.theme)?.fixedSize) job.params = districtParams();
    if (state.generator === 'place') { const { geo, name } = await placeGeo(); job.geo = geo; job.params = { name, objectiveName: $('#place-objective').value || null, maxStoreys: Number($('#place-storeys').value), coverRepair: $('#place-cover').checked }; }
    busy(true, `Generating ${GENERATORS[state.generator].label.toLowerCase()} · ${state.generator === 'place' ? job.params.name : $('#theme').selectedOptions[0]?.textContent} · seed ${state.seed}`);
    const t0 = performance.now();
    worker.onmessage = ({ data }) => {
        if (data.id !== jobId) return;
        busy(false);
        if (!data.ok) { toast(`Generation failed: ${data.error}`); console.error(data.stack); return; }
        state.result = data.result; state.result.wallMs = Math.round(performance.now() - t0);
        state.cut = Infinity; show(true); writeHash();
    };
    worker.onerror = e => { busy(false); toast(`Worker error: ${e.message}`); };
    worker.postMessage(job);
}

// ---- drawing --------------------------------------------------------------------------------------------------
const mats = {
    opaque: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }),
    clear: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.42, depthWrite: false })
};
let pickMesh = null;
function show(frame = false) {
    const r = state.result; if (!r) return;
    for (const c of [...world.children]) { world.remove(c); c.traverse?.(o => { o.geometry?.dispose?.(); }); }
    const { width: W, depth: D, height: H } = r.grid, cut = state.cut;
    const { opaque, clear } = meshGrid(r.grid, r.palette, { cut });
    const om = new THREE.Mesh(opaque, mats.opaque); om.castShadow = om.receiveShadow = true; world.add(om); pickMesh = om;
    world.add(new THREE.Mesh(clear, mats.clear));
    if (state.layers.props) world.add(buildProps(r.layers.decor, { cut }));
    if (state.layers.paint && r.layers.roadPaint) world.add(roadPaint(r.layers.roadPaint.quads, cut));
    if (state.layers.rooms) world.add(roomTint(r.layers.rooms, cut));
    const t = r.plugins?.tactics;
    if (t && state.layers.cover) world.add(coverMarks(t.cover, cut));
    if (t && state.layers.spawns) world.add(spawnMarks(t.spawns));
    // light + shadow box around the map
    const span = Math.max(W, D);
    sun.position.set(W * 0.5 - span * 0.55, span * 0.9, D * 0.5 - span * 0.35); sun.target.position.set(W / 2, 0, D / 2);
    Object.assign(sun.shadow.camera, { left: -span * 0.8, right: span * 0.8, top: span * 0.8, bottom: -span * 0.8, near: 1, far: span * 3 }); sun.shadow.camera.updateProjectionMatrix();
    if (frame) {
        controls.target.set(W / 2, 2, D / 2);
        camera.position.set(W / 2 - span * 0.5, span * 0.78, D / 2 + span * 0.86);
        const cuts = $('#cut'); cuts.max = H; cuts.value = H; $('#cut-label').textContent = 'all';
    }
    $('#layers').hidden = false; $('#export').hidden = false;
    $('#lay-cover').parentElement.hidden = $('#lay-spawns').parentElement.hidden = !t;
    $('#lay-paint').parentElement.hidden = !r.layers.roadPaint;
    stats(r);
}
function roadPaint(quads, cut) {
    const pos = [], col = [], idx = [];
    const C = { white: [0.92, 0.92, 0.88], yellow: [0.95, 0.75, 0.2] };
    for (const q of quads) {
        if (q.z > cut) continue;
        const s = pos.length / 3, y = q.z + 1.02, c = C[q.color] || C.white;
        for (const [x, z] of q.c) { pos.push(x, y, z); col.push(...c); }
        idx.push(s, s + 2, s + 1, s, s + 3, s + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    return m;
}
const KIND_COLORS = {};
const kindColor = k => (KIND_COLORS[k] ||= new THREE.Color().setHSL(([...k].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 360) / 360, 0.55, 0.55));
function roomTint(rooms, cut) {
    const pos = [], col = [];
    for (const r of rooms) {
        if (r.floorZ > cut || !r.cells) continue;
        const c = kindColor(r.kind || 'room'), y = r.floorZ + 1.04;
        for (const [x, z] of r.cells) { pos.push(x + .08, y, z + .08, x + .92, y, z + .92, x + .92, y, z + .08, x + .08, y, z + .08, x + .08, y, z + .92, x + .92, y, z + .92); for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
}
function coverMarks(tiles, cut) {
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]], half = [], full = [];
    for (const [x, y, z, ...c] of tiles) { if (z > cut) continue; c.forEach((v, i) => { if (v) (v === 2 ? full : half).push([x + 0.5 + dirs[i][0] * 0.38, z + 1, y + 0.5 + dirs[i][1] * 0.38, i % 2]); }); }
    const g = new THREE.Group(), box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), m4 = new THREE.Matrix4();
    for (const [list, h, color] of [[half, 0.22, 0x6fb4ff], [full, 0.5, 0x3d7fe6]]) {
        const mesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }), list.length);
        list.forEach(([x, y, z, ns], i) => { m4.makeScale(ns ? 0.05 : 0.5, h, ns ? 0.5 : 0.05); m4.setPosition(x, y + 0.02, z); mesh.setMatrixAt(i, m4); });
        g.add(mesh);
    }
    return g;
}
function spawnMarks(spawns) {
    const g = new THREE.Group(), geo = new THREE.CylinderGeometry(0.35, 0.35, 1.6, 12).translate(0, 0.8, 0);
    for (const p of spawns?.player || []) { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3d8bff, emissive: 0x1d4bbf })); m.position.set(p.x + .5, p.z + 1, p.y + .5); g.add(m); }
    for (const e of spawns?.enemy || []) { const p = e.pos || e; const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe0483a, emissive: 0x8a1d12 })); m.position.set(p.x + .5, p.z + 1, p.y + .5); g.add(m); }
    return g;
}

// ---- layers, cutaway, picking ----------------------------------------------------------------------------------
for (const k of Object.keys(state.layers)) { const el = $(`#lay-${k}`); el.checked = state.layers[k]; el.onchange = () => { state.layers[k] = el.checked; show(); }; }
$('#cut').oninput = e => { const v = Number(e.target.value), H = state.result?.grid.height; state.cut = v >= H ? Infinity : v; $('#cut-label').textContent = v >= H ? 'all' : `z ≤ ${v}`; };
$('#cut').onchange = () => show();
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || !pickMesh || !state.result) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(pickMesh)[0]; if (!hit) return;
    const p = hit.point.clone().addScaledVector(hit.face.normal, -0.01);
    inspect(Math.floor(p.x), Math.floor(p.z), Math.floor(p.y));
});
function inspect(x, y, z) {
    const r = state.result, g = r.grid, m = g.data[(z * g.depth + y) * g.width + x], mat = r.palette[m];
    const room = r.layers.rooms.find(rm => rm.floorZ <= z && z <= rm.floorZ + 3 && rm.cells?.some(([cx, cy]) => cx === x && cy === y))
        || r.layers.rooms.find(rm => rm.floorZ <= z + 1 && rm.cells?.some(([cx, cy]) => Math.abs(cx - x) + Math.abs(cy - y) <= 1 && rm.floorZ >= z - 3));
    const b = (room && r.layers.buildings.find(b => b.id === room.buildingId)) || r.layers.buildings.find(b => x >= b.x0 && y >= b.y0 && x < b.x0 + b.w && y < b.y0 + b.d && z <= (b.top ?? 99));
    const rows = [['Voxel', `${x}, ${y}, ${z}`], ['Material', mat ? `${mat.label} (${mat.key})` : '—']];
    if (b) rows.push(['Building', b.name || b.id], ['Use', b.program || '—'], ['Storeys', b.storeys ?? '—'], ...(b.landmark ? [['Landmark', 'yes']] : []));
    if (room) rows.push(['Room', `${room.kind} · storey ${room.storey ?? 0}`]);
    $('#inspect').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${String(v).replace(/</g, '&lt;')}</b></div>`).join('');
    $('#inspect').hidden = false;
}
function stats(r) {
    const counts = {}; for (const b of r.layers.buildings) counts[b.program || 'building'] = (counts[b.program || 'building'] || 0) + 1;
    const t = r.plugins?.tactics?.metrics;
    $('#stats').innerHTML = `<h3>${r.name}</h3><p>${r.grid.width} × ${r.grid.depth} × ${r.grid.height} cells · seed ${r.seed} · ${r.wallMs ?? r.ms} ms</p>
      <p>${r.layers.buildings.length} buildings · ${r.layers.rooms.length} rooms · ${r.layers.decor.length} props</p>
      <p class="uses">${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span>${k} ${n}</span>`).join('')}</p>
      ${t ? `<p>Cover density ${(t.coverDensity * 100).toFixed(0)}% · outdoor ${(t.outdoorCover * 100).toFixed(0)}% · largest gap ${t.coverGap} · ${t.lanes} lanes</p>` : ''}`;
}

// ---- export ---------------------------------------------------------------------------------------------------
const save = (bytes, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
const base = () => `${state.result.generator}-${state.result.theme}-s${state.result.seed}`.replace(/[^a-z0-9-]+/gi, '-');
$('#ex-vox').onclick = () => { try { save(toVox(state.result.grid), `${base()}.vox`, 'application/octet-stream'); } catch (e) { toast(e.message); } };
$('#ex-map').onclick = () => { const { grid, palette, ...rest } = state.result; save(JSON.stringify({ ...rest, palette }), `${base()}.map.json`, 'application/json'); };
$('#ex-grid').onclick = () => {
    const g = state.result.grid, runs = [];
    for (let i = 0; i < g.data.length;) { let j = i + 1; while (j < g.data.length && g.data[j] === g.data[i]) j++; runs.push(j - i, g.data[i]); i = j; }
    save(JSON.stringify({ format: 'geo-voxels/grid@1', width: g.width, depth: g.depth, height: g.height, palette: g.palette.map(([n]) => n), colors: g.palette.map(([, c]) => c), runs }), `${base()}.grid.json`, 'application/json');
};
$('#ex-glb').onclick = () => new GLTFExporter().parse(world, glb => save(glb, `${base()}.glb`, 'model/gltf-binary'), e => toast(e.message), { binary: true });
$('#ex-png').onclick = () => { renderer.render(scene, camera); renderer.domElement.toBlob(b => save(b, `${base()}.png`, 'image/png')); };

// ---- misc -----------------------------------------------------------------------------------------------------
function busy(on, text = '') { $('#busy').hidden = !on; $('#busy-text').textContent = text; $('#go').disabled = on; }
function toast(text) { const t = $('#toast'); t.textContent = text; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 6000); }
function writeHash() { history.replaceState(null, '', `#g=${state.generator}&t=${encodeURIComponent(state.theme)}&s=${state.seed}${state.tactics ? '&tactics=1' : ''}`); }
function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (GENERATORS[h.get('g')]) state.generator = h.get('g');
    if (h.get('t')) state.theme = h.get('t');
    if (h.get('s')) state.seed = Math.max(0, Number(h.get('s')) || 1);
    state.tactics = h.get('tactics') === '1';
    return h.has('g');
}
window.__mb = { camera, controls, state, show, inspect };   // for scripted screenshots and debugging
readHash();
syncForm(); resize();
generateNow();
