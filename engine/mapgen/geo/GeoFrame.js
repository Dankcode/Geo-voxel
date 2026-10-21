// Geo import — frame, rasterisation and terrain for faithful (1:1) maps built from a BlenderGIS export.
//
// Frame: the export is in metres around a projected origin (UTM). The block is rotated so its dominant wall direction
// lies on the grid (real downtown grids are a few degrees off north — staircased walls would read as noise), then
// sampled at one kit cell (≈ 0.9 m, KitMetric.CELL) per cell with one uniform scale. Cell (i, j) covers
// [i, i+1) × [j, j+1); j grows southwards (north is up, as on the BlenderGIS render).
//
// Terrain: a DEM becomes a ground heightfield in whole voxels. A bare-earth DTM (USGS 3DEP) is used as is; a surface
// model (SRTM — towers bleed into it downtown) is first opened morphologically (erosion then dilation) so only ground
// remains. Heights are quantised to 1-voxel steps, which every walker can take (TraversalRules maxStep 1), building
// footprints are flattened to plateaus with an apron, and a relaxation pass keeps every neighbouring step ≤ 1 voxel.

export const METRES_PER_CELL = 0.9;

/** Length-weighted dominant direction of the footprint edges, in radians in (-π/4, π/4]. */
export function dominantAngle(rings) {
    let C = 0, S = 0;
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length], L = Math.hypot(x1 - x0, y1 - y0);
        if (L < 2) continue;
        const a = Math.atan2(y1 - y0, x1 - x0);
        C += L * Math.cos(4 * a); S += L * Math.sin(4 * a);
    }
    return C || S ? Math.atan2(S, C) / 4 : 0;
}

/**
 * The world → cell transform. opts.rotate: 'auto' | radians | 0.  Returns
 * { W, D, cell, theta, toCell([x, y]) → [cx, cy] (continuous), toWorld([cx, cy]) → [x, y] }.
 */
export function geoFrame(geo, { cell = METRES_PER_CELL, rotate = 'auto', maxCells = 192 } = {}) {
    // the map is the export's `window` when it fetched a padded `extent` (rotate, then crop: no empty corners)
    const E = geo.window || geo.extent, Wm = E.x1 - E.x0, Hm = E.y1 - E.y0, cx0 = (E.x0 + E.x1) / 2, cy0 = (E.y0 + E.y1) / 2;
    const theta = rotate === 'auto' ? dominantAngle((geo.buildings || []).map(b => b.ring).filter(r => r?.length >= 3)) : Number(rotate) || 0;
    const c = Math.cos(-theta), s = Math.sin(-theta);
    const W = Math.round(Wm / cell), D = Math.round(Hm / cell);
    if (W > maxCells || D > maxCells) throw Error(`geo.frame: ${W}×${D} cells exceeds the ${maxCells}-cell budget — export a smaller extent`);
    const toCell = ([x, y]) => {
        const dx = x - cx0, dy = y - cy0, rx = dx * c - dy * s, ry = dx * s + dy * c;
        return [(rx + Wm / 2) / cell, (Hm / 2 - ry) / cell];
    };
    const toWorld = ([i, j]) => {
        const rx = i * cell - Wm / 2, ry = Hm / 2 - j * cell, ci = Math.cos(theta), si = Math.sin(theta);
        return [cx0 + rx * ci - ry * si, cy0 + rx * si + ry * ci];
    };
    return { W, D, cell, theta, toCell, toWorld, extent: E };
}

// ------------------------------------------------------------------------------------------------ rasterisation
export function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
export function distToPolyline(p, line, closed = false) {
    let best = Infinity;
    const n = closed ? line.length : line.length - 1;
    for (let i = 0; i < n; i++) {
        const [ax, ay] = line[i], [bx, by] = line[(i + 1) % line.length], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L));
        best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
    return best;
}
/**
 * Cells of a polygon (in cell coordinates). A cell belongs when its centre is inside, or — with grow > 0 — within
 * `grow` cells of the outline (so two footprints that touch in reality both claim their shared wall line).
 */
export function rasterPolygon(poly, W, D, { grow = 0 } = {}) {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]), out = [];
    for (let j = Math.max(0, Math.floor(Math.min(...ys) - grow - 1)); j <= Math.min(D - 1, Math.ceil(Math.max(...ys) + grow)); j++)
        for (let i = Math.max(0, Math.floor(Math.min(...xs) - grow - 1)); i <= Math.min(W - 1, Math.ceil(Math.max(...xs) + grow)); i++) {
            const p = [i + 0.5, j + 0.5];
            if (pointInPolygon(poly, p[0], p[1]) || grow > 0 && distToPolyline(p, poly, true) <= grow) out.push([i, j]);
        }
    return out;
}
export const polygonArea = ring => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// ------------------------------------------------------------------------------------------------ terrain
const isNum = v => typeof v === 'number' && Number.isFinite(v);
function filterGrid(z, r, op) {
    const H = z.length, W = z[0].length, out = z.map(row => row.slice());
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let v = op === 'min' ? Infinity : -Infinity, any = false;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r + r) continue;
            const q = z[y + dy]?.[x + dx]; if (!isNum(q)) continue;
            any = true; v = op === 'min' ? Math.min(v, q) : Math.max(v, q);
        }
        out[y][x] = any ? v : z[y][x];
    }
    return out;
}
function blur(z, passes = 1) {
    let g = z;
    for (let p = 0; p < passes; p++) g = g.map((row, y) => row.map((v, x) => {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = g[y + dy]?.[x + dx]; if (isNum(q)) { const w = dx || dy ? 1 : 2; s += q * w; n += w; } }
        return n ? s / n : v;
    }));
    return g;
}
/**
 * Bare-ground model from the export's DEM samples. kind 'dtm' (bare earth) keeps the samples; 'dsm' opens them with
 * a radius of `openingM` metres so buildings and trees leave the surface. Returns sample(x, y) in metres (world).
 */
