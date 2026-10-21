// Uniform vertical access: exterior fire escapes use ladder-linked platforms;
// internal storeys and underground service shafts use stairs.
// Module frame: u along the facade (0..5), r outward (wall = 0).
// Each 6×2 platform wraps the same ladder well and bolts directly to the facade.
import { MAT, AIR, materialById } from '../voxel/Materials.js';
import { ladderAttachment } from '../world/LadderAttachment.js';
import { STOREY } from './KitMetric.js';

export const SIDE_FRAME = Object.freeze({
    n: { a: [1, 0], o: [0, -1] }, s: { a: [1, 0], o: [0, 1] },
    e: { a: [0, 1], o: [1, 0] }, w: { a: [0, 1], o: [-1, 0] }
});
export const FIRE_ESCAPE = Object.freeze({ along: 6, out: 2, lip: 0, apron: 2, landing: 6, flight: 0, ladderRise: STOREY, storey: STOREY });
export const ROOF_LADDER = Object.freeze({ width: 1, segment: STOREY, parapetGap: 1, maxStoreys: 2 });
export const MANHOLE = Object.freeze({ shaft: [1, 1], levels: 1 });
export const SERVICE_STAIR = Object.freeze({ along: 6, out: 2, shaft: [8, 4] });
export const STREET_STAIR = Object.freeze({ length: 4, width: 1, rise: 3 });

const at = (f, u, r) => [f.origin[0] + f.a[0] * u + f.o[0] * r, f.origin[1] + f.a[1] * u + f.o[1] * r];
const key3 = (x, y, z) => `${x},${y},${z}`;

/** The wall cell at u = 0 for a facade `side` of building b, `offset` cells from the facade's first corner. */
export function facadeOrigin(b, side, offset) {
    return side === 'e' ? [b.x0 + b.w - 1, b.y0 + offset] : side === 'w' ? [b.x0, b.y0 + offset]
        : side === 'n' ? [b.x0 + offset, b.y0] : [b.x0 + offset, b.y0 + b.d - 1];
}
export const facadeLength = (b, side) => (side === 'n' || side === 's' ? b.w : b.d);
/** Facade door end (also used by service stairs) of level s: 0 = left (u 0–1), 4 = right (u 4–5). The street landing (s = 0) is the left end. */
export const landingEnd = s => (s % 2 ? 4 : 0);

/**
 * The complete fire escape for `storeys` storeys as a cell list. params: { side, origin, datum, storeys, doors }
 * doors: { [storey]: u } — the facade cell behind the landing that becomes a door on that storey.
 */
export function fireEscapeTemplate({ side, origin, datum, storeys, doors = {} }) {
    const f = { ...SIDE_FRAME[side], origin }, cells = [];
    const put = (u, r, z, mat, role, level) => { const [x, y] = at(f, u, r); cells.push({ x, y, z, mat, role, level, u, r }); };
    const z = s => datum + STOREY * s;
    for (let level=1;level<=storeys;level++) {
        const incoming=2;
        for(let u=0;u<6;u++)for(const r of [1,2]) {
            if(r===2&&u===incoming)continue; // Incoming ladder passes through this well.
            put(u,r,z(level),MAT.grate,'landing',level);
        }
        if(level<storeys&&doors[level]!=null)for(const h of [1,2])put(doors[level],0,z(level)+h,MAT.door,'door',level);
        if(level===storeys)for(const u of [landingEnd(level),landingEnd(level)+1])put(u,0,z(level)+1,AIR,'gap',level);
    }
    // One aligned ladder well runs through every platform.
    for(let level=0;level<storeys;level++)for(let h=z(level)+1;h<=z(level+1);h++)put(2,2,h,MAT.ladder,'rung',level+1);
    const last=new Map();for(const c of cells)last.set(key3(c.x,c.y,c.z),c);
    return { cells:[...last.values()],frame:f };
}

