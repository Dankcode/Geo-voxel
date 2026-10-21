// PLAN-06 §5.3 — parcel mixes: compound parcels whose children sit inside them (a fenced salvage yard inside an auto
// repair parcel, a garden centre inside a supermarket) or merge across a shared edge socket (a shop row and the lot in
// front of it, back yards sharing one fence line, a warehouse apron and its neighbour's).
//
// Each mix declares its size range in the parcel's local frame (U along the frontage, V from the frontage back),
// whether it needs a road frontage, family weights and what it is good for (hold-zone host, landmark), then lays
// itself out in two passes so neighbouring parcels never fight over a door approach:
//   plan(ctx)         buildings only (all parcels build first, so their door approaches are reserved)
//   dress(ctx, state) ground, boundary treatments, lots, yards, aprons and their purposeful props
// Every prop carries the origin `mix:<id>/<part>`; vehicles only use the stalls a mix registers.
import { paint, run, fenceEdge, fenceRect, parkingLot, driveway, plantTree, block, booth, canopy, dumpsterEnclosure, playFrame, addStall, canStand } from './Props.js';
import { tag, tagAt, tagRect, put, registerSolids, groundAt, edgeCells } from './Core.js';
import { MAT } from '../../voxel/Materials.js';
import { layoutWarehouse, addCatwalk } from './Warehouse.js';

const W = (o, fam) => o[fam] ?? o.mixed ?? 0;

/** Central helper: a building on a local rectangle of the parcel, facing the parcel front unless told otherwise. */
function building(ctx, local, spec) { return ctx.build(local, spec); }
/** World rectangle of a local one. */
const R = (ctx, u0, v0, uw, vd) => ctx.F.rect(u0, v0, uw, vd);
/** World cells of a local edge run. */
const cellsU = (ctx, v, u0, u1) => { const out = []; for (let u = u0; u <= u1; u++) out.push(ctx.F.at(u, v)); return out; };
const cellsV = (ctx, u, v0, v1) => { const out = []; for (let v = v0; v <= v1; v++) out.push(ctx.F.at(u, v)); return out; };
/** Frontage fence with a gap for driveways/paths given as local u ranges. */
function frontage(ctx, kind, gaps = []) {
    const cells = cellsU(ctx, 0, 0, ctx.F.U - 1).filter((_, u) => !gaps.some(([a, b]) => u >= a && u <= b));
    return run(ctx.m, cells, { 'low-wall': 'brick', picket: 'fence', chain: 'chainlink', privacy: 'privacy_fence', wall: 'concrete_wall', bollard: 'concrete_wall' }[kind], kind === 'chain' || kind === 'privacy' ? 2 : 1, `${ctx.origin}/frontage-${kind}`, { landUse: 'fence' });
}
/** Bollards every few cells along the frontage (half cover, very tough, plazas and forecourts). */
function bollards(ctx, step = 4, gaps = []) {
    const cells = [];
    for (let u = 1; u < ctx.F.U - 1; u += step) if (!gaps.some(([a, b]) => u >= a && u <= b)) cells.push(ctx.F.at(u, 0));
    return run(ctx.m, cells, 'concrete_wall', 1, `${ctx.origin}/bollard-block`);
}
/** Driveways through the sidewalk in front of local u (4 wide). */
function drive(ctx, u, width = 4) {
    if (!ctx.frontage) return [];
    const [x, y] = ctx.F.at(ctx.F.front === 's' || ctx.F.front === 'w' ? u : u + width - 1, 0);
    const cells = driveway(ctx.m, x, y, ctx.F.front, width);
    // Gate pillars either side of the opening (full cover, brick).
    for (const pu of [u - 1, u + width]) {
        if (pu < 0 || pu >= ctx.F.U) continue;
        const [px, py] = ctx.F.at(pu, 0), m = ctx.m, g = ctx.z;
        if (m.keep.has(`${px},${py}`) || m.district.stallCells.has(`${px},${py}`) || m.store.topSolid(px, py) !== g) continue;
        for (let k = 1; k <= 2; k++) put(m, px, py, g + k, 'brick', `${ctx.origin}/gate-pillar`);
        tag(m, px, py, 'fence');
    }
    return cells;
}
/** Back and side boundary of the parcel; the frontage stays open (it is dressed by each mix). */
function boundary(ctx, kind, { front = false, gates = {} } = {}) {
    const open = front ? [] : [ctx.F.front];
    fenceRect(ctx.m, ctx.R, kind, `${ctx.origin}/boundary`, { open, gates });
}
/** A vehicle slot in local coordinates: 2 wide, `len` long, its long side along v (default) or u. */
function slot(ctx, u, v, { len = 4, along = 'v', kind = 'stall', types = ['car'], priority = 0.5, part = 'stall', z = null } = {}) {
    const r = along === 'v' ? ctx.F.rect(u, v, 2, len) : ctx.F.rect(u, v, len, 2);
    return addStall(ctx.m, { x: r.x0, y: r.y0, axis: along === 'v' ? ctx.F.vAxis : ctx.F.uAxis, length: len, kind, types, priority, origin: `${ctx.origin}/${part}`, z: z ?? ctx.z });
}
const rowOf = (ctx, u0, u1, v, key, h, part) => run(ctx.m, cellsU(ctx, v, u0, u1), key, h, `${ctx.origin}/${part}`);

