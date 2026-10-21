// PLAN-06 §5.9 — hold zones built around destructible cover.
//
// The host parcel (office plaza, lot centre, warehouse apron or gutted warehouse floor) is pinned before the mixes are
// solved; when it dresses, fortifyHoldZone gives the zone durable anchors (jersey barriers, concrete plinths, brick
// low walls: hp ≥ 12 or walls that leave rubble) and a fallback ring outside it so a lost zone can be retaken.
// evaluateHoldZone then grades the compiled mission:
//   approaches  ≥ 3 open corridors into the zone from ≥ 2 sides
//   vertical    a reachable position ≥ 2 voxels above the zone within 14 cells (a roof, an upper floor, a deck)
//   anchors     ≥ 4 hard-cover cells in or on the edge of the zone
//   durability  with every soft-cover voxel gone, ≥ 50 % of zone cells keep half cover and each approach side still
//               has a cover position facing it
//   blast       after three greedy frag blasts, each approach side still has a cover position facing it
//   fallback    ≥ 2 fallback cover pieces outside the zone
//   spawns      enemy spawns ≥ 20 cells away and none can see into the zone
import { MAT, materialById } from '../../voxel/Materials.js';
import { measureMission } from '../../mission/MissionMetrics.js';
import { coverAt, COVER } from '../../voxel/Cover.js';
import { explodeVoxels } from '../../voxel/Destruction.js';
import { castRay, blocksSight } from '../../voxel/Raycast.js';
import { reachable, nodeKey } from '../../world/PathSearch.js';
import { AGENT_PROFILES } from '../../world/TraversalRules.js';
import { k2, isHardCover, put, tag } from './Core.js';
import { canStand } from './Props.js';
import { placeRoofLadder } from '../AccessModules.js';
import { THROWABLES } from '../../content/weapons.js';

export const HOLD_SIZE = 7;

/** Grow a host rectangle to a HOLD_SIZE square centred on it. */
export function zoneRect(z) {
    const cx = Math.floor((z.x0 + z.x1) / 2), cy = Math.floor((z.y0 + z.y1) / 2), h = Math.floor(HOLD_SIZE / 2);
    return { ...z, x0: cx - h, y0: cy - h, x1: cx - h + HOLD_SIZE - 1, y1: cy - h + HOLD_SIZE - 1 };
}

export function fortifyHoldZone(m, zone, origin) {
    Object.assign(zone, zoneRect(zone));
    const { x0, y0, x1, y1 } = zone;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tag(m, x, y, 'zone', { force: false });
    const placed = [];
    const line = (cells, key, part) => {
        if (!cells.every(([x, y]) => canStand(m, x, y) && m.store.topSolid(x, y) === zone.z)) return false;
        for (const [x, y] of cells) put(m, x, y, zone.z + 1, key, `${origin}/${part}`);
        placed.push({ part, cells }); return true;
    };
    // Four anchors, one per quadrant, oriented to face the nearest zone edge; try a few offsets each.
    const quads = [[x0 + 1, y0 + 1, 'x'], [x1 - 2, y0 + 1, 'y'], [x0 + 1, y1 - 2, 'y'], [x1 - 2, y1 - 1, 'x']];
    quads.forEach(([qx, qy, axis], i) => {
        const key = i % 2 ? 'jersey' : 'brick';
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]]) {
            const cells = axis === 'x' ? [[qx + ox, qy + oy], [qx + ox + 1, qy + oy]] : [[qx + ox, qy + oy], [qx + ox, qy + oy + 1]];
            if (line(cells, key, 'hold-anchor')) break;
        }
    });
    // A concrete plinth in the middle: full, hard cover that survives grenades.
    const cx = Math.floor((x0 + x1) / 2), cy = Math.floor((y0 + y1) / 2);
    for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [1, 1]]) {
        const cells = [[cx + ox, cy + oy], [cx + ox + 1, cy + oy]];
        if (cells.every(([x, y]) => canStand(m, x, y))) { for (const [x, y] of cells) for (let k = 1; k <= 2; k++) put(m, x, y, zone.z + k, 'concrete_wall', `${origin}/hold-plinth`); placed.push({ part: 'plinth', cells }); break; }
    }
    // Fallback ring: jersey barriers 4–9 cells out from each edge, sliding sideways until one fits.
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        let ok = false;
        for (const dist of [5, 6, 4, 7, 8, 9]) { for (const slide of [0, -2, 2, -4, 4]) {
            const fx = cx + dx * (dist + 3) + (dy ? slide : 0), fy = cy + dy * (dist + 3) + (dx ? slide : 0), along = dx ? 'y' : 'x';
            const cells = along === 'x' ? [[fx, fy], [fx + 1, fy]] : [[fx, fy], [fx, fy + 1]];
            if (line(cells, 'jersey', 'hold-fallback')) { ok = true; break; }
        } if (ok) break; }
    }
    ensureOverlook(m, zone, origin);
    zone.fortifications = placed.map(p => p.part);
    return zone;
}