/** Write a fire escape into the store; returns its record (params + landings + support groups). */
export function compileFireEscape(store, params) {
    const { cells } = fireEscapeTemplate(params);
    for (const c of cells) store.set(c.x, c.y, c.z, c.mat);
    const f = { ...SIDE_FRAME[params.side], origin: params.origin };
    const landings = [];
    for (let s = 1; s <= params.storeys; s++) {
        const own = cells.filter(c => c.level === s && ['landing', 'lip', 'rail', 'rung'].includes(c.role));
        const land = own.filter(c => c.role === 'landing');
        // A full platform links the ladder well to the facade door.
        const door = params.doors?.[s], end = landingEnd(s);
        const stand = land.find(c => c.r === 1 && c.u === (door ?? (end ? 4 : 1))) || land[0];
        landings.push({ storey: s, z: params.datum + STOREY * s, end, cells: land.map(c => [c.x, c.y, c.z]), stand: { x: stand.x, y: stand.y, z: stand.z }, door: door ?? null, toRoof: s === params.storeys });
        const [lx,ly]=at(f,2,2), top=params.datum+STOREY*s;
        (store.supportGroups ??= []).push({ posts: [], columns: [],
            anchors: Array.from({length:6},(_,u)=>[...at(f,u,0),top]),
            ladder: {x:lx,y:ly,lo:top-STOREY+1,hi:top,backing:[-f.o[0],-f.o[1]]},
            members: own.map(c => [c.x, c.y, c.z]) });
    }
    return { module: 'fire_escape', params: structuredClone(params), landings };
}

/** Cell-for-cell check of a compiled access record against its template. Throws on any mismatch. */
export function validateAccessModule(store, rec) {
    const tpl = rec.module === 'fire_escape' ? fireEscapeTemplate(rec.params)
        : rec.module === 'roof_ladder' ? roofLadderTemplate(rec.params)
        : rec.module === 'manhole' ? manholeTemplate(rec.params)
        : rec.module === 'service_stair' ? serviceStairTemplate(rec.params)
        : rec.module === 'street_stair' ? streetStairTemplate(rec.params) : null;
    if (!tpl) throw Error(`access.module: unknown module ${rec.module}`);
    for (const c of tpl.cells) {
        const got = store.get(c.x, c.y, c.z);
        if (got !== c.mat) throw Error(`access.template: ${rec.module} ${c.role} at ${c.x},${c.y},${c.z} is ${materialById(got).key}, expected ${materialById(c.mat).key}`);
    }
    if (rec.module === 'fire_escape') {
        const us = tpl.cells.map(c => c.u), rs = tpl.cells.filter(c => c.r > 0).map(c => c.r);
        if (Math.min(...us) < 0 || Math.max(...us) > FIRE_ESCAPE.along - 1 || Math.max(...rs) > FIRE_ESCAPE.out + FIRE_ESCAPE.lip) throw Error('access.size: fire escape left its 6 × 2 module');
        if(tpl.cells.some(c=>c.mat===MAT.steel_stair)||!tpl.cells.some(c=>c.mat===MAT.ladder))throw Error('access.ladder: fire escapes require vertical ladders, not stairs');
        for(const c of tpl.cells.filter(c=>c.role==='rung'))if(!ladderAttachment(store,c.x,c.y,c.z))throw Error(`access.attachment: fire_escape ${c.x},${c.y},${c.z}`);
    }
    if (rec.module === 'roof_ladder' || rec.module === 'manhole') {
        const rung = tpl.cells.find(c => c.mat === MAT.ladder);
        if (!ladderAttachment(store, rung.x, rung.y, rung.z)) throw Error(`access.attachment: ${rec.module} at ${rung.x},${rung.y}`);
    }
    return true;
}

/**
 * Find a facade for the uniform fire escape on building b (already compiled: shell, rooms, doors) and build it.
 * opts: { prefer: ['e','s',…] facade order (approach lanes first), exitFloors: storeys with a door (default: all upper),
 *         blocked(x, y) → true where the module or its apron may not go, rooms: room records by id }
 * Never resizes: if no facade fits, it throws and the caller regenerates the building.
 */
