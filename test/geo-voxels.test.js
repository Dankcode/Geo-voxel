import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlace, rectifyNetwork, orthogonalizeRing, weightedGridAngle, decomposeFootprint, largestRectangle, resolveParty, plateauAndRelax, VoxelGrid, toVox, toSlatePNG, roadSpec, M } from '../src/index.js';

const example = id => JSON.parse(readFileSync(new URL(`../examples/${id}/blender-export.json`, import.meta.url), 'utf8'));
const rot = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const onGrid = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9;

test('straighten: a grid 6° off with a 79° crossing becomes exact grid lines; junctions and carriageway order kept', () => {
    const a = 6 * Math.PI / 180, J = rot([60, 60], a);
    const roads = [
        { id: 'blvd', cls: 3, half: 5, line: [rot([0, 60], a), [30, 64.5], J, rot([140, 60], a)] },
        { id: 'cross', cls: 3, half: 4, line: [[J[0] - 18, J[1] - 90], J, [J[0] + 17, J[1] + 80]] },
        { id: 'north', cls: 2, half: 3, line: [rot([0, 20], a), rot([140, 20], a)] },
        { id: 'south', cls: 2, half: 3, line: [rot([0, 30], a), rot([140, 30], a)] }];
    const R = rectifyNetwork(roads, { buildings: [{ id: 'b', ring: [rot([80, 70], a), rot([100, 70], a), rot([100, 85], a), rot([80, 85], a)] }] });
    for (const r of R.roads) for (let i = 1; i < r.line.length; i++) assert.ok(onGrid(r.line[i - 1], r.line[i]), `${r.id} on the grid`);
    const blvd = R.roads.find(r => r.id === 'blvd'), cross = R.roads.find(r => r.id === 'cross');
    assert.ok(cross.line.some(p => blvd.line.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9)), 'the crossing keeps its junction');
    assert.ok(R.roads.find(r => r.id === 'south').line[0][1] - R.roads.find(r => r.id === 'north').line[0][1] >= 2);
    const b = R.buildings[0].ring; for (let i = 0; i < b.length; i++) assert.ok(Math.abs(b[i][0] - b[(i + 1) % b.length][0]) < 1e-6 || Math.abs(b[i][1] - b[(i + 1) % b.length][1]) < 1e-6);
});

test('orthogonalizeRing and weightedGridAngle', () => {
    const r = orthogonalizeRing([[0, 0], [40, 1.5], [41, 30], [1, 29]]);
    assert.equal(r.length, 4); for (let i = 0; i < 4; i++) assert.ok(onGrid(r[i], r[(i + 1) % 4]));
    const tri = orthogonalizeRing([[0, 0], [40, 0], [40, 40]]); for (let i = 0; i < tri.length; i++) assert.ok(onGrid(tri[i], tri[(i + 1) % tri.length]));
    assert.ok(Math.abs(weightedGridAngle([{ pts: [[0, 0], [Math.cos(0.1) * 50, Math.sin(0.1) * 50]] }]) - 0.1) < 1e-9);
});

test('footprints: an L becomes two wings sharing a wall line; touching buildings keep one party wall', () => {
    const cells = []; for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) if (x < 8 || y < 8) cells.push([x, y]);
    const { wings, mass } = decomposeFootprint(cells);
    assert.equal(wings.length, 2); assert.equal(mass.length, 0);
    const a = { id: 'a', cells: [], area: 0 }, b = { id: 'b', cells: [], area: 0 };
    for (let y = 0; y < 10; y++) { for (let x = 0; x <= 10; x++) a.cells.push([x, y]); for (let x = 10; x < 18; x++) b.cells.push([x, y]); }
    a.area = a.cells.length; b.area = b.cells.length;
    const party = resolveParty([a, b]);
    // one shared wall line: every party cell is in both footprints, and they all lie on one column
    assert.ok(party.size > 0);
    const inA = new Set(a.cells.map(c => c.join(','))), inB = new Set(b.cells.map(c => c.join(',')));
    assert.ok([...party].every(k => inA.has(k) && inB.has(k)));
    assert.equal(new Set([...party].map(k => k.split(',')[0])).size, 1);
    assert.deepEqual(largestRectangle(new Set(['0,0', '1,0', '0,1', '1,1', '2,0']), { x0: 0, y0: 0, x1: 2, y1: 1 }), { x0: 0, y0: 0, w: 2, d: 2 });
});