const SIDE_DIRS = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

/** High ground over the zone: if no building of 2+ storeys is near, a 1–2 storey flat roof gets a ladder up. */
export function ensureOverlook(m, zone, origin) {
    const cx = (zone.x0 + zone.x1) / 2, cy = (zone.y0 + zone.y1) / 2;
    const near = m.buildings.map(b => ({ b, d: Math.hypot(Math.max(b.x0 - cx, 0, cx - (b.x0 + b.w - 1)), Math.max(b.y0 - cy, 0, cy - (b.y0 + b.d - 1))) })).filter(e => e.d <= 12 && e.b.storeys <= 2 && e.b.baseZ === zone.z).sort((a, b) => a.d - b.d);
    for (const { b } of near) {
        const bx = b.x0 + b.w / 2, by = b.y0 + b.d / 2;
        const facing = [['s', cy - by], ['n', by - cy], ['e', cx - bx], ['w', bx - cx]].sort((p, q) => q[1] - p[1]).map(p => p[0]);
        try {
            const l = placeRoofLadder(m, b, { prefer: facing, blocked: (x, y) => !canStand(m, x, y) });
            for (let z = l.foot + 1; z <= l.top; z++) m.district.origins.set(`${l.x},${l.y},${z}`, `${origin}/overlook-ladder`);
            m.district.connectors.push({ id: `${origin}-overlook`, template: 'roof-ladder', sockets: [{ x: l.x, y: l.y, z: l.foot }, { ...l.landing }] });
            zone.overlook = { building: b.id, x: l.x, y: l.y };
            return zone.overlook;
        } catch { /* no blank bay on this building */ }
    }
    return null;
}

/** Approach runs: walkable, reachable cells just outside each zone edge, split where something blocks them. */
function approaches(store, zone, search) {
    const runs = [], sides = new Set();
    const edge = {
        n: Array.from({ length: zone.x1 - zone.x0 + 1 }, (_, i) => [zone.x0 + i, zone.y0 - 1]),
        s: Array.from({ length: zone.x1 - zone.x0 + 1 }, (_, i) => [zone.x0 + i, zone.y1 + 1]),
        w: Array.from({ length: zone.y1 - zone.y0 + 1 }, (_, i) => [zone.x0 - 1, zone.y0 + i]),
        e: Array.from({ length: zone.y1 - zone.y0 + 1 }, (_, i) => [zone.x1 + 1, zone.y0 + i])
    };
    for (const [side, cells] of Object.entries(edge)) {
        let cur = 0;
        const flush = () => { if (cur >= 2) { runs.push(side); sides.add(side); } cur = 0; };
        for (const [x, y] of cells) { const ok = [0, 1, -1].some(dz => search.costs.has(nodeKey({ x, y, z: zone.z + dz }))); if (ok) cur++; else flush(); }
        flush();
    }
    return { runs: runs.length, sides: [...sides] };
}

