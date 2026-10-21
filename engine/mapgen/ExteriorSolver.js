// PLAN-04 §5.3 steps 2–3 — the exterior as a hierarchical, field-guided WFC (Alaka & Bidarra-style meta-tiles over
// XCOM 2's plot → parcel → piece hierarchy):
//
//   district  per 16 × 16 block quad      commercial / residential / industrial / park / plaza / yard
//   lot       per 8 × 8 lot               parcel templates; multi-lot parcels are meta-tiles whose parts must assemble,
//                                         street frontage must face a road, two flush building walls never meet
//   bay       per 2 × 2 cells (per lot)   cover, vehicles, trees and street furniture as WFC tiles with sockets:
//                                         cars on lanes along the road, benches along sidewalks, runs that join, no
//                                         two props touching (nothing seals a street), cover facing the advance
//
// Guide fields bias every stage through the solver's node weights; WFC still guarantees adjacency. Gameplay fields
// come first: the line of play, its flanks, the spawn and the underground openings are protected before any piece
// is chosen, and engagement pockets are pinned into the bay solve as seeds.
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
import { LOT, BAY } from './KitMetric.js';
import { LOT_KINDS, BAY_PIECES, PIECE_POOLS, lotKindsFor, objectiveKindFor, groupSize, buildingRect, DISTRICT_WALLS, DISTRICT_PALETTE, WING_PROGRAM } from './LotCatalogue.js';
import { plotLot, SIDE_VEC, OPPOSITE } from './PlotCatalogue.js';
import { fbm, NOISE_LAYERS } from './Fields.js';
import { hashString } from '../util/Rng.js';

const SIDES = ['n', 'e', 's', 'w'];
const unit = s => (hashString(s) >>> 0) / 4294967296;
const noiseAt = (seed, layer, x, y) => fbm(`${seed}:${layer}`, x, y, NOISE_LAYERS[layer]);
/** Each tile kind prefers its own band of the noise, so noise shifts the mix region by region instead of per tile. */
const noisePref = (kind, n) => 0.35 + 1.3 * Math.max(0, 1 - 2.2 * Math.abs(n - unit(`pref:${kind}`)));

// ------------------------------------------------------------------------------------------------ ground
/**
 * Road lots are shaped by their road connections: a 4-cell carriageway band toward every connected side, 2-cell
 * sidewalks elsewhere and a turning circle at a dead end (road paint is a client overlay, PLAN-12).
 */
export function roadLotCells(c) {
    const any = c.n || c.e || c.s || c.w, conn = SIDES.filter(s => c[s]).length, dead = conn === 1;
    const cells = [];
    for (let cy = 0; cy < LOT; cy++) for (let cx = 0; cx < LOT; cx++) {
        const bx = cy >= 2 && cy <= 5, by = cx >= 2 && cx <= 5;
        let asph = any && ((bx && ((cx < 2 && c.w) || (cx > 5 && c.e) || by)) || (by && ((cy < 2 && c.n) || (cy > 5 && c.s) || bx)));
        if (dead && cx >= 1 && cx <= 6 && cy >= 1 && cy <= 6) asph = true;
        let mat = asph ? 'asphalt' : 'concrete', cls = asph ? 'asphalt' : 'sidewalk';
        const straightX = (c.e || c.w) && !c.n && !c.s, straightY = (c.n || c.s) && !c.e && !c.w;
        // PLAN-12: no painted voxel cells for lines — a whole 1 m cell cannot centre a line on a 4-cell carriageway or draw a
        // zebra. Road paint is drawn thin and centred by the client (client/src/render/RoadMarkings.js) from the asphalt.
        // Parking lane: carriageway cells next to the kerb on straight roads.
        if (asph && straightX && cy >= 2 && cy <= 5) cls = 'lane_x';
        if (asph && straightY && cx >= 2 && cx <= 5) cls = 'lane_y';
        cells.push({ cx, cy, mat, cls });
    }
    return cells;
}

