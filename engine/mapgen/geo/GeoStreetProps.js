// Geo import — street props placed by what the real place has, never scattered:
//   junction of two streets (tertiary+)   traffic_signal on two opposite corners, the arm over the carriageway;
//                                         a divided-boulevard crossing (several centreline junctions of the same two
//                                         named streets) is ONE intersection: mast arms on its four outer corners
//   any street junction                   street_sign on a free corner
//   minor road meeting a bigger one       stop_sign at the minor road's mouth, right-hand side
//   collectors / arterials                utility_pole every ~28 cells along one side (Baton Rouge overhead lines)
//   primaries                             bus stop (bench pair + stop sign) every ~60 cells (CATS routes)
//   shop / diner entrances                storefront_awning over the door and the cells either side
//   shop fronts on a walk                 concrete planters between the entrance bays (half cover)
//   car parks                             shopping_cart decor in free aisle cells, one cart_corral per lot section
//   large car park next to a street       plaza_sign (pylon) at the lot corner nearest the biggest road
//   large flat roofs                      rooftop_ac (2 × 2, half cover) + rooftop_vent decor
// Decor is visual only; solid props are voxels registered with an origin (the prop-origin gate accounts for them).
import { MAT } from '../../voxel/Materials.js';
import { tagAt, groundAt, put, registerCells } from '../district/Core.js';
import { hashString } from '../../util/Rng.js';
import { distToPolyline } from './GeoFrame.js';

const k2 = (x, y) => `${x},${y}`;
const unit = s => (hashString(s) >>> 0) / 4294967296;
const yawToward = (dx, dy) => Math.atan2(dx, dy);     // decor yaw: local +Z → world (sin yaw, cos yaw) in (x, cell y)