function coverFacing(store, zone, side) {
    for (let y = zone.y0; y <= zone.y1; y++) for (let x = zone.x0; x <= zone.x1; x++) {
        if (store.isSolid(x, y, zone.z + 1) || !store.isSolid(x, y, zone.z)) continue;
        if (coverAt(store, x, y, zone.z)[side] >= COVER.HALF) return true;
    }
    return false;
}
function coveredShare(store, zone) {
    let open = 0, cov = 0;
    for (let y = zone.y0; y <= zone.y1; y++) for (let x = zone.x0; x <= zone.x1; x++) {
        if (store.isSolid(x, y, zone.z + 1) || !store.isSolid(x, y, zone.z)) continue;
        open++; const c = coverAt(store, x, y, zone.z); if (Math.max(c.n, c.e, c.s, c.w) >= COVER.HALF) cov++;
    }
    return open ? cov / open : 0;
}

export function evaluateHoldZone(mission, zone, { origins = null } = {}) {
    const s = mission.store, start = mission.spawns.player[0];
    const search = reachable(s, start, Infinity, AGENT_PROFILES.player);
    const ap = approaches(s, zone, search);
    const cx = (zone.x0 + zone.x1) / 2, cy = (zone.y0 + zone.y1) / 2;
    let vertical = false;
    for (const n of search.nodes.values()) if (n.z >= zone.z + 2 && Math.hypot(n.x - cx, n.y - cy) <= 16) { vertical = true; break; }
    // Hard anchors in or on the edge of the zone.
    let anchors = 0;
    for (let y = zone.y0 - 1; y <= zone.y1 + 1; y++) for (let x = zone.x0 - 1; x <= zone.x1 + 1; x++) if (isHardCover(s.get(x, y, zone.z + 1))) anchors++;
    // Durability: strip every soft cover voxel around the zone.
    const soft = s.clone();
    let softRemoved = 0;
    for (let y = zone.y0 - 2; y <= zone.y1 + 2; y++) for (let x = zone.x0 - 2; x <= zone.x1 + 2; x++) for (let z = zone.z + 1; z <= zone.z + 2; z++) {
        const m = materialById(soft.get(x, y, z)); if (m.solid && !isHardCover(m)) { soft.set(x, y, z, 0); softRemoved++; }
    }
    const share = coveredShare(soft, zone);
    const durableSides = ap.sides.filter(side => coverFacing(soft, zone, side));
    // Blast: three frag grenades, each where it would destroy the most cover.
    const frag = THROWABLES.powder_bomb, blasted = s.clone(), blasts = [];
    for (let i = 0; i < 3; i++) {
        let best = null;
        for (let y = zone.y0; y <= zone.y1; y++) for (let x = zone.x0; x <= zone.x1; x++) {
            let n = 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = 1; dz <= 2; dz++) { const mm = materialById(blasted.get(x + dx, y + dy, zone.z + dz)); if (mm.solid && mm.projectile !== 'pass') n++; }
            if (!best || n > best.n) best = { x, y, n };
        }
        if (!best || !best.n) break;
        const result = explodeVoxels(blasted, { x: best.x + 0.5, y: best.y + 0.5, h: zone.z + 1.5, radius: frag.radius, power: frag.power, element: frag.element });
        blasts.push({ x: best.x, y: best.y, z: zone.z, destroyed: result.destroyed.length });
    }
    const blastSides = ap.sides.filter(side => coverFacing(blasted, zone, side));
    let fallback = 0;
    if (origins) for (const o of origins.values()) if (o.endsWith('/hold-fallback')) fallback++;
    fallback = Math.floor(fallback / 2);
    // Spawns: far away and blind to the zone.
    let spawnsOk = true;
    const probes = [[zone.x0, zone.y0], [zone.x1, zone.y0], [zone.x0, zone.y1], [zone.x1, zone.y1], [Math.round(cx), Math.round(cy)]];
    for (const e of mission.spawns.enemy) {
        if (Math.hypot(e.pos.x - cx, e.pos.y - cy) < 20) { spawnsOk = false; break; }
        for (const [x, y] of probes) { const r = castRay(s, { x: e.pos.x + 0.5, y: e.pos.y + 0.5, h: e.pos.z + 2.5 }, { x: x + 0.5, y: y + 0.5, h: zone.z + 1.5 }, { blocks: blocksSight }); if (!r.hit) { spawnsOk = false; break; } }
    }
    const gates = {
        approaches: ap.runs >= 3 && ap.sides.length >= 2, vertical: vertical || zone.kind === 'interior', anchors: anchors >= 4,
        durability: share >= 0.5 && durableSides.length === ap.sides.length, blast: blastSides.length === ap.sides.length,
        fallback: fallback >= 2, spawns: spawnsOk
    };
    return { pass: Object.values(gates).every(Boolean), gates, details: { approachRuns: ap.runs, approachSides: ap.sides, anchors, softRemoved, softRemovedCoverShare: +share.toFixed(2), blasts, durableSides, blastSides, fallback } };
}

