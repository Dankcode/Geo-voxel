import { solveFacadeWave, solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
import { fbm, NOISE_LAYERS } from './Fields.js';

export function solveFacade(b, floors, seed) {
    const slots=[];
    for(let x=0;x<b.w;x++)slots.push({x,y:0});
    for(let y=1;y<b.d;y++)slots.push({x:b.w-1,y});
    for(let x=b.w-2;x>=0;x--)slots.push({x,y:b.d-1});
    for(let y=b.d-2;y>0;y--)slots.push({x:0,y});
    slots.forEach((s,i)=>{s.id=String(i);s.neighbors=[String((i+slots.length-1)%slots.length),String((i+1)%slots.length)];});
    // One wave across the facade keeps vertical window stacks aligned. A service room on any floor closes its stack.
    const fixedWalls=slots.filter(({x,y})=> {
        if((x===0||x===b.w-1)&&(y===0||y===b.d-1))return true;
        const ix=x===0?1:x===b.w-1?b.w-2:x,iy=y===0?1:y===b.d-1?b.d-2:y;
        return floors.some(f=>!f.rooms.some(r=>r.gameplay!==false&&r.cells.some(([a,c])=>a===ix&&c===iy)));
    }).map(s=>s.id);
    const wave=solveFacadeWave({slots,fixedWalls,seed:`${b.id}:facade:${seed}`});
    return slots.map(s=>({x:s.x,y:s.y,kind:wave.get(s.id)}));
}

// ------------------------------------------------------------------------------------------------ v3 (PLAN-04 P4)
// One WFC per building over every facade bay of every storey. Openings sit at odd offsets (bay cells), piers and
// partitions on the even bay lines, so windows never collide with interior walls. Vertical sockets keep window
// families stacked on the upper floors (a service room closes its stack); the ground floor is free to differ
// (storefronts on a commercial frontage, doors where the lot sockets put the exits). Wall material comes from the
// district; weights follow the room behind each bay (living rooms and lobbies glaze, offices band, flats punch).

export const FACADE_KINDS = Object.freeze(['window', 'band', 'storefront', 'glazing', 'door', 'blank', 'vent', 'sign']);
const GLAZE_PREF = {
    living: 'glazing', dining: 'storefront', sales: 'storefront', lobby: 'glazing', open_office: 'band', kitchen: 'window', study: 'window',
    office: 'band', meeting: 'band', bedroom: 'window', unit: 'window', hall: 'window', galley: 'band', barracks: 'window',
    warehouse: 'band', workshop: 'band', loading: 'blank', storeroom: 'blank', armory: 'blank'
};
const COMMERCIAL = new Set(['shop', 'diner', 'office', 'bar', 'motel']);   // PLAN-14: bar and motel too
const family = k => (k === 'window' ? 'w' : k === 'band' ? 'b' : k === 'glazing' ? 'g' : k === 'storefront' ? 's' : 'x');

/** Facade bay slots of a footprint: odd offsets on every side, with the bay cell just inside. */
export function facadeSlots(b) {
    const out = [];
    for (let x = 1; x < b.w - 1; x += 2) { out.push({ side: 'n', x, y: 0, ix: x, iy: 1, pos: x }); out.push({ side: 's', x, y: b.d - 1, ix: x, iy: b.d - 2, pos: x }); }
    for (let y = 1; y < b.d - 1; y += 2) { out.push({ side: 'w', x: 0, y, ix: 1, iy: y, pos: y }); out.push({ side: 'e', x: b.w - 1, y, ix: b.w - 2, iy: y, pos: y }); }
    return out;
}

/**
 * b: { id, w, d, storeys, program, front, district }, floors: v3 floor plans, opts: { seed, exits: [{x, y}],
 * blank: [{x, y}] (slots kept solid on every storey: roof ladder column, fire-escape doors) }
 */
export function solveFacadeV3(b, floors, { seed = 1, exits = [], blank = [] } = {}) {
    const slots = facadeSlots(b), nodes = [], domains = new Map(), fixed = new Map();
    const id = (sl, s) => `${sl.side}:${sl.pos}:${s}`;
    const behind = (sl, s) => {
        const f = floors[s], cellRoom = f.rooms.find(r => r.cells.some(([x, y]) => x === sl.ix && y === sl.iy));
        return cellRoom || null;
    };
    const noise = (sl, s) => fbm(`${seed}:${b.id}:facade`, sl.x * 0.7 + s * 3, sl.y * 0.7, NOISE_LAYERS.detail);
    for (let s = 0; s < b.storeys; s++) for (const sl of slots) {
        const nid = id(sl, s), neighbors = [];
        for (const o of slots) if (o.side === sl.side && Math.abs(o.pos - sl.pos) === 2) neighbors.push({ id: id(o, s), direction: 'h' });
        if (s + 1 < b.storeys) neighbors.push({ id: id(sl, s + 1), direction: `up:${s}` });
        nodes.push({ id: nid, neighbors });
        const room = behind(sl, s), isExit = s === 0 && exits.some(e => e.x === sl.x && e.y === sl.y);
        if (isExit) { domains.set(nid, ['door']); fixed.set(nid, 'door'); continue; }
        if (blank.some(e => e.x === sl.x && e.y === sl.y)) { domains.set(nid, ['blank']); fixed.set(nid, 'blank'); continue; }
        let dom;
        if (!room || room.gameplay === false) dom = ['blank', 'vent'];
        else {
            dom = ['window', 'band', 'blank'];
            if (['living', 'lobby', 'open_office', 'dining', 'sales', 'unit'].includes(room.kind)) dom.push('glazing');
            if (s === 0 && sl.side === b.front && COMMERCIAL.has(b.program)) dom.push('storefront', 'sign');
            if (s === 1 && sl.side === b.front && COMMERCIAL.has(b.program)) dom.push('sign');
            if (b.district === 'industrial' || b.program === 'warehouse' || b.program === 'garage') dom.push('vent');
        }
        domains.set(nid, dom);
    }
    const weight = (nid, tile) => {
        const [side, pos, s] = nid.split(':'), sl = slots.find(o => o.side === side && o.pos === Number(pos)), room = behind(sl, Number(s));
        const pref = GLAZE_PREF[room?.kind] || 'window';
        let w = tile === pref ? 3 : tile === 'blank' ? 0.7 : tile === 'vent' ? 0.25 : tile === 'sign' ? 0.35 : 1;
        if (b.district === 'commercial' && (tile === 'band' || tile === 'glazing')) w *= 1.5;
        if (b.district === 'residential' && tile === 'window') w *= 1.6;
        if (b.district === 'industrial' && (tile === 'band' || tile === 'blank')) w *= 1.4;
        if (tile === 'storefront') w *= 4;
        return w * (0.5 + noise(sl, Number(s)));
    };
    const compatible = (a, c, dir) => {
        if (dir === 'h') return !(a === 'sign' && c === 'sign') && !(a === 'door' && c === 'door');
        const lower = Number(dir.split(':')[1]);
        if (lower === 0) return true;
        return family(a) === family(c);
    };
    let wave = null, last;
    for (let attempt = 0; attempt < 4 && !wave; attempt++) {
        try { wave = solveWaveFunctionCollapse({ nodes, tiles: FACADE_KINDS.map(id => ({ id, weight: 1 })), domains, fixed, nodeWeights: weight, compatible, seed: `${b.id}:facade:v3:${seed}:${attempt}` }); }
        catch (e) { last = e; for (const [k, d] of domains) if (!fixed.has(k) && !d.includes('blank')) d.push('blank'); }
    }
    if (!wave) throw Error(`facade.v3: ${b.id}: ${last?.message}`);
    const out = [];
    for (let s = 0; s < b.storeys; s++) for (const sl of slots) {
        const kind = wave.get(id(sl, s));
        if (kind !== 'blank' && kind !== 'door') out.push({ x: sl.x, y: sl.y, storey: s, kind });
    }
    return out;
}