export function groundModel(dem, { kind = 'dsm', openingM = 40 } = {}) {
    if (!dem?.z?.length) return { kind: 'flat', sample: () => 0, stats: null };
    let z = dem.z.map(row => row.map(v => isNum(v) ? v : null));
    // fill gaps from neighbours
    for (let pass = 0; pass < 4; pass++) z = z.map((row, y) => row.map((v, x) => {
        if (isNum(v)) return v; const n = [z[y - 1]?.[x], z[y + 1]?.[x], row[x - 1], row[x + 1]].filter(isNum); return n.length ? n.reduce((a, b) => a + b) / n.length : null;
    }));
    if (kind === 'dsm') { const r = Math.max(1, Math.round(openingM / dem.step)); z = filterGrid(filterGrid(z, r, 'min'), r, 'max'); }
    z = blur(z, kind === 'dsm' ? 2 : 1);
    const H = z.length, Wn = z[0].length;
    const sample = (x, y) => {
        const fx = Math.max(0, Math.min(Wn - 1.001, (x - dem.x0) / dem.step)), fy = Math.max(0, Math.min(H - 1.001, (y - dem.y0) / dem.step));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const v = (a, b) => isNum(z[b]?.[a]) ? z[b][a] : z[y0][x0];
        return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
    };
    const flat = z.flat().filter(isNum);
    return { kind, sample, stats: { min: Math.min(...flat), max: Math.max(...flat) } };
}

/**
 * Whole-voxel ground heights per cell: datum + round((ground − lowest) / cell), compressed linearly if the relief
 * exceeds maxRelief voxels. Returns { z: Int16Array(W*D), relief, compressed, metres: Float32Array }.
 */
export function heightfield(frame, ground, { datum = 1, maxRelief = 6 } = {}) {
    const { W, D, cell } = frame, metres = new Float32Array(W * D);
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const [x, y] = frame.toWorld([i + 0.5, j + 0.5]); metres[i + j * W] = ground.sample(x, y); }
    let lo = Infinity, hi = -Infinity; for (const v of metres) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const reliefVox = (hi - lo) / cell, k = reliefVox > maxRelief ? maxRelief / reliefVox : 1;
    const z = new Int16Array(W * D);
    for (let i = 0; i < z.length; i++) z[i] = datum + Math.round((metres[i] - lo) / cell * k);
    return { z, metres, lowM: lo, reliefM: hi - lo, reliefVoxels: Math.max(...z) - datum, compressed: k < 1 ? k : null };
}

/**
 * Flatten each footprint (cells) to one plateau plus an apron, then relax every unlocked cell so no neighbouring
 * cells (8-neighbourhood, so diagonal moves stay legal) differ by more than one voxel. Returns the plateaus.
 */
export function plateauAndRelax(hf, W, D, footprints, { apron = 2, locked: extraLocked = null } = {}) {
    const z = hf.z, locked = new Uint8Array(W * D), plateaus = new Map();
    for (const f of footprints) {
        const vals = f.cells.map(([x, y]) => z[x + y * W]).sort((a, b) => a - b);
        let base = vals[Math.floor(vals.length / 2)];
        // touching plateaus (a street segment against the next one, a lot against its street) stay one step apart
        let lo = -Infinity, hi = Infinity;
        for (const [x, y] of f.cells) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy, i = X + Y * W; if (X >= 0 && Y >= 0 && X < W && Y < D && locked[i] === 2) { lo = Math.max(lo, z[i] - 1); hi = Math.min(hi, z[i] + 1); } }
        if (lo <= hi) base = Math.max(lo, Math.min(hi, base));
        plateaus.set(f.id, base);
        for (const [x, y] of f.cells) { z[x + y * W] = base; locked[x + y * W] = 2; }
    }
    for (const f of footprints) {
        const base = plateaus.get(f.id), own = new Set(f.cells.map(([x, y]) => x + y * W));
        for (const [x, y] of f.cells) for (let dy = -apron; dy <= apron; dy++) for (let dx = -apron; dx <= apron; dx++) {
            const X = x + dx, Y = y + dy, i = X + Y * W;
            if (X < 0 || Y < 0 || X >= W || Y >= D || own.has(i) || locked[i]) continue;
            z[i] = base; locked[i] = 1;
        }
    }
    if (extraLocked) for (const i of extraLocked) locked[i] ||= 1;
    for (let iter = 0; iter < 400; iter++) {
        let changed = 0;
        for (let pass = 0; pass < 2; pass++) for (let j = pass ? D - 1 : 0; pass ? j >= 0 : j < D; pass ? j-- : j++) for (let i = pass ? W - 1 : 0; pass ? i >= 0 : i < W; pass ? i-- : i++) {
            const k = i + j * W;
            if (locked[k] === 2) continue;
            let lo = -Infinity, hi = Infinity;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue; const X = i + dx, Y = j + dy; if (X < 0 || Y < 0 || X >= W || Y >= D) continue;
                // an apron/terrain cell next to a plateau must step to it; building cells are walls, not floors to walk
                const n = z[X + Y * W]; lo = Math.max(lo, n - 1); hi = Math.min(hi, n + 1);
            }
            const v = lo > hi ? Math.round((lo + hi) / 2) : Math.max(lo, Math.min(hi, z[k]));
            if (v !== z[k] && (locked[k] !== 1 || lo > z[k] || hi < z[k])) { z[k] = v; changed++; }
        }
        if (!changed) break;
    }
    return plateaus;
}
