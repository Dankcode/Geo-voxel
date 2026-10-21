// Geo import — landmark dressing: an iconic real building rebuilt from what is known about it (Wikidata style,
// heritage, height, floors; OSM height / building:levels / roof:shape / material) with a hard-coded grammar of
// architectural parts in voxels, on top of the playable building the interior system made (≤ 3 storeys).
//
//   gothic     (Gothic Revival, castle, Romanesque, Tudor)  crenellated parapet, corner turrets, twin towers flanking
//                                                           the entrance, taller than the roof
//   colonial   (Georgian, Colonial, Federal)               pitched roof (builder), a clock tower with a stepped
//                                                           steeple and spire on the middle of the front
//   classical  (Neoclassical, Beaux-Arts, Greek Revival)   a portico: columns before the entrance (real cover),
//                                                           entablature and a stepped pediment, cornice
//   tall       (any style, real height above the playable storeys)  upper massing: setbacks, window bands, a cap
//
// Every voxel is registered with origin `building:<group>/landmark` and stays off streets and sidewalks (the district
// road-air gate); columns only stand on the building's own plaza / yard cells.
import { MAT } from '../../voxel/Materials.js';
import { registerCells, tagAt } from '../district/Core.js';

const k2 = (x, y) => `${x},${y}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const OUT = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const ROADWAY = new Set(['road', 'kerb', 'sidewalk', 'driveway']);
export const LANDMARK_MAX_HEIGHT = 60;   // voxels above datum (≈ 54 m): taller towers are capped and reported

/** Style family from Wikidata/OSM: 'gothic' | 'colonial' | 'classical' | 'deco' | null. */
export function styleFamily(info) {
    const s = `${(info?.facts?.style || []).join(' ')} ${info?.tags?.['building:architecture'] || ''} ${info?.tags?.historic || ''}`.toLowerCase();
    if (/gothic|castle|romanesque|tudor|norman|medieval/.test(s)) return 'gothic';
    if (/georgian|colonial|federal|palladian/.test(s)) return 'colonial';
    if (/neoclassic|beaux|greek revival|classical|renaissance revival/.test(s)) return 'classical';
    if (/art deco|moderne|streamline/.test(s)) return 'deco';
    const year = parseInt(info?.facts?.inception || info?.tags?.start_date, 10);
    if (info?.landmark && year && year < 1800) return 'colonial';
    if (info?.landmark && year && year < 1880) return 'gothic';
    if (info?.landmark && year && year < 1935) return 'classical';
    return null;
}
/** Extra height (voxels above the playable roof) a landmark will need — GeoDistrict sizes the map with it. */
export function landmarkHeadroom(info, { storeys, cell = 0.9, storey = 3 }) {
    const partTop = Math.max(0, ...(info?.parts || []).map(p => Math.round(p.maxM / cell)));
    const fam = styleFamily(info), real = Math.max(info?.heightM ? Math.round(info.heightM / cell) : 0, partTop) || null, playable = storeys * storey + 1;
    const tall = real && real > playable + 3 ? real - playable : 0;
    return Math.max(tall, fam === 'colonial' ? 16 : fam === 'gothic' ? 7 : fam === 'classical' ? 4 : 0);
}

/**
 * Dress one built landmark. b: { group, records (wing records), cells ([x, y] footprint), info (GeoContext entry),
 * wall (material key), osmParts ([{ cells, minM, maxM, roofM, roofShape, material }] in map cells) }. Returns a report { style, parts: [...], cappedAt }.
 */
export function dressLandmark(m, { group, records, cells, info, wall = 'stone', osmParts = [] }) {
    const s = m.store, own = new Set(cells.map(([x, y]) => k2(x, y))), fam = styleFamily(info), parts = [];
    const main = records.find(r => r.wing === 0) || records[0];
    if (!main) return { style: fam, parts };
    const top = Math.max(...records.map(r => r.top)), base = main.baseZ, W = MAT[wall] ?? MAT.stone, trim = MAT.stucco, roofMat = MAT.roof;
    const cap = Math.min(s.height - 2, LANDMARK_MAX_HEIGHT);
    const vox = [];
    const put = (x, y, z, mat) => { if (z > cap || !s.inBounds(x, y, z)) return false; s.set(x, y, z, mat); vox.push([x, y, z]); return true; };
    const edge = (x, y) => own.has(k2(x, y)) && N4.some(([dx, dy]) => !own.has(k2(x + dx, y + dy)));
    const corners = cells.filter(([x, y]) => { const o = N4.map(([dx, dy]) => !own.has(k2(x + dx, y + dy))); return (o[0] || o[1]) && (o[2] || o[3]); });
    const keepClear = new Set((main.stairs || []).flatMap(st => [st.after, ...(st.cells || [])].filter(Boolean).map(c => k2(c.x, c.y))));
    const front = main.front || 's', door = main.entry || (main.exits || [])[0], [fx, fy] = OUT[front], along = fx ? [0, 1] : [1, 0];
    const tower = (cx, cy, size, z0, z1, capKind) => {
        const half = Math.floor(size / 2), cellsT = [];
        for (let dy = -half; dy < size - half; dy++) for (let dx = -half; dx < size - half; dx++) cellsT.push([cx + dx, cy + dy]);
        if (!cellsT.every(([x, y]) => own.has(k2(x, y)) && !keepClear.has(k2(x, y)))) return false;
        for (let z = z0; z <= z1; z++) for (const [x, y] of cellsT) {
            const rim = cellsT.some(([a, b]) => a === x && b === y) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !cellsT.some(([a, b]) => a === x + dx && b === y + dy));
            put(x, y, z, rim && (z - z0) % 4 === 2 && size >= 3 && (x + y) % 2 ? MAT.glass : W);
        }
        if (capKind === 'crenel') for (const [x, y] of cellsT) { const rim = N4.some(([dx, dy]) => !cellsT.some(([a, b]) => a === x + dx && b === y + dy)); if (rim && (x + y) % 2 === 0) put(x, y, z1 + 1, W); }
        if (capKind === 'spire') {
            // stepped steeple: shrink one cell a side every 3 levels, then a 1-cell spire
            let r = half, z = z1 + 1;
            while (r > 0) { for (let lv = 0; lv < 3; lv++, z++) for (let dy = -r + 1; dy < r; dy++) for (let dx = -r + 1; dx < r; dx++) put(cx + dx, cy + dy, z, lv === 2 ? trim : W); r--; }
            for (let lv = 0; lv < 4; lv++) put(cx, cy, z + lv, MAT.metal ?? W);
        }
        if (capKind === 'pyramid') { let r = half, z = z1 + 1; while (r >= 0) { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(cx + dx, cy + dy, z, roofMat); r--; z++; } }
        parts.push({ part: 'tower', at: [cx, cy], size, from: z0, to: z1, cap: capKind });
        return true;
    };
    // 0 OSM 3D parts (Simple 3D Buildings): every part that rises above the playable storeys, at its real height, with
    //   its own walls, window bands and roof shape — towers, steeples, cupolas
    let partTowers = 0;
    for (const p of osmParts.slice().sort((a, b) => a.maxM - b.maxM)) {
        const roofV = Math.round((p.roofM ?? (p.roofShape === 'flat' ? 0 : 0)) / 0.9), zTop = Math.min(cap, base + Math.round(p.maxM / 0.9)), zMin = base + Math.round(p.minM / 0.9);
        const zWall = Math.max(zMin, top + 1), zEave = zTop - roofV;
        if (zTop <= top + 1) continue;
        const pc = p.cells.filter(([x, y]) => s.inBounds(x, y, 0)), pset = new Set(pc.map(([x, y]) => k2(x, y)));
        if (!pc.length) continue;
        const pm = /brick/.test(p.material || '') ? MAT.brick : /stone/.test(p.material || '') ? MAT.stone : W;
        const rim = (x, y) => N4.some(([dx, dy]) => !pset.has(k2(x + dx, y + dy)));
        for (let z = zWall; z <= Math.max(zWall, zEave); z++) for (const [x, y] of pc) {
            if (z === zWall && zWall > top) put(x, y, z, MAT.concrete);                      // its floor over the roof
            else if (rim(x, y)) put(x, y, z, (z - zWall) % 4 === 2 && pc.length > 6 && (x + y) % 2 ? MAT.glass : pm);
        }
        // roof: flat slab, or a voxel stair toward the middle (gabled along the long axis; hipped/pyramidal/dome all
        // round), as tall as roof:height or half the narrow side
        const xs = pc.map(c => c[0]), ys = pc.map(c => c[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const shape = p.roofShape, gable = /gabled|saltbox/.test(shape), rise = roofV || (shape === 'flat' ? 0 : Math.max(1, Math.min(3, Math.floor(Math.min(x1 - x0 + 1, y1 - y0 + 1) / 2))));
        for (const [x, y] of pc) {
            if (shape === 'flat' || !rise) { put(x, y, Math.max(zWall, zEave) + 1, MAT.concrete_wall); continue; }
            const inX = Math.min(x - x0, x1 - x), inY = Math.min(y - y0, y1 - y), along = x1 - x0 >= y1 - y0;
            const step = gable ? (along ? inY : inX) : Math.min(inX, inY);
            const h = Math.min(rise, step + 1);
            for (let z = 1; z <= h; z++) put(x, y, Math.max(zWall, zEave) + z, /dome|onion|round/.test(shape) ? MAT.metal ?? roofMat : roofMat);
        }
        partTowers++;
    }
    if (partTowers) parts.push({ part: 'OSM 3D parts', count: partTowers });
    // 1 tall: the real height above the playable storeys, as an inset massing with setbacks and window bands
    const realTop = info?.heightM ? base + Math.round(info.heightM / 0.9) : null;
    if (!partTowers && realTop && realTop > top + 4) {
        const zTop = Math.min(realTop, cap), inset0 = fam === 'deco' ? 2 : 1;
        const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]), bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
        for (let z = top + 1; z <= zTop; z++) {
            const tier = Math.floor((z - top - 1) / 12), inset = inset0 + tier * (fam === 'deco' ? 2 : 1);
            for (let y = by0 + inset; y <= by1 - inset; y++) for (let x = bx0 + inset; x <= bx1 - inset; x++) {
                if (!own.has(k2(x, y)) || keepClear.has(k2(x, y))) continue;
                const rim = x === bx0 + inset || x === bx1 - inset || y === by0 + inset || y === by1 - inset;
                if (z === zTop) put(x, y, z, MAT.concrete_wall); else if (rim) put(x, y, z, (z - top) % 3 === 2 && (x + y) % 3 ? MAT.glass : W);
            }
        }
        parts.push({ part: 'upper massing', to: zTop, realTop, capped: realTop > cap });
    }
    // 2 gothic: crenellated parapet, corner turrets, twin towers at the entrance
    if (fam === 'gothic') {
        for (const [x, y] of cells) if (edge(x, y)) { put(x, y, top + 1, W); if ((x + y) % 2 === 0) put(x, y, top + 2, W); }
        parts.push({ part: 'crenellated parapet' });
        let n = 0;
        // a 2 × 2 turret on every outer corner, set into the footprint (a size-2 tower covers cx−1..cx)
        // only the four outermost corners (nearest each corner of the bounding box), as on a castle keep
        const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]), bb = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.min(...xs), Math.max(...ys)], [Math.max(...xs), Math.max(...ys)]];
        const outer = [...new Set(bb.map(([bx, by]) => corners.slice().sort((p, q) => Math.hypot(p[0] - bx, p[1] - by) - Math.hypot(q[0] - bx, q[1] - by))[0]).filter(Boolean))];
        for (const [x, y] of outer) if (tower(own.has(k2(x + 1, y)) ? x + 1 : x, own.has(k2(x, y + 1)) ? y + 1 : y, 2, top + 1, top + 4, 'crenel')) n++;
        parts.push({ part: 'corner turrets', count: n });
        if (door && !partTowers) {
            // inward from the entrance, both sides of it
            const bx = door.x - fx * 2, by = door.y - fy * 2;
            for (const sgn of [-1, 1]) tower(bx + along[0] * sgn * 4, by + along[1] * sgn * 4, 3, top + 1, Math.min(cap - 2, top + 7), 'crenel');
        }
    }
    // 3 colonial: clock tower with a steeple on the middle of the front
    // (only when the real height says there is a tower: not every Georgian building has one)
    if (fam === 'colonial' && door && !partTowers && info?.heightM && info.heightM > (main.storeys || 2) * 3.5 + 6) {
        const cx = door.x - fx * 3, cy = door.y - fy * 3;
        const zTop = Math.min(cap - 10, realTop ? Math.max(top + 6, realTop - 10) : top + 8);
        if (tower(cx, cy, 4, top + 1, zTop, 'spire')) {
            // a clock face: trim ring on the front of the top storey
            for (let o = -1; o <= 0; o++) put(cx + along[0] * o + fx * 2, cy + along[1] * o + fy * 2, zTop - 1, trim);
        }
    }
    // 4 classical: portico before the entrance (columns are real half cover), entablature, stepped pediment; cornice
    if ((fam === 'classical' || fam === 'deco') && door) {
        const span = Math.max(5, Math.min(13, Math.floor((fx ? main.d : main.w) * 0.5) | 1)), half = Math.floor(span / 2);
        const colTop = Math.min(top, base + 6), cols = [];
        const okCell = (x, y) => !own.has(k2(x, y)) && !ROADWAY.has(tagAt(m, x, y)) && s.topSolid(x, y) <= base && !m.keep?.has?.(`col:${x},${y}`);
        for (let i = -half; i <= half; i++) {
            const x = door.x + fx * 2 + along[0] * i, y = door.y + fy * 2 + along[1] * i;
            if (Math.abs(i) < 1 || i % 2) continue;                      // never in front of the door; every other cell
            if (!okCell(x, y)) continue;
            for (let z = base + 1; z <= colTop; z++) put(x, y, z, MAT.stone);
            cols.push([x, y]);
        }
        if (cols.length >= 2) {
            // entablature over the columns and the gap back to the facade, then a stepped pediment above it
            for (let i = -half; i <= half; i++) for (const dep of [1, 2]) {
                const x = door.x + fx * dep + along[0] * i, y = door.y + fy * dep + along[1] * i;
                if (!own.has(k2(x, y)) && !ROADWAY.has(tagAt(m, x, y))) put(x, y, colTop + 1, trim);
            }
            for (let lv = 0; lv <= half && lv < 4; lv++) for (let i = -half + lv * 2; i <= half - lv * 2; i++) {
                const x = door.x + along[0] * i, y = door.y + along[1] * i;
                put(x, y, Math.max(colTop, top) + 1 + lv, trim);
            }
            parts.push({ part: 'portico', columns: cols.length });
        }
        for (const [x, y] of cells) if (edge(x, y)) put(x, y, top + 1, trim);
        parts.push({ part: 'cornice' });
    }
    registerCells(m, vox, `building:${group}/landmark`);
    return { style: fam, parts, voxels: vox.length, cappedAt: cap };
}
