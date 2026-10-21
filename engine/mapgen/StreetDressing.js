import {MAT} from '../voxel/Materials.js';
export const VEHICLE_SPECS=Object.freeze({car:{length:4,width:2,axles:2},abandoned_car:{length:4,width:2,axles:2},truck:{length:6,width:2,axles:2},bus:{length:8,width:2,axles:3},semitrailer:{length:10,width:2,axles:4},eighteen_wheeler:{length:12,width:2,axles:5}});
/** A whole object and its exact tactical footprint share one descriptor. */
export function placeStreetVehicle(m,type,x,y,{axis='x',z=m.G}={}) {
 const spec=VEHICLE_SPECS[type];if(!spec)throw Error(`Unknown street vehicle ${type}`);
 const cells=[];
 for(let i=0;i<spec.length;i++)for(let j=0;j<spec.width;j++){
  const px=x+(axis==='x'?i:j),py=y+(axis==='x'?j:i);
  if(!m.store.inBounds(px,py,z)||m.store.topSolid(px,py)!==z||m.keep.has(`${px},${py}`))return null;
  for(let h=1;h<=2;h++)if(m.store.get(px,py,z+h)!==0)return null;
 }
 for(let i=0;i<spec.length;i++)for(let j=0;j<spec.width;j++){
  const px=x+(axis==='x'?i:j),py=y+(axis==='x'?j:i);
  m.store.set(px,py,z+1,MAT.car_body);cells.push([px,py,z+1]);
  if(type!=='abandoned_car'&&(type!=='car'||i===1||i===2)){m.store.set(px,py,z+2,MAT.car_cabin);cells.push([px,py,z+2]);}
 }
 m.object(type,cells,{axis,dir:1,size:[spec.length,spec.width],tint:type==='abandoned_car'?[.27,.25,.22]:type==='bus'?[.18,.4,.5]:null});
 m.reserve(x-1,y-1,x+(axis==='x'?spec.length:spec.width),y+(axis==='x'?spec.width:spec.length));
 return {type,x,y,z,axis,length:spec.length,width:spec.width};
}
// PLAN-06 §5.5/§5.10 — streets as data. A road is { id, axis: 'x'|'y', lo, hi (carriageway rows/columns), from, to
// (extent along the road), z, kind: 'main'|'cross'|'service', sidewalk }. Roads own their carriageway, kerbs and
// sidewalks (land use), offer kerb-lane vehicle slots, and place street furniture by rule — never by scatter.
import { tag, tagAt, groundAt, put, k2 } from './district/Core.js';
import { addStall, canStand } from './district/Props.js';