export function placeGeoProps(m, { roads, roadAt, junctions = [], lots = [], seed = 1, furniture = [] }) {
    const s = m.store, d = m.district, W = d.W, D = d.D, out = { traffic_signal: 0, street_sign: 0, stop_sign: 0, utility_pole: 0, storefront_awning: 0, shopping_cart: 0, cart_corral: 0, plaza_sign: 0, rooftop_ac: 0 };
    const used = new Set();
    const free = (x, y) => x >= 0 && y >= 0 && x < W && y < D && !used.has(k2(x, y)) && !m.keep.has(k2(x, y)) && s.topSolid(x, y) === groundAt(m, x, y) && !s.isSolid(x, y, groundAt(m, x, y) + 1) && !d.stallCells.has(k2(x, y));
    const decor = (kind, x, y, yaw, extra = {}) => { m.ctx.decor.push({ kind, x, y, z: groundAt(m, x, y) + 1, yaw, ...extra }); used.add(k2(x, y)); out[kind] = (out[kind] || 0) + 1; };
    const role = (x, y) => roadAt.get(k2(x, y))?.role || null;
    const byId = new Map(roads.map(r => [r.id, r]));
    // real street furniture from the context fetch (cell coordinates): where mapped, it decides; otherwise the rules do
    const realSignals = furniture.filter(f => f.kind === 'traffic_signals'), realStops = furniture.filter(f => f.kind === 'bus_stop');
    const signalNear = J => realSignals.some(f => Math.hypot(f.at[0] - J.x, f.at[1] - J.y) < J.r + 12);
    const nearestFree = (at, want, r = 6) => { let best = null; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const x = Math.floor(at[0]) + dx, y = Math.floor(at[1]) + dy; if (want(x, y) && free(x, y) && (!best || Math.hypot(dx, dy) < best.d)) best = { x, y, d: Math.hypot(dx, dy) }; } return best; };

    // ---- intersections: centreline junctions within ~20 m are one real intersection (divided roads, slip lanes)
    const clusters = [];
    const arterial = J => new Set(J.roads.map(id => byId.get(id)).filter(r => r && r.cls >= 2 && !r.link).map(r => r.name || r.id)).size >= 2 || J.roads.map(id => byId.get(id)).filter(r => r && r.cls >= 2 && !r.link).length >= 2;
    for (const J of junctions) {
        if (!(arterial(J) || signalNear(J))) continue;
        const hit = clusters.filter(C => C.js.some(K => Math.hypot(K.x - J.x, K.y - J.y) < 22));
        const C = hit[0] || { js: [] }; if (!hit.length) clusters.push(C);
        C.js.push(J); for (const o of hit.slice(1)) { C.js.push(...o.js); clusters.splice(clusters.indexOf(o), 1); }
    }
    const handled = new Set();
    for (const C of clusters) {
        if (C.js.length < 2) continue;
        const rs = [...new Set(C.js.flatMap(J => J.roads))].map(id => byId.get(id)).filter(Boolean);
        const names = new Set(rs.filter(r => r.cls >= 2 && !r.link).map(r => r.name || r.id));
        if (!(realSignals.length ? C.js.some(signalNear) : names.size >= 2)) continue;
        const cx = C.js.reduce((a, J) => a + J.x, 0) / C.js.length, cy = C.js.reduce((a, J) => a + J.y, 0) / C.js.length;
        const R = Math.max(...C.js.map(J => Math.hypot(J.x - cx, J.y - cy) + J.r));
        // corner cells: sidewalk just outside any of the intersection's junction boxes, off every arm
        const ring = [], seen = new Set();
        for (const J of C.js) for (let dy = -Math.ceil(J.r + 5); dy <= Math.ceil(J.r + 5); dy++) for (let dx = -Math.ceil(J.r + 5); dx <= Math.ceil(J.r + 5); dx++) {
            const x = Math.floor(J.x + dx), y = Math.floor(J.y + dy), dj = Math.hypot(x + 0.5 - J.x, y + 0.5 - J.y);
            if (seen.has(k2(x, y)) || dj < J.r || dj > J.r + 5 || role(x, y) !== 'sidewalk' || !free(x, y)) continue;
            if (rs.some(r => distToPolyline([x + 0.5, y + 0.5], r.line) < r.half + 1.2)) continue;
            seen.add(k2(x, y));
            ring.push({ x, y, a: Math.atan2(y + 0.5 - cy, x + 0.5 - cx), dist: Math.hypot(x + 0.5 - cx, y + 0.5 - cy) });
        }
        ring.sort((a, b) => a.dist - b.dist || a.a - b.a);
        const pick = [];
        for (const c of ring) if (pick.length < 4 && !pick.some(p => Math.abs(Math.atan2(Math.sin(p.a - c.a), Math.cos(p.a - c.a))) < 1.0)) pick.push(c);
        for (const c of pick) decor('traffic_signal', c.x, c.y, yawToward(cx - (c.x + 0.5), cy - (c.y + 0.5)));
        const sign = ring.find(c => !used.has(k2(c.x, c.y)) && pick.every(p => Math.hypot(p.x - c.x, p.y - c.y) > 3));
        if (sign) decor('street_sign', sign.x, sign.y, yawToward(cx - (sign.x + 0.5), cy - (sign.y + 0.5)));
        for (const J of C.js) handled.add(J);
        for (const J of junctions) if (Math.hypot(J.x - cx, J.y - cy) < R + 2) handled.add(J);
    }
    // ---- single junctions
    for (const J of junctions) {
        if (handled.has(J)) continue;
        const rs = J.roads.map(id => byId.get(id)).filter(Boolean), streets = rs.filter(r => r.cls >= 1);
        if (streets.length < 2 && !(streets.length === 1 && rs.length >= 2)) continue;
        // corner sidewalk cells around the box, sorted by angle
        const ring = [];
        for (let dy = -Math.ceil(J.r + 4); dy <= Math.ceil(J.r + 4); dy++) for (let dx = -Math.ceil(J.r + 4); dx <= Math.ceil(J.r + 4); dx++) {
            const x = Math.floor(J.x + dx), y = Math.floor(J.y + dy), dist = Math.hypot(x + 0.5 - J.x, y + 0.5 - J.y);
            if (dist < J.r || dist > J.r + 4 || role(x, y) !== 'sidewalk' || !free(x, y)) continue;
            // a corner is off every arm's centreline (diagonal from the box)
            if (rs.some(r => distToPolyline([x + 0.5, y + 0.5], r.line) < r.half + 1.2)) continue;
            ring.push({ x, y, a: Math.atan2(y + 0.5 - J.y, x + 0.5 - J.x), dist });
        }
        if (!ring.length) continue;
        ring.sort((a, b) => a.a - b.a || a.dist - b.dist);
        const major = realSignals.length ? signalNear(J) : new Set(streets.filter(r => r.cls >= 2 && !r.link).map(r => r.name || r.id)).size >= 2;
        const pick = [];
        for (const c of ring) if (!pick.some(p => Math.abs(Math.atan2(Math.sin(p.a - c.a), Math.cos(p.a - c.a))) < 1.2)) pick.push(c);
        if (major) {
            // two opposite corners, arms pointing over the junction toward its centre
            const a = pick[0], b = pick.slice(1).sort((p, q) => Math.abs(Math.abs(q.a - a.a) - Math.PI) - Math.abs(Math.abs(p.a - a.a) - Math.PI)).reverse()[0];
            for (const c of [a, b].filter(Boolean)) decor('traffic_signal', c.x, c.y, yawToward(J.x - (c.x + 0.5), J.y - (c.y + 0.5)));
            const rest = pick.filter(c => c !== a && c !== b)[0];
            if (rest) decor('street_sign', rest.x, rest.y, yawToward(J.x - (rest.x + 0.5), J.y - (rest.y + 0.5)));
        } else if (pick[0]) decor('street_sign', pick[0].x, pick[0].y, yawToward(J.x - (pick[0].x + 0.5), J.y - (pick[0].y + 0.5)));
        // stop sign: each minor arm meeting a bigger road, on its right-hand kerb side facing the approaching traffic
        const top = Math.max(...rs.map(r => r.cls));
        for (const r of rs) if (r.cls < top) {
            const c = ring.filter(q => !used.has(k2(q.x, q.y))).sort((p, q) => distToPolyline([p.x + 0.5, p.y + 0.5], r.line) - distToPolyline([q.x + 0.5, q.y + 0.5], r.line))[0];
            if (c) decor('stop_sign', c.x, c.y, yawToward(-(J.x - (c.x + 0.5)), -(J.y - (c.y + 0.5))));
        }
    }

    // ---- utility poles along one side of collectors / arterials
    for (const r of roads) if (r.cls >= 1 && r.sidewalk) {
        let acc = unit(`${seed}:${r.id}:pole`) * 20;
        const side = unit(`${r.id}:side`) < 0.5 ? -1 : 1;
        for (let i = 1; i < r.line.length; i++) {
            const [ax, ay] = r.line[i - 1], [bx, by] = r.line[i], L = Math.hypot(bx - ax, by - ay); if (L < 1e-6) continue;
            const ux = (bx - ax) / L, uy = (by - ay) / L;
            for (let t = 0; t < L; t += 1) {
                if ((acc + t) % 28 >= 1) continue;
                const off = r.half + 1 + r.sidewalk - 0.4, x = Math.floor(ax + ux * t - uy * off * side), y = Math.floor(ay + uy * t + ux * off * side);
                if (role(x, y) !== 'sidewalk' || !free(x, y) || junctions.some(J => Math.hypot(x - J.x, y - J.y) < J.r + 4)) continue;
                if (m.ctx.decor.some(q => q.kind === 'streetlight' && Math.hypot(q.x - x, q.y - y) < 3)) continue;
                decor('utility_pole', x, y, yawToward(ux, uy));
            }
            acc += L;
        }
    }

    // ---- bus stops (CATS routes run the arterials): a bench pair and the stop sign on the outer sidewalk of a
    // primary every ~60 cells, clear of junctions
    // real stops first: a bench pair and the stop sign on the sidewalk nearest each mapped bus stop
    for (const f of realStops) {
        const c = nearestFree(f.at, (x, y) => role(x, y) === 'sidewalk' && role(x + 1, y) === 'sidewalk' && free(x + 1, y));
        if (!c) continue;
        const z = groundAt(m, c.x, c.y); if (groundAt(m, c.x + 1, c.y) !== z) continue;
        for (const x of [c.x, c.x + 1]) { put(m, x, c.y, z + 1, 'bench', `road:osm/bus-stop`); used.add(k2(x, c.y)); }
        m.ctx.decor.push({ kind: 'bus_stop', x: c.x + 1, y: c.y + 0.5, z: z + 1, yaw: 0, free: true }); out.bus_stop = (out.bus_stop || 0) + 1;
    }
    // hydrants where mapped
    for (const f of furniture.filter(q => q.kind === 'fire_hydrant')) { const c = nearestFree(f.at, (x, y) => role(x, y) === 'sidewalk', 3); if (c) decor('hydrant', c.x, c.y, 0); }
    if (!realStops.length) for (const r of roads) if (r.hw === 'primary' && r.sidewalk) {
        let acc = 20 + unit(`${seed}:${r.id}:bus`) * 20;
        for (let i = 1; i < r.line.length; i++) {
            const [ax, ay] = r.line[i - 1], [bx, by] = r.line[i], L = Math.hypot(bx - ax, by - ay); if (L < 1e-6) continue;
            const ux = (bx - ax) / L, uy = (by - ay) / L;
            for (let t = 0; t < L; t += 1) {
                if ((acc + t) % 60 >= 1) continue;
                for (const side of [1, -1]) {
                    const off = r.half + 1 + r.sidewalk - 1, x = Math.floor(ax + ux * t - uy * off * side), y = Math.floor(ay + uy * t + ux * off * side);
                    const cells = Math.abs(ux) >= Math.abs(uy) ? [[x, y], [x + 1, y]] : [[x, y], [x, y + 1]];
                    if (!cells.every(([cx, cy]) => role(cx, cy) === 'sidewalk' && free(cx, cy)) || junctions.some(J => Math.hypot(x - J.x, y - J.y) < J.r + 6)) continue;
                    const z = groundAt(m, x, y); if (cells.some(([cx, cy]) => groundAt(m, cx, cy) !== z)) continue;
                    for (const [cx, cy] of cells) { put(m, cx, cy, z + 1, 'bench', `road:${r.id}/bus-stop`); used.add(k2(cx, cy)); }
                    m.ctx.decor.push({ kind: 'bus_stop', x: cells[0][0] + (cells[1][0] - cells[0][0] + 1) / 2, y: cells[0][1] + (cells[1][1] - cells[0][1] + 1) / 2, z: z + 1, yaw: yawToward(-uy * side, ux * side), free: true });
                    out.bus_stop = (out.bus_stop || 0) + 1;
                    break;
                }
            }
            acc += L;
        }
    }

    // ---- shop awnings over street entrances
    const OUTV = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
    for (const b of m.buildings) if (['shop', 'supermarket', 'diner'].includes(b.program)) for (const e of (b.exits || []).filter(e => e.entry && !e.internal)) {
        const [dx, dy] = OUTV[e.side], along = dx ? [0, 1] : [1, 0];
        for (const k of [-2, -1, 0, 1, 2]) {
            const fx = e.x + along[0] * k, fy = e.y + along[1] * k, x = fx + dx, y = fy + dy;
            if (!(fx >= b.x0 && fy >= b.y0 && fx < b.x0 + b.w && fy < b.y0 + b.d)) continue;
            if (x < 0 || y < 0 || x >= W || y >= D || s.isSolid(x, y, b.baseZ + 1) || s.isSolid(x, y, b.baseZ + 2)) continue;
            m.ctx.decor.push({ kind: 'storefront_awning', x, y, z: b.baseZ + 1, yaw: yawToward(dx, dy), free: true }); out.storefront_awning++;
        }
    }

    // ---- storefront walks: concrete planters between the entrance bays of every shop front facing a car park
    for (const b of m.buildings) if (['shop', 'supermarket', 'diner'].includes(b.program) && (b.wing === 0 || b.wing == null)) {
        const doors = (b.exits || []).filter(e => !e.internal);
        for (const side of ['n', 's', 'e', 'w']) {
            const [dx, dy] = OUTV[side], along = dx ? [0, 1] : [1, 0];
            const x0 = side === 'e' ? b.x0 + b.w : side === 'w' ? b.x0 - 1 : b.x0, y0 = side === 's' ? b.y0 + b.d : side === 'n' ? b.y0 - 1 : b.y0, n = dx ? b.d : b.w;
            for (let i = 2; i < n - 2; i += 5) {
                const cells = [0, 1].map(j => [x0 + along[0] * (i + j), y0 + along[1] * (i + j)]);
                if (doors.some(e => cells.some(([cx, cy]) => Math.abs(cx - (e.x + dx)) + Math.abs(cy - (e.y + dy)) <= 2))) continue;
                if (!cells.every(([cx, cy]) => tagAt(m, cx, cy) === 'plaza' && free(cx, cy) && free(cx + dx, cy + dy))) continue;
                const z = groundAt(m, cells[0][0], cells[0][1]), vox = [];
                if (cells.some(([cx, cy]) => groundAt(m, cx, cy) !== z)) continue;
                for (const [cx, cy] of cells) { put(m, cx, cy, z + 1, 'planter', `building:${b.group || b.id}/storefront-planter`); vox.push([cx, cy, z + 1]); used.add(k2(cx, cy)); }
                out.storefront_planter = (out.storefront_planter || 0) + 1;
            }
        }
    }

    // ---- car parks: carts, corrals, pylon sign
    const biggest = roads.slice().sort((a, b) => b.cls - a.cls || b.half - a.half)[0];
    for (const [li, l] of lots.entries()) {
        const aisle = l.cells.filter(([x, y]) => tagAt(m, x, y) === 'aisle' && free(x, y));
        const carts = Math.min(8, Math.floor(aisle.length / 120));
        for (let i = 0; i < carts; i++) { const [x, y] = aisle[Math.floor(unit(`${seed}:${l.id}:cart:${i}`) * aisle.length)]; if (free(x, y)) decor('shopping_cart', x, y, unit(`${l.id}:cy:${i}`) * 6.28); }
        // corrals: on a straight run of 3 free aisle cells along the lot's long axis, one per ~500 cells
        // (a shopping-centre lot has one every couple of stall rows)
        const want = Math.max(l.cells.length >= 400 ? 1 : 0, Math.floor(l.cells.length / (l.implied ? 300 : 600)));
        const set = new Set(aisle.map(([x, y]) => k2(x, y)));
        for (let i = 0, tries = 0; i < want && tries < 40 + 4 * want; tries++) {
            const [x, y] = aisle[Math.floor(unit(`${seed}:${l.id}:corral:${tries}`) * aisle.length)] || [];
            if (x == null) break;
            for (const [ax, ay] of [[1, 0], [0, 1]]) {
                const cells = [0, 1, 2].map(j => [x + ax * j, y + ay * j]);
                // keep a lane open on both sides (never seal an aisle)
                if (!cells.every(([cx, cy]) => set.has(k2(cx, cy)) && free(cx, cy) && set.has(k2(cx + ay, cy + ax)) && set.has(k2(cx - ay, cy - ax)))) continue;
                const z = groundAt(m, x, y), vox = [];
                for (const [cx, cy] of cells) { put(m, cx, cy, z + 1, 'railing', `geo:${l.id}/cart-corral`); vox.push([cx, cy, z + 1]); used.add(k2(cx, cy)); }
                m.object('cart_corral', vox, { axis: ax ? 'x' : 'y', dir: 1, size: [3, 1] }); out.cart_corral++; i++;
                break;
            }
        }
        if (l.cells.length >= 1500 && biggest) {
            const edge = l.cells.filter(([x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ['sidewalk', 'kerb'].includes(role(x + dx, y + dy))))
                .map(([x, y]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [x + dx, y + dy]).find(([nx, ny]) => role(nx, ny) === 'sidewalk' && free(nx, ny))).filter(Boolean)
                .sort((a, b) => distToPolyline([a[0] + 0.5, a[1] + 0.5], biggest.line) - distToPolyline([b[0] + 0.5, b[1] + 0.5], biggest.line));
            const c = edge[0];
            if (c) { const q = closestDir(biggest.line, c); decor('plaza_sign', c[0], c[1], yawToward(q[0], q[1])); }
        }
        void li;
    }

    // ---- roofs: plant on big flat roofs (cover on the roof, and what real strip-mall roofs look like)
    for (const b of m.buildings) {
        if (b.w < 10 || b.d < 10 || b.landmark) continue;
        const n = Math.max(1, Math.floor((b.w - 4) * (b.d - 4) / 160));
        for (let i = 0, tries = 0; i < n && tries < 30; tries++) {
            const x = b.x0 + 2 + Math.floor(unit(`${seed}:${b.id}:ac:${tries}:x`) * (b.w - 5)), y = b.y0 + 2 + Math.floor(unit(`${seed}:${b.id}:ac:${tries}:y`) * (b.d - 5)), z = b.top + 1;
            const cells = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
            if (!cells.every(([cx, cy]) => s.isSolid(cx, cy, b.top) && !s.isSolid(cx, cy, z) && !s.isSolid(cx, cy, z + 1))) continue;
            if (cells.some(([cx, cy]) => (b.stairs || []).some(st => [st.before, ...st.cells, st.after].some(c => c && Math.abs(c.x - cx) <= 1 && Math.abs(c.y - cy) <= 1)))) continue;
            const vox = [];
            for (const [cx, cy] of cells) { s.set(cx, cy, z, MAT.appliance); vox.push([cx, cy, z]); }
            registerCells(m, vox, `building:${b.group || b.id}/roof-plant`);
            m.object('rooftop_ac', vox, { axis: 'x', dir: 1, size: [2, 2] }); out.rooftop_ac++; i++;
        }
        const vx = b.x0 + 2, vy = b.y0 + b.d - 3;
        if (!s.isSolid(vx, vy, b.top + 1) && s.isSolid(vx, vy, b.top)) m.ctx.decor.push({ kind: 'rooftop_vent', x: vx, y: vy, z: b.top + 1, yaw: 0 });
    }
    return out;
}
function closestDir(line, [x, y]) {
    let best = null;
    for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1], vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)), px = ax + vx * t, py = ay + vy * t, dd = Math.hypot(px - x, py - y);
        if (!best || dd < best.d) best = { d: dd, v: [px - x, py - y] };
    }
    return best ? best.v : [0, 1];
}
