// PLAN-13 — authored parcel layouts. Open lots and building yards no longer take a random scatter of bay pieces
// (the "random boxes": lone dumpsters, vending machines, bins, rubble blocks, barrier stubs). Each lot kind has one designed layout
// in frontage-local bay coordinates, the way XCOM 2 parcels and plot cover pieces are authored: cover comes from
// what the place is, laid out along its edges and its use (a fenced vacant lot with a gate, a container yard in
// aisles, a plaza of planters, trees and benches, a park inside its hedge), and the rest of the lot stays open.
//
// A lot is 4 × 4 bays. Local u runs along the frontage (0–3), v runs inward from it (v = 0 touches the street).
// Line pieces take a local side ('front' | 'back' | 'left' | 'right') that becomes their facing (the bay row the
// line sits on). Pins that do not fit (a protected route cell, the wrong ground, a building margin) are dropped by
// the bay solver, so a layout never blocks the line of play.
import { BAY_PIECES } from './LotCatalogue.js';
import { plotLot } from './PlotCatalogue.js';

const LB = 4;
const SIDE_VEC = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
const VEC_SIDE = v => (v[0] === 0 ? (v[1] < 0 ? 'n' : 's') : (v[0] < 0 ? 'w' : 'e'));
const LOCAL_VEC = { front: [0, -1], back: [0, 1], left: [-1, 0], right: [1, 0] };
/** Local (u, v) → lot bay (i, j), and local side → world side, for a lot whose street lies to `F`. */
const toLot = { n: (u, v) => [u, v], s: (u, v) => [3 - u, 3 - v], w: (u, v) => [v, 3 - u], e: (u, v) => [3 - v, u] };
const rotVec = { n: ([a, b]) => [a, b], s: ([a, b]) => [-a, -b], w: ([a, b]) => [b, -a], e: ([a, b]) => [-b, a] };
const worldSide = (F, side) => VEC_SIDE(rotVec[F](LOCAL_VEC[side]));

/** Designed layouts: [u, v, base, side]. `side` is null for single-cell pieces (trees). */
export const PARCEL_LAYOUTS = Object.freeze({
    // Fenced along the street with a gate: open ground to cross, cover only at its edge.
    vacant_lot: [[0, 0, 'chainlink', 'front'], [2, 0, 'chainlink', 'front'], [3, 0, 'chainlink', 'front']],
    // Hoarding with a site gate, side fences and a staging line of barriers.
    construction_site: [[0, 0, 'chainlink', 'front'], [1, 0, 'chainlink', 'front'], [3, 0, 'chainlink', 'front'],
        [0, 1, 'chainlink', 'left'], [0, 2, 'chainlink', 'left'], [0, 3, 'chainlink', 'left'],
        [3, 1, 'chainlink', 'right'], [3, 2, 'chainlink', 'right'], [3, 3, 'chainlink', 'right'],
        [1, 2, 'jersey', 'front'], [2, 2, 'jersey', 'front']],
    // A barrier lane along one side and a fenced back boundary with a gate. No dumpsters or bins: lone boxes.
    depot_yard: [[0, 1, 'jersey', 'left'], [0, 2, 'jersey', 'left'], [0, 3, 'jersey', 'left'], [1, 3, 'chainlink', 'back'], [3, 3, 'chainlink', 'back']],
    // An alley is a clear run between buildings.
    alley: [],
    // A small square: planters at the corners of the street edge, two trees with benches facing them, tall planters
    // (full cover) closing the back corners.
    plaza: [[0, 0, 'planter', 'front'], [3, 0, 'planter', 'front'], [1, 1, 'tree', null], [2, 1, 'tree', null],
        [1, 2, 'bench', 'front'], [2, 2, 'bench', 'front'], [0, 3, 'tall_planter', 'back'], [3, 3, 'tall_planter', 'back']],
    subway_plaza: [[0, 0, 'planter', 'front'], [3, 0, 'planter', 'front'], [0, 3, 'bench', 'back'], [3, 3, 'bench', 'back']],
    // Hedged on three sides and open to the street, trees and a bench inside.
    pocket_park: [[0, 0, 'hedge', 'left'], [0, 1, 'hedge', 'left'], [0, 2, 'hedge', 'left'], [0, 3, 'hedge', 'left'],
        [3, 0, 'hedge', 'right'], [3, 1, 'hedge', 'right'], [3, 2, 'hedge', 'right'], [3, 3, 'hedge', 'right'],
        [1, 3, 'hedge', 'back'], [2, 3, 'hedge', 'back'], [1, 1, 'tree', null], [2, 2, 'tree', null], [2, 1, 'bench', 'left']],
    // A fenced garden: fence on the back and sides, a hedge on the street edge with a gap, one tree.
    backyard: [[0, 1, 'fence', 'left'], [0, 2, 'fence', 'left'], [0, 3, 'fence', 'left'], [3, 1, 'fence', 'right'], [3, 2, 'fence', 'right'],
        [3, 3, 'fence', 'right'], [1, 3, 'fence', 'back'], [2, 3, 'fence', 'back'], [0, 0, 'hedge', 'front'], [3, 0, 'hedge', 'front'], [2, 1, 'tree', null]]
});