export function placeFireEscape(m, b, { prefer = ['e', 's', 'w', 'n'], exitFloors = null, blocked = () => false, roomById } = {}) {
    const s = m.store, S = b.storeys, G = m.G;
    const exits = exitFloors ?? Array.from({ length: S - 1 }, (_, i) => i + 1);
    const sides = [...new Set([...prefer, 'e', 's', 'w', 'n'])];
    const groundDoors = new Set(b.doors.filter(d => d.exterior && d.storey === 0).map(d => `${d.x},${d.y}`));
    const tried = [];
    for (const side of sides) {
        const len = facadeLength(b, side);
        // Odd offsets put the module on a bay line; corners (0 and len − 1) are never used.
        for (let offset = 1; offset + FIRE_ESCAPE.along - 1 <= len - 2; offset += 2) {
            const origin = facadeOrigin(b, side, offset), f = { ...SIDE_FRAME[side], origin };
            let ok = true;
            for (let u = -1; u <= FIRE_ESCAPE.along && ok; u++) {
                const [wx, wy] = at(f, u, 0);
                if (groundDoors.has(`${wx},${wy}`)) ok = false;
                for (let r = 1; r <= FIRE_ESCAPE.out + FIRE_ESCAPE.lip + FIRE_ESCAPE.apron && ok; r++) {
                    const [x, y] = at(f, u, r);
                    if (x < 1 || y < 1 || x >= s.width - 1 || y >= s.depth - 1 || blocked(x, y) || m.keep.has(`${x},${y}`)) ok = false;
                    else if (m.buildings.some(o => x >= o.x0 - 1 && y >= o.y0 - 1 && x <= o.x0 + o.w && y <= o.y0 + o.d)) ok = false;
                    else if (!s.isSolid(x, y, G) || s.isSolid(x, y, G + 1) || s.isSolid(x, y, G + 2)) ok = false;
                }
            }
            if (!ok) { tried.push(`${side}${offset}:apron`); continue; }
            const doors = {};
            for (const lvl of exits) {
                const E = landingEnd(lvl), z = G + STOREY * lvl;
                const options = [E ? 4 : 1, E ? 5 : 0].filter(u => {
                    const [wx, wy] = at(f, u, 0), [ix, iy] = at(f, u, -1);
                    const room = s.roomAt(ix, iy, z + 1);
                    return room >= 0 && roomById(room)?.gameplay !== false && s.isSolid(ix, iy, z) && !s.isSolid(ix, iy, z + 1) && !s.isSolid(ix, iy, z + 2)
                        && s.get(wx, wy, z + 1) !== MAT.door && s.get(wx, wy, z + 1) !== MAT.door_locked;
                });
                if (!options.length) { ok = false; break; }
                doors[lvl] = options[0];
            }
            if (!ok) { tried.push(`${side}${offset}:doors`); continue; }
            const rec = compileFireEscape(s, { side, origin, datum: G, storeys: S, doors });
            reserveFireEscape(m, f);
            const [fx, fy] = at(f, 0, 1);
            rec.foot = { x: fx, y: fy, z: G };
            return rec;
        }
    }
    throw Error(`escape.placement: ${b.id} has no facade for the uniform 6×2 fire escape (${tried.slice(0, 6).join(' ')})`);
}

/** Keep the module, a walkway along its face and the 2-cell street apron at its foot clear of scattered props. */
export function reserveFireEscape(m, f) {
    for (let u = -1; u <= FIRE_ESCAPE.along; u++) for (let r = 1; r <= FIRE_ESCAPE.out + FIRE_ESCAPE.lip + (u <= 2 ? FIRE_ESCAPE.apron : 1); r++) { const [x, y] = at(f, u, r); m.keep.add(`${x},${y}`); }
}

