#!/usr/bin/env node
// Copy the town engine (procedural towns, large districts, real places, the building builder) out of a voxel-tactics
// checkout into engine/, keeping its folder layout so every import works unchanged.
//
//   node tools/sync-engine.mjs <path to voxel-tactics> [--check]
//
// The engine is the import closure of ENTRIES below (only relative imports are followed; tests are never copied).
// engine/SOURCE.json records the source commit, whether the tree was dirty, and a hash per file; --check exits 1
// when engine/ no longer matches the checkout (CI or before a release).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ENTRIES = [
    'shared/mapgen/Generator.js',            // XCOM-style operations: plot family → site → parcels → buildings → repair
    'shared/mapgen/ExteriorCompiler.js',     // operation layout → voxels
    'shared/mission/LargeDistricts.js',      // large districts (park, mall, drainage, suburb, downtown, docks, highway, terraces)
    'shared/mission/ConnectingDistricts.js', // split-level districts
    'shared/mission/GeoDistrict.js',         // real places (BlenderGIS export → straight-street district)
    'shared/mapgen/geo/BuildingPrefab.js',   // bake / stamp single buildings
    'shared/mapgen/geo/PrefabLibrary.js'
];

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
export function closure(root) {
    const seen = new Set(), stack = ENTRIES.map(e => resolve(root, e));
    while (stack.length) {
        const f = stack.pop(); if (seen.has(f)) continue;
        if (!existsSync(f)) throw Error(`engine sync: missing ${relative(root, f)}`);
        seen.add(f);
        if (!/\.m?js$/.test(f)) continue;
        for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) { const s = m[1] || m[2]; if (s.startsWith('.')) stack.push(resolve(dirname(f), s)); }
    }
    return [...seen].map(f => relative(resolve(root, 'shared'), f)).sort();
}
const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const src = process.argv.slice(2).find(a => !a.startsWith('--')); if (!src) { console.error('usage: node tools/sync-engine.mjs <voxel-tactics checkout> [--check]'); process.exit(2); }
    const root = resolve(src), out = resolve(dirname(fileURLToPath(import.meta.url)), '../engine');
    const files = closure(root), check = process.argv.includes('--check');
    const git = cmd => { try { return execSync(`git -C ${JSON.stringify(root)} ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
    const hashes = Object.fromEntries(files.map(f => [f, sha(readFileSync(join(root, 'shared', f)))]));
    if (check) {
        const prev = JSON.parse(readFileSync(join(out, 'SOURCE.json'), 'utf8')).files;
        const diff = [...new Set([...Object.keys(prev), ...files])].filter(f => prev[f] !== hashes[f]);
        if (diff.length) { console.log(`engine/ differs from ${root}:\n  ${diff.join('\n  ')}`); process.exit(1); }
        console.log(`engine/ matches ${root} (${files.length} files)`); process.exit(0);
    }
    for (const d of ['content', 'elements', 'generation', 'mapgen', 'mission', 'session', 'util', 'voxel', 'world']) rmSync(join(out, d), { recursive: true, force: true });
    for (const f of files) { mkdirSync(dirname(join(out, f)), { recursive: true }); writeFileSync(join(out, f), readFileSync(join(root, 'shared', f))); }
    const dirty = git('status --porcelain -- shared');
    writeFileSync(join(out, 'SOURCE.json'), JSON.stringify({ from: 'voxel-tactics/shared', commit: git('rev-parse HEAD'), dirty: dirty == null ? null : dirty.length > 0, synced: new Date().toISOString(), entries: ENTRIES, files: hashes }, null, 1) + '\n');
    console.log(`engine: ${files.length} files from ${root}${dirty ? ' (working tree had uncommitted changes)' : ''} → ${out}`);
}