/** Building-yard edges, by the yard's pool: what stands on the parcel boundary (street edge / other edges). */
const YARD_EDGES = Object.freeze({
    yard_garden: { street: 'hedge', boundary: 'fence', gateEvery: 3 },
    yard_industrial: { street: null, boundary: 'chainlink', gateEvery: 4 },
    yard_paved: { street: 'planter', boundary: null, cornersOnly: true }
});

/** The side of a lot that faces a street (the first neighbouring road lot), or null. */
export function lotFrontage(plot, lot) {
    for (const s of ['s', 'n', 'w', 'e']) { const [dx, dy] = SIDE_VEC[s]; if (plotLot(plot, lot.lx + dx, lot.ly + dy)?.road) return s; }
    return null;
}

/** The piece id a layout entry asks for, in world terms (multi-cell objects pick their axis). */
function pieceId(base, side, F) {
    if (base === 'tree' || base === 'rubble') return base;
    if (base === 'dumpster') return F === 'n' || F === 's' ? 'dumpster_x' : 'dumpster_y';
    const id = `${base}_${worldSide(F, side)}`;
    return BAY_PIECES[id] ? id : null;
}

/**
 * Pins for every open lot and building yard (bay id → piece id). Pocket and repair pins are merged over these by the
 * caller, so line-of-play cover always wins.
 */
export function planParcelPins(plot, bayGrid, lotKindAt, lotPoolOf) {
    const pins = new Map();
    const set = (bx, by, id) => {
        const bay = bayGrid.at(bx, by);
        if (!id || !bay || bay.blocked || bay.cls === 'sidewalk' || bay.cls === 'carriageway' || bay.cls.startsWith('lane_') || bay.cls.startsWith('parking_')) return;
        const p = BAY_PIECES[id];
        if (p.cells.some(([x, y]) => bay.protected.some(([px, py]) => px === x && py === y))) return;
        if ((p.base === 'tree' || p.base === 'dumpster') && bay.protected.length) return;
        pins.set(`${bx},${by}`, id);
    };
    for (const lot of plot.lots) {
        if (lot.road) continue;
        const kind = lotKindAt(lot); if (!kind) continue;
        const F = lotFrontage(plot, lot) || 's';
        const bx0 = lot.lx * LB, by0 = lot.ly * LB;
        if (kind === 'container_yard') { containerYard(pins, bayGrid, bx0, by0, F); continue; }
        const layout = PARCEL_LAYOUTS[kind];
        if (layout) {
            for (const [u, v, base, side] of layout) { const [i, j] = toLot[F](u, v); set(bx0 + i, by0 + j, pieceId(base, side, F)); }
            continue;
        }
        // Building parcels: dress the yard edge that is the parcel boundary.
        const yard = YARD_EDGES[lotPoolOf(kind)]; if (!yard) continue;
        for (const s of ['n', 's', 'w', 'e']) {
            const [dx, dy] = SIDE_VEC[s], n = plotLot(plot, lot.lx + dx, lot.ly + dy);
            if (n && !n.road && lotKindAt(n) === kind) continue;          // same parcel continues past this edge
            const base = n?.road ? yard.street : yard.boundary; if (!base) continue;
            for (let t = 0; t < LB; t++) {
                if (yard.cornersOnly && t !== 0 && t !== LB - 1) continue;
                if (yard.gateEvery && t % yard.gateEvery === 1) continue;  // a gate / gap in every run
                const [i, j] = s === 'n' ? [t, 0] : s === 's' ? [t, LB - 1] : s === 'w' ? [0, t] : [LB - 1, t];
                set(bx0 + i, by0 + j, BAY_PIECES[`${base}_${s}`] ? `${base}_${s}` : null);
            }
        }
    }
    return pins;
}

/** Containers in two aisles (x-axis, 3 bays each), the street edge fenced with a gate. */
function containerYard(pins, bayGrid, bx0, by0, F) {
    const rows = F === 's' ? [0, 2] : [1, 3], i0 = F === 'w' ? 1 : 0, used = new Set();
    for (const j of rows) {
        const parts = ['container_x_a', 'container_x_b', 'container_x_c'].map((id, k) => [bx0 + i0 + k, by0 + j, id]);
        if (parts.every(([bx, by]) => { const b = bayGrid.at(bx, by); return b && !b.blocked && !b.protected.length; })) for (const [bx, by, id] of parts) { pins.set(`${bx},${by}`, id); used.add(`${bx},${by}`); }
    }
    for (let t = 0; t < LB; t++) {
        if (t === 1) continue;
        const [i, j] = F === 'n' ? [t, 0] : F === 's' ? [t, 3] : F === 'w' ? [0, t] : [3, t];
        const bx = bx0 + i, by = by0 + j, b = bayGrid.at(bx, by);
        if (!b || b.blocked || used.has(`${bx},${by}`) || b.protected.length) continue;
        pins.set(`${bx},${by}`, `chainlink_${F}`);
    }
}

/** Street trees on a fixed rhythm (every fourth sidewalk bay), the XCOM 2 roadside cover strip. */
export function planStreetTrees(bayGrid) {
    const pins = new Map();
    for (const b of bayGrid.bays) if (!b.blocked && b.cls === 'sidewalk' && !b.protected.length && (b.bx + b.by) % 4 === 2) pins.set(`${b.bx},${b.by}`, 'tree');
    return pins;
}