export const MIXES = Object.freeze({
    'strip-mall': {
        name: 'Strip mall with its lot', U: [26, 52], V: [30, 38], frontage: true, holdHost: true, buildings: 3,
        weights: { retail: 3, mixed: 2, suburban: 1, industrial: 0.3, roadside: 1.5, urban: 0.8 }, fill: ['plaza', 'paving'],
        plan(ctx) {
            const { F } = ctx, shopsV = 16, depth = F.V - 19, n = Math.max(2, Math.min(4, Math.floor((F.U - 4) / 11)));
            const unit = Math.floor((F.U - 4) / n), shells = [], gap = ctx.remix.merges ? 0 : 2;
            for (let i = 0; i < n; i++) {
                const wide = (i === n - 1 ? F.U - 4 - unit * (n - 1) : unit) - (i < n - 1 ? gap : 0);
                const b = building(ctx, { u0: 2 + i * unit, v0: shopsV, uw: wide, vd: depth }, { program: i === 0 && n > 2 ? 'diner' : 'shop', storeys: 1, part: `shop-${i}`, joinSiblings: ctx.remix.merges });
                if (b) shells.push(b);
            }
            if (ctx.remix.merges) for (let i = 1; i < shells.length; i++) ctx.merge(shells[i - 1], shells[i]);
            return { shells, depth };
        },
        dress(ctx, st) {
            const { F, m } = ctx;
            const lot = parkingLot(m, F, { u0: 0, v0: 0, uw: F.U, vd: 14 }, { origin: `${ctx.origin}/lot`, frontage: ctx.frontage, z: ctx.z });
            drive(ctx, lot.entry);
            frontage(ctx, 'low-wall', [[lot.entry - 1, lot.entry + 4]]);
            paint(m, R(ctx, 0, 14, F.U, 2), 'paving', 'plaza', { z: ctx.z });
            // Cart corral and bike racks on the shop-front walk, clear of every door approach.
            rowOf(ctx, 1, 3, 15, 'railing', 1, 'cart-corral');
            ctx.furniture('bike_rack', F.at(F.U - 4, 15), F.uAxis, 'chainlink');
            paint(m, R(ctx, 0, F.V - 3, F.U, 3), 'asphalt', 'alley', { z: ctx.z });
            const r = R(ctx, F.U - 6, F.V - 3, 3, 3);
            dumpsterEnclosure(m, r.x0, r.y0, F.front, `${ctx.origin}/dumpster-enclosure`);
            const binCells = cellsU(ctx, F.V - 1, 2, 3);
            run(m, binCells, 'bin', 1, `${ctx.origin}/bins`);
            paint(m, R(ctx, 0, 16, 2, st.depth), 'lawn', 'verge', { z: ctx.z }); paint(m, R(ctx, F.U - 2, 16, 2, st.depth), 'lawn', 'verge', { z: ctx.z });
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [0.2] });
            for (const side of [F.left, F.right]) fenceEdge(m, ctx.R, side, 'low-wall', `${ctx.origin}/side-wall`, { gates: [0.15, 0.85] });
            if (ctx.hold) ctx.holdZone(lot.centre, 'lot');
            return lot;
        }
    },
    supermarket: {
        name: 'Supermarket, lot and garden centre', U: [36, 52], V: [34, 42], frontage: true, landmark: true, holdHost: true, buildings: 1,
        weights: { retail: 2, mixed: 1.2, suburban: 0.8, industrial: 0.2, roadside: 1, urban: 1 }, fill: ['plaza', 'paving'],
        plan(ctx) {
            const { F } = ctx, depth = F.V - 19;
            const store = building(ctx, { u0: 2, v0: 16, uw: F.U - 14, vd: depth }, { program: 'shop', storeys: 1, part: 'store', rounded: false });
            return { store, depth };
        },
        dress(ctx, st) {
            const { F, m } = ctx;
            const lot = parkingLot(m, F, { u0: 0, v0: 0, uw: F.U, vd: 14 }, { origin: `${ctx.origin}/lot`, frontage: ctx.frontage, z: ctx.z });
            drive(ctx, lot.entry); frontage(ctx, 'low-wall', [[lot.entry - 1, lot.entry + 4]]);
            paint(m, R(ctx, 0, 14, F.U, 2), 'paving', 'plaza', { z: ctx.z });
            rowOf(ctx, 3, 5, 15, 'railing', 1, 'cart-corral');
            // Garden centre (nested): chain-link pen with plant benches and pallet stock.
            const gc = R(ctx, F.U - 11, 16, 9, st.depth);
            paint(m, gc, 'gravel', 'yard', { z: ctx.z });
            fenceRect(m, gc, 'chain', `${ctx.origin}/garden-centre`, { gates: { [F.front]: [0.5] } });
            for (let v = 18; v < 16 + st.depth - 2; v += 3) rowOf(ctx, F.U - 9, F.U - 5, v, 'shelving', 1, 'plant-bench');
            paint(m, R(ctx, 0, F.V - 3, F.U, 3), 'asphalt', 'alley', { z: ctx.z });
            const r = R(ctx, 4, F.V - 3, 3, 3); dumpsterEnclosure(m, r.x0, r.y0, F.front, `${ctx.origin}/dumpster-enclosure`);
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [0.8] });
            if (ctx.hold) ctx.holdZone(lot.centre, 'lot');
            return lot;
        }
    },
    'diner-drive': {
        name: 'Diner with drive-thru lane', U: [22, 30], V: [22, 28], frontage: true, buildings: 1,
        weights: { retail: 1.4, mixed: 1, suburban: 0.8, industrial: 0.3, roadside: 3, urban: 0.6 }, fill: ['plaza', 'paving'],
        plan(ctx) {
            const { F } = ctx, w = Math.min(14, F.U - 8);
            return { diner: building(ctx, { u0: Math.floor((F.U - w) / 2), v0: F.V - 14, uw: w, vd: 10 }, { program: 'diner', storeys: 1, part: 'diner' }), w };
        },
        dress(ctx, st) {
            const { F, m } = ctx, u0 = Math.floor((F.U - st.w) / 2);
            const lot = parkingLot(m, F, { u0: 0, v0: 0, uw: F.U, vd: 9 }, { origin: `${ctx.origin}/lot`, frontage: ctx.frontage, z: ctx.z, islands: false });
            drive(ctx, 0); drive(ctx, F.U - 4);
            frontage(ctx, 'low-wall', [[0, 4], [F.U - 5, F.U - 1]]);
            // The drive-thru lane loops behind the diner: in on the left, out on the right.
            const lane = [R(ctx, 0, 9, u0, F.V - 9), R(ctx, 0, F.V - 4, F.U, 4), R(ctx, u0 + st.w, 9, F.U - u0 - st.w, F.V - 9)];
            for (const r of lane) paint(m, r, 'asphalt', 'aisle', { z: ctx.z });
            slot(ctx, 0, 11, { kind: 'queue', part: 'drive-thru' });
            run(m, [F.at(u0 - 1, 15)], 'appliance', 2, `${ctx.origin}/menu-board`);
            paint(m, R(ctx, u0, 9, st.w, F.V - 13 - 9 > 0 ? F.V - 13 - 9 : 1), 'paving', 'plaza', { z: ctx.z });
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [] });
            return lot;
        }
    },
    'gas-station': {
        name: 'Gas station forecourt', U: [24, 32], V: [18, 28], frontage: true, holdHost: false, buildings: 1,
        weights: { retail: 1, mixed: 1, suburban: 0.8, industrial: 0.8, roadside: 3, urban: 0.4 }, fill: ['forecourt', 'concrete'],
        plan(ctx) { const { F } = ctx; return { kiosk: building(ctx, { u0: F.U - 13, v0: F.V - 10, uw: 11, vd: 8 }, { program: 'station', storeys: 1, part: 'kiosk' }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, F.V - 11), 'asphalt', 'forecourt', { z: ctx.z });
            drive(ctx, 1); drive(ctx, F.U - 5);
            // Two pump islands under one canopy; a car may be filling up at each pump.
            const islands = [Math.floor(F.U / 2) - 5, Math.floor(F.U / 2) + 2];
            for (const iu of islands) {
                paint(m, R(ctx, iu, 6, 2, 5), 'concrete', 'forecourt', { z: ctx.z });
                run(m, [F.at(iu, 7), F.at(iu, 9)], 'pump', 1, `${ctx.origin}/pump`);
                slot(ctx, iu + 2, 6, { kind: 'pump', part: 'pump-bay' });
            }
            const c = R(ctx, islands[0] - 1, 5, islands[1] - islands[0] + 4, 7);
            canopy(m, c, `${ctx.origin}/canopy`, { z: ctx.z });
            run(m, [F.at(1, F.V - 6)], 'appliance', 1, `${ctx.origin}/air-water`);
            paint(m, R(ctx, 0, F.V - 11, F.U - 13, 11), 'lawn', 'verge', { z: ctx.z });
            plantTree(m, ...F.at(3, F.V - 4), `${ctx.origin}/tree`);
            fenceEdge(m, ctx.R, F.back, 'low-wall', `${ctx.origin}/rear-wall`, { gates: [0.3] });
            for (const side of [F.left, F.right]) fenceEdge(m, ctx.R, side, 'low-wall', `${ctx.origin}/side-wall`, { gates: [0.8] });
        }
    },
    'office-plaza': {
        name: 'Office block and plaza', U: [20, 40], V: [24, 34], frontage: true, holdHost: true, buildings: 1,
        weights: { retail: 1.2, mixed: 2, suburban: 0.4, industrial: 0.6, roadside: 0.6, urban: 3 }, fill: ['plaza', 'paving'],
        plan(ctx) {
            const { F } = ctx, w = Math.min(F.U - 6, 20), u0 = F.U >= 32 ? 3 : Math.floor((F.U - w) / 2);
            return { office: building(ctx, { u0, v0: F.V - 15, uw: w, vd: 12 }, { program: 'office', storeys: [2, 3], part: 'office', rounded: false }), u0, w };
        },
        dress(ctx, st) {
            const { F, m } = ctx, plazaV = F.V - 15;
            const lotU = F.U >= 32 ? st.u0 + st.w + 1 : null;
            paint(m, R(ctx, 0, 0, F.U, plazaV), 'paving', 'plaza', { z: ctx.z });
            // Paving pattern: dark tile bands every 4 cells.
            for (let v = 1; v < plazaV; v += 4) paint(m, R(ctx, 1, v, (lotU ?? F.U) - 2, 1), 'tile_dark', 'plaza', { z: ctx.z });
            bollards(ctx, 3, lotU ? [[lotU - 1, F.U]] : []);
            // Low walls, tree pits and a plinth: real plaza furniture, hard cover that leaves rubble.
            const pu = Math.floor(((lotU ?? F.U) - 1) / 2);
            if (!ctx.hold) {
                rowOf(ctx, 2, 5, 4, 'brick', 1, 'low-wall'); rowOf(ctx, pu + 3, pu + 6, 4, 'brick', 1, 'low-wall');
                plantTree(m, ...F.at(2, plazaV - 3), `${ctx.origin}/tree-pit`); plantTree(m, ...F.at((lotU ?? F.U) - 3, plazaV - 3), `${ctx.origin}/tree-pit`);
                block(m, R(ctx, pu, Math.max(6, plazaV - 6), 2, 2), 'concrete_wall', 2, `${ctx.origin}/plinth`);
            }
            if (lotU) {
                const lot = parkingLot(m, F, { u0: lotU, v0: 0, uw: F.U - lotU, vd: Math.min(plazaV + 12, F.V - 2) }, { origin: `${ctx.origin}/visitor-lot`, frontage: ctx.frontage, z: ctx.z, islands: false });
                drive(ctx, lot.entry);
            }
            paint(m, R(ctx, 0, F.V - 3, F.U, 3), 'lawn', 'verge', { z: ctx.z });
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [0.5] });
            if (ctx.hold) ctx.holdZone(R(ctx, Math.max(1, pu - 3), Math.max(1, Math.floor(plazaV / 2) - 3), 7, Math.min(7, plazaV - 1)), 'plaza');
        }
    },
    'mainstreet-row': {
        name: 'Main-street shop row with offices over', U: [20, 40], V: [16, 24], frontage: true, buildings: 2,
        weights: { retail: 2.4, mixed: 2.2, suburban: 0.5, industrial: 0.4, roadside: 0.3, urban: 3.2 }, fill: ['yard', 'concrete'],
        plan(ctx) {
            const { F } = ctx, n = F.U >= 24 ? 2 : 1, unit = Math.floor((F.U - 2) / n), out = [];
            const gap = ctx.remix.merges ? 0 : 2;
            for (let i = 0; i < n; i++) { const b = building(ctx, { u0: 1 + i * unit, v0: 1, uw: (i === n - 1 ? F.U - 2 - unit * (n - 1) : unit) - (i < n - 1 ? gap : 0), vd: 11 }, { program: i % 2 && unit >= 14 ? 'office' : 'shop', storeys: [2, 3], part: `row-${i}`, rounded: false, joinSiblings: ctx.remix.merges }); if (b) out.push(b); }
            if (ctx.remix.merges) for (let i = 1; i < out.length; i++) ctx.merge(out[i - 1], out[i]);
            return { row: out };
        },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, 1), 'paving', 'plaza', { z: ctx.z });
            // Rear service yard: a short row of staff stalls, bins and a fenced boundary.
            const yard = R(ctx, 0, 12, F.U, F.V - 12);
            paint(m, yard, 'concrete', 'apron', { z: ctx.z });
            if (F.V - 12 >= 8) for (let u = 2; u + 2 < F.U - 2; u += 5) slot(ctx, u, 14, { priority: 0.3, part: 'staff-stall' });
            run(m, cellsU(ctx, F.V - 2, F.U - 4, F.U - 3), 'bin', 1, `${ctx.origin}/bins`);
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [0.5], gateWidth: 3 });
            for (const side of [F.left, F.right]) fenceEdge(m, R(ctx, 0, 12, F.U, F.V - 12), side, 'chain', `${ctx.origin}/yard-fence`, { gates: [0.5] });
        }
    },
    'city-block': {
        name: 'City block: street-wall frontage, rear service alley, back-row walk-ups', U: [24, 48], V: [22, 34], frontage: true, holdHost: false, buildings: 5,
        weights: { urban: 4.5, mixed: 0.8, retail: 0.8, suburban: 0, industrial: 0, roadside: 0 }, fill: ['alley', 'asphalt'],
        plan(ctx) {
            const { F } = ctx, merges = ctx.remix.merges, gap = merges ? 0 : 2;
            // Street wall: two or three units shoulder to shoulder, 2-cell passages through to the alley unless merged.
            const n = Math.max(1, Math.min(3, Math.floor((F.U - 2 + gap) / (12 + gap)))), unit = Math.floor((F.U - 2 - gap * (n - 1)) / n);
            const front = [], back = [];
            for (let i = 0; i < n; i++) {
                const w = i === n - 1 ? F.U - 2 - (unit + gap) * (n - 1) : unit;
                const b = building(ctx, { u0: 1 + i * (unit + gap), v0: 1, uw: w, vd: 11 }, { program: i % 2 && w >= 14 ? 'office' : 'shop', storeys: [2, 3], part: `front-${i}`, rounded: false, joinSiblings: merges });
                if (b) front.push(b);
            }
            if (merges) for (let i = 1; i < front.length; i++) ctx.merge(front[i - 1], front[i]);
            // Deep blocks get a back row facing the alley, so the alley is a real street-within-the-block.
            const backD = Math.min(12, F.V - 18);
            if (backD >= 10) {
                const k = F.U >= 30 ? 2 : 1, bw = Math.floor((F.U - 2 - 3 * (k - 1)) / k);
                for (let i = 0; i < k; i++) { const b = building(ctx, { u0: 1 + i * (bw + 3), v0: F.V - 1 - backD, uw: i === k - 1 ? F.U - 2 - (bw + 3) * (k - 1) : bw, vd: backD }, { program: bw >= 14 ? 'office' : 'shop', storeys: [2, 3], part: `back-${i}`, rounded: false }); if (b) back.push(b); }
            }
            return { front, back, backD: back.length ? backD : 0 };
        },
        dress(ctx, st) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, 1), 'paving', 'plaza', { z: ctx.z });
            const a0 = 12, a1 = st.backD ? F.V - 2 - st.backD : F.V - 1;
            paint(m, R(ctx, 0, a0, F.U, a1 - a0 + 1), 'asphalt', 'alley', { z: ctx.z });
            // Dumpsters against the street wall's back and bins at the passages: the alley's cover, all of it hard.
            for (let u = 3; u + 2 < F.U - 1; u += 9) { const [x, y] = F.at(u, a0), [x2, y2] = F.at(u + 1, a0); if (canStand(m, x, y) && canStand(m, x2, y2)) { m.dumpster(Math.min(x, x2), Math.min(y, y2), F.uAxis, groundAt(m, x, y)); registerSolids(m, { x0: Math.min(x, x2), y0: Math.min(y, y2), w: F.uAxis === 'x' ? 2 : 1, d: F.uAxis === 'x' ? 1 : 2 }, `${ctx.origin}/dumpster`); tag(m, x, y, 'utility'); tag(m, x2, y2, 'utility'); } }
            if (a1 - a0 >= 4) slot(ctx, Math.max(2, Math.floor(F.U / 2) - 3), a1 - 1, { len: 6, along: 'u', kind: 'service', types: ['truck', 'car'], priority: 0.6, part: 'loading-bay' });
            for (let i = 1; i < st.front.length; i++) { const u = 1 + Math.round((F.U - 2) * i / st.front.length); run(m, [F.at(u, a0 + 1)], 'bin', 1, `${ctx.origin}/bins`); }
            if (!st.backD) {
                if (F.V - 12 >= 8) for (let u = 2; u + 2 < F.U - 2; u += 5) slot(ctx, u, F.V - 5, { priority: 0.3, part: 'staff-stall' });
                fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [0.5], gateWidth: 3 });
            }
            // Street trees in pits on the frontage paving, between the shop doors.
            for (let i = 1; i < st.front.length; i++) { const u = 1 + Math.round((F.U - 2) * i / st.front.length); plantTree(m, ...F.at(u, 0), `${ctx.origin}/street-tree`, 'ornamental'); }
        }
    },
    'house-plot': {
        name: 'House, driveway and fenced back yard', U: [13, 18], V: [18, 30], frontage: true, repeat: true, buildings: 1,
        weights: { suburban: 4, mixed: 1, retail: 0.3, industrial: 0, roadside: 0.2, urban: 0 }, fill: ['yard', 'lawn'],
        plan(ctx) {
            const { F } = ctx, hw = Math.min(F.U - 5, 11), hd = Math.min(10, F.V - 8);
            const two = ctx.rng.next() < 0.45 && hd >= 10 && hw >= 8;
            const b = building(ctx, { u0: 1, v0: 5, uw: hw, vd: hd }, two ? { program: 'townhouse', storeys: 2, part: 'house' } : { program: ctx.rng.next() < 0.5 ? 'house' : 'bungalow', storeys: 1, part: 'house' });
            return { b, hw, hd };
        },
        dress(ctx, st) {
            const { F, m } = ctx, du = F.U - 4;
            paint(m, R(ctx, 0, 0, F.U, 5), 'lawn', 'yard', { z: ctx.z });
            paint(m, R(ctx, du, 0, 3, 5 + st.hd), 'concrete', 'driveway', { z: ctx.z });
            drive(ctx, du, 3);
            for (const v of [0, 5]) slot(ctx, du, v, { kind: 'driveway', priority: v ? 0.8 : 0.4, part: 'driveway' });
            frontage(ctx, 'picket', [[Math.floor(st.hw / 2), Math.floor(st.hw / 2) + 1], [du - 1, F.U - 1]]);
            const back = 5 + st.hd, yard = R(ctx, 0, back, F.U, F.V - back);
            paint(m, yard, 'lawn', 'yard', { z: ctx.z });
            paint(m, R(ctx, 2, back, Math.min(5, st.hw - 2), 3), 'deck', 'yard', { z: ctx.z });
            const sr = R(ctx, F.U - 4, F.V - 4, 3, 2); block(m, sr, 'siding', 2, `${ctx.origin}/shed`, { roofKey: 'roof_metal', landUse: 'yard' });
            if (F.V - back >= 9 && ctx.rng.next() < 0.6) { const [px, py] = F.at(2, F.V - 5); playFrame(m, Math.min(px, F.at(4, F.V - 3)[0]), Math.min(py, F.at(4, F.V - 3)[1]), `${ctx.origin}/play-set`); }
            plantTree(m, ...F.at(1, F.V - 2), `${ctx.origin}/yard-tree`);
            // Back-yard fences: privacy fence on the back and on the sides from the house line back.
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/back-fence`, { gates: [] });
            for (const side of [F.left, F.right]) fenceEdge(m, yard, side, 'privacy', `${ctx.origin}/side-fence`, { gates: [side === F.right ? 0.15 : 0.9] });
            for (const side of [F.left]) fenceEdge(m, R(ctx, 0, 0, F.U, back), side, 'picket', `${ctx.origin}/front-side`, { gates: [0.6] });
        }
    },
    'townhouse-row': {
        name: 'Semi-detached row with side passages', U: [22, 42], V: [18, 28], frontage: true, repeat: true, buildings: 3,
        weights: { suburban: 3, mixed: 1, retail: 0.3, industrial: 0, roadside: 0.1, urban: 0.8 }, fill: ['yard', 'lawn'],
        plan(ctx) {
            const { F } = ctx, n = Math.max(2, Math.floor(F.U / 10)), pitch = Math.floor(F.U / n), out = [];
            for (let i = 0; i < n; i++) { const b = building(ctx, { u0: i * pitch + 1, v0: 4, uw: pitch - 2, vd: 10 }, { program: 'townhouse', storeys: 2, part: `unit-${i}` }); if (b) out.push({ b, u0: i * pitch, pitch }); }
            return { units: out };
        },
        dress(ctx, st) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, 4), 'lawn', 'yard', { z: ctx.z });
            const gaps = st.units.map(u => [u.u0 + Math.floor(u.pitch / 2) - 1, u.u0 + Math.floor(u.pitch / 2)]);
            frontage(ctx, 'picket', gaps);
            paint(m, R(ctx, 0, 14, F.U, F.V - 14), 'lawn', 'yard', { z: ctx.z });
            for (const u of st.units) {
                paint(m, R(ctx, u.u0, 14, u.pitch, 2), 'deck', 'yard', { z: ctx.z });
                const sh = R(ctx, u.u0 + u.pitch - 3, F.V - 3, 2, 2); block(m, sh, 'siding', 2, `${ctx.origin}/shed`, { roofKey: 'roof_metal', landUse: 'yard' });
                // Fence between back yards (one line per shared boundary) with a gate to the passage.
                if (u.u0 > 0) run(m, cellsV(ctx, u.u0, 14, F.V - 1).filter((_, i) => i !== 1), 'privacy_fence', 2, `${ctx.origin}/yard-divider`, { landUse: 'fence' });
            }
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/back-fence`, { gates: [] });
            for (const side of [F.left, F.right]) fenceEdge(m, R(ctx, 0, 14, F.U, F.V - 14), side, 'privacy', `${ctx.origin}/side-fence`, { gates: [0.2] });
        }
    },
    'warehouse-yard': {
        name: 'Warehouse, loading apron and yard', U: [34, 56], V: [30, 46], frontage: true, holdHost: true, buildings: 1,
        weights: { industrial: 4, mixed: 1, retail: 0.4, suburban: 0.1, roadside: 1, urban: 0 }, fill: ['apron', 'concrete'],
        plan(ctx) {
            const { F } = ctx, w = Math.max(24, Math.min(F.U - 8, 32)), d = Math.max(16, Math.min(F.V - 14, 22));
            const b = building(ctx, { u0: Math.floor((F.U - w) / 2), v0: F.V - d - 3, uw: w, vd: d }, { program: 'warehouse', storeys: 2, part: 'warehouse', rounded: false, furnish: false });
            if (b) addCatwalk(ctx.m, b, { origin: `${ctx.origin}/catwalk` });
            return { b, w, d };
        },
        dress(ctx, st) {
            const { F, m } = ctx, apronV = F.V - st.d - 3, u0 = Math.floor((F.U - st.w) / 2);
            paint(m, R(ctx, 0, 0, F.U, F.V), 'concrete', 'apron', { z: ctx.z });
            // Perimeter chain-link, a 6-wide vehicle gate and a guard booth beside it.
            const gu = Math.floor(F.U / 2) - 3;
            // Vehicle gate in the middle, pedestrian gates near both corners.
            frontage(ctx, 'chain', [[gu, gu + 5], [2, 3], [F.U - 4, F.U - 3]]);
            for (const pu of [2, F.U - 4]) { const [px, py] = F.at(pu, 0), [qx, qy] = F.at(pu + 1, 2); m.reserve(Math.min(px, qx), Math.min(py, qy), Math.max(px, qx), Math.max(py, qy)); }
            drive(ctx, gu + 1, 4);
            boundary(ctx, 'chain', { gates: { [F.back]: [0.15], [F.left]: [0.5], [F.right]: [0.5] } });
            const br = R(ctx, gu + 7, 1, 3, 3); booth(m, br, F.front, `${ctx.origin}/guard-booth`);
            // Dock bays in front of the roller doors: trucks back up to the building.
            if (st.b) for (const e of st.b.exits.filter(e => e.roller && e.side === F.front)) {
                const len = apronV >= 15 ? 10 : 6, [ud] = F.toLocal(e.x, e.y);
                slot(ctx, Math.min(F.U - 3, ud), apronV - 2 - len, { len, kind: 'dock', types: len >= 10 ? ['semitrailer', 'truck'] : ['truck'], priority: 0.9, part: 'dock-bay' });
            }
            // Container stack along one side, a pallet bay along the other.
            for (let v = 2; v + 5 < apronV + st.d; v += 6) {
                const [x, y] = F.at(2, v), [x2, y2] = F.at(3, v + 4);
                const cr = { x0: Math.min(x, x2), y0: Math.min(y, y2), w: Math.abs(x - x2) + 1, d: Math.abs(y - y2) + 1 };
                if (u0 < 5) break;
                let ok = true; for (let yy = cr.y0; yy < cr.y0 + cr.d; yy++) for (let xx = cr.x0; xx < cr.x0 + cr.w; xx++) if (!canStand(m, xx, yy)) ok = false;
                if (!ok) continue;
                m.container(cr.x0, cr.y0, F.vAxis, null, ctx.z, ctx.rng.next() < 0.35);
                registerSolids(m, cr, `${ctx.origin}/container-stack`); tagRect(m, cr, 'apron');
            }
            for (let v = 3; v + 2 < apronV; v += 4) rowOf(ctx, F.U - 4, F.U - 3, v, 'pallet', 1, 'pallet-bay');
            run(m, [F.at(F.U - 3, apronV + 2), F.at(F.U - 2, apronV + 2)], 'barrel_powder', 1, `${ctx.origin}/drum-store`);
            if (st.b) layoutWarehouse(m, st.b, { seed: ctx.seed, variant: ctx.hold ? 'gutted' : null, origin: `${ctx.origin}/interior` });
            if (ctx.hold) ctx.holdZone(R(ctx, Math.floor(F.U / 2) - 3, Math.max(4, apronV - 9), 7, 7), 'apron');
        }
    },
    'auto-repair': {
        name: 'Auto repair with salvage yard', U: [22, 26], V: [18, 30], frontage: true, buildings: 1,
        weights: { industrial: 2, mixed: 1, retail: 0.5, suburban: 0.5, roadside: 2, urban: 0.3 }, fill: ['forecourt', 'concrete'],
        plan(ctx) { return { b: building(ctx, { u0: 1, v0: ctx.F.V - 12, uw: 12, vd: 10 }, { program: 'garage', storeys: 1, part: 'garage', rounded: false }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, F.V), 'concrete', 'forecourt', { z: ctx.z });
            drive(ctx, 3); frontage(ctx, 'low-wall', [[2, 7]]);
            for (let u = 2; u + 2 < 13; u += 4) slot(ctx, u, 3, { kind: 'forecourt', part: 'waiting-bay' });
            run(m, [F.at(13, F.V - 4), F.at(13, F.V - 5)], 'barrel_powder', 1, `${ctx.origin}/oil-drums`);
            // Tyre racks and a parts container along the working yard.
            for (let v = 9; v + 1 < F.V - 13; v += 4) rowOf(ctx, 2, 4, v, 'shelving', 1, 'tyre-rack');
            block(m, R(ctx, 8, 9, 2, 4), 'siding', 2, `${ctx.origin}/parts-shed`, { roofKey: 'roof_metal', landUse: 'forecourt' });
            // Salvage yard (nested): chain-link pen with wrecks.
            // Flush with the side and back edges, so no blind 1-cell slot is left between its fence and the neighbour's.
            const sy = R(ctx, F.U - 9, 2, 9, F.V - 2);
            paint(m, sy, 'gravel', 'yard', { z: ctx.z });
            fenceRect(m, sy, 'chain', `${ctx.origin}/salvage-yard`, { gates: { [F.left]: [0.3] } });
            for (let v = 4; v + 4 < F.V - 2; v += 6) slot(ctx, F.U - 6, v, { kind: 'salvage', types: ['abandoned_car'], part: 'wreck' });
            fenceEdge(m, ctx.R, F.back, 'chain', `${ctx.origin}/rear-fence`, { gates: [] });
        }
    },
    'self-storage': {
        name: 'Self-storage lanes', U: [30, 48], V: [20, 40], frontage: true, buildings: 1,
        weights: { industrial: 2, mixed: 1, suburban: 1, retail: 0.4, roadside: 1.5, urban: 0 }, fill: ['storage', 'asphalt'],
        plan(ctx) { return { office: building(ctx, { u0: 1, v0: 1, uw: 10, vd: 8 }, { program: 'office', storeys: 1, part: 'office', rounded: false }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, F.V), 'asphalt', 'storage', { z: ctx.z });
            const gu = 13; frontage(ctx, 'chain', [[gu, gu + 4], [F.U - 4, F.U - 3]]); drive(ctx, gu, 4);
            boundary(ctx, 'chain', { gates: { [F.back]: [0.5] } });
            // Unit rows: 2-high steel blocks, 4 deep, with 4-wide drive lanes and cross gaps every 9.
            for (let v = 11; v + 4 <= F.V - 2; v += 8) for (let u = 2; u + 3 < F.U - 2; u += 10) {
                const len = Math.min(8, F.U - 2 - u);
                block(m, R(ctx, u, v, len, 4), 'siding', 2, `${ctx.origin}/unit-row`, { roofKey: 'roof_metal', landUse: 'storage' });
            }
            slot(ctx, F.U - 3, 15, { len: 6, kind: 'lane', types: ['truck'], priority: 0.4, part: 'van' });
        }
    },
    'surface-lot': {
        name: 'Surface car park', U: [12, 44], V: [9, 30], frontage: true, holdHost: false, buildings: 0,
        weights: { retail: 0.5, mixed: 0.45, industrial: 0.4, suburban: 0.25, roadside: 0.5, urban: 0.35 }, narrowBonus: 4, fill: ['aisle', 'asphalt'],
        dress(ctx) {
            const { F, m } = ctx;
            // One or two bays of stalls with their own aisle each; a pay booth by the entrance on wide lots.
            const band = F.V >= 23 ? 14 : F.V >= 14 ? 14 : 9;
            let v = 0, entries = [];
            while (v + 9 <= F.V - 1) {
                const vd = Math.min(band, F.V - 1 - v) >= 14 ? 14 : 9;
                const lot = parkingLot(m, F, { u0: 0, v0: v, uw: F.U, vd }, { origin: `${ctx.origin}/bay-${v}`, frontage: v === 0 && ctx.frontage, z: ctx.z, islands: F.U >= 16 });
                if (v === 0) entries.push(lot.entry);
                v += vd;
            }
            paint(m, R(ctx, 0, v, F.U, F.V - v), 'lawn', 'verge', { z: ctx.z });
            if (entries.length) { drive(ctx, entries[0]); frontage(ctx, 'low-wall', [[entries[0] - 1, entries[0] + 4]]); if (F.U >= 16) booth(m, R(ctx, entries[0] + 5, 1, 3, 3), F.front, `${ctx.origin}/pay-booth`); }
            boundary(ctx, 'low-wall', { gates: { [F.left]: [0.5], [F.right]: [0.5], [F.back]: [0.3, 0.7] } });
        }
    },
    'car-dealership': {
        name: 'Car dealership: showroom and display lot', U: [24, 40], V: [22, 32], frontage: true, buildings: 1,
        weights: { roadside: 3, retail: 1.2, mixed: 0.9, suburban: 0.4, industrial: 0.5, urban: 0.3 }, fill: ['aisle', 'asphalt'],
        plan(ctx) { const { F } = ctx, w = Math.min(F.U - 6, 18); return { b: building(ctx, { u0: F.U - w - 2, v0: F.V - 12, uw: w, vd: 10 }, { program: 'shop', storeys: 1, part: 'showroom', rounded: true }), w }; },
        dress(ctx, st) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, F.U, F.V - 1), 'asphalt', 'aisle', { z: ctx.z });
            // Display rows facing the road: nose-out, tightly packed, nearly always full.
            for (const v of [1, 7]) for (let u = 1; u + 2 < F.U - 1; u += 3) { if (v === 7 && u + 3 > F.U - st.w - 3 && F.V - 12 < 12) continue; slot(ctx, u, v, { kind: 'display', priority: 0.9, part: `display-row-${v}` }); }
            for (let u = 0; u < F.U; u++) { const [x, y] = F.at(u, 6); if (tagAt(m, x, y) === 'aisle' && (u % 3 === 0)) m.store.set(x, y, ctx.z, MAT.road_mark); }
            drive(ctx, Math.floor(F.U / 2) - 2); frontage(ctx, 'low-wall', [[Math.floor(F.U / 2) - 3, Math.floor(F.U / 2) + 2]]);
            run(m, [F.at(1, 0), F.at(F.U - 2, 0)], 'concrete_wall', 2, `${ctx.origin}/price-pylon`);
            boundary(ctx, 'low-wall', { gates: { [F.back]: [0.5], [F.left]: [0.5], [F.right]: [0.5] } });
        }
    },
    'fire-station': {
        name: 'Fire station: apparatus bays, office and apron', U: [26, 36], V: [22, 30], frontage: true, buildings: 2,
        weights: { suburban: 1.2, mixed: 1, retail: 0.6, industrial: 0.8, roadside: 0.6, urban: 1 }, fill: ['apron', 'concrete'],
        plan(ctx) {
            const { F } = ctx, bays = building(ctx, { u0: 1, v0: F.V - 13, uw: 14, vd: 11 }, { program: 'garage', storeys: 1, part: 'bays', rounded: false, joinSiblings: true, wall: 'brick' });
            const office = building(ctx, { u0: 15, v0: F.V - 13, uw: Math.min(F.U - 16, 15), vd: 11 }, { program: F.U - 16 >= 14 ? 'office' : 'shop', storeys: [1, 2], part: 'office', rounded: false, joinSiblings: true, wall: 'brick' });
            if (bays && office) ctx.merge(bays, office);
            return { bays, office };
        },
        dress(ctx, st) {
            const { F, m } = ctx, apronD = F.V - 13;
            paint(m, R(ctx, 0, 0, F.U, apronD), 'concrete', 'apron', { z: ctx.z });
            drive(ctx, 2, 4); drive(ctx, 8, 4);
            // Engines parked nose-out on the apron in front of the bays (trucks), a hose-drying rack and bollards.
            for (const u of [2, 8]) slot(ctx, u, Math.max(1, apronD - 8), { len: 6, kind: 'dock', types: ['truck'], priority: 1, part: 'engine-bay' });
            rowOf(ctx, 16, 18, 1, 'steel_post', 1, 'hose-rack');
            bollards(ctx, 4, [[1, 13]]);
            fenceEdge(m, ctx.R, F.back, 'chain', `${ctx.origin}/rear-fence`, { gates: [0.5] });
        }
    },
    'police-compound': {
        name: 'Police station with a fenced vehicle pound', U: [26, 38], V: [24, 34], frontage: true, holdHost: false, buildings: 1,
        weights: { mixed: 1, retail: 0.6, suburban: 0.6, industrial: 0.7, roadside: 0.8, urban: 1.2 }, fill: ['apron', 'concrete'],
        plan(ctx) { const { F } = ctx; return { b: building(ctx, { u0: 1, v0: 2, uw: 14, vd: 11 }, { program: 'office', storeys: [1, 2], part: 'station', rounded: false, wall: 'concrete_wall' }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, R(ctx, 0, 0, 16, F.V), 'paving', 'plaza', { z: ctx.z });
            bollards(ctx, 3, [[16, F.U]]);
            const pound = R(ctx, 17, 1, F.U - 18, F.V - 2);
            paint(m, pound, 'asphalt', 'apron', { z: ctx.z });
            fenceRect(m, pound, 'chain', `${ctx.origin}/vehicle-pound`, { gates: { [F.front]: [0.4] } });
            drive(ctx, 19, 4);
            // Cruisers in the pound, jersey barriers staggered inside the gate (a defended entrance).
            for (let u = 19; u + 2 < F.U - 2; u += 3) slot(ctx, u, F.V - 7, { kind: 'stall', priority: 0.9, part: 'cruiser' });
            rowOf(ctx, 21, 22, 4, 'jersey', 1, 'gate-barrier'); rowOf(ctx, 26, 27, 6, 'jersey', 1, 'gate-barrier');
            boundary(ctx, 'low-wall', { gates: { [F.back]: [0.2] } });
        }
    },
    motel: {
        name: 'Motel facing its lot, with a fenced pool', U: [28, 44], V: [24, 34], frontage: true, buildings: 1,
        weights: { roadside: 3, suburban: 0.6, mixed: 0.6, retail: 0.4, industrial: 0.2, urban: 0.3 }, fill: ['aisle', 'asphalt'],
        plan(ctx) { const { F } = ctx; return { b: building(ctx, { u0: 2, v0: F.V - 11, uw: F.U - 12, vd: 9 }, { program: 'motel', storeys: 1, part: 'motel', rounded: false }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            const lot = parkingLot(m, F, { u0: 0, v0: 0, uw: F.U - 9, vd: Math.min(14, F.V - 12) }, { origin: `${ctx.origin}/lot`, frontage: ctx.frontage, z: ctx.z, islands: false });
            drive(ctx, lot.entry); frontage(ctx, 'low-wall', [[lot.entry - 1, lot.entry + 4]]);
            // Pool: water in a paved surround, chain-link around it, a gate on the lot side.
            const pool = R(ctx, F.U - 8, 2, 7, F.V - 5);
            paint(m, pool, 'paving', 'yard', { z: ctx.z });
            const water = R(ctx, F.U - 6, 4, 3, F.V - 9);
            for (let y = water.y0; y < water.y0 + water.d; y++) for (let x = water.x0; x < water.x0 + water.w; x++) if (canStand(m, x, y)) { m.store.set(x, y, ctx.z, MAT.water); tag(m, x, y, 'yard'); }
            fenceRect(m, pool, 'chain', `${ctx.origin}/pool-fence`, { gates: { [F.left]: [0.5] } });
            run(m, [F.at(F.U - 4, 1)], 'concrete_wall', 2, `${ctx.origin}/motel-sign`);
            fenceEdge(m, ctx.R, F.back, 'privacy', `${ctx.origin}/rear-fence`, { gates: [] });
        }
    },
    'sports-court': {
        name: 'Fenced sports court with bleachers', U: [16, 28], V: [14, 24], frontage: false, buildings: 0,
        weights: { suburban: 1.4, mixed: 1, retail: 0.5, industrial: 0.2, roadside: 0.2, urban: 0.5 }, fill: ['green', 'lawn'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'lawn', 'green', { z: ctx.z });
            const court = R(ctx, 1, 1, F.U - 2, F.V - 5);
            paint(m, court, 'asphalt', 'plaza', { z: ctx.z });
            for (let u = 2; u < F.U - 2; u++) for (const v of [2, F.V - 6]) { const [x, y] = F.at(u, v); m.store.set(x, y, ctx.z, MAT.road_mark); }
            for (let v = 2; v < F.V - 5; v++) { const [x, y] = F.at(Math.floor(F.U / 2), v); m.store.set(x, y, ctx.z, MAT.road_mark); }
            fenceRect(m, court, 'chain', `${ctx.origin}/court-fence`, { gates: { [F.back]: [0.3, 0.7], [F.front]: [0.5] } });
            for (const u of [3, F.U - 4]) run(m, [F.at(u, Math.floor((F.V - 4) / 2))], 'steel_post', 2, `${ctx.origin}/hoop`);
            // Concrete bleachers: two stepped rows along the back (half and full cover).
            rowOf(ctx, 3, F.U - 4, F.V - 3, 'concrete_wall', 1, 'bleacher-low'); rowOf(ctx, 3, F.U - 4, F.V - 2, 'concrete_wall', 2, 'bleacher-high');
        }
    },
    'car-wash': {
        name: 'Car wash with canopy bays', U: [18, 28], V: [16, 24], frontage: true, buildings: 0,
        weights: { roadside: 2, retail: 0.8, mixed: 0.7, suburban: 0.5, industrial: 0.5, urban: 0.15 }, fill: ['forecourt', 'concrete'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'concrete', 'forecourt', { z: ctx.z });
            drive(ctx, 1, 4); drive(ctx, F.U - 5, 4);
            const bays = Math.min(3, Math.floor((F.U - 6) / 5));
            for (let i = 0; i < bays; i++) {
                const u = 3 + i * 5;
                canopy(m, R(ctx, u, 4, 4, 7), `${ctx.origin}/wash-canopy`, { z: ctx.z });
                run(m, [F.at(u, 5), F.at(u, 9)], 'concrete_wall', 1, `${ctx.origin}/bay-divider`);
                slot(ctx, u + 1, 5, { kind: 'queue', priority: 0.6, part: `wash-bay-${i}` });
            }
            booth(m, R(ctx, F.U - 5, F.V - 4, 3, 3), F.front, `${ctx.origin}/pay-booth`);
            run(m, [F.at(1, F.V - 3), F.at(2, F.V - 3)], 'appliance', 1, `${ctx.origin}/vacuum-station`);
        }
    },
    'parking-deck': {
        name: 'Two-level parking deck with a ramp', U: [22, 34], V: [20, 30], frontage: true, holdHost: false, buildings: 0,
        weights: { retail: 1, mixed: 1, roadside: 0.8, industrial: 0.4, suburban: 0.2, urban: 2.2 }, fill: ['aisle', 'asphalt'],
        dress(ctx) {
            const { F, m } = ctx, z = ctx.z, dz = z + 3;
            // The ramp runs up one side; it goes on whichever side is clear of a neighbour's door approach.
            const clear = mir => { for (let v = 5; v <= 11; v++) for (let u = 0; u <= 4; u++) { const [x, y] = F.at(mir ? F.U - 1 - u : u, v); if (!canStand(m, x, y)) return false; } return true; };
            const mir = !clear(false) && clear(true);
            if (!mir && !clear(false)) {
                // No side is clear: a plain surface lot instead of a deck.
                paint(m, ctx.R, 'asphalt', 'aisle', { z });
                const lot = parkingLot(m, F, { u0: 0, v0: 1, uw: F.U, vd: F.V - 2 }, { origin: `${ctx.origin}/lot`, frontage: ctx.frontage, z, islands: true });
                drive(ctx, lot.entry); frontage(ctx, 'low-wall', [[lot.entry - 1, lot.entry + 4]]);
                return;
            }
            const U = u => mir ? F.U - 1 - u : u, at = (u, v) => F.at(U(u), v);
            paint(m, ctx.R, 'asphalt', 'aisle', { z });
            drive(ctx, mir ? F.U - 5 : 1, 4); frontage(ctx, 'low-wall', [mir ? [F.U - 6, F.U - 1] : [0, 5]]);
            // Deck over the back of the parcel on concrete columns (hard cover below), ramp up along the clear side.
            const deck = R(ctx, mir ? 1 : 5, 6, F.U - 6, F.V - 7);
            for (let y = deck.y0; y < deck.y0 + deck.d; y++) for (let x = deck.x0; x < deck.x0 + deck.w; x++) put(m, x, y, dz, 'concrete', `${ctx.origin}/deck`);
            for (let v = 6; v < F.V - 1; v += 5) for (let u = 5; u < F.U - 1; u += 5) { const [x, y] = at(u, v); for (let h = z + 1; h < dz; h++) put(m, x, y, h, 'concrete_wall', `${ctx.origin}/column`); }
            const ramp = [];
            for (let i = 0; i < 3; i++) for (let w = 1; w <= 3; w++) { const [x, y] = at(w, 7 + i), h = z + 1 + i; for (let zz = z + 1; zz < h; zz++) put(m, x, y, zz, 'concrete', `${ctx.origin}/ramp`); put(m, x, y, h, 'asphalt', `${ctx.origin}/ramp`); m.reserve(x - 1, y - 1, x + 1, y + 1); tag(m, x, y, 'level'); if (w === 2) ramp.push({ x, y, z: h }); }
            // The ramp lands at v 10, which must be deck: extend the deck across the ramp head.
            for (let w = 1; w <= 4; w++) { const [x, y] = at(w, 10); put(m, x, y, dz, 'concrete', `${ctx.origin}/deck`); for (let zz = z + 1; zz < dz; zz++) if (w <= 3) put(m, x, y, zz, 'concrete', `${ctx.origin}/ramp`); }
            // Parapet on the deck edge (half cover for shooters up top), open at the ramp head.
            for (let y = deck.y0; y < deck.y0 + deck.d; y++) for (let x = deck.x0; x < deck.x0 + deck.w; x++) {
                const edge = x === deck.x0 || y === deck.y0 || x === deck.x0 + deck.w - 1 || y === deck.y0 + deck.d - 1;
                const nearRamp = ramp.some(r => Math.abs(r.x - x) + Math.abs(r.y - y) <= 3);
                if (edge && !nearRamp && !m.store.isSolid(x, y, dz + 1)) put(m, x, y, dz + 1, 'concrete_wall', `${ctx.origin}/parapet`);
            }
            // Deck cover that does not depend on parked cars: a stair/lift core in the far corner (full cover) and
            // jersey dividers between the stall rows (half cover), so the roof is a fight, not a shooting gallery.
            for (let du = 0; du < 2; du++) for (let dv = 0; dv < 2; dv++) { const [x, y] = at(F.U - 5 + du, F.V - 5 + dv); for (let h = 1; h <= 2; h++) put(m, x, y, dz + h, 'concrete_wall', `${ctx.origin}/lift-core`); }
            for (let v = 13; v <= F.V - 4; v += 4) for (let u = 6; u + 1 < F.U - 6; u += 5) for (let k = 0; k < 2; k++) {
                const [x, y] = at(u + k, v);
                if (!m.store.isSolid(x, y, dz + 1) && !m.district.stallCells.has(`${x},${y}`)) put(m, x, y, dz + 1, 'jersey', `${ctx.origin}/deck-divider`);
            }
            // Cars on the roof deck (slots at deck level) and along the front at ground level.
            for (let u = 7; u + 2 < F.U - 2; u += 3) slot(ctx, mir ? F.U - 2 - u : u, 8, { kind: 'stall', priority: 0.6, part: 'roof-stall', z: dz });
            for (let u = 7; u + 2 < F.U - 1; u += 3) slot(ctx, mir ? F.U - 2 - u : u, 1, { kind: 'stall', priority: 0.7, part: 'front-stall' });
            const [gx, gy] = at(2, 6), [tx, ty] = at(2, 10);
            ctx.connector({ id: `${ctx.origin}-ramp`, template: 'parking-ramp', sockets: [{ x: gx, y: gy, z }, { x: tx, y: ty, z: dz }] });
        }
    },
    scrapyard: {
        name: 'Scrapyard with crushed-car bales', U: [24, 40], V: [22, 34], frontage: true, buildings: 0,
        weights: { industrial: 1.2, roadside: 1, mixed: 0.5, retail: 0.2, suburban: 0.1, urban: 0 }, fill: ['construction', 'gravel'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'gravel', 'construction', { z: ctx.z });
            frontage(ctx, 'chain', [[3, 8]]); drive(ctx, 4, 4);
            boundary(ctx, 'privacy', { gates: { [F.back]: [0.5], [F.left]: [0.7] } });
            // Bale stacks (steel, very tough, 1–2 high) in rows with 3-wide lanes; wrecks waiting to be crushed.
            for (let v = 5; v + 1 < F.V - 2; v += 5) for (let u = 2; u + 1 < F.U - 2; u += 5) {
                if (u <= 9 && v <= 6) continue;
                const h = ((u + v) % 3) ? 2 : 1;
                block(m, R(ctx, u, v, 2, 2), 'metal', h, `${ctx.origin}/bale-stack`, { landUse: 'construction' });
            }
            for (let u = 12; u + 2 < F.U - 2; u += 7) slot(ctx, u, 1, { kind: 'salvage', types: ['abandoned_car'], part: 'wreck' });
            const pc = R(ctx, F.U - 7, F.V - 4, 5, 2);
            if (block(m, pc, 'container', 2, `${ctx.origin}/site-office`, { landUse: 'construction' })) m.object('container', [...Array(pc.w * pc.d)].flatMap((_, i) => [[pc.x0 + (i % pc.w), pc.y0 + Math.floor(i / pc.w), ctx.z + 1], [pc.x0 + (i % pc.w), pc.y0 + Math.floor(i / pc.w), ctx.z + 2]]), { axis: pc.w >= pc.d ? 'x' : 'y', dir: 1, size: [5, 2], tint: [0.55, 0.5, 0.42] });
        }
    },
    'bus-depot': {
        name: 'Bus depot: garage, bus bays and a fuel island', U: [32, 46], V: [26, 36], frontage: true, buildings: 1,
        weights: { industrial: 1.2, roadside: 1.4, mixed: 0.7, retail: 0.3, suburban: 0.2, urban: 0.4 }, fill: ['apron', 'concrete'],
        plan(ctx) { const { F } = ctx; return { b: building(ctx, { u0: F.U - 18, v0: F.V - 13, uw: 16, vd: 11 }, { program: 'garage', storeys: 1, part: 'depot', rounded: false }) }; },
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'concrete', 'apron', { z: ctx.z });
            frontage(ctx, 'chain', [[2, 9]]); drive(ctx, 3, 6);
            boundary(ctx, 'chain', { gates: { [F.back]: [0.2] } });
            for (let u = 2; u + 2 < F.U - 19; u += 4) slot(ctx, u, 10, { len: 8, kind: 'dock', types: ['bus'], priority: 0.9, part: 'bus-bay' });
            const isl = R(ctx, F.U - 14, 3, 6, 2); paint(m, isl, 'concrete', 'forecourt', { z: ctx.z });
            run(m, [F.at(F.U - 13, 3), F.at(F.U - 10, 3)], 'pump', 1, `${ctx.origin}/fuel-pump`);
            canopy(m, R(ctx, F.U - 15, 2, 8, 4), `${ctx.origin}/fuel-canopy`, { z: ctx.z });
        }
    },
    utility: {
        name: 'Fenced substation', U: [10, 18], V: [10, 18], frontage: false, buildings: 0, cap: 2,
        weights: { industrial: 1.2, mixed: 0.8, retail: 0.5, suburban: 0.6, roadside: 0.6, urban: 0.3 }, fill: ['utility', 'gravel'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'gravel', 'utility', { z: ctx.z });
            paint(m, R(ctx, 2, 2, F.U - 4, F.V - 4), 'concrete', 'utility', { z: ctx.z });
            fenceRect(m, ctx.R, 'chain', `${ctx.origin}/fence`, { gates: { [F.front]: [0.5] } });
            for (let u = 3; u + 1 < F.U - 3; u += 4) block(m, R(ctx, u, Math.floor(F.V / 2) - 1, 2, 2), 'appliance', 2, `${ctx.origin}/transformer`, { landUse: 'utility' });
            block(m, R(ctx, 3, F.V - 4, 2, 1), 'appliance', 1, `${ctx.origin}/control-cabinet`, { landUse: 'utility' });
        }
    },
    construction: {
        name: 'Construction site', U: [14, 40], V: [14, 34], frontage: false, buildings: 0,
        weights: { mixed: 1, industrial: 1.5, retail: 0.7, suburban: 0.5, roadside: 0.6, urban: 0.8 }, fill: ['construction', 'gravel'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'gravel', 'construction', { z: ctx.z });
            fenceRect(m, ctx.R, 'hoarding', `${ctx.origin}/hoarding`, { gates: { [F.front]: [0.3], [F.back]: [0.7] } });
            // A half-built concrete frame: columns on a 4-cell grid and a slab over part of it, with a ladder up.
            const fu0 = 3, fv0 = Math.floor(F.V / 2) - 2, fu1 = Math.min(F.U - 4, fu0 + 12), fv1 = Math.min(F.V - 4, fv0 + 8), z = ctx.z;
            const cols = [];
            for (let u = fu0; u <= fu1; u += 4) for (let v = fv0; v <= fv1; v += 4) cols.push(F.at(u, v));
            const okCols = cols.filter(([x, y]) => canStand(m, x, y));
            if (okCols.length >= 4) {
                for (const [x, y] of okCols) for (let k = 1; k <= 3; k++) put(m, x, y, z + k, 'concrete_wall', `${ctx.origin}/frame-column`);
                const slab = R(ctx, fu0, fv0, Math.min(9, fu1 - fu0 + 1), fv1 - fv0 + 1);
                for (let y = slab.y0; y < slab.y0 + slab.d; y++) for (let x = slab.x0; x < slab.x0 + slab.w; x++) if (!m.store.isSolid(x, y, z + 3)) put(m, x, y, z + 3, 'concrete', `${ctx.origin}/frame-slab`);
                tagRect(m, slab, 'construction');
                const [lx, ly] = F.at(fu0 + 2, fv0 - 1), [ix, iy] = F.at(fu0 + 2, fv0);
                if (canStand(m, lx, ly) && m.store.isSolid(ix, iy, z + 3)) { try { const l = m.ladder(lx, ly, ix - lx, iy - ly); registerSolids(m, { x0: lx, y0: ly, w: 1, d: 1 }, `${ctx.origin}/ladder`); ctx.connector({ id: `${ctx.origin}-ladder`, template: 'site-ladder', sockets: [{ x: lx, y: ly, z: l.foot }, { x: ix, y: iy, z: l.top }] }); } catch { /* no ledge: leave the slab as cover */ } }
            }
            for (let u = F.U - 6; u >= fu1 + 2 && u > 2; u -= 4) rowOf(ctx, u, u + 1, 3, 'pallet', 1, 'material-pile');
            rowOf(ctx, 2, 3, F.V - 3, 'brick', 1, 'brick-pallets');
            const pc = R(ctx, F.U - 7, F.V - 4, 5, 2);
            if (block(m, pc, 'container', 2, `${ctx.origin}/portacabin`, { landUse: 'construction' })) m.object('container', [...Array(pc.w * pc.d)].flatMap((_, i) => [[pc.x0 + (i % pc.w), pc.y0 + Math.floor(i / pc.w), z + 1], [pc.x0 + (i % pc.w), pc.y0 + Math.floor(i / pc.w), z + 2]]), { axis: pc.w >= pc.d ? 'x' : 'y', dir: 1, size: [5, 2], tint: [0.85, 0.83, 0.78] });
            slot(ctx, 2, 3, { len: 6, kind: 'site', types: ['truck'], priority: 1, part: 'plant' });
        }
    },
    'vacant-lot': {
        name: 'Vacant lot', U: [10, 30], V: [10, 30], frontage: false, buildings: 0, cap: 1,
        weights: { mixed: 0.3, industrial: 0.4, retail: 0.2, suburban: 0.2, roadside: 0.4, urban: 0.15 }, fill: ['green', 'soil'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'gravel', 'green', { z: ctx.z });
            for (let v = 1; v < F.V - 1; v += 3) paint(m, R(ctx, (v * 7) % Math.max(1, F.U - 4), v, 3, 2), 'soil', 'green', { z: ctx.z });
            frontage(ctx, 'chain', [[Math.floor(F.U / 2) - 1, Math.floor(F.U / 2) + 1]]);
            plantTree(m, ...F.at(F.U - 3, F.V - 3), `${ctx.origin}/overgrowth`); plantTree(m, ...F.at(2, F.V - 4), `${ctx.origin}/overgrowth`);
            slot(ctx, Math.floor(F.U / 2) + 2, 3, { kind: 'salvage', types: ['abandoned_car'], priority: 1, part: 'dumped-car' });
        }
    },
    'community-garden': {
        name: 'Community garden', U: [12, 26], V: [12, 26], frontage: false, buildings: 0,
        weights: { suburban: 2, mixed: 1, retail: 0.3, industrial: 0.2, roadside: 0.1, urban: 0.3 }, fill: ['green', 'lawn'],
        dress(ctx) {
            const { F, m } = ctx;
            paint(m, ctx.R, 'lawn', 'green', { z: ctx.z });
            fenceRect(m, ctx.R, 'picket', `${ctx.origin}/garden-fence`, { gates: { [F.front]: [0.5], [F.back]: [0.5] } });
            for (let v = 2; v + 1 < F.V - 3; v += 4) for (let u = 2; u + 3 < F.U - 2; u += 6) paint(m, R(ctx, u, v, 4, 2), 'soil', 'green', { z: ctx.z });
            paint(m, R(ctx, Math.floor(F.U / 2), 1, 1, F.V - 2), 'gravel', 'path', { z: ctx.z });
            block(m, R(ctx, F.U - 4, F.V - 4, 2, 2), 'siding', 2, `${ctx.origin}/tool-shed`, { roofKey: 'roof_metal', landUse: 'green' });
            run(m, [F.at(2, F.V - 3), F.at(3, F.V - 3)], 'barrel_water', 1, `${ctx.origin}/water-butts`);
            plantTree(m, ...F.at(1, 1), `${ctx.origin}/tree`);
        }
    }

});
export const MIX_IDS = Object.freeze(Object.keys(MIXES));
export const mixWeight = (id, family) => W(MIXES[id].weights, family);

/** Does a mix fit a parcel of local size U × V (and, if it needs one, a road frontage)? */
export function mixFits(id, { U, V, frontage }, { elevated = true } = {}) {
    const x = MIXES[id];
    if (!x) return false;
    if (x.requires === 'elevated' && !elevated) return false;
    if (x.frontage && !frontage) return false;
    return U >= x.U[0] && U <= x.U[1] && V >= x.V[0] && V <= x.V[1];
}
