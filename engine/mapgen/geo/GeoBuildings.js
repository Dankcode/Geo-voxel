// Geo import — buildings with their real outlines.
//
// A footprint (a cell mask rasterised from the OSM polygon) is cut into rectangular WINGS that share their boundary
// wall lines. Cuts follow the outline's reflex corners (the approach of Camozzato et al., "Procedural floor plan
// generation from building sketches", SIGGRAPH 2015: extend the walls that meet at reflex corners to get an
// axis-aligned partition of the footprint), taken greedily as the largest rectangle left. Every wing is built by the
// existing ModernBuilder (shell, room plan, interior doors, stairs, glazing, furniture — the same parcel interior
// system every generated map uses), then the building is stitched:
//   * shared wing walls stay single and solid (no glass between wings), with a doorway on every storey;
//   * roof parapets along shared lines are removed where both roofs meet at one height;
//   * cells too thin for a wing (< 5 cells) are solid wall mass (thick walls, chimneys, bays);
//   * party walls between neighbouring real buildings are one wall line owned by both, never glazed.
// Each wing is a building record (like PLAN-14's merged parcels); records of one footprint share `group`.
import { MAT } from '../../voxel/Materials.js';
import { STOREY } from '../../mission/modern/ModernBuilder.js';
import { registerCells, k3 } from '../district/Core.js';