// ------------------------------------------------------------------------------------------------ districts
const FORBIDDEN = new Set(['industrial|residential', 'residential|industrial', 'park|industrial', 'industrial|park', 'plaza|industrial', 'industrial|plaza']);
export function solveDistricts(plot, fields, seed) {
    const QW = Math.ceil(plot.LW / 2), QD = Math.ceil(plot.LD / 2), nodes = [], ids = new Set();
    for (let qy = 0; qy < QD; qy++) for (let qx = 0; qx < QW; qx++) {
        const lots = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => plotLot(plot, qx * 2 + a, qy * 2 + b)).filter(l => l && !l.road);
        if (lots.length) ids.add(`${qx},${qy}`);
    }
    for (const id of ids) {
        const [qx, qy] = id.split(',').map(Number);
        nodes.push({ id, neighbors: SIDES.map(s => `${qx + SIDE_VEC[s][0]},${qy + SIDE_VEC[s][1]}`).filter(n => ids.has(n)).map(n => ({ id: n, direction: 'adj' })) });
    }
    const tiles = Object.entries(plot.districts).map(([id, w]) => ({ id, weight: w }));
    const weights = (nodeId, tile) => {
        const [qx, qy] = nodeId.split(',').map(Number), x0 = qx * 16, y0 = qy * 16;
        const built = fields.prior.building.mean(x0, y0, x0 + 15, y0 + 15), green = fields.prior.green.mean(x0, y0, x0 + 15, y0 + 15);
        const open = tile === 'park' || tile === 'plaza' || tile === 'yard';
        const prior = open ? 0.55 + green - 0.4 * built : 0.7 + built;
        return plot.districts[tile] * Math.max(0.05, prior) * noisePref(`district:${tile}`, noiseAt(seed, 'district', x0 + 8, y0 + 8));
    };
    let solved;
    for (let attempt = 0; attempt < 6 && !solved; attempt++) {
        try { solved = solveWaveFunctionCollapse({ nodes, tiles, nodeWeights: weights, compatible: (a, b) => !FORBIDDEN.has(`${a}|${b}`), seed: `${plot.family}:${seed}:districts:${attempt}` }); }
        catch (e) { if (attempt === 5) throw Error(`exterior.district: ${e.message}`); }
    }
    return { at: (lx, ly) => solved.get(`${lx >> 1},${ly >> 1}`) || Object.keys(plot.districts)[0], quads: Object.fromEntries(solved) };
}

// ------------------------------------------------------------------------------------------------ lots
function lotTileCatalog(family) {
    const tiles = new Map();
    const add = t => tiles.set(t.id, t);
    for (const kind of [...lotKindsFor(family), objectiveKindFor(family)]) {
        const k = LOT_KINDS[kind];
        if (!k.building && k.size[0] === 1 && k.size[1] === 1) { add({ id: kind, kind, front: null, i: 0, j: 0, gw: 1, gd: 1, open: true }); continue; }
        for (const front of SIDES) {
            const [gw, gd] = groupSize(kind, front);
            for (let j = 0; j < gd; j++) for (let i = 0; i < gw; i++) add({ id: `${kind}|${front}|${i},${j}`, kind, front, i, j, gw, gd, open: false, objective: !!k.objective });
        }
    }
    // Side sockets: P inside a parcel, else the template's S / W / O.
    for (const t of tiles.values()) {
        t.sockets = {};
        const rect = t.open ? null : buildingRect(t.kind, { x0: 0, y0: 0, w: t.gw * LOT, d: t.gd * LOT }, t.front);
        for (const s of SIDES) {
            const [dx, dy] = SIDE_VEC[s], ii = t.i + dx, jj = t.j + dy;
            t.sockets[s] = !t.open && ii >= 0 && jj >= 0 && ii < t.gw && jj < t.gd ? 'P' : rect ? rect.sockets[s] : 'O';
        }
    }
    return tiles;
}

export function lotCompatible(tiles) {
    return (a, b, dir) => {
        const ta = tiles.get(a), tb = tiles.get(b);
        if (!ta || !tb) return true;           // roads / context
        const back = OPPOSITE[dir], sa = ta.sockets[dir], sb = tb.sockets[back];
        if (sa === 'P' || sb === 'P') {
            if (sa !== 'P' || sb !== 'P') return false;
            const [dx, dy] = SIDE_VEC[dir];
            return ta.kind === tb.kind && ta.front === tb.front && tb.i === ta.i + dx && tb.j === ta.j + dy;
        }
        return !(sa === 'W' && sb === 'W');
    };
}

/**
 * Lot WFC over the non-road lots. Multi-lot parcels must assemble from their parts, frontage must face a road,
 * the objective parcel is pinned, districts gate which kinds may stand where. Returns lot assignments and parcels.
 */