/** Enemy spawn candidates for a hold mission: far from the zone, out of its sight, deterministic. */
export function holdEnemySpawns(mission, zone, count = 2) {
    const s = mission.store, search = reachable(s, mission.spawns.player[0], Infinity, AGENT_PROFILES.player);
    const cx = (zone.x0 + zone.x1) / 2, cy = (zone.y0 + zone.y1) / 2, p = mission.spawns.player[0];
    const cands = [...search.nodes.values()].filter(n => Math.hypot(n.x - cx, n.y - cy) >= 22 && Math.hypot(n.x - p.x, n.y - p.y) >= 26 && s.roomAt(n.x, n.y, n.z + 1) >= 0);
    const blind = n => [[zone.x0, zone.y0], [zone.x1, zone.y1], [zone.x0, zone.y1], [zone.x1, zone.y0], [Math.round(cx), Math.round(cy)]].every(([x, y]) => castRay(s, { x: n.x + 0.5, y: n.y + 0.5, h: n.z + 2.5 }, { x: x + 0.5, y: y + 0.5, h: zone.z + 1.5 }, { blocks: blocksSight }).hit);
    cands.sort((a, b) => Math.hypot(b.x - p.x, b.y - p.y) - Math.hypot(a.x - p.x, a.y - p.y) || a.x - b.x || a.y - b.y);
    const out = [];
    for (const n of cands) { if (out.length >= count) break; if (!blind(n)) continue; if (out.some(o => Math.hypot(o.x - n.x, o.y - n.y) < 10)) continue; out.push({ x: n.x, y: n.y, z: n.z }); }
    return out;
}

/** No outdoor host fits (a dense arcade district): hold the largest ground-floor interior far from the insertion. */
export function interiorHoldZone(m,spawn) {
 const rooms=m.buildings.flatMap(b=>b.rooms.filter(r=>r.storey===0&&r.cells.length>=80&&r.gameplay!==false).map(r=>({b,r}))).sort((a,c)=>Math.hypot(c.b.x0-spawn.x,c.b.y0-spawn.y)-Math.hypot(a.b.x0-spawn.x,a.b.y0-spawn.y));
 for(const {b,r} of rooms){
  const set=new Set(r.cells.map(([x,y])=>`${x},${y}`)),xs=r.cells.map(c=>c[0]),ys=r.cells.map(c=>c[1]);
  const cx=Math.round((Math.min(...xs)+Math.max(...xs))/2),cy=Math.round((Math.min(...ys)+Math.max(...ys))/2);
  for(let o=0;o<6;o++)for(const [ox,oy] of [[0,0],[o,0],[-o,0],[0,o],[0,-o]]){
   const x0=cx+ox-3,y0=cy+oy-3;let ok=true;for(let y=y0;y<y0+7&&ok;y++)for(let x=x0;x<x0+7;x++)if(!set.has(`${x},${y}`)){ok=false;break;}
   if(!ok||b.exits.length<2)continue;
   // Display plinths: concrete counters the defenders can hold behind (hard cover inside the shop).
   const z=r.floorZ,zone={x0,y0,x1:x0+6,y1:y0+6,z,host:b.id,kind:'interior'};
   for(const [px,py] of [[x0+1,y0+1],[x0+4,y0+1],[x0+1,y0+5],[x0+4,y0+5],[x0+3,y0+3]])for(const dx of [0,1])if(!m.store.isSolid(px+dx,py,z+1))m.store.set(px+dx,py,z+1,MAT.concrete_wall);
   // Fallback counters two cells outside the zone, still inside the shop.
   for(const [px,py] of [[x0+3,y0-3],[x0+3,y0+9],[x0-3,y0+3],[x0+9,y0+3]])if(set.has(`${px},${py}`)&&set.has(`${px+1},${py}`)&&!m.store.isSolid(px,py,z+1)&&!m.store.isSolid(px+1,py,z+1))for(const dx of [0,1]){m.store.set(px+dx,py,z+1,MAT.concrete_wall);m.district.origins.set(`${px+dx},${py},${z+1}`,`hold:${b.id}/hold-fallback`);}
   m.district.zones.push(zone);return zone;
  }
 }
 return null;
}