const k2 = (x, y) => `${x},${y}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const AIR = 0;
export const MIN_WING = 5;

/** Solidify or open a facade voxel and drop the window it may have carried (hint, opening, window record). */
function retire(m, records, x, y, z) {
    delete m.hints[`${x},${y},${z}`];
    for (const r of records) { r.windows = r.windows.filter(w => !(w.x === x && w.y === y && (w.z === z || w.z === z - 1))); }
    for (const fz of [z - 1, z - 2]) m.store.windowOpenings?.delete?.(`${x},${y},${fz}`);
}
export function wallAt(m, records, x, y, z, mat) { retire(m, records, x, y, z); m.store.set(x, y, z, mat); }
export function openAt(m, records, x, y, z) { retire(m, records, x, y, z); m.store.set(x, y, z, AIR); }     // cells, walls included: a 3 × 3 interior is the smallest room plan

/** Largest axis-aligned rectangle of cells in `set` (histogram method). Returns { x0, y0, w, d } or null. */
export function largestRectangle(set, box) {
    const W = box.x1 - box.x0 + 1, H = box.y1 - box.y0 + 1, h = new Int32Array(W);
    let best = null, bestA = 0;
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) h[i] = set.has(k2(box.x0 + i, box.y0 + j)) ? h[i] + 1 : 0;
        const st = [];
        for (let i = 0; i <= W; i++) {
            const cur = i < W ? h[i] : 0;
            while (st.length && h[st[st.length - 1]] >= cur) {
                const top = st.pop(), height = h[top], left = st.length ? st[st.length - 1] + 1 : 0, width = i - left;
                // prefer squarer wings at equal area: they plan into better rooms
                const a = height * width - (Math.abs(height - width) > 3 * Math.min(height, width) ? 0.5 : 0);
                if (height && width && a > bestA) { bestA = a; best = { x0: box.x0 + left, y0: box.y0 + j - height + 1, w: width, d: height }; }
            }
            st.push(i);
        }
    }
    return best;
}

/**
 * Wings of a mask: rectangles that share boundary lines (overlap by exactly one cell row/column where they meet).
 * Returns { wings: [{x0,y0,w,d}], mass: [[x,y]] (mask cells no wing covers) }.
 */
export function decomposeFootprint(cells, { minWing = MIN_WING, maxWings = 8 } = {}) {
    const mask = new Set(cells.map(([x, y]) => k2(x, y))), remaining = new Set(mask);
    const box = { x0: Math.min(...cells.map(c => c[0])), y0: Math.min(...cells.map(c => c[1])), x1: Math.max(...cells.map(c => c[0])), y1: Math.max(...cells.map(c => c[1])) };
    const wings = [], covered = new Set();
    while (wings.length < maxWings) {
        const r = largestRectangle(remaining, box);
        if (!r || r.w < minWing || r.d < minWing) break;
        wings.push(r);
        const inR = (x, y) => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d;
        const drop = [];
        for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) {
            covered.add(k2(x, y));
            const edge = x === r.x0 || y === r.y0 || x === r.x0 + r.w - 1 || y === r.y0 + r.d - 1;
            // a boundary cell next to unclaimed mask stays available: the next wing shares this wall line
            const shared = edge && N4.some(([dx, dy]) => !inR(x + dx, y + dy) && remaining.has(k2(x + dx, y + dy)) && !covered.has(k2(x + dx, y + dy)));
            if (!shared) drop.push(k2(x, y));
        }
        for (const k of drop) remaining.delete(k);
        // stop if what is left is only the shared lines themselves
        if (![...remaining].some(k => !covered.has(k))) break;
    }
    const mass = cells.filter(([x, y]) => !covered.has(k2(x, y)));
    return { wings, mass };
}

/**
 * Clean a raw mask: drop spur cells (fewer than two 4-neighbours) and fill single-cell holes.
 */
export function cleanMask(cells) {
    let set = new Set(cells.map(([x, y]) => k2(x, y)));
    for (let it = 0; it < 4; it++) {
        const drop = [...set].filter(k => { const [x, y] = k.split(',').map(Number); return N4.filter(([dx, dy]) => set.has(k2(x + dx, y + dy))).length < 2; });
        if (!drop.length) break; for (const k of drop) set.delete(k);
    }
    const xs = [...set].map(k => +k.split(',')[0]), ys = [...set].map(k => +k.split(',')[1]);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++)
        if (!set.has(k2(x, y)) && N4.filter(([dx, dy]) => set.has(k2(x + dx, y + dy))).length >= 3) set.add(k2(x, y));
    return [...set].map(k => k.split(',').map(Number));
}

/**
 * Resolve real footprints against each other. Genuine overlaps (mapping errors) go to the larger building. Then,
 * where two footprints touch (4-adjacent cells), the larger one also claims the smaller one's boundary cells: both
 * build their wall on that one line — a single party wall, owned by both, as in a real terrace. Input:
 * [{ id, cells, area }]. Mutates cells; returns the set of party-wall cell keys.
 */
export function resolveParty(footprints) {
    const owner = new Map();
    for (const f of footprints.slice().sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1)))
        for (const [x, y] of f.cells) if (!owner.has(k2(x, y))) owner.set(k2(x, y), f);
    const masks = new Map(footprints.map(f => [f, new Set()]));
    for (const [k, f] of owner) masks.get(f).add(k);
    const party = new Set();
    for (const [k, f] of owner) {
        const [x, y] = k.split(',').map(Number);
        for (const [dx, dy] of N4) {
            const g = owner.get(k2(x + dx, y + dy));
            if (!g || g === f) continue;
            // the larger (then lower id) footprint extends onto the other's boundary cell
            const big = f.area > g.area || f.area === g.area && f.id < g.id ? f : g, small = big === f ? g : f;
            const cell = big === f ? k2(x + dx, y + dy) : k;
            if (owner.get(cell) !== small) continue;
            masks.get(big).add(cell); party.add(cell);
        }
    }
    for (const f of footprints) f.cells = [...masks.get(f)].map(s => s.split(',').map(Number));
    return party;
}

const sideOf = (r, side) => {
    const out = [];
    if (side === 'n' || side === 's') { const y = side === 'n' ? r.y0 : r.y0 + r.d - 1; for (let x = r.x0; x < r.x0 + r.w; x++) out.push([x, y]); }
    else { const x = side === 'w' ? r.x0 : r.x0 + r.w - 1; for (let y = r.y0; y < r.y0 + r.d; y++) out.push([x, y]); }
    return out;
};
const OUT = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/**
 * Build one real building. b: { id, name, program, storeys, baseZ, cells, frontScore(side, cells) → number,
 * wall?, roof? }. shared: { occupied:Set (cells of every footprint), party:Set }. m: the MapKit map.
 * Returns { records, wings, mass, doors } and pushes records into m.buildings (via m.building).
 */
export function buildFootprint(m, b, { occupied, party, furnish = true } = {}) {
    const { wings, mass: rawMass } = decomposeFootprint(b.cells);
    const s = m.store, own = new Set(b.cells.map(([x, y]) => k2(x, y))), records = [], wingDoors = [];
    // a footprint a few degrees off the grid leaves thin staircase slivers outside its wing rectangles; built solid
    // they wall up every door on that side, so an outer sliver (≤ 2 cells from a wing, not a party wall, not
    // touching another building) is pavement, not mass
    const wingDist = (x, y) => Math.min(...wings.map(r => Math.max(r.x0 - x, x - (r.x0 + r.w - 1), 0) + Math.max(r.y0 - y, y - (r.y0 + r.d - 1), 0)));
    const fringe = [], mass = [];
    for (const [x, y] of rawMass) {
        const thin = wings.length && wingDist(x, y) <= 2 && !party.has(k2(x, y)) && ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => occupied.has(k2(x + dx, y + dy)) && !own.has(k2(x + dx, y + dy)));
        (thin ? fringe : mass).push([x, y]);
    }
    if (!wings.length) {
        // too small to stand as a room: a solid kiosk block keeps the footprint
        const top = b.baseZ + STOREY;
        for (const [x, y] of b.cells) { for (let z = b.baseZ + 1; z <= top; z++) s.set(x, y, z, MAT[b.wall || 'brick']); }
        registerCells(m, b.cells.flatMap(([x, y]) => Array.from({ length: STOREY }, (_, i) => [x, y, b.baseZ + 1 + i])), `building:${b.id}/mass`);
        return { records, wings, mass: b.cells, doors: [] };
    }
    const inWing = (r, x, y) => x >= r.x0 && y >= r.y0 && x < r.x0 + r.w && y < r.y0 + r.d;
    // exterior share of each wing side: cells whose outward neighbour is outside every footprint
    const fr = new Set(fringe.map(([x, y]) => k2(x, y)));
    const exposure = (r, side) => { const [dx, dy] = OUT[side], cs = sideOf(r, side); return cs.filter(([x, y]) => !occupied.has(k2(x + dx, y + dy)) || fr.has(k2(x + dx, y + dy))).length / cs.length; };
    wings.forEach((r, i) => {
        const sides = ['n', 'e', 's', 'w'].map(side => ({ side, exp: exposure(r, side), score: b.frontScore ? b.frontScore(side, sideOf(r, side)) : 0 }));
        const front = sides.filter(q => q.exp >= 0.6).sort((a, c) => c.score - a.score || c.exp - a.exp)[0]?.side || sides.sort((a, c) => c.exp - a.exp)[0].side;
        const id = i === 0 ? b.id : `${b.id}-w${i + 1}`;
        const rec = m.building({ id, name: b.name || b.id, program: b.program, x0: r.x0, y0: r.y0, w: r.w, d: r.d, baseZ: b.baseZ, storeys: b.storeys, front,
            ...(b.wall ? { wall: b.wall } : {}), ...(b.roof ? { roof: b.roof } : {}), ...(b.floor ? { floor: b.floor } : {}), ...(b.programDef ? { programDef: b.programDef } : {}), furnish, foundation: true });
        rec.group = b.id; rec.osm = b.osm || null; rec.realName = b.name || null; rec.wing = i;
        records.push(rec);
    });
    for (const rec of records) rec.mergedWith = records.filter(o => o !== rec).map(o => o.id);
    const top = records[0].top, wallMat = MAT[records[0].wall] ?? MAT.brick;
    // --- shared wing lines: solid wall on every storey, one doorway per storey, no parapet across a flat roof
    for (let a = 0; a < wings.length; a++) for (let c = a + 1; c < wings.length; c++) {
        const A = wings[a], C = wings[c], line = [];
        for (let y = Math.max(A.y0, C.y0); y < Math.min(A.y0 + A.d, C.y0 + C.d); y++) for (let x = Math.max(A.x0, C.x0); x < Math.min(A.x0 + A.w, C.x0 + C.w); x++) line.push([x, y]);
        if (line.length < 3) continue;
        const vertical = line.every(([x]) => x === line[0][0]);
        const across = vertical ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
        for (let st = 0; st < b.storeys; st++) {
            const fz = b.baseZ + STOREY * st;
            for (const [x, y] of line) for (let h = 1; h < STOREY; h++) { const v = s.get(x, y, fz + h); if (v === MAT.glass || v === AIR) wallAt(m, records, x, y, fz + h, wallMat); }
            // doorway where both sides stand free (no partition, stair or furniture right behind it)
            const free = (x, y) => s.get(x, y, fz + 1) === AIR && s.get(x, y, fz + 2) === AIR && s.isSolid(x, y, fz);
            const cands = line.slice(1, -1).filter(([x, y]) => across.every(([dx, dy]) => free(x + dx, y + dy)));
            const mid = line[Math.floor(line.length / 2)];
            cands.sort((p, q) => Math.abs(p[0] - mid[0]) + Math.abs(p[1] - mid[1]) - Math.abs(q[0] - mid[0]) - Math.abs(q[1] - mid[1]));
            const d = cands[0];
            if (d) {
                for (let h = 1; h < STOREY; h++) openAt(m, records, d[0], d[1], fz + h);
                s.set(d[0], d[1], fz, s.get(d[0] + across[0][0], d[1] + across[0][1], fz));
                wingDoors.push({ x: d[0], y: d[1], z: fz, storey: st, between: [records[a].id, records[c].id] });
                for (const rec of [records[a], records[c]]) rec.doors.push({ x: d[0], y: d[1], z: fz, storey: st, exterior: false, open: true, wing: true });
            }
        }
        for (const [x, y] of line) if (s.get(x, y, top + 1) === wallMat && across.every(([dx, dy]) => s.get(x + dx, y + dy, top) !== AIR && s.get(x + dx, y + dy, top + 1) === AIR)) s.set(x, y, top + 1, AIR);
    }
    // --- party walls with neighbouring buildings: never glazed, never a door
    for (const rec of records) for (const [x, y] of sideOf(rec, 'n').concat(sideOf(rec, 's'), sideOf(rec, 'e'), sideOf(rec, 'w'))) {
        if (!party.has(k2(x, y))) continue;
        for (let st = 0; st < b.storeys; st++) for (let h = 1; h < STOREY; h++) { const z = b.baseZ + STOREY * st + h, v = s.get(x, y, z); if (v === MAT.glass || v === MAT.door || v === AIR) wallAt(m, records, x, y, z, wallMat); }
    }
    // --- exterior doors that open into a sibling wing: the landing behind them must be walkable
    for (const rec of records) for (const e of rec.exits || []) {
        const [dx, dy] = OUT[e.side] || [0, 0], X = e.x + dx, Y = e.y + dy;
        const sib = records.find(o => o !== rec && inWing(o, X, Y));
        if (sib) { for (let h = 1; h < STOREY; h++) openAt(m, records, X, Y, b.baseZ + h); e.internal = sib.id; }
    }
    // --- leftover mass: solid wall to the roofline (registered so the prop-origin gate knows why it stands)
    const massVox = [];
    for (const [x, y] of mass) {
        for (let z = 1; z < b.baseZ; z++) if (!s.isSolid(x, y, z)) s.set(x, y, z, MAT.concrete);
        s.set(x, y, b.baseZ, MAT.concrete);
        for (let z = b.baseZ + 1; z <= top; z++) { s.set(x, y, z, z === top ? MAT.concrete : wallMat); massVox.push([x, y, z]); }
    }
    registerCells(m, massVox, `building:${b.id}/mass`);
    for (const [x, y] of fringe) { for (let z = 1; z < b.baseZ; z++) if (!s.isSolid(x, y, z)) s.set(x, y, z, MAT.stone); s.set(x, y, b.baseZ, MAT.paving); }
    return { records, wings, mass, fringe, doors: wingDoors };
}

/** Footprint fidelity: IoU of the built cells (wing rectangles ∪ mass) against the source mask. */
export function footprintIoU(cells, result) {
    const src = new Set(cells.map(([x, y]) => k2(x, y))), built = new Set(result.mass.map(([x, y]) => k2(x, y)));
    for (const r of result.wings) for (let y = r.y0; y < r.y0 + r.d; y++) for (let x = r.x0; x < r.x0 + r.w; x++) built.add(k2(x, y));
    let inter = 0; for (const k of built) if (src.has(k)) inter++;
    return inter / (src.size + built.size - inter);
}
export { k3 };

/**
 * After every footprint is built: an exterior door whose outside cell is solid (own wall mass, a neighbour's party
 * wall, a later building) becomes wall again and leaves the exit list. Returns the number of doors closed.
 */
export function closeDeadExits(m, records) {
    const s = m.store, OUTV = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
    let closed = 0;
    for (const rec of records) {
        const wallMat = MAT[rec.wall] ?? MAT.brick, keep = [];
        for (const e of rec.exits || []) {
            const [dx, dy] = OUTV[e.side] || [0, 0], X = e.x + dx, Y = e.y + dy;
            // a door into another real building (back-to-back doors through a party wall) is not an exit either
            const foreign = records.some(o => o.group !== rec.group && X >= o.x0 && Y >= o.y0 && X < o.x0 + o.w && Y < o.y0 + o.d);
            const blocked = foreign || !s.inBounds(X, Y, rec.baseZ + 2) || [1, 2].some(h => s.isSolid(X, Y, rec.baseZ + h)) || !s.isSolid(X, Y, rec.baseZ) && !s.isSolid(X, Y, rec.baseZ - 1);
            if (!blocked) { keep.push(e); continue; }
            for (let h = 1; h < STOREY; h++) wallAt(m, [rec], e.x, e.y, rec.baseZ + h, wallMat);
            rec.doors = rec.doors.filter(d => !(d.exterior && d.x === e.x && d.y === e.y));
            for (let h = 1; h <= STOREY; h++) m.keep.delete?.(k2(X, Y));
            closed++;
        }
        rec.exits = keep;
        if (rec.entry && !keep.includes(rec.entry)) rec.entry = keep.find(e => e.entry) || keep[0] || null;
    }
    return closed;
}