export function solveLots(plot, districts, fields, seed) {
    const tiles = lotTileCatalog(plot.family), compatible = lotCompatible(tiles);
    const isRoad = (lx, ly) => !!plotLot(plot, lx, ly)?.road;
    const inside = (lx, ly) => lx >= 0 && ly >= 0 && lx < plot.LW && ly < plot.LD;
    const okind = objectiveKindFor(plot.family), O = plot.objective;
    const objective = new Map();
    {
        const [gw, gd] = groupSize(okind, O.front);
        for (let j = 0; j < gd; j++) for (let i = 0; i < gw; i++) objective.set(`${O.lx + i},${O.ly + j}`, `${okind}|${O.front}|${i},${j}`);
    }
    const nodes = [], domains = new Map(), fixed = new Map();
    for (const lot of plot.lots) {
        if (lot.road) continue;
        const id = `${lot.lx},${lot.ly}`;
        nodes.push({ id, neighbors: SIDES.map(s => [s, lot.lx + SIDE_VEC[s][0], lot.ly + SIDE_VEC[s][1]]).filter(([, x, y]) => inside(x, y) && !isRoad(x, y)).map(([s, x, y]) => ({ id: `${x},${y}`, direction: s })) });
        if (objective.has(id)) { fixed.set(id, objective.get(id)); domains.set(id, [objective.get(id)]); continue; }
        const domain = [];
        for (const t of tiles.values()) {
            if (t.objective) continue;
            const k = LOT_KINDS[t.kind], ox = lot.lx - t.i, oy = lot.ly - t.j;
            let ok = true;
            for (let j = 0; j < t.gd && ok; j++) for (let i = 0; i < t.gw && ok; i++) {
                const gx = ox + i, gy = oy + j;
                if (!inside(gx, gy) || isRoad(gx, gy) || objective.has(`${gx},${gy}`) || (k.districts && !k.districts.includes(districts.at(gx, gy)))) ok = false;
            }
            if (ok && !t.open) {
                // Every lot along the frontage edge faces a road.
                const [dx, dy] = SIDE_VEC[t.front];
                for (let j = 0; j < t.gd && ok; j++) for (let i = 0; i < t.gw && ok; i++) {
                    const edge = i + dx < 0 || i + dx >= t.gw || j + dy < 0 || j + dy >= t.gd;
                    if (edge && !isRoad(ox + i + dx, oy + j + dy)) ok = false;
                }
            }
            if (ok && t.open && k.districts && !k.districts.includes(districts.at(lot.lx, lot.ly))) ok = false;
            if (ok) domain.push(t.id);
        }
        if (!domain.length) domain.push('vacant_lot');
        domains.set(id, domain);
    }
    // The prior sets the building/open balance per lot; the many open kinds and the many building parts each share
    // their side's weight, so neither side wins just by having more tile variants.
    const share = new Map([...domains].map(([id, d]) => [id, { b: d.filter(t => !tiles.get(t).open).length || 1, o: d.filter(t => tiles.get(t).open).length || 1 }]));
    const weightOf = (nodeId, tileId) => {
        const t = tiles.get(tileId), k = LOT_KINDS[t.kind], [lx, ly] = nodeId.split(',').map(Number), x0 = lx * LOT, y0 = ly * LOT;
        const P = fields.prior, built = Math.max(0.15, Math.min(0.9, P.building.mean(x0, y0, x0 + 7, y0 + 7))), green = P.green.mean(x0, y0, x0 + 7, y0 + 7), paved = P.paved.mean(x0, y0, x0 + 7, y0 + 7);
        let prior = (k.building ? built / share.get(nodeId).b * 4 : (1 - built) / share.get(nodeId).o * 4);
        if (['pocket_park', 'backyard', 'house'].includes(t.kind)) prior *= 0.6 + green;
        if (['plaza', 'parking_lot', 'subway_plaza'].includes(t.kind)) prior *= 0.6 + paved;
        const n = noisePref(`lot:${t.kind}`, noiseAt(seed, 'lot', x0 + 4, y0 + 4));
        const dl = fields.play.dist.get(x0 + 4, y0 + 4), H = fields.height.get(x0 + 4, y0 + 4);
        let g = 1;
        if (dl <= 6) g *= k.building ? 0.8 : ['parking_lot', 'plaza', 'depot_yard', 'construction_site', 'container_yard'].includes(t.kind) ? 1.8 : 1.2;
        else if (dl <= 14) g *= k.building ? 1.25 : 0.9;
        if (k.building) g *= 0.6 + H * (k.building.storeys[1] >= 3 ? 1.2 : 0.6);
        return (k.w ?? 1) * Math.max(0.02, prior) * n * g;
    };
    let assignment = null, last;
    for (let attempt = 0; attempt < 8 && !assignment; attempt++) {
        try { assignment = solveWaveFunctionCollapse({ nodes, tiles: [...tiles.values()].map(t => ({ id: t.id, weight: 1 })), domains, fixed, nodeWeights: weightOf, compatible, seed: `${plot.family}:${seed}:lots:${attempt}` }); }
        catch (e) { last = e; }
    }
    if (!assignment) throw Error(`exterior.lot: ${last?.message}`);
    // Parcels: one per assembled group (anchored at its 0,0 part).
    const parcels = [], byLot = new Map();
    for (const [id, tileId] of [...assignment].sort((a, b) => { const [ax, ay] = a[0].split(',').map(Number), [bx, by] = b[0].split(',').map(Number); return ay - by || ax - bx; })) {
        const t = tiles.get(tileId), [lx, ly] = id.split(',').map(Number);
        if (t.i !== 0 || t.j !== 0) continue;
        const parcel = { id: `p${parcels.length}`, kind: t.kind, front: t.front, lx, ly, gw: t.gw, gd: t.gd, x0: lx * LOT, y0: ly * LOT, w: t.gw * LOT, d: t.gd * LOT, district: districts.at(lx, ly), objective: !!t.objective };
        parcels.push(parcel);
        for (let j = 0; j < t.gd; j++) for (let i = 0; i < t.gw; i++) byLot.set(`${lx + i},${ly + j}`, parcel);
    }
    return { assignment: Object.fromEntries(assignment), parcels, byLot, tiles };
}

