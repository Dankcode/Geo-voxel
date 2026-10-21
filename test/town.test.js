import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generate, GENERATORS, ENGINE_PALETTE, tactics, toVoxBytes, VoxelGrid } from '../src/index.js';

const hash = a => createHash('sha1').update(a).digest('hex');
const example = id => JSON.parse(readFileSync(new URL(`../examples/${id}/blender-export.json`, import.meta.url), 'utf8'));

test('catalogue: three generators, every theme described, the engine palette fits a .vox', () => {
    assert.deepEqual(Object.keys(GENERATORS), ['operation', 'district', 'place']);
    assert.deepEqual(GENERATORS.operation.themes.map(t => t.id), ['downtown', 'industrial', 'suburb']);
    for (const id of ['park', 'mall', 'drainage', 'suburb', 'downtown', 'docks', 'highway', 'terraces', 'sunken-junction', 'sunken-boulevard', 'freight-terraces'])
        assert.ok(GENERATORS.district.themes.find(t => t.id === id)?.text, id);
    assert.ok(ENGINE_PALETTE.length > 40 && ENGINE_PALETTE.length < 256);
    assert.equal(ENGINE_PALETTE[0].key, 'air');
});

test('district: deterministic, furnished, layers in cell coordinates, .vox and grid JSON round trip', () => {
    const a = generate({ generator: 'district', theme: 'sunken-junction', seed: 3 }), b = generate({ generator: 'district', theme: 'sunken-junction', seed: 3 });
    assert.equal(hash(a.grid.data), hash(b.grid.data));
    assert.notEqual(hash(a.grid.data), hash(generate({ generator: 'district', theme: 'sunken-junction', seed: 4 }).grid.data));
    assert.equal(a.format, 'geo-voxels/map@1');
    assert.ok(a.layers.buildings.length >= 3 && a.layers.rooms.length >= a.layers.buildings.length && a.layers.decor.length > 10);
    for (const r of a.layers.rooms) for (const [x, y] of r.cells) assert.ok(x >= 0 && y >= 0 && x < a.grid.width && y < a.grid.depth);
    assert.equal(a.plugins.tactics, undefined);
    const vox = toVoxBytes(a.grid);
    assert.equal(new TextDecoder().decode(vox.slice(0, 4)), 'VOX ');
    const back = VoxelGrid.fromJSON(JSON.parse(JSON.stringify(a.grid.toJSON())));
    assert.equal(hash(back.data), hash(a.grid.data));
    assert.deepEqual(back.palette[5], a.grid.palette[5]);
});

test('operation + tactics plugin: spawns, objective, per-tile cover and the gate metrics', () => {
    const r = generate({ generator: 'operation', theme: 'suburb', seed: 7, plugins: [tactics()] });
    const t = r.plugins.tactics;
    assert.ok(t.spawns.player.length >= 4 && t.spawns.enemy.length >= 2);
    assert.ok(t.objective?.kind);
    assert.ok(t.cover.length > 50 && t.cover.every(c => c.length === 7 && c.slice(3).some(v => v > 0)));
    assert.ok(t.metrics.coverGap <= 8 && t.metrics.reachableTiles > 500);
});

test('real place through the full engine: tenants, real uses, and coverRepair:false keeps open land as it is', () => {
    const geo = example('baton-rouge-sherwood-florida');
    const plain = generate({ generator: 'place', geo, seed: 1, params: { coverRepair: false } });
    const game = generate({ generator: 'place', geo, seed: 1 });
    const names = plain.layers.buildings.map(b => b.name);
    for (const n of ['Asian Supermarket', 'Dollar Tree']) assert.ok(names.includes(n), n);
    const count = (r, key) => { const id = ENGINE_PALETTE.findIndex(p => p.key === key); let n = 0; for (const v of r.grid.data) if (v === id) n++; return n; };
    assert.ok(count(game, 'leaves') + count(game, 'brick') > count(plain, 'leaves') + count(plain, 'brick'), 'the game fill adds cover');
    assert.ok(plain.layers.roadPaint.quads.length > 100);
});