test('terrain: touching plateaus stay one step apart', () => {
    const W = 10, D = 4, z = new Array(W * D).fill(1); for (let y = 0; y < D; y++) for (let x = 5; x < W; x++) z[x + y * W] = 4;
    const hf = { z, reliefM: 3 }, A = [], B = [];
    for (let y = 0; y < D; y++) { for (let x = 0; x < 5; x++) A.push([x, y]); for (let x = 5; x < W; x++) B.push([x, y]); }
    const p = plateauAndRelax(hf, W, D, [{ id: 'a', cells: A }, { id: 'b', cells: B }], { apron: 0 });
    assert.ok(Math.abs(p.get('a') - p.get('b')) <= 1);
});

for (const id of ['baton-rouge-third-street', 'baton-rouge-sherwood-florida']) test(`real place ${id}: streets on the grid, no staircase edges, buildings with doors, valid outputs`, () => {
    const r = buildPlace(example(id), { tagOverrides: { 1194681426: { name: 'Asian Supermarket', shop: 'supermarket', 'building:levels': '1' } } });
    const { grid: g, layers } = r;
    for (const s of layers.roads) for (let i = 1; i < s.line.length; i++) assert.ok(onGrid(s.line[i - 1], s.line[i]), `${s.id} segment ${i}`);
    // a slanted edge rasterises as a run of stair corners along the carriageway edge
    const R = (x, y) => layers.landUse.codes[x + y * g.width] === 'R';
    let run = 0, worst = 0;
    for (let y = 0; y + 2 < g.depth; y++) for (let x = 0; x + 2 < g.width; x++) {
        const m = [R(x, y), R(x + 1, y), R(x, y + 1), R(x + 1, y + 1)].filter(Boolean).length, n = [R(x + 1, y + 1), R(x + 2, y + 1), R(x + 1, y + 2), R(x + 2, y + 2)].filter(Boolean).length;
        if ((m === 1 || m === 3) && (n === 1 || n === 3)) worst = Math.max(worst, ++run); else run = 0;
    }
    assert.ok(worst < 3, `staircase run ${worst}`);
    assert.ok(layers.buildings.length >= 3 && layers.buildings.every(b => b.doors.length >= 1));
    for (const b of layers.buildings) { const d = b.doors[0]; assert.equal(g.get(d.x, d.y, d.z + 1), M.door, `${b.id} has a door`); }
    // walkable: no neighbouring ground step above 1 voxel on streets
    for (let i = 0; i < layers.heightfield.length; i++) { const x = i % g.width, y = Math.floor(i / g.width); if (x + 1 < g.width && 'RKS'.includes(layers.landUse.codes[i]) && 'RKS'.includes(layers.landUse.codes[i + 1])) assert.ok(Math.abs(layers.heightfield[i] - layers.heightfield[i + 1]) <= 1); }
    const vox = toVox(g); assert.equal(vox.subarray(0, 4).toString(), 'VOX '); assert.equal(vox.readUInt32LE(4), 150);
    const png = toSlatePNG(g, { scale: 1 }); assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const back = VoxelGrid.fromJSON(JSON.parse(JSON.stringify(g.toJSON()))); assert.deepEqual(back.data, g.data);
    const a = buildPlace(example(id)), b2 = buildPlace(example(id)); assert.deepEqual(a.grid.data, b2.grid.data, 'deterministic');
});

test('raw geometry is still available (straighten: null) and staircases where the real streets are slanted', () => {
    const raw = buildPlace(example('baton-rouge-sherwood-florida'), { straighten: null });
    assert.equal(raw.report.straighten, null);
    assert.ok(raw.layers.roads.some(s => s.line.some((p, i) => i && !onGrid(s.line[i - 1], p))));
    assert.equal(roadSpec({ highway: 'primary_link' }).link, true);
});