/**
 * Building records from building parcels: footprint (kit metric), storeys from height intent, district materials.
 * PLAN-14: each parcel picks one of its kind's footprint variants (never larger than the template, so lot sockets
 * hold), and a share of parcels are merged with a lower attached wing — a second building record touching the main
 * block's back or side wall, with its own programme, height and wall material — so blocks read as L, T and stepped
 * shapes instead of the same box every time.
 */
export function placeBuildings(plot, parcels, fields, seed) {
    const out = [];
    for (const p of parcels) {
        const k = LOT_KINDS[p.kind]; if (!k.building) continue;
        const t = k.building, n = noiseAt(seed, 'wear', p.x0 + 8, p.y0 + 8);
        const variants = (!p.objective && t.variants) || [[t.along, t.deep]];
        const dims = variants[Math.floor(unit(`${seed}:${p.id}:variant`) * variants.length)];
        const slack = (p.front === 'n' || p.front === 's' ? p.w : p.d) - dims[0];
        const wantWing = !p.objective && unit(`${seed}:${p.id}:wing`) < 0.75;
        // A merged parcel pushes the main block to one end so its wing has room beside it.
        const shift = wantWing && slack >= 5 ? (unit(`${seed}:${p.id}:shift`) < 0.5 ? -slack : slack) : slack > 1 ? Math.round((unit(`${seed}:${p.id}:shift`) - 0.5) * 2) : 0;
        const rect = buildingRect(p.kind, p, p.front, shift, dims);
        const H = fields.height.mean(rect.x0, rect.y0, rect.x0 + rect.w - 1, rect.y0 + rect.d - 1);
        const [lo, hi] = t.storeys, storeys = p.objective ? hi : Math.max(lo, Math.min(hi, lo + Math.floor(H * (hi - lo + 1.2))));
        const walls = DISTRICT_WALLS[p.district] || DISTRICT_WALLS.commercial;
        const palette = DISTRICT_PALETTE[p.district] || DISTRICT_PALETTE.commercial;
        const wall = walls[Math.floor(n * walls.length) % walls.length];
        const main = { id: p.objective ? 'objective' : `b${out.length}`, parcel: p.id, kind: p.kind, program: t.program, district: p.district, x0: rect.x0, y0: rect.y0, w: rect.w, d: rect.d,
            storeys, front: p.front, margins: rect.margins, wall, roof: 'flat',
            accent: palette[Math.floor(unit(`${seed}:${p.id}:accent`) * palette.length)], objective: p.objective };
        out.push(main);
        if (wantWing) {
            const wing = planWing(main, p, seed, walls.filter(x => x !== wall)[0] || wall, palette);
            if (wing) { wing.id = `b${out.length}`; out.push(wing); }
        }
    }
    return out;
}
const odd = v => (v % 2 ? v : v - 1);
/** An attached wing behind or beside `main` inside parcel `p` (or null when the margins are too tight). */
function planWing(main, p, seed, wall, palette) {
    const B = OPPOSITE[main.front], ns = main.front === 'n' || main.front === 's';
    const perp = ns ? ['w', 'e'] : ['n', 's'];
    const options = [];
    // Back wing (T / L): 5–7 deep behind the block (up to the parcel edge when the margin is exactly 5).
    if (main.margins[B] >= 5) for (const wa of [9, 7]) if (wa <= (ns ? main.w : main.d) - 2) { options.push({ kind: 'back', wd: odd(Math.min(7, main.margins[B] >= 6 ? main.margins[B] - 1 : main.margins[B])), wa }); break; }
    // Side wing (stepped frontage): 5–7 wide beside the block, set back two cells from the street face.
    for (const S of perp) if (main.margins[S] >= 5) options.push({ kind: 'side', S, ww: odd(Math.min(7, main.margins[S] >= 6 ? main.margins[S] - 1 : main.margins[S])) });
    if (!options.length) return null;
    const o = options[Math.floor(unit(`${seed}:${p.id}:wing-kind`) * options.length)];
    let x0, y0, w, d, front, touch;
    if (o.kind === 'back') {
        const along = ns ? main.w : main.d, at = ['start', 'end', 'mid'][Math.floor(unit(`${seed}:${p.id}:wing-at`) * 3)];
        const off = at === 'start' ? 0 : at === 'end' ? along - o.wa : (along - o.wa) >> 1;
        if (ns) { w = o.wa; d = o.wd; x0 = main.x0 + off; y0 = B === 's' ? main.y0 + main.d : main.y0 - d; }
        else { w = o.wd; d = o.wa; y0 = main.y0 + off; x0 = B === 'e' ? main.x0 + main.w : main.x0 - w; }
        touch = B;
        // The wing's door faces whichever free side is wider.
        const ends = ns ? [['w', x0 - p.x0], ['e', p.x0 + p.w - (x0 + w)]] : [['n', y0 - p.y0], ['s', p.y0 + p.d - (y0 + d)]];
        front = ends.sort((a, c) => c[1] - a[1])[0][0];
    } else {
        const deep = ns ? main.d : main.w, wd = Math.max(5, odd(deep - 2));
        if (ns) { w = o.ww; d = wd; x0 = o.S === 'e' ? main.x0 + main.w : main.x0 - w; y0 = main.front === 'n' ? main.y0 + (deep - wd) : main.y0; }
        else { w = wd; d = o.ww; y0 = o.S === 's' ? main.y0 + main.d : main.y0 - d; x0 = main.front === 'w' ? main.x0 + (deep - wd) : main.x0; }
        touch = o.S; front = main.front;
    }
    if (x0 < p.x0 || y0 < p.y0 || x0 + w > p.x0 + p.w || y0 + d > p.y0 + p.d || w < 5 || d < 5) return null;
    const margins = { n: y0 - p.y0, s: p.y0 + p.d - (y0 + d), w: x0 - p.x0, e: p.x0 + p.w - (x0 + w) };
    margins[OPPOSITE[touch]] = 0;                    // the party wall against the main block
    main.margins = { ...main.margins, [touch]: 0 };   // the main block loses that side for doors and access
    const big = Math.max(w, d) >= 9 && Math.min(w, d) >= 7 && main.storeys >= 3;   // a stair core needs room beside the rooms
    const storeys = big && unit(`${seed}:${p.id}:wing-h`) < 0.4 ? 2 : 1;
    return { parcel: p.id, kind: `${p.kind}_wing`, program: WING_PROGRAM[main.program] || 'shop', district: p.district, x0, y0, w, d, storeys, front, margins, wall, roof: 'flat',
        accent: palette[Math.floor(unit(`${seed}:${p.id}:wing-accent`) * palette.length)], objective: false, wingOf: main.id };
}

