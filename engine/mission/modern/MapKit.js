import { organizeStreetLights } from '../../mapgen/StreetLighting.js';
// Map-authoring toolkit for the present-day themes: ground, roads, buildings, vehicles, trees, hedges, decor, the
// theme cover pass and the finishing step. Every map is still a voxel grid (the gameplay truth); vehicles, trees and
// furniture also leave render hints so the tile set can draw them as whole objects, and decor is visual only.
import { ladderAttachment, validateLadders } from '../../world/LadderAttachment.js';
import { VoxelStore } from '../../voxel/VoxelStore.js';
import { MAT } from '../../voxel/Materials.js';
import { createRng, hashString } from '../../util/Rng.js';
import { buildModern } from './ModernBuilder.js';
import { scatterCover } from '../CoverScatter.js';
import { finalizeMission } from '../MissionCommon.js';

export const CAR_COLORS = [[0.92, 0.93, 0.94], [0.18, 0.2, 0.23], [0.42, 0.5, 0.47], [0.62, 0.66, 0.7], [0.55, 0.14, 0.12], [0.2, 0.3, 0.45], [0.75, 0.7, 0.6]];
export const CONTAINER_COLORS = [[0.62, 0.2, 0.14], [0.16, 0.3, 0.5], [0.2, 0.42, 0.3], [0.78, 0.5, 0.16], [0.55, 0.57, 0.6]];