/** Roof ladder: one cell, rungs from the street to the roof slab, through a one-cell parapet gap. */
export function roofLadderTemplate({ side, origin, datum, storeys }) {
    const f = { ...SIDE_FRAME[side], origin }, cells = [], top = datum + STOREY * storeys;
    const [x, y] = at(f, 0, 1);
    for (let z = datum + 1; z <= top; z++) cells.push({ x, y, z, mat: MAT.ladder, role: 'rung', u: 0, r: 1 });
    cells.push({ x: origin[0], y: origin[1], z: top + 1, mat: AIR, role: 'gap', u: 0, r: 0 });
    return { cells, frame: f };
}
export function placeRoofLadder(m, b, { prefer = ['w', 'n', 'e', 's'], blocked = () => false } = {}) {
    if (b.storeys > ROOF_LADDER.maxStoreys) throw Error(`access.height: ${b.id} has ${b.storeys} storeys; roof ladders serve 1–2 storey flat roofs only`);
    const s = m.store, G = m.G, top = G + STOREY * b.storeys;
    const doorCells = new Set(b.doors.filter(d => d.exterior).map(d => `${d.x},${d.y}`));
    for (const side of [...new Set([...prefer, 'w', 'n', 'e', 's'])]) {
        const len = facadeLength(b, side);
        // The first blank bay from the facade's corner: ladders hug a building's corner, clear of its doors.
        for (let offset = 1; offset <= len - 2; offset++) {
            const origin = facadeOrigin(b, side, offset), f = { ...SIDE_FRAME[side], origin };
            const near = [-1, 0, 1].some(u => { const [x, y] = at(f, u, 0); return doorCells.has(`${x},${y}`); });
            if (near) continue;
            let ok = true;
            for (let z = G + 1; z <= top && ok; z++) {
                const mat = materialById(s.get(origin[0], origin[1], z));
                if (!mat.solid || mat.key === 'glass' || mat.key === 'door' || mat.key === 'door_locked') ok = false;
            }
            for (const r of [1, 2]) for (const u of [-1, 0, 1]) {
                const [x, y] = at(f, u, r);
                if (!ok) break;
                if (x < 1 || y < 1 || x >= s.width - 1 || y >= s.depth - 1 || blocked(x, y)) ok = false;
                else if (m.buildings.some(o => o !== b && x >= o.x0 - 1 && y >= o.y0 - 1 && x <= o.x0 + o.w && y <= o.y0 + o.d)) ok = false;
                else if (!s.isSolid(x, y, G) || s.isSolid(x, y, G + 1) || s.isSolid(x, y, G + 2)) ok = false;
            }
            if (!ok) continue;
            const params = { side, origin, datum: G, storeys: b.storeys };
            for (const c of roofLadderTemplate(params).cells) s.set(c.x, c.y, c.z, c.mat);
            const [x, y] = at(f, 0, 1);
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.keep.add(`${x + dx},${y + dy}`);
            return { module: 'roof_ladder', params, x, y, foot: G, top, landing: { x: origin[0], y: origin[1], z: top } };
        }
    }
    throw Error(`access.placement: ${b.id} has no blank facade bay for a roof ladder`);
}

/** Manhole: ladder against one shaft wall from the tunnel floor (z = 1) to the street datum. */
export function manholeTemplate({ x, y, dir = [1, 0], datum }) {
    const cells = [];
    for (let z = 2; z <= datum; z++) cells.push({ x, y, z, mat: MAT.ladder, role: 'rung' });
    for (let z = 2; z < datum; z++) cells.push({ x: x + dir[0], y: y + dir[1], z, mat: MAT.concrete, role: 'backing' });
    return { cells };
}
export function compileManhole(store, params) {
    for (const c of manholeTemplate(params).cells) store.set(c.x, c.y, c.z, c.mat);
    const { x, y, dir = [1, 0], datum } = params;
    return { module: 'manhole', params: structuredClone(params), opening: { from: { x: x + dir[0], y: y + dir[1], z: datum }, to: { x, y, z: 1 }, kind: 'climb' } };
}

/** Subway stair: 1 × 4 straight run from the tunnel floor to the street (the PLAN-03 way down). */
export function streetStairTemplate({ x, y, dir, datum }) {
    const cells = [];
    for (let i = 0; i < STREET_STAIR.length; i++) {
        const cx = x + dir[0] * i, cy = y + dir[1] * i, z = 1 + i;
        for (let h = 2; h < z; h++) cells.push({ x: cx, y: cy, z: h, mat: MAT.stairs_stone, role: 'riser' });
        cells.push({ x: cx, y: cy, z, mat: i ? MAT.stairs_stone : MAT.concrete, role: i ? 'step' : 'foot' });
        for (let h = Math.max(z + 1, 2); h <= datum + 2; h++) cells.push({ x: cx, y: cy, z: h, mat: AIR, role: 'headroom' });
    }
    return { cells };
}

/**
 * Service stair: the fire-escape module turned inward inside a shaft, for 1–2 underground levels. The shaft walls
 * are concrete; the bottom landing opens into the tunnel at its left end; a railing rings the street opening.
 * params: { side, origin (cell at u = 0, r = 0 — the shaft wall line), datum, levels }
 */