// ------------------------------------------------------------------------------------------------ bays
const pieceTiles = Object.values(BAY_PIECES);
const touches = (a, b, dir) => {
    // Solid cells of a and b that meet across the shared bay edge (4-adjacent).
    const [dx, dy] = SIDE_VEC[dir];
    for (const [ax, ay] of a.cells) for (const [bx, by] of b.cells) if (ax + dx === bx + dx * BAY && ay + dy === by + dy * BAY) return true;
    return false;
};
/** The sibling part a multi-bay object needs on side `dir`, or null. */
function needsSibling(p, dir) {
    if (!p.parts) return null;
    const pos = p.axis === 'x' ? 'e' : 's';
    if (dir === pos && p.part < p.parts - 1) return p.part + 1;
    if (dir === OPPOSITE[pos] && p.part > 0) return p.part - 1;
    return null;
}
export function bayCompatible(a, b, dir) {
    const pa = BAY_PIECES[a], pb = BAY_PIECES[b];
    if (!pa || !pb) return true;
    // Multi-bay objects assemble along their axis.
    const ra = needsSibling(pa, dir), rb = needsSibling(pb, OPPOSITE[dir]);
    if (ra !== null || rb !== null) return ra !== null && rb !== null && pb.base === pa.base && pb.axis === pa.axis && pb.part === ra && pa.part === rb;
    if (!touches(pa, pb, dir)) return true;
    // Line runs may join end to end along their own axis (barrier runs, fences, hedges).
    const along = (dir === 'e' || dir === 'w') ? 'x' : 'y';
    return pa.base === pb.base && pa.facing === pb.facing && pa.run === along;
}

/**
 * Classify each bay of the map: blocked (a building and its margin), protected cells inside it (routes, spawn,
 * underground openings, exits, the escape apron), and its surface class for the piece pools.
 */