export function createMap({ id, width, depth, height = 14, seed = 1, ground = 'lawn', datum = 1 }) {
    const store = new VoxelStore(width, depth, height);
    const rng = createRng(hashString(`${id}:${seed}`));
    let next = 0;
    const ctx = { rng, rooms: [], nextRoomId: () => next++, hints: {}, decor: [] };
    const m = {
        id, seed, store, rng, ctx, buildings: [], keep: new Set(), G: datum,
        hints: ctx.hints, decor: ctx.decor,
        ground(x0, y0, x1, y1, key, z = datum) {
            for (let y = Math.max(0, y0); y <= Math.min(depth - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) store.set(x, y, z, MAT[key]);
        },
        /** Keep these cells free of scattered cover (approaches, spawns, driveways). */
        reserve(x0, y0, x1, y1) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.keep.add(`${x},${y}`); },
        /** Road along x (rows y0..y1) with a dashed centre line. */
        roadX(y0, y1, x0 = 0, x1 = width - 1, { dash = true, curb = 'concrete' } = {}) {
            m.ground(x0, y0, x1, y1, 'asphalt');
            if (dash) { const yc = Math.floor((y0 + y1) / 2); for (let x = x0 + 1; x <= x1; x += 4) m.ground(x, yc, Math.min(x1, x + 1), yc, 'road_mark'); }
            if (curb) { m.ground(x0, y0 - 1, x1, y0 - 1, curb); m.ground(x0, y1 + 1, x1, y1 + 1, curb); }
        },
        roadY(x0, x1, y0 = 0, y1 = depth - 1, { dash = true, curb = 'concrete' } = {}) {
            m.ground(x0, y0, x1, y1, 'asphalt');
            if (dash) { const xc = Math.floor((x0 + x1) / 2); for (let y = y0 + 1; y <= y1; y += 4) m.ground(xc, y, xc, Math.min(y1, y + 1), 'road_mark'); }
            if (curb) { m.ground(x0 - 1, y0, x0 - 1, y1, curb); m.ground(x1 + 1, y0, x1 + 1, y1, curb); }
        },
        /** Zebra crossing across a road running along x, at column x. */
        crossingX(x, y0, y1) { for (let y = y0; y <= y1; y++) for (let dx = 0; dx < 3; dx += 2) store.set(x + dx, y, 1, MAT.road_mark); },
        building(spec) {
            const b = buildModern(store, { baseZ: 1, ...spec }, ctx);
            m.buildings.push(b);
            for (const [x, y] of b.approach) m.keep.add(`${x},${y}`);
            for (const e of b.exits) { const k = `${e.x},${e.y}`; m.keep.add(k); }
            return b;
        },
        /** A line of `key` voxels h tall. axis 'x' | 'y'. */
        line(x, y, len, axis, key, h = 1, z = datum) {
            for (let i = 0; i < len; i++) for (let k = 1; k <= h; k++) store.set(x + (axis === 'x' ? i : 0), y + (axis === 'y' ? i : 0), z + k, MAT[key]);
        },
        hedge(x, y, len, axis, z = 1) { m.line(x, y, len, axis, 'hedge', 1, z); },
        /**
         * Steel ladder in cell (x, y) leaning on its neighbour in direction (dx, dy): rungs from the ground up to the
         * neighbour's top, so units climb from (x, y) onto that ledge (PathSearch.ladderMoves). Fails loudly when the
         * top is not a standable ledge or the ladder cell is not open ground.
         */
        ladder(x, y, dx, dy) {
            const foot = store.topSolid(x, y), top = store.topSolid(x + dx, y + dy);
            const land = store.surfaces(x + dx, y + dy).find(s => s.z === top);
            if (!(top - foot >= 2) || !land || land.headroom < 2)
                throw new Error(`${id}: no ledge for a ladder at ${x},${y} → ${dx},${dy} (foot ${foot}, top ${top})`);
            for (let z = foot + 1; z <= top; z++) if(!store.isSolid(x+dx,y+dy,z)) throw Error(`ladder.attachment: ${id} ${x},${y},${z}`);
            for (let z = foot + 1; z <= top; z++) store.set(x, y, z, MAT.ladder);
            m.reserve(x - 2, y - 2, x + 2, y + 2);
            return { x, y, foot, top };
        },
        /**
         * Parked car: 2 wide × 4 long, body voxels (half cover) with a cabin over the middle two rows (full cover there).
         * axis: the long axis; dir +1 / −1: which end is the front.
         */
        car(x, y, axis = 'x', dir = 1, color = null, z = 1) {
            const L = 4, Wd = 2, cells = [];
            for (let i = 0; i < L; i++) for (let j = 0; j < Wd; j++) {
                const cx = axis === 'x' ? x + i : x + j, cy = axis === 'x' ? y + j : y + i;
                store.set(cx, cy, z + 1, MAT.car_body); cells.push([cx, cy, z + 1]);
                if (i === 1 || i === 2) { store.set(cx, cy, z + 2, MAT.car_cabin); cells.push([cx, cy, z + 2]); }
            }
            const tint = color || CAR_COLORS[Math.floor(rng.next() * CAR_COLORS.length)];
            m.object('car', cells, { axis, dir, size: [L, Wd], tint });
        },
        /** Shipping container: 2 wide × 5 long × 2 high (full cover, very tough). */
        container(x, y, axis = 'x', color = null, z = 1, stacked = false) {
            const L = 5, Wd = 2, cells = [];
            for (let i = 0; i < L; i++) for (let j = 0; j < Wd; j++) for (let h = 1; h <= 2; h++) {
                const cx = axis === 'x' ? x + i : x + j, cy = axis === 'x' ? y + j : y + i;
                store.set(cx, cy, z + h, MAT.container); cells.push([cx, cy, z + h]);
            }
            m.object('container', cells, { axis, dir: 1, size: [L, Wd], tint: color || CONTAINER_COLORS[Math.floor(rng.next() * CONTAINER_COLORS.length)] });
            if (stacked) m.container(x, y, axis, null, z + 2);
        },
        dumpster(x, y, axis = 'x', z = 1) {
            const cells = [0, 1].map(i => [axis === 'x' ? x + i : x, axis === 'y' ? y + i : y, z + 1]);
            for (const [cx, cy, cz] of cells) store.set(cx, cy, cz, MAT.dumpster);
            m.object('dumpster', cells, { axis, dir: 1, size: [2, 1] });
        },
        /** A multi-cell object drawn as one piece while it is intact (hints: anchor + members). */
        object(piece, cells, { axis, dir, size, tint = null }) {
            const anchor = cells.reduce((a, c) => (c[2] < a[2] || (c[2] === a[2] && (c[1] < a[1] || (c[1] === a[1] && c[0] < a[0]))) ? c : a));
            const ak = anchor.join(',');
            const xs = cells.map(c => c[0]), ys = cells.map(c => c[1]);
            const centre = [(Math.min(...xs) + Math.max(...xs) + 1) / 2, (Math.min(...ys) + Math.max(...ys) + 1) / 2];
            const yaw = axis === 'x' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
            ctx.hints[ak] = { piece, yaw, centre, z: anchor[2], cells: cells.map(c => c.join(',')), materials:cells.map(c=>store.get(...c)), tint };
            for (const c of cells) if (c.join(',') !== ak) ctx.hints[c.join(',')] = { member: ak };
        },
        /** Tree: trunk + canopy voxels (cover and sight); drawn as one tree while its trunk stands. kind 'round' | 'conifer' | 'palm'. */
        tree(x, y, kind = 'round', z = 1) {
            const cells = [];
            // PLAN-14: a canopy only fills empty air (never a ladder rung, railing or other non-solid fixture).
            const put = (cx, cy, cz, key) => { if (store.inBounds(cx, cy, cz) && store.get(cx, cy, cz) === 0) { store.set(cx, cy, cz, MAT[key]); cells.push([cx, cy, cz]); } };
            if (kind === 'conifer') {
                put(x, y, z + 1, 'trunk');
                for (let h = 2; h <= 5; h++) put(x, y, z + h, 'leaves');
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(x + dx, y + dy, z + 2, 'leaves');
            } else {
                for (let h = 1; h <= 3; h++) put(x, y, z + h, 'trunk');
                for (let dz = 3; dz <= 5; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    if (Math.abs(dx) + Math.abs(dy) + (dz === 5 ? 1 : 0) > 2 || (dx === 0 && dy === 0 && dz < 4)) continue;
                    put(x + dx, y + dy, z + dz, 'leaves');
                }
            }
            if (!cells.length) return;
            const base = `${x},${y},${z + 1}`;
            ctx.hints[base] = { piece: kind === 'conifer' ? 'tree_conifer' : 'tree_round', yaw: rng.next() * 6.28, scale: 0.9 + rng.next() * 0.25, tree: true, cells: cells.map(c => c.join(',')) };
            for (const c of cells) if (c.join(',') !== base) ctx.hints[c.join(',')] = { member: base, tree: true };
        },
        decorAt(kind, x, y, extra = {}) {
            const z = extra.z ?? (store.topSolid(x, y) + 1);
            ctx.decor.push({ kind, x, y, z, yaw: extra.yaw ?? 0, ...extra });
        },
        /** Theme cover pass over open ground, keeping reserved cells and building surrounds clear. */
        scatter(catalog, { maxGap = 4, targetShare = 0.3, budget, margin = 1, blocked = () => false } = {}) {
            const near = (x, y) => m.buildings.some(b => x >= b.x0 - 1 && y >= b.y0 - 1 && x <= b.x0 + b.w && y <= b.y0 + b.d);
            return scatterCover(store, { rng, props: catalog, maxGap, targetShare, budget, margin,
                blocked: (x, y) => m.keep.has(`${x},${y}`) || near(x, y) || blocked(x, y) });
        },
        finish({ name, spawns, objective, meta = {} }) {
            validateLadders(store);
            const streetLights=organizeStreetLights(m,{roads:m.lightRoutes||[],spacing:meta.lightSpacing||12});
            // Decor that a later prop or the cover pass landed on is dropped.
            for (let i = ctx.decor.length - 1; i >= 0; i--) {
                const d = ctx.decor[i];
                if (d.free) continue;
                if (store.get(Math.floor(d.x + 0.5), Math.floor(d.y + 0.5), d.z) !== 0) ctx.decor.splice(i, 1);
            }
            return finalizeMission({ id, name, store, rooms: ctx.rooms, buildings: m.buildings, spawns, rng, objective,
                meta: { seed, ...meta, streetLighting:{algorithm:"curb-arclength-v1",count:streetLights.length}, timeOfDay: meta.timeOfDay || meta.lighting || 'day' }, visual: { hints: ctx.hints, decor: ctx.decor } });
        }
    };
    store.fill(0, 0, 0, width - 1, depth - 1, 0, 'bedrock');
    if(datum>1)store.fill(0,0,1,width-1,depth-1,datum-1,'concrete');
    store.datum=datum;
    m.ground(0, 0, width - 1, depth - 1, ground);
    return m;
}
