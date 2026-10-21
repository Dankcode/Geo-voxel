// Tactics plugin — the turn-based game rules the town engine builds maps for (it came out of an XCOM-style tactics
// game), kept out of the plain map output. Add it when the map is for a tactics game:
//
//   generate({ generator: 'district', theme: 'downtown', seed: 2, plugins: [tactics()] }).plugins.tactics
//   → { spawns { player, enemy }, objective, holdZone, metrics, gates, cover }
//
//   cover    per standable tile: [x, y, z, n, e, s, w] with 0 none · 1 half · 2 full (XCOM shields), from the voxels
//   metrics  the design-gate measures: reachable tiles, cover density, outdoor cover share, largest cover gap
//            ("killing field"), sightline median, lanes, breachability, spawn safety …
//
// The generators themselves already shape maps for play (cover repair fills open ground with real objects, pods sit
// out of the first sightline); that is part of their recipe and happens with or without this plugin.
import { coverAt } from '../../engine/voxel/Cover.js';

export function tactics({ cover = true } = {}) {
    return {
        name: 'tactics',
        apply(map) {
            const s = map.store, tiles = [];
            if (cover) for (let y = 0; y < s.depth; y++) for (let x = 0; x < s.width; x++) for (const { z } of s.surfaces(x, y)) {
                const c = coverAt(s, x, y, z);
                if (c.n || c.e || c.s || c.w) tiles.push([x, y, z, c.n, c.e, c.s, c.w]);
            }
            const metrics = map.metrics ? Object.fromEntries(Object.entries(map.metrics).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v) === false)) : null;
            return {
                spawns: map.spawns || null, objective: map.objective || null, holdZone: map.meta?.holdZone || map.objective?.zone || null,
                lanesGoal: map.meta?.lanesGoal || null, metrics, gates: map.meta?.gates || map.meta?.audit || null, cover: tiles
            };
        }
    };
}