export function classifyBays(W, D, ground, blocked, protectedCells) {
    const BW = W / BAY, BD = D / BAY, bays = [];
    for (let by = 0; by < BD; by++) for (let bx = 0; bx < BW; bx++) {
        const cells = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => [bx * BAY + a, by * BAY + b]);
        const isBlocked = cells.some(([x, y]) => blocked(x, y) || x === 0 || y === 0 || x === W - 1 || y === D - 1);
        const classes = cells.map(([x, y]) => ground.cls[x + y * W]);
        // A bay across a lane and the carriageway counts as lane (cars and barriers run along the road).
        const roadish = classes.every(c => c === 'lane_x' || c === 'asphalt') ? 'lane_x' : classes.every(c => c === 'lane_y' || c === 'asphalt') ? 'lane_y' : null;
        const cls = classes.every(c => c === 'lane_x') ? 'lane_x' : classes.every(c => c === 'lane_y') ? 'lane_y'
            : classes.every(c => c === 'sidewalk') ? 'sidewalk' : classes.every(c => c === classes[0]) ? classes[0]
            : roadish && classes.some(c => c.startsWith('lane')) ? roadish : 'mixed';
        const prot = cells.map(([x, y], i) => protectedCells.has(`${x},${y}`) ? i : -1).filter(i => i >= 0).map(i => [i & 1, i >> 1]);
        bays.push({ bx, by, x: bx * BAY, y: by * BAY, blocked: isBlocked, cls, protected: prot });
    }
    return { BW, BD, bays, at: (bx, by) => (bx >= 0 && by >= 0 && bx < BW && by < BD ? bays[bx + by * BW] : null) };
}

/** Piece pool for a bay: road part, or its lot kind's pool, filtered by the surface each piece may stand on. */
function bayDomain(bay, poolName, sidewalkAxis) {
    if (bay.blocked) return ['open'];
    const pool = PIECE_POOLS[poolName] || PIECE_POOLS.yard_paved;
    const surf = bay.cls.startsWith('parking_')?'asphalt':bay.cls === 'lane_x' || bay.cls === 'lane_y' ? 'lane' : bay.cls;
    const out = [];
    for (const p of pieceTiles) {
        if (!(p.base in pool)||p.base==='lamp') continue;
        if (p.id !== 'open' && (!p.surfaces || !(p.surfaces.includes(surf) || (surf === 'lane' && p.surfaces.includes('asphalt'))))) continue;
        if (p.base === 'car' && !((bay.cls === 'lane_x' && p.axis === 'x') || (bay.cls === 'lane_y' && p.axis === 'y') || (bay.cls === 'asphalt' && poolName === 'parking')||bay.cls===`parking_${p.axis}`)) continue;
        if ((bay.cls === 'sidewalk' || surf === 'lane') && p.run && sidewalkAxis && p.run !== sidewalkAxis) continue;
        if (bay.cls === 'sidewalk' && p.base === 'car') continue;
        // Protected cells (routes, openings, exits) may hold nothing.
        if (p.cells.some(([cx, cy]) => bay.protected.some(([px, py]) => px === cx && py === cy))) continue;
        if (p.base === 'tree' && bay.protected.length) continue;
        if (p.decor && bay.protected.length && p.id === 'bus_stop') continue;
        out.push(p.id);
    }
    return out.length ? out : ['open'];
}

/**
 * Bay-level WFC, one lot at a time in reading order. Bays already solved in the lots to the west and north join the
 * graph as fixed context, so sockets hold across lot edges; multi-bay vehicles stay inside their lot. Pocket pins
 * are fixed tiles. Weights: pool × facing toward the objective × line of play × sightline breakers × noise × prior.
 */
