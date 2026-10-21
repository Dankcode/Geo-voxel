// PLAN-04 §5.3 step 1 — plots: the backbone of a map (roads, blocks, the street datum, map edges, insertion and the
// objective block), like XCOM 2's plot-and-parcel maps. A plot is an authored family with sockets; the seed picks a
// variant (which row the main road runs on, where the cross street meets it, which end the squad drops in), and the
// picture read picks the family. Everything snaps to the kit metric: roads and blocks are whole 8-cell lots.
import { LOT } from './KitMetric.js';
import { createRng, hashString } from '../util/Rng.js';

const SIDES = ['n', 'e', 's', 'w'];
export const SIDE_VEC = Object.freeze({ n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] });
export const OPPOSITE = Object.freeze({ n: 's', s: 'n', e: 'w', w: 'e' });

/**
 * Plot families (P2 ships three). Each has a theme (prop palette, materials), district weights, the underground kind
 * its streets hide (PLAN-03 D4), the times of day it suits and a road layout generator on the lot grid.
 */
export const PLOT_FAMILIES = Object.freeze({
    downtown: {
        name: 'Downtown grid', theme: 'Downtown', size: [56, 48], underground: 'subway', times: ['dusk', 'night-ops', 'overcast', 'night', 'day'],
        districts: { commercial: 4, residential: 1.4, plaza: 1.1 },
        text: 'A main road and a cross street through shops, offices and apartments, with a subway beneath.',
        roads(rng, LW, LD) {
            const row = rng.pick([LD - 2, LD - 3]), col = rng.int(2, LW - 3), full = rng.next() < 0.5;
            const cells = [];
            for (let lx = 0; lx < LW; lx++) cells.push([lx, row]);
            for (let ly = 0; ly < (full ? LD : row); ly++) if (ly !== row) cells.push([col, ly]);
            return { cells, exits: [['w', row], ['e', row], ['n', col], ...(full ? [['s', col]] : [])], main: row };
        }
    },
    industrial: {
        name: 'Industrial yard', theme: 'Industrial', size: [56, 48], underground: 'storm-drain', times: ['night', 'night-ops', 'dusk', 'overcast'],
        districts: { industrial: 4, yard: 2, commercial: 0.5 },
        text: 'An access road and a service road around depots, container stacks and loading yards, over a storm drain.',
        roads(rng, LW, LD) {
            const col = rng.pick([1, LW - 2]), row = LD - 2, cells = [];
            for (let lx = 0; lx < LW; lx++) cells.push([lx, row]);
            for (let ly = 0; ly < LD; ly++) if (ly !== row) cells.push([col, ly]);
            return { cells, exits: [['w', row], ['e', row], ['n', col], ['s', col]], main: row };
        }
    },
    suburb: {
        name: 'Suburb close', theme: 'Suburbs', size: [56, 48], underground: 'storm-drain', times: ['dusk', 'day', 'dawn', 'night'],
        districts: { residential: 4, park: 1.3, commercial: 0.5 },
        text: 'A residential road with a cul-de-sac between houses, back gardens and a pocket park, over a storm drain.',
        roads(rng, LW, LD) {
            const row = rng.pick([LD - 2, LD - 3]), col = rng.int(2, LW - 3), cells = [];
            for (let lx = 0; lx < LW; lx++) cells.push([lx, row]);
            for (let ly = 1; ly < row; ly++) cells.push([col, ly]);          // the close: a dead end with a turning circle
            return { cells, exits: [['w', row], ['e', row]], main: row };
        }
    }
});
export const PLOT_IDS = Object.freeze(Object.keys(PLOT_FAMILIES));

/** The picture read picks a family: its theme first, then road cues. */
export function familyForSite(site) {
    if (site?.plot && PLOT_FAMILIES[site.plot]) return site.plot;
    return { Downtown: 'downtown', Industrial: 'industrial', Suburbs: 'suburb', Roadside: 'suburb' }[site?.theme] || 'downtown';
}

/** Road connections of a road lot to its road neighbours (and off-map exits). */
function connections(isRoad, exits, lx, ly, LW, LD) {
    const c = {};
    for (const side of SIDES) {
        const [dx, dy] = SIDE_VEC[side], nx = lx + dx, ny = ly + dy;
        if (nx < 0 || ny < 0 || nx >= LW || ny >= LD) c[side] = exits.some(([s, at]) => s === side && at === (side === 'n' || side === 's' ? lx : ly));
        else c[side] = isRoad(nx, ny);
    }
    return c;
}