/** Hold missions: enemy squads start out of the zone's sight and at least 22 cells from it. */
export function secureHoldSpawns(result,zone) {
 // PLAN-07: districts field pods of 2–3. Each pod gets one far, blind anchor; its members take the nearest blind,
 // reachable interior cells around it (pod-mates may stand close, pods stay ≥ 10 apart).
 const enemy=result.spawns.enemy,groups=[...new Set(enemy.map(e=>e.group))];
 const anchors=holdEnemySpawns(result,zone,groups.length);
 const s=result.store,search=reachable(s,result.spawns.player[0],Infinity,AGENT_PROFILES.player);
 const cx=(zone.x0+zone.x1)/2,cy=(zone.y0+zone.y1)/2,taken=new Set();
 const blind=n=>[[zone.x0,zone.y0],[zone.x1,zone.y1],[zone.x0,zone.y1],[zone.x1,zone.y0],[Math.round(cx),Math.round(cy)]].every(([x,y])=>castRay(s,{x:n.x+.5,y:n.y+.5,h:n.z+2.5},{x:x+.5,y:y+.5,h:zone.z+1.5},{blocks:blocksSight}).hit);
 groups.forEach((g,gi)=>{
  const a=anchors[gi];if(!a)return;
  const near=[...search.nodes.values()].filter(n=>Math.abs(n.x-a.x)<=6&&Math.abs(n.y-a.y)<=6&&n.z===a.z&&Math.hypot(n.x-cx,n.y-cy)>=21&&s.roomAt(n.x,n.y,n.z+1)>=0)
   .sort((p,q)=>Math.hypot(p.x-a.x,p.y-a.y)-Math.hypot(q.x-a.x,q.y-a.y)||p.x-q.x||p.y-q.y);
  for(const e of enemy.filter(e=>e.group===g)){const n=near.find(n=>!taken.has(`${n.x},${n.y},${n.z}`)&&blind(n));if(!n)continue;taken.add(`${n.x},${n.y},${n.z}`);e.pos={x:n.x,y:n.y,z:n.z};e.placed=true;}
 });
 // Anyone left over (too few anchors or no blind cell beside one) takes the next far, blind interior spot.
 const rest=enemy.filter(e=>!e.placed);
 if(rest.length){const pool=holdEnemySpawns(result,zone,enemy.length+groups.length).filter(n=>!taken.has(`${n.x},${n.y},${n.z}`));rest.forEach((e,i)=>{if(pool[i]){e.pos=pool[i];e.placed=true;taken.add(`${pool[i].x},${pool[i].y},${pool[i].z}`);}});}
 // Still unplaced (only one or two far interiors exist): share the nearest anchor's room with another pod.
 for(const e of enemy.filter(e=>!e.placed&&(Math.hypot(e.pos.x-cx,e.pos.y-cy)<20||!blind(e.pos)))){
  for(const a of anchors){const n=[...search.nodes.values()].filter(n=>Math.abs(n.x-a.x)<=8&&Math.abs(n.y-a.y)<=8&&Math.hypot(n.x-cx,n.y-cy)>=21&&s.roomAt(n.x,n.y,n.z+1)>=0&&!taken.has(`${n.x},${n.y},${n.z}`)&&blind(n)).sort((p,q)=>Math.hypot(p.x-a.x,p.y-a.y)-Math.hypot(q.x-a.x,q.y-a.y)||p.x-q.x||p.y-q.y)[0];
   if(n){e.pos={x:n.x,y:n.y,z:n.z};taken.add(`${n.x},${n.y},${n.z}`);break;}}
 }
 for(const e of enemy)delete e.placed;
 result.metrics=measureMission(result);
}