const along = (r, i, j) => r.axis === 'x' ? [i, j] : [j, i];
/** Tag carriageway, kerbs and sidewalks; pave the sidewalks. */
export function registerRoads(m, roads) {
    const d = m.district;
    d.roadKind ||= new Map();
    const own = (x, y, tag, z) => {
        if (!m.store.inBounds(x, y, z) || !d.contains(x, y)) return;
        const key = k2(x, y), entries = d.roadOwnership.get(key) || [];
        const current = entries.find(e => e.z === z);
        if (!current) entries.push({ tag, z });
        else if (tag === 'road') current.tag = tag;
        d.roadOwnership.set(key, entries);
    };
    const mark = (x, y, kind) => { const k = k2(x, y), cur = d.roadKind.get(k); if (!cur || cur === 'service' || (cur === 'cross' && kind === 'main')) d.roadKind.set(k, kind); };
    for (const r of roads) for (let i = r.from; i <= r.to; i++) for (let j = r.lo - 2 - (r.sidewalk ?? 2); j <= r.hi + 2 + (r.sidewalk ?? 2); j++) { const [x, y] = along(r, i, j); mark(x, y, r.kind); }
    for (const r of roads) for (let i = r.from; i <= r.to; i++) for (let j = r.lo; j <= r.hi; j++) { const [x, y] = along(r, i, j); if (d.contains(x, y)) { own(x, y, 'road', r.z); tag(m, x, y, 'road', { force: true }); } }
    for (const r of roads) for (let i = r.from; i <= r.to; i++) {
        for (const j of [r.lo - 1, r.hi + 1]) { const [x, y] = along(r, i, j); if (d.contains(x, y) && tagAt(m, x, y) === 'plain' && m.store.topSolid(x, y) === r.z) { own(x, y, 'kerb', r.z); tag(m, x, y, 'kerb'); } }
        for (let k = 0; k < (r.sidewalk ?? 2); k++) for (const j of [r.lo - 2 - k, r.hi + 2 + k]) {
            const [x, y] = along(r, i, j);
            if (!d.contains(x, y) || tagAt(m, x, y) !== 'plain' || m.store.topSolid(x, y) !== r.z) continue;
            m.store.set(x, y, r.z, MAT.paving); own(x, y, 'sidewalk', r.z); tag(m, x, y, 'sidewalk');
        }
    }
    m.lightRoutes = roads.filter(r => r.z === m.G).map(r => { const c = (r.lo + r.hi + 1) / 2; return { id: r.id, width: r.hi - r.lo + 1, points: r.axis === 'x' ? [[r.from, c], [r.to + 1, c]] : [[c, r.from], [c, r.to + 1]] }; });
}
const nearJunction = (roads, r, i, pad = 5) => roads.some(o => o !== r && o.axis !== r.axis && i >= o.lo - pad && i <= o.hi + pad && (r.lo <= o.to && r.hi >= o.from));
const nearDriveway = (m, r, i, pad = 2) => { for (let di = -pad; di <= pad + 4; di++) for (const j of [r.lo - 2, r.hi + 2]) { const [x, y] = along(r, i + di, j); if (tagAt(m, x, y) === 'driveway') return true; } return false; };
/** Kerb-lane slots: cars along main and cross streets, staggered sides; long vehicles on service roads. */
export function kerbStalls(m, roads, { avoid = () => false } = {}) {
    let count = 0;
    for (const r of roads) {
        if (r.hi - r.lo + 1 < 5 || r.parking === false) continue;
        const service = r.kind === 'service', len = service ? 12 : 4, step = service ? 14 : 7;
        for (let i = r.from + 8, n = 0; i + len < r.to - 4; i += step, n++) {
            if (nearJunction(roads, r, i) || nearJunction(roads, r, i + len) || nearDriveway(m, r, i) || avoid(...along(r, i, r.lo))) continue;
            const side = n % 2 ? 'hi' : 'lo', j = side === 'lo' ? r.lo : r.hi - 1;
            const [x, y] = along(r, i, j);
            if (addStall(m, { x, y, axis: r.axis, length: len, width: 2, kind: service ? 'service' : 'kerb', types: service ? ['car', 'truck', 'semitrailer', 'eighteen_wheeler'] : (n % 5 === 4 ? ['truck', 'car'] : ['car']), priority: 0.4, z: r.z, origin: `road:${r.id}/kerb-${side}` })) count++;
        }
    }
    return count;
}
/** Bus stops: a shelter on the outer sidewalk row and a bus bay in the kerb lane in front of it. */
export function busStops(m, roads, { max = 2 } = {}) {
    const out = [];
    const mains = roads.filter(r => r.kind === 'main').sort((a, b) => (b.to - b.from) - (a.to - a.from));
    for (const r of mains) for (const [f, side] of [[0.3, 'hi'], [0.7, 'lo']]) {
        if (out.length >= max) break;
        for (let tries = 0; tries < 12; tries++) {
            const i = Math.round(r.from + (r.to - r.from) * f) + (tries % 2 ? -1 : 1) * tries * 2;
            if (nearJunction(roads, r, i, 4) || nearJunction(roads, r, i + 8, 4) || nearDriveway(m, r, i, 1)) continue;
            const row = side === 'hi' ? r.hi + 3 : r.lo - 3, lane = side === 'hi' ? r.hi - 1 : r.lo;
            const cells = [0, 1, 2].map(k => along(r, i + 3 + k, row));
            if (!cells.every(([x, y]) => tagAt(m, x, y) === 'sidewalk' && !m.keep.has(k2(x, y)) && !m.district.stallCells.has(k2(x, y)) && m.store.topSolid(x, y) === r.z)) continue;
            const [bx, by] = along(r, i, lane);
            const st = addStall(m, { x: bx, y: by, axis: r.axis, length: 8, width: 2, kind: 'bus-stop', types: ['bus'], priority: 1, z: r.z, origin: `road:${r.id}/bus-stop-${side}` });
            if (!st) continue;
            const voxels = [];
            for (const [x, y] of cells) for (let h = 1; h <= 2; h++) { put(m, x, y, r.z + h, 'car_cabin', `road:${r.id}/bus-shelter`); voxels.push([x, y, r.z + h]); }
            m.object('transit_shelter', voxels, { axis: r.axis, dir: 1, size: [3, 1] });
            for (const [x, y] of cells) { const [ix, iy] = r.axis === 'x' ? [x, y + (side === 'hi' ? -1 : 1)] : [x + (side === 'hi' ? -1 : 1), y]; m.reserve(ix, iy, ix, iy); }
            out.push({ type: 'transit_shelter', x: cells[0][0], y: cells[0][1], z: r.z, road: r.id }); break;
        }
    }
    return out;
}
/**
 * Road dressing sets (PLAN-05 §5.7, placed by level design, never by scatter):
 *   roadblock  at the insertion end of the main street: jersey barriers across one carriageway half and an
 *              abandoned car, leaving a lane through — the squad's first cover
 *   stalled    abandoned cars in the centre lanes every ~30 cells of straight main street: sightline breakers
 * Every vehicle is a registered slot; every barrier carries a roadset origin.
 */