export function solveBays({ plot, bayGrid, lotPool, roadAxis, fields, seed, pins = new Map(), soft = null, objectiveAt, weightBoost = () => 1, lots = null, previous = null }) {
    const result = previous ? new Map(previous) : new Map();
    const LB = LOT / BAY;
    const toSolve = lots || plot.lots.map(l => [l.lx, l.ly]);
    for (const [lx, ly] of toSolve) {
        const nodes = [], domains = new Map(), fixed = new Map(), free = new Map();
        const local = new Set();
        for (let j = 0; j < LB; j++) for (let i = 0; i < LB; i++) local.add(`${lx * LB + i},${ly * LB + j}`);
        const context = new Set();
        for (const id of local) {
            const [bx, by] = id.split(',').map(Number);
            for (const s of SIDES) { const n = `${bx + SIDE_VEC[s][0]},${by + SIDE_VEC[s][1]}`; if (!local.has(n) && result.has(n)) context.add(n); }
        }
        for (const id of [...local, ...context]) {
            const [bx, by] = id.split(',').map(Number), bay = bayGrid.at(bx, by);
            nodes.push({ id, neighbors: SIDES.map(s => [s, `${bx + SIDE_VEC[s][0]},${by + SIDE_VEC[s][1]}`]).filter(([, n]) => local.has(n) || context.has(n)).map(([s, n]) => ({ id: n, direction: s })) });
            if (context.has(id)) { fixed.set(id, result.get(id)); domains.set(id, [result.get(id)]); continue; }
            const lot = plotLot(plot, lx, ly);
            let domain = bayDomain(bay, lotPool(lot, bay), roadAxis(lot));
            // Multi-bay objects must finish inside this lot.
            domain = domain.filter(t => { const p = BAY_PIECES[t]; if (!p.parts) return true; const off = p.axis === 'x' ? bx - lx * LB : by - ly * LB; return off - p.part >= 0 && off - p.part + p.parts <= LB; });
            free.set(id, domain.filter(t => !BAY_PIECES[t].parts));
            if(pins.has(id)) {
                const pin=BAY_PIECES[pins.get(id)],surface=bay.cls.startsWith('parking_')||bay.cls==='carriageway'?'asphalt':bay.cls.startsWith('lane_')?'lane':bay.cls;
                // A repair may introduce a compatible cover module outside the decorative pool. It still obeys
                // collision reservations, real surface types and single-bay assembly constraints.
                const valid=pin&&!bay.blocked&&!pin.parts&&pin.cells.every(([x,y])=>!bay.protected.some(([px,py])=>px===x&&py===y))&&(!pin.surfaces||pin.surfaces.includes(surface)||(surface==='lane'&&pin.surfaces.includes('asphalt')));
                if(domain.includes(pins.get(id))||valid){fixed.set(id,pins.get(id));domain=[pins.get(id)];}
            }
            domains.set(id, domain.length ? domain : ['open']);
        }
        // PLAN-13: pins never contradict each other. Where two fixed bays would touch (the no-touch socket rule),
        // the weaker pin is released: already-solved context > pocket / repair pins > parcel-layout pins (`soft`).
        const rank = id => context.has(id) ? 3 : soft?.has(id) ? 1 : 2;
        for (let changed = true; changed;) {
            changed = false;
            for (const node of nodes) {
                const a = fixed.get(node.id); if (!a) continue;
                const nb = node.neighbors.find(n => fixed.has(n.id) && !bayCompatible(a, fixed.get(n.id), n.direction));
                if (!nb) continue;
                const loser = rank(node.id) < rank(nb.id) ? node.id : rank(nb.id) < rank(node.id) ? nb.id : (node.id > nb.id ? node.id : nb.id);
                if (context.has(loser)) continue;
                fixed.delete(loser); domains.set(loser, (free.get(loser) || ['open']).filter(t => t !== a && t !== fixed.get(nb.id)).concat('open').filter((t, i, l) => l.indexOf(t) === i));
                changed = true; break;
            }
        }
        const weightOf = (nodeId, tileId) => {
            const p = BAY_PIECES[tileId], [bx, by] = nodeId.split(',').map(Number), bay = bayGrid.at(bx, by);
            const lot = plotLot(plot, lx, ly), pool = PIECE_POOLS[lotPool(lot, bay)] || {};
            const facings = p.facing ? 4 : 1;
            let w = (pool[p.base] ?? 0.3) / facings;
            const cx = bay.x + 1, cy = bay.y + 1, dl = fields.play.dist.get(cx, cy), df = fields.play.flank.get(cx, cy);
            if (p.cover) {
                if (dl >= 1 && dl <= 4) w *= 1.7; else if (dl <= 9) w *= 1.1; else w *= 0.6;
                if (df <= 2) w *= 1.4;
                if (p.cover === 'full' && fields.sight(cx, cy) > 18 && dl > 1) w *= 2;
                if (p.facing && objectiveAt) {
                    const dx = objectiveAt.x - cx, dy = objectiveAt.y - cy, toward = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
                    w *= p.facing === toward ? 2.2 : p.facing === OPPOSITE[toward] ? 0.45 : 1;
                }
            } else if (p.id === 'open' && dl < 1) w *= 2;
            w *= noisePref(`bay:${p.base}`, noiseAt(seed, 'detail', cx, cy));
            if (['hedge', 'tree', 'fence'].includes(p.base)) w *= 0.6 + fields.prior.green.get(cx, cy);
            if (['planter', 'bench'].includes(p.base)) w *= 0.7 + fields.prior.paved.get(cx, cy);
            return Math.max(0.001, w * weightBoost(bx, by, p));
        };
        let assignment = null, last;
        for (let attempt = 0; attempt < 6 && !assignment; attempt++) {
            try { assignment = solveWaveFunctionCollapse({ nodes, tiles: pieceTiles.map(p => ({ id: p.id, weight: 1 })), domains, fixed, nodeWeights: weightOf, compatible: bayCompatible, seed: `${plot.family}:${seed}:bays:${lx},${ly}:${attempt}` }); }
            catch (e) { last = e; if (attempt === 2) for (const [id, d] of domains) if (!context.has(id) && !fixed.has(id)) domains.set(id, d.filter(t => !BAY_PIECES[t].parts).concat()); }
        }
        if (!assignment) {
            // Last resort: open ground for this lot (logged, never silent).
            if (globalThis.MAPGEN_TRACE) console.log('  lot fallback', lx, ly, last?.message?.slice(0, 120), JSON.stringify([...fixed]));
            for (const id of local) result.set(id, 'open');
            continue;
        }
        for (const id of local) result.set(id, assignment.get(id));
    }
    return result;
}