export function serviceStairTemplate({ side, origin, datum, levels = 1 }) {
    const f = { ...SIDE_FRAME[side], origin }, cells = [], base = datum - STOREY * levels;
    const put = (u, r, z, mat, role) => { const [x, y] = at(f, u, r); cells.push({ x, y, z, mat, role, u, r }); };
    const z = l => base + STOREY * l, topEnd = landingEnd(levels);
    for (let u = 0; u < 6; u++) for (const r of [1, 2]) {
        for (let h = base + 1; h <= datum; h++) put(u, r, h, AIR, 'shaft');
        put(u, r, base, MAT.concrete, 'floor');
    }
    for (let l = 1; l <= levels; l++) { const E = landingEnd(l); for (const u of [E, E + 1]) for (const r of [1, 2]) put(u, r, z(l), l === levels ? MAT.concrete : MAT.grate, 'landing'); }
    for (let l = 0; l < levels; l++) { const row = 1 + (l % 2), order = l % 2 ? [3, 2] : [2, 3]; order.forEach((u, i) => put(u, row, z(l) + 1 + i, MAT.steel_stair, 'flight')); }
    for (let u = -1; u <= 6; u++) for (const r of [0, 3]) for (let h = base + 1; h < datum; h++) put(u, r, h, MAT.concrete_wall, 'wall');
    for (const r of [1, 2]) for (let h = base + 1; h < datum; h++) put(topEnd ? -1 : 6, r, h, MAT.concrete_wall, 'wall');
    // The bottom landing opens into the tunnel through the shaft's left end.
    for (const r of [1, 2]) for (let h = base + 1; h <= base + 2; h++) put(topEnd ? 6 : -1, r, h, AIR, 'portal');
    // Railings ring the open part of the street opening.
    for (let u = 0; u < 6; u++) if (u < topEnd || u > topEnd + 1) for (const r of [0, 3]) put(u, r, datum + 1, MAT.railing, 'rail');
    put(topEnd ? -1 : 6, 1, datum + 1, MAT.railing, 'rail'); put(topEnd ? -1 : 6, 2, datum + 1, MAT.railing, 'rail');
    // Later entries override earlier ones on the same voxel (the template is applied in order).
    const last = new Map(); for (const c of cells) last.set(key3(c.x, c.y, c.z), c);
    return { cells: [...last.values()], frame: f };
}
export function compileServiceStair(store, params) {
    const tpl = serviceStairTemplate(params);
    for (const c of tpl.cells) store.set(c.x, c.y, c.z, c.mat);
    const levels = params.levels ?? 1, E = landingEnd(levels), base = params.datum - STOREY * levels;
    const [tx, ty] = at(tpl.frame, E ? 4 : 1, 1), [bx, by] = at(tpl.frame, E ? 6 : -1, 1);
    return { module: 'service_stair', params: structuredClone(params), opening: { from: { x: tx, y: ty, z: params.datum }, to: { x: bx, y: by, z: base }, kind: 'stairs' } };
}

/**
 * Access gate (PLAN-03 D3 + PLAN-04 §5.2): every structure matches its template, buildings of 3–4 storeys climb by
 * ladder-linked fire escapes; standalone roof ladders serve only 1–2 storey flat roofs.
 */
export function checkAccess(mission) {
    const s = mission.store, out = { accessTemplates: true, accessByHeight: true };
    for (const b of mission.buildings) {
        for (const rec of b.access || []) {
            if (rec.module === 'roof_stair') continue;   // PLAN-14: the core's own roof flight
            try { validateAccessModule(s, rec); } catch { out.accessTemplates = false; }
            if (rec.module === 'roof_ladder' && b.storeys > ROOF_LADDER.maxStoreys) out.accessByHeight = false;
            if (rec.module === 'fire_escape' && b.storeys < 3) out.accessByHeight = false;
        }
        if (b.storeys >= 3) {
            if (!(b.access || []).some(r => r.module === 'fire_escape' || r.module === 'roof_stair')) out.accessByHeight = false;
            const allowed=new Set((b.access||[]).filter(r=>r.module==='fire_escape').flatMap(r=>fireEscapeTemplate(r.params).cells.filter(c=>c.role==='rung').map(c=>key3(c.x,c.y,c.z))));
            for(let y=b.y0-1;y<=b.y0+b.d;y++)for(let x=b.x0-1;x<=b.x0+b.w;x++)for(let z=b.baseZ;z<=b.top+1;z++)
                if(s.get(x,y,z)===MAT.ladder&&!allowed.has(key3(x,y,z)))out.accessByHeight=false;
        }
    }
    return out;
}