export function roadSets(m, roads, { spawn = null } = {}) {
    const out = [];
    for (const r of roads.filter(r => r.kind === 'main' && r.hi - r.lo + 1 >= 5)) {
        const z = r.z;
        if (spawn && r.from <= spawn.x + 12) {
            const i = r.from + 4;
            const barrier = [0, 1, 2].map(k => along(r, i, r.lo + k));
            if (barrier.every(([x, y]) => !m.store.isSolid(x, y, z + 1) && !m.district.stallCells.has(k2(x, y)))) {
                for (const [x, y] of barrier) put(m, x, y, z + 1, 'jersey', `roadset:${r.id}/roadblock`);
                const [cx, cy] = along(r, i + 3, r.hi - 1);
                addStall(m, { x: cx, y: cy, axis: r.axis, length: 4, kind: 'salvage', types: ['abandoned_car'], priority: 1, z, origin: `roadset:${r.id}/roadblock-car` });
                out.push({ type: 'roadblock', road: r.id, at: i });
            }
        }
        // A crashed car at the mouth of each cross street that meets this one.
        for (const c of roads.filter(c => c.kind === 'cross' && c.axis !== r.axis && c.lo <= r.to && c.hi >= r.from)) {
            // The junction itself: two wrecks offset either side of the cross street, a lane left through.
            for (const [ii, jj] of [[c.lo - 6, r.lo + 1], [c.hi + 2, r.hi - 1]]) { const [wx, wy] = along(r, ii, jj); addStall(m, { x: wx, y: wy, axis: r.axis, length: 4, kind: 'salvage', types: ['abandoned_car'], priority: 1, z: r.z, origin: `roadset:${r.id}/junction-crash` }); }
            const i = c.from < r.lo ? r.lo - 10 : r.hi + 6;
            const [x, y] = along(c, i, c.lo);
            if (addStall(m, { x, y, axis: c.axis, length: 4, kind: 'salvage', types: ['abandoned_car'], priority: 1, z: c.z, origin: `roadset:${c.id}/crash` })) {
                const [jx, jy] = along(c, i + 5, c.lo + 2);
                if (!m.store.isSolid(jx, jy, c.z + 1) && !m.keep.has(k2(jx, jy))) put(m, jx, jy, c.z + 1, 'jersey', `roadset:${c.id}/crash`);
                out.push({ type: 'crash', road: c.id, at: i });
            }
        }
        // A divided road gets a jersey-barrier median in runs of six with three-cell crossings (low cover mid-road).
        if (r.median && r.hi - r.lo + 1 >= 8) {
            const j0 = Math.floor((r.lo + r.hi) / 2);
            for (let i = r.from + 10; i + 6 < r.to - 2; i += 9) {
                if (nearJunction(roads, r, i, 4) || nearJunction(roads, r, i + 5, 4)) continue;
                const cells = [];
                for (let k = 0; k < 6; k++) for (const j of [j0, j0 + 1]) cells.push(along(r, i + k, j));
                if (!cells.every(([x, y]) => !m.store.isSolid(x, y, z + 1) && !m.district.stallCells.has(k2(x, y)) && !m.keep.has(k2(x, y)))) continue;
                for (const [x, y] of cells) put(m, x, y, z + 1, 'jersey', `roadset:${r.id}/median`);
                out.push({ type: 'median', road: r.id, at: i });
            }
        }
        for (let i = r.from + 26; i + 5 < r.to - 6; i += 30) {
            if (nearJunction(roads, r, i, 6) || nearJunction(roads, r, i + 4, 6)) continue;
            const [x, y] = along(r, i, r.lo + 1);
            if (addStall(m, { x, y, axis: r.axis, length: 4, kind: 'salvage', types: ['abandoned_car'], priority: 1, z, origin: `roadset:${r.id}/stalled-${i}` })) out.push({ type: 'stalled', road: r.id, at: i });
        }
    }
    return out;
}
/** Traffic posts by rule: signal poles on the kerb corners of every junction, sign posts on its approaches. */
export function streetPosts(m, roads) {
    const out = [];
    const post = (x, y, z, rule, allowKerb = true) => {
        const t = tagAt(m, x, y);
        if (!(t === 'sidewalk' || (allowKerb && t === 'kerb')) || m.keep.has(k2(x, y)) || m.district.stallCells.has(k2(x, y)) || m.store.topSolid(x, y) !== z || m.store.isSolid(x, y, z + 1)) return false;
        put(m, x, y, z + 1, 'steel_post', `road:${rule}`); out.push({ type: 'post', x, y, z }); return true;
    };
    for (const a of roads) for (const b of roads) {
        if (a.axis !== 'x' || b.axis !== 'y' || a.z !== b.z || b.lo > a.to || b.hi < a.from || a.lo > b.to || a.hi < b.from) continue;
        for (const [x, y] of [[b.lo - 1, a.lo - 1], [b.hi + 1, a.lo - 1], [b.lo - 1, a.hi + 1], [b.hi + 1, a.hi + 1]]) post(x, y, a.z, `junction-${a.id}-${b.id}/signal`);
        for (const d of [6, 12]) for (const [x, y] of [[b.lo - 1 - d, a.lo - 2], [b.hi + 1 + d, a.hi + 2], [b.lo - 2, a.lo - 1 - d], [b.hi + 2, a.hi + 1 + d]]) post(x, y, a.z, `junction-${a.id}-${b.id}/sign`, false);
    }
    // Driveway mouths get a pair of bollards on the sidewalk either side.
    for (const r of roads) for (let i = r.from; i <= r.to; i++) for (const j of [r.lo - 2, r.hi + 2]) {
        const [x, y] = along(r, i, j), [nx, ny] = along(r, i + 1, j);
        if (tagAt(m, nx, ny) === 'driveway' && tagAt(m, x, y) === 'sidewalk') post(x, y, r.z, `${r.id}/driveway-bollard`, false);
        const [px, py] = along(r, i - 1, j);
        if (tagAt(m, px, py) === 'driveway' && tagAt(m, x, y) === 'sidewalk') post(x, y, r.z, `${r.id}/driveway-bollard`, false);
    }
    return out;
}
/** Street trees in pits on the outer sidewalk row, every 10 cells, clear of junctions, driveways and doors. */
export function streetTrees(m, roads, { plant }) {
    let n = 0;
    for (const r of roads) {
        if (r.kind === 'service' || (r.sidewalk ?? 2) < 2) continue;
        for (let i = r.from + 5; i < r.to - 3; i += 10) for (const j of [r.lo - 3, r.hi + 3]) {
            if (nearJunction(roads, r, i, 3) || nearDriveway(m, r, i, 2)) continue;
            const [x, y] = along(r, i, j);
            if (tagAt(m, x, y) !== 'sidewalk' || m.keep.has(k2(x, y))) continue;
            if (plant(x, y, `road:${r.id}/street-tree`)) n++;
        }
    }
    return n;
}
/** Street furniture by rule: cabinets at junction corners, bike racks and lockers beside shop and office doors. */
export function streetFurniture(m, roads, { pedestrian = 'light' } = {}) {
    if (pedestrian === 'none') return [];
    const out = [];
    const piece = (name, cells, key, h, rule) => {
        if (!cells.every(([x, y]) => canStand(m, x, y) || (tagAt(m, x, y) === 'sidewalk' && !m.keep.has(k2(x, y)) && !m.store.isSolid(x, y, groundAt(m, x, y) + 1)))) return false;
        const vox = [];
        for (const [x, y] of cells) for (let k = 1; k <= h; k++) { put(m, x, y, groundAt(m, x, y) + k, key, `road:${rule}`); vox.push([x, y, groundAt(m, x, y) + k]); }
        m.object(name, vox, { axis: cells[1][0] !== cells[0][0] ? 'x' : 'y', dir: 1, size: [2, 1] });
        out.push({ type: name, x: cells[0][0], y: cells[0][1], z: groundAt(m, cells[0][0], cells[0][1]) });
        return true;
    };
    // Utility cabinets on the outer sidewalk row at each junction corner (one per junction).
    for (const a of roads) for (const b of roads) {
        if (a.axis !== 'x' || b.axis !== 'y' || b.lo > a.to || b.hi < a.from || a.lo > b.to || a.hi < b.from) continue;
        for (const [i, j] of [[b.hi + 3, a.hi + 3], [b.lo - 4, a.lo - 3], [b.hi + 3, a.lo - 3], [b.lo - 4, a.hi + 3]]) if (piece('utility_cabinet', [[i, j], [i + 1, j]], 'appliance', 1, `junction-${a.id}-${b.id}/cabinet`)) break;
    }
    if (pedestrian === 'normal' || pedestrian === 'light') for (const b of m.buildings) {
        if (!['shop', 'diner', 'office', 'station'].includes(b.program)) continue;
        const e = b.exits?.find(e => e.entry); if (!e) continue;
        const [dx, dy] = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[e.side] || [0, 1];
        const [px, py] = [e.x + dx, e.y + dy];
        const sideways = dx ? [0, 1] : [1, 0];
        const at = k => [px + sideways[0] * k, py + sideways[1] * k];
        if (pedestrian === 'normal' || b.program !== 'office') piece(b.program === 'office' ? 'parcel_locker' : 'bike_rack', [at(3), at(4)], b.program === 'office' ? 'appliance' : 'chainlink', b.program === 'office' ? 2 : 1, `entrance-${b.id}/${b.program === 'office' ? 'lockers' : 'bike-rack'}`);
    }
    return out;
}