/**
 * Build a plot: lot grid, road lots with their connections, blocks (4-connected non-road lots), the insertion cell
 * (on the main road, at one end), the objective group (a 2 × 2 block-lot group far from the insertion, fronting a road)
 * and the off-map road exits that the world edge closes with barricades.
 */
export function createPlot(family, seed = 1, { size = null } = {}) {
    const F = PLOT_FAMILIES[family];
    if (!F) throw Error(`plot.family: unknown family ${family}`);
    const rng = createRng(hashString(`plot:${family}:${seed}`));
    const [W, D] = size || F.size, LW = W / LOT, LD = D / LOT;
    if (!Number.isInteger(LW) || !Number.isInteger(LD) || W > 64 || D > 64) throw Error('plot.size: whole lots within 64 × 64 required');
    const { cells, exits, main } = F.roads(rng, LW, LD);
    const road = new Set(cells.map(([x, y]) => `${x},${y}`)), isRoad = (x, y) => road.has(`${x},${y}`);
    const lots = [];
    for (let ly = 0; ly < LD; ly++) for (let lx = 0; lx < LW; lx++) {
        const r = isRoad(lx, ly);
        lots.push({ lx, ly, x0: lx * LOT, y0: ly * LOT, road: r ? connections(isRoad, exits, lx, ly, LW, LD) : null, block: -1 });
    }
    const lotAt = (lx, ly) => (lx >= 0 && ly >= 0 && lx < LW && ly < LD ? lots[lx + ly * LW] : null);
    // Blocks: 4-connected components of non-road lots.
    const blocks = [];
    for (const lot of lots) {
        if (lot.road || lot.block >= 0) continue;
        const id = blocks.length, members = [lot], q = [lot]; lot.block = id;
        for (let i = 0; i < q.length; i++) for (const side of SIDES) {
            const [dx, dy] = SIDE_VEC[side], n = lotAt(q[i].lx + dx, q[i].ly + dy);
            if (n && !n.road && n.block < 0) { n.block = id; q.push(n); members.push(n); }
        }
        blocks.push({ id, lots: members.map(l => [l.lx, l.ly]) });
    }
    // Insertion: on the main road, three cells in from one end (the squad's dropship side).
    const fromWest = rng.next() < 0.5, iy = main * LOT + 3;
    const insertion = { x: fromWest ? 3 : W - 4, y: iy, side: fromWest ? 'w' : 'e' };
    // Objective: the 2 × 2 non-road group that fronts a road and lies farthest from the insertion.
    let objective = null;
    for (let ly = 0; ly < LD - 1; ly++) for (let lx = 0; lx < LW - 1; lx++) {
        const group = [[lx, ly], [lx + 1, ly], [lx, ly + 1], [lx + 1, ly + 1]];
        if (group.some(([x, y]) => isRoad(x, y))) continue;
        const fronts = SIDES.filter(side => {
            const [dx, dy] = SIDE_VEC[side];
            const edge = group.filter(([x, y]) => !group.some(([a, b]) => a === x + dx && b === y + dy));
            return edge.every(([x, y]) => isRoad(x + dx, y + dy));
        });
        if (!fronts.length) continue;
        const cx = (lx + 1) * LOT, cy = (ly + 1) * LOT, d = Math.hypot(cx - insertion.x, cy - insertion.y) + rng.next() * 4;
        if (!objective || d > objective.d) objective = { lx, ly, fronts, d };
    }
    if (!objective) throw Error(`plot.objective: ${family} seed ${seed} has no 2×2 block fronting a road`);
    const front = objective.fronts.includes(OPPOSITE[insertion.side]) ? OPPOSITE[insertion.side] : objective.fronts.includes('s') ? 's' : objective.fronts[0];
    return {
        version: 1, family, theme: F.theme, seed, W, D, LW, LD, datum: 4, height: 18, lots, blocks,
        roadExits: exits.map(([side, at]) => ({ side, at })), insertion,
        objective: { lx: objective.lx, ly: objective.ly, size: [2, 2], front },
        underground: F.underground, times: F.times, districts: F.districts
    };
}

/** Lot lookup for a plot (kept off the serialisable object). */
export const plotLot = (plot, lx, ly) => (lx >= 0 && ly >= 0 && lx < plot.LW && ly < plot.LD ? plot.lots[lx + ly * plot.LW] : null);