/** Expand a bay assignment into placed pieces with world cells (multi-bay objects once, at their first part). */
export function piecesFromBays(bays, bayGrid) {
    const out = [];
    for (const [id, tileId] of [...bays].sort((a, b) => { const [ax, ay] = a[0].split(',').map(Number), [bx, by] = b[0].split(',').map(Number); return ay - by || ax - bx; })) {
        const p = BAY_PIECES[tileId]; if (!p || p.id === 'open') continue;
        const [bx, by] = id.split(',').map(Number), bay = bayGrid.at(bx, by);
        if (p.parts && p.part > 0) continue;
        out.push({ piece: p.id, base: p.base, x: bay.x, y: bay.y, facing: p.facing || null, axis: p.axis || null, cover: p.cover, cells: p.cells.map(([dx, dy, stack]) => [bay.x + dx, bay.y + dy, stack]) });
    }
    return out;
}

/**
 * Engagement pockets (PLAN-04 §5.4): along the line of play, every 8–12 cells from a quarter of the way in, a pocket
 * of 2–4 cover pieces beside the route on alternating sides, facing the advance. Returned as bay pins.
 */
const POCKET_COVER = ['low_wall', 'planter', 'hedge', 'tall_planter', 'jersey', 'fence', 'bench'];   // PLAN-13: no vending boxes or sandbags
const bayCls = b => b.cls.startsWith('parking_') || b.cls === 'carriageway' ? 'asphalt' : b.cls.startsWith('lane_') ? 'lane' : b.cls;
const onRoad = b => b.cls === 'carriageway' || b.cls.startsWith('lane_') || b.cls.startsWith('parking_');
export function planPockets(main, bayGrid, { seed, spacing = null } = {}) {
    const pins = new Map(), pockets = [];
    if (!main?.length) return { pins, pockets };
    // Aim for three pockets between a quarter and nine tenths of the route (8–12 cells apart on long routes).
    const gap = spacing || [Math.max(6, Math.min(8, Math.floor(main.length * 0.65 / 3))), Math.max(7, Math.min(12, Math.floor(main.length * 0.65 / 2.5)))];
    let i = Math.floor(main.length * 0.25), side = unit(`${seed}:pocket-side`) < 0.5 ? 1 : -1, k = 0;
    while (i < main.length * 0.9) {
        const p = main[i], q = main[Math.min(main.length - 1, i + 3)], dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const toward = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
        let centre = null;
        for (const sd of [side, -side]) for (const r of [3, 2, 4]) {
            if (centre) break;
            const cx = Math.round(p.x - dy / len * sd * r), cy = Math.round(p.y + dx / len * sd * r), c = bayGrid.at(Math.floor(cx / BAY), Math.floor(cy / BAY));
            if (c && !c.blocked && !onRoad(c)) centre = c;
        }
        if (centre) {
            // PLAN-13: a pocket is ONE run of the same cover (a low wall, a planter row, a hedge) across the advance,
            // up to three bays long, not single pieces dotted around a point. The run lies across the facing.
            const along = toward === 'n' || toward === 's' ? [1, 0] : [0, 1];
            const run = [[0, 0], along, [-along[0], -along[1]]].map(([ox, oy]) => bayGrid.at(centre.bx + ox, centre.by + oy)).filter(b => b && !b.blocked && !onRoad(b));
            const fits = (base, b) => { const id = `${base}_${toward}`, p = BAY_PIECES[id]; return p && p.surfaces?.includes(bayCls(b)) && !p.cells.some(([x, y]) => b.protected.some(([px, py]) => px === x && py === y)); };
            const options = POCKET_COVER.filter(base => run[0] && fits(base, run[0]));
            const base = options.length ? options[Math.floor(unit(`${seed}:pocket:${k}`) * Math.min(options.length, 3))] : null;
            const members = base ? run.filter(b => fits(base, b)) : [];
            for (const b of members) pins.set(`${b.bx},${b.by}`, `${base}_${toward}`);
            if (members.length) pockets.push({ id: k, x: centre.x + 1, y: centre.y + 1, facing: toward, along: i / Math.max(1, main.length - 1), bays: members.map(b => [b.bx, b.by]) });
        }
        k++; side = -side;
        i += gap[0] + Math.floor(unit(`${seed}:pocket-gap:${k}`) * (gap[1] - gap[0] + 1));
    }
    return { pins, pockets };
}
