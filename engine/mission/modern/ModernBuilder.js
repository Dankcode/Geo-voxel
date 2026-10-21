import { solveDressing } from '../../mapgen/DressingSolver.js';
// Present-day buildings on the tactical grid.
//
// A building is a PROGRAM (house, shop, diner, warehouse, motel, station, office …) laid out as rows of rooms from
// the street front to the back, separated by 1-voxel partitions. Every storey is slab + 2 voxels of headroom
// (STOREY = 3), like the legacy builder, so traversal, cover and destruction rules are unchanged.
//
// The builder writes voxels (the gameplay truth) and, alongside them, VISUAL data that never affects gameplay:
//   hints  'x,y,z' → { piece, yaw, … }  how the tile set should draw a furniture / vehicle voxel (orientation, end
//          pieces, which cell of a bed is the head). Missing hints fall back to the renderer's own autotiling.
//   decor  [{ kind, x, y, z, yaw, w?, d? }] purely visual dressing: rugs, plants, lamps, TVs, stools, chairs,
//          toilets … Drawn only while the cell is empty and the floor under it still exists.
//
// Doors: a spanning tree over room adjacency from the entry room, then extra doors until most rooms have two ways
// in (XCOM breaching). Open-plan pairs (living ↔ kitchen) get a 2-wide opening instead of a door. Furniture is
// placed with a connectivity guard: every floor cell stays reachable from the entry.
import { MAT, AIR } from '../../voxel/Materials.js';
import { buildingEra, markBuildingEdges } from '../BuildingEra.js';
import { createStairRun } from '../../world/StairRun.js';

export const STOREY = 3;
const SIDES = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };
const YAW_OF = { e: 0, n: Math.PI / 2, w: Math.PI, s: -Math.PI / 2 };     // +X piece axis → world direction (see KitView DIRS)
const k2 = (x, y) => `${x},${y}`;

/**
 * Programs. rows: front → back; depth / w are fractions (or whole cells when ≥ 1).
 * glaze: room kind → facade treatment of the outer wall behind it ('full' floor-to-ceiling, 'band', 'punched',
 * 'clerestory', 'none'). open: kind pairs joined by a 2-wide opening. back: kinds that get a back door.
 */
export const PROGRAMS = {
    house: {
        wall: 'stucco', floor: 'oak_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.56, rooms: [{ kind: 'living', w: 0.58 }, { kind: 'kitchen', w: 0.42 }] },
            { depth: 0.44, rooms: [{ kind: 'bedroom', w: 0.4 }, { kind: 'bathroom', w: 3 }, { kind: 'study', w: 0.6 }] }],
        open: [['living', 'kitchen']], entry: 'living', back: ['kitchen', 'bedroom', 'study'], side: ['study', 'bedroom']
    },
    townhouse: {
        wall: 'brick', floor: 'oak_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.6, rooms: [{ kind: 'living', w: 1 }] }, { depth: 0.4, rooms: [{ kind: 'kitchen', w: 0.55 }, { kind: 'bathroom', w: 0.45 }] }],
        upper: { living: 'bedroom', kitchen: 'study', bathroom: 'bathroom' }, entry: 'living', back: ['kitchen'], side: ['living'], stairs: ['living']
    },
    bungalow: {
        wall: 'brick', floor: 'oak_floor', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.5, rooms: [{ kind: 'living', w: 0.55 }, { kind: 'bedroom', w: 0.45 }] },
            { depth: 0.5, rooms: [{ kind: 'kitchen', w: 0.6 }, { kind: 'bathroom', w: 0.4 }] }],
        entry: 'living', back: ['kitchen'], side: ['bedroom']
    },
    shop: {
        wall: 'brick', floor: 'tile_dark', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.66, rooms: [{ kind: 'sales', w: 1 }] }, { depth: 0.34, rooms: [{ kind: 'storeroom', w: 0.62 }, { kind: 'office', w: 0.38 }] }],
        entry: 'sales', back: ['storeroom'], side: ['office']
    },
    diner: {
        wall: 'stucco', floor: 'ceramic', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.62, rooms: [{ kind: 'dining', w: 1 }] }, { depth: 0.38, rooms: [{ kind: 'galley', w: 0.6 }, { kind: 'restroom', w: 0.4 }] }],
        entry: 'dining', back: ['galley'], side: ['dining']
    },
    station: {
        wall: 'concrete_wall', floor: 'tile_dark', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.62, rooms: [{ kind: 'sales', w: 1 }] }, { depth: 0.38, rooms: [{ kind: 'storeroom', w: 0.65 }, { kind: 'restroom', w: 0.35 }] }],
        entry: 'sales', back: ['storeroom'], side: ['sales']
    },
    warehouse: {
        wall: 'siding', floor: 'concrete', wet: 'concrete', roof: 'metal', dim: ['warehouse'],
        rows: [{ depth: 4, rooms: [{ kind: 'office', w: 0.35 }, { kind: 'loading', w: 0.65 }] }, { depth: 1, rooms: [{ kind: 'warehouse', w: 1 }] }],
        entry: 'loading', back: ['warehouse'], side: ['warehouse', 'office'], rollers: true
    },
    garage: {
        wall: 'siding', floor: 'concrete', wet: 'concrete', roof: 'metal',
        rows: [{ depth: 1, rooms: [{ kind: 'workshop', w: 0.7 }, { kind: 'storeroom', w: 0.3 }] }],
        entry: 'workshop', back: ['workshop', 'storeroom'], side: ['storeroom'], rollers: true
    },
    motel: {
        wall: 'brick', floor: 'carpet', wet: 'ceramic', roof: 'flat', unitsPerFront: true,
        rows: [{ depth: 0.68, rooms: 'units' }, { depth: 0.32, rooms: 'baths' }],
        entry: 'unit', back: []
    },
    office: {
        wall: 'concrete_wall', floor: 'carpet', wet: 'ceramic', roof: 'flat',
        rows: [{ depth: 0.55, rooms: [{ kind: 'lobby', w: 0.55 }, { kind: 'office', w: 0.45 }] },
            { depth: 0.45, rooms: [{ kind: 'meeting', w: 0.4 }, { kind: 'hall', w: 4 }, { kind: 'office', w: 0.6 }] }],
        upper: { lobby: 'open_office', hall: 'hall', office: 'office', meeting: 'meeting' },
        entry: 'lobby', back: ['hall', 'meeting'], side: ['office'], stairs: ['hall', 'lobby']
    },
    bunker: {
        wall: 'concrete_wall', floor: 'concrete', wet: 'concrete', roof: 'flat',
        rows: [{ depth: 0.4, rooms: [{ kind: 'office', w: 0.35 }, { kind: 'hall', w: 0.3 }, { kind: 'armory', w: 0.35 }] },
            { depth: 0.6, rooms: [{ kind: 'barracks', w: 0.5 }, { kind: 'storeroom', w: 0.5 }] }],
        upper: { office: 'office', hall: 'hall', armory: 'meeting', barracks: 'open_office', storeroom: 'storeroom' },
        entry: 'hall', back: ['barracks', 'storeroom'], side: ['office', 'armory'], stairs: ['hall', 'barracks', 'storeroom']
    },
    tower: {
        wall: 'concrete_wall', floor: 'concrete', wet: 'concrete', roof: 'flat',
        rows: [{ depth: 1, rooms: [{ kind: 'hall', w: 1 }] }], entry: 'hall', back: ['hall'], stairs: ['hall'], roofAccess: true
    }
};

const GLAZE = {
    living: 'full', dining: 'full', sales: 'full', lobby: 'full', open_office: 'full', kitchen: 'band', study: 'band',
    office: 'band', meeting: 'band', bedroom: 'punched', unit: 'punched', hall: 'punched', galley: 'band', barracks: 'punched',
    warehouse: 'clerestory', workshop: 'clerestory', loading: 'none', storeroom: 'none', bathroom: 'none', restroom: 'none',
    bath: 'none', armory: 'none', utility: 'none'
};
const WET = new Set(['kitchen', 'bathroom', 'restroom', 'bath', 'galley']);

// ------------------------------------------------------------------------------------------------ furniture
// mat: voxel material; len along the wall (or the room's long axis for centre items); dep away from the wall; h tall.
// piece(i, j, len, dep) → tile-set piece for footprint cell (i along, j away from the wall).
const ITEMS = {
    sofa: { mat: 'sofa', len: 3, dep: 1, h: 1, place: 'wall', piece: (i, j, n) => (i === 0 ? 'sofa_end_l' : i === n - 1 ? 'sofa_end_r' : 'sofa'),
        decor: (f, add) => { add('rug', f.front(1.5), { w: f.len + 0.6, d: 2.2 }); add('coffee_table', f.front(1.6)); add('floor_lamp', f.beside(-1)); } },
    loveseat: { mat: 'sofa', len: 2, dep: 1, h: 1, place: 'wall', piece: (i, j, n) => (i === 0 ? 'sofa_end_l' : 'sofa_end_r'),
        decor: (f, add) => add('plant', f.beside(2)) },
    tv: { mat: 'cabinet', len: 2, dep: 1, h: 1, place: 'wall', piece: () => 'tv_unit', top: 'tv' },
    kitchen: { mat: 'cabinet', len: 4, dep: 1, h: 1, place: 'wall', minLen: 3, piece: (i) => (i === 1 ? 'kitchen_sink' : i === 2 ? 'kitchen_hob' : 'kitchen') },
    fridge: { mat: 'appliance', len: 1, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'fridge_lower' : 'fridge_upper') },
    island: { mat: 'cabinet', len: 2, dep: 1, h: 1, place: 'center', piece: () => 'island', decor: (f, add) => { add('stool', f.front(1, 0)); add('stool', f.front(1, 1)); } },
    bed: { mat: 'bed', len: 2, dep: 2, h: 1, place: 'wall', piece: (i, j) => (j === 0 ? 'bed_head' : 'bed_foot'), across: true,
        decor: (f, add) => { add('nightstand', f.beside(-1)); add('rug', f.front(2.2), { w: 2.4, d: 1.2 }); } },
    bed_single: { mat: 'bed', len: 1, dep: 2, h: 1, place: 'wall', piece: (i, j) => (j === 0 ? 'bed_head_single' : 'bed_foot_single'), across: true },
    wardrobe: { mat: 'cabinet', len: 2, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'wardrobe_lower' : 'wardrobe_upper') },
    aid_station: { mat: 'cabinet', len: 1, dep: 1, h: 1, place: 'wall', piece: () => 'aid_station' },
    tool_chest: { mat: 'cabinet', len: 1, dep: 1, h: 1, place: 'wall', piece: () => 'tool_chest' },
    server_rack: { mat: 'appliance', len: 1, dep: 1, h: 2, place: 'wall', piece: (i,j,n,h) => h === 0 ? 'server_lower' : 'server_upper' },
    desk: { mat: 'desk', len: 2, dep: 1, h: 1, place: 'wall', piece: (i, j, n) => (i === 0 ? 'desk_end_l' : 'desk_end_r'),
        decor: (f, add) => { add('office_chair', f.front(1, 0)); add('monitor', f.top(0)); } },
    desk_pair: { mat: 'desk', len: 2, dep: 1, h: 1, place: 'center', piece: (i) => (i === 0 ? 'desk_end_l' : 'desk_end_r'),
        decor: (f, add) => { add('office_chair', f.front(1, 0)); add('office_chair', f.front(-1, 1, Math.PI)); add('monitor', f.top(0)); add('monitor', f.top(1, Math.PI)); } },
    conference: { mat: 'desk', len: 3, dep: 1, h: 1, place: 'center', piece: (i, j, n) => (i === 0 ? 'desk_end_l' : i === n - 1 ? 'desk_end_r' : 'desk_mid'),
        decor: (f, add) => { for (let i = 0; i < 3; i++) { add('office_chair', f.front(1, i)); add('office_chair', f.front(-1, i, Math.PI)); } } },
    filing: { mat: 'cabinet', len: 1, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'wardrobe_lower' : 'wardrobe_upper') },
    bookcase: { mat: 'shelving', len: 2, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'bookcase_lower' : 'bookcase_upper') },
    vanity: { mat: 'cabinet', len: 1, dep: 1, h: 1, place: 'wall', piece: () => 'vanity', decor: (f, add) => { add('toilet', f.beside(1)); add('shower', f.beside(-1)); } },
    washer: { mat: 'appliance', len: 1, dep: 1, h: 1, place: 'wall', piece: () => 'washer' },
    aisle: { mat: 'shelving', len: 3, dep: 1, h: 2, place: 'center', piece: (i, j, n, h) => (h === 0 ? 'store_shelf_lower' : 'store_shelf_upper') },
    wall_shelf: { mat: 'shelving', len: 3, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'store_shelf_lower' : 'store_shelf_upper') },
    produce: {mat:'shelving',len:2,dep:1,h:1,place:'center',piece:()=> 'produce_display'},
    hardware_shelf: {mat:'shelving',len:2,dep:1,h:2,place:'wall',piece:(i,j,n,h)=>h===0?'pegboard_lower':'pegboard_upper'},
    warehouse_rack: {mat:'shelving',len:3,dep:1,h:2,place:'center',piece:(i,j,n,h)=>h===0?'warehouse_rack_lower':'warehouse_rack_upper'},
    stock_rack: {mat:'shelving',len:2,dep:1,h:2,place:'wall',piece:(i,j,n,h)=>h===0?'warehouse_rack_lower':'warehouse_rack_upper'},
    checkout: { mat: 'cabinet', len: 2, dep: 1, h: 1, place: 'center', piece: () => 'checkout', decor: (f, add) => add('register', f.top(0)) },
    cooler: { mat: 'appliance', len: 2, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'cooler_lower' : 'cooler_upper') },
    booth: { mat: 'sofa', len: 1, dep: 1, h: 1, place: 'wall', piece: () => 'booth', decor: (f, add) => add('cafe_table', f.front(1)) },
    counter: { mat: 'cabinet', len: 4, dep: 1, h: 1, place: 'center', minLen: 3, piece: () => 'counter', decor: (f, add) => { for (let i = 0; i < f.len; i++) add('stool', f.front(1, i)); } },
    reception: { mat: 'cabinet', len: 3, dep: 1, h: 1, place: 'center', piece: () => 'counter', decor: (f, add) => add('monitor', f.top(1)) },
    pallets: { mat: 'pallet', len: 2, dep: 1, h: 1, place: 'wall', piece: () => 'pallet' },
    pallet_stack: { mat: 'pallet', len: 1, dep: 1, h: 2, place: 'center', piece: (i, j, n, h) => (h === 0 ? 'pallet' : 'pallet_top') },
    crates: { mat: 'crate', len: 1, dep: 1, h: 2, place: 'wall', piece: () => null },
    drums: { mat: 'barrel_powder', len: 2, dep: 1, h: 1, place: 'wall', piece: () => null },
    water_drum: { mat: 'barrel_water', len: 1, dep: 1, h: 1, place: 'wall', piece: () => null },
    workbench: { mat: 'desk', len: 2, dep: 1, h: 1, place: 'wall', piece: () => 'workbench' },
    lockers: { mat: 'shelving', len: 2, dep: 1, h: 2, place: 'wall', piece: (i, j, n, h) => (h === 0 ? 'locker_lower' : 'locker_upper') },
    bunks: { mat: 'bed', len: 1, dep: 2, h: 1, place: 'wall', piece: (i, j) => (j === 0 ? 'bed_head_single' : 'bed_foot_single'), across: true }
};
export const ROOM_FURNITURE = {
    living: ['sofa', 'tv', 'loveseat'], kitchen: ['kitchen', 'fridge', 'island'], bedroom: ['bed', 'wardrobe'], study: ['desk', 'bookcase'],
    bathroom: ['vanity'], restroom: ['vanity'], bath: ['vanity'], utility: ['washer', 'wall_shelf'],
    sales: ['aisle', 'produce', 'checkout', 'cooler', 'hardware_shelf'], storeroom: ['stock_rack', 'pallets', 'crates', 'water_drum'], office: ['desk', 'filing', 'loveseat'],
    dining: ['booth', 'booth', 'booth', 'counter', 'booth'], galley: ['kitchen', 'fridge', 'island'], warehouse: ['warehouse_rack', 'warehouse_rack', 'pallet_stack', 'pallet_stack', 'drums', 'crates', 'pallets'],
    loading: ['pallets', 'pallet_stack', 'crates'], workshop: ['workbench', 'drums', 'wall_shelf', 'pallet_stack'], lobby: ['reception', 'loveseat'],
    open_office: ['desk_pair', 'desk_pair', 'desk_pair', 'filing'], meeting: ['conference', 'tv'], hall: ['filing'], unit: ['bed', 'tv', 'desk'],
    barracks: ['bunks', 'bunks', 'lockers', 'bunks'], armory: ['lockers', 'crates', 'drums', 'wall_shelf'],
    // landmark / civic room kinds (geo imports: GeoPrograms.GEO_PROGRAMS)
    vault: ['stock_rack', 'crates', 'filing'], gallery: ['counter', 'bookcase', 'counter'], nave: ['booth', 'booth', 'booth', 'booth'],
    vestry: ['wardrobe', 'bookcase'], chamber: ['conference', 'booth', 'booth'], classroom: ['desk_pair', 'desk_pair', 'bookcase'],
    reading: ['bookcase', 'bookcase', 'desk', 'bookcase'], ward: ['bed_single', 'bed_single', 'aid_station']
};
const PLANTS = new Set(['living', 'lobby', 'office', 'open_office', 'study', 'dining', 'meeting', 'unit']);

// ------------------------------------------------------------------------------------------------ build
/**
 * spec: { id, name, program, x0, y0, w, d, baseZ, storeys?, front: 'n'|'e'|'s'|'w', wall?, roof?, entryAt? (0..1 along
 *         the front), roofAccess?, furnish? }
 * ctx:  { rng, nextRoomId(), rooms: [], hints: {}, decor: [] }
 */
export function buildModern(store, spec, ctx) {
    // spec.programDef: a building may bring its own plan (same shape as a PROGRAMS entry — e.g. a geo landmark)
    const prog = spec.programDef || PROGRAMS[spec.program] || PROGRAMS.house;
    const { x0, y0, w, d, baseZ } = spec;
    const storeys = Math.max(1, Math.min(3, spec.storeys || 1));
    const wallKey = spec.wall || prog.wall, floorKey = spec.floor || prog.floor;
    const roof = spec.roof || prog.roof;
    const top = baseZ + STOREY * storeys;
    const front = spec.front || 's';
    const rng = ctx.rng;
    const hints = ctx.hints || (ctx.hints = {}), decor = ctx.decor || (ctx.decor = []);
    const result = { id: spec.id, name: spec.name || spec.id, role: spec.program, program: spec.program, x0, y0, w, d, baseZ, storeys, top, front, wall: wallKey,
        era: buildingEra(spec), rooms: [], doors: [], windows: [], stairs: [], approach: [] };
    // Modern: rounded edges everywhere. Old: straight edges for the whole footprint, interior included.
    result.rounded = result.era === 'modern';
    markBuildingEdges(store, result, result.era);

    // Frame: local (u along the front, v from front to back) → world.
    const W = front === 'n' || front === 's' ? w : d, D = front === 'n' || front === 's' ? d : w;
    const toWorld = (u, v) => front === 's' ? [x0 + u, y0 + d - 1 - v] : front === 'n' ? [x0 + w - 1 - u, y0 + v]
        : front === 'e' ? [x0 + w - 1 - v, y0 + u] : [x0 + v, y0 + d - 1 - u];
    const inFoot = (x, y) => x >= x0 && y >= y0 && x < x0 + w && y < y0 + d;
    const perim = (x, y) => inFoot(x, y) && (x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + d - 1);

    // 1. Shell: clear, foundation, slabs, outer walls.
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) {
        for (let z = 1; spec.foundation!==false && z < baseZ; z++) if (!store.isSolid(x, y, z)) store.set(x, y, z, MAT.concrete);
        for (let z = baseZ; z <= top + 4 && z < store.height; z++) store.set(x, y, z, AIR);
        for (let s = 0; s < storeys; s++) {
            const fz = baseZ + STOREY * s;
            store.set(x, y, fz, MAT[floorKey]);
            if (perim(x, y)) for (let h = 1; h < STOREY; h++) store.set(x, y, fz + h, MAT[wallKey]);
        }
    }
    buildRoof(store, { x0, y0, w, d }, top, roof, wallKey);

    // 2. Plan (shared by every storey so stairs and partitions line up).
    const plan = planRows(W - 2, D - 2, prog, spec);
    const L = (iu, iv) => toWorld(iu + 1, iv + 1);
    const wallSet = new Set([...plan.walls].map(c => { const [iu, iv] = c.split(',').map(Number); return k2(...L(iu, iv)); }));
    const roomsW = plan.rooms.map(r => ({ ...r, cells: r.cells.map(([iu, iv]) => L(iu, iv)) }));
    const doorsW = plan.doors.map(dr => { const [x, y] = L(dr.iu, dr.iv); return { x, y, open: dr.open, locked: dr.locked, a: dr.a, b: dr.b }; });
    const floorCells = [];
    for (let y = y0 + 1; y < y0 + d - 1; y++) for (let x = x0 + 1; x < x0 + w - 1; x++) if (!wallSet.has(k2(x, y)) || doorsW.some(dr => dr.x === x && dr.y === y)) floorCells.push([x, y]);
    for (const dr of doorsW) wallSet.delete(k2(dr.x, dr.y));

    // Exterior doors (world): entry + back/side doors.
    const outward = (x, y) => Object.entries(SIDES).find(([, [dx, dy]]) => !inFoot(x + dx, y + dy))?.[0];
    const exterior = plan.exits.map(ex => {
        const [x, y] = toWorld(ex.u, ex.v);
        return { x, y, side: outward(x, y), room: ex.room, entry: ex.entry, roller: ex.roller };
    });

    // 3. Per storey: partitions, doors, rooms.
    const byStorey = [];
    for (let s = 0; s < storeys; s++) {
        const fz = baseZ + STOREY * s;
        for (const c of wallSet) { const [x, y] = c.split(',').map(Number); for (let h = 1; h < STOREY; h++) store.set(x, y, fz + h, MAT[wallKey]); }
        for (const dr of doorsW) {
            for (let h = 1; h < STOREY; h++) store.set(dr.x, dr.y, fz + h, dr.locked ? MAT.door_locked : dr.open ? AIR : MAT.door);
            result.doors.push({ x: dr.x, y: dr.y, z: fz, storey: s, exterior: false, open: dr.open, locked: !!dr.locked });
        }
        const recs = roomsW.map(room => {
            const kind = s > 0 && prog.upper ? (prog.upper[room.kind] || room.kind) : room.kind;
            const id = ctx.nextRoomId();
            const rec = { id, buildingId: spec.id, storey: s, kind, gameplay: room.gameplay, cells: room.cells, floorZ: fz, lit: spec.lighting?.[kind] ?? spec.lit ?? !(prog.dim || []).includes(kind), doors: [] };
            for (const [x, y] of room.cells) {
                for (let h = 1; h < STOREY; h++) store.rooms[store.index(x, y, fz + h)] = id;
                if (WET.has(kind)) store.set(x, y, fz, MAT[prog.wet || 'ceramic']);
            }
            result.rooms.push(rec); ctx.rooms.push(rec);
            return rec;
        });
        // Doorway cells belong to no room but are floor.
        byStorey.push(recs);
    }
    for (const ex of exterior) {
        for (let h = 1; h < STOREY; h++) store.set(ex.x, ex.y, baseZ + h, MAT.door);
        result.doors.push({ x: ex.x, y: ex.y, z: baseZ, storey: 0, exterior: true, side: ex.side, roller: !!ex.roller });
        const [dx, dy] = SIDES[ex.side];
        for (let h = 1; h <= STOREY; h++) if (store.isSolid(ex.x + dx, ex.y + dy, baseZ + h)) store.set(ex.x + dx, ex.y + dy, baseZ + h, AIR);
        result.approach.push([ex.x + dx, ex.y + dy], [ex.x + 2 * dx, ex.y + 2 * dy]);
        if (ex.roller) hints[`${ex.x},${ex.y},${baseZ + 1}`] = { roller: true };
    }

    // 4. Stairs between storeys (and to the roof when asked).
    const inactive = new Set(roomsW.filter(r => !r.gameplay).flatMap(r => r.cells.map(c => k2(...c))));
    for (const dr of doorsW) if (dr.locked) inactive.add(k2(dr.x, dr.y));
    const floorSet = new Set(floorCells.filter(c => !inactive.has(k2(...c))).map(([x, y]) => k2(x, y)));
    const frontOf = (x, y) => Object.values(SIDES).map(([dx, dy]) => k2(x + dx, y + dy)).filter(k => floorSet.has(k));
    const reserved = new Set([...doorsW.flatMap(dr => [k2(dr.x, dr.y), ...frontOf(dr.x, dr.y)]), ...exterior.flatMap(e => frontOf(e.x, e.y))]);
    const roofAccess = spec.roofAccess ?? prog.roofAccess ?? false;
    const runs = storeys - 1 + (roofAccess && roof === 'flat' ? 1 : 0);
    const stairRooms = (prog.stairs || []).map(kind => roomsW.find(r => r.kind === kind)).filter(Boolean);
    const stairCells = new Set();
    for (let s = 0; s < runs; s++) {
        const fz = baseZ + STOREY * s;
        const run = placeStairRun(floorSet, reserved, stairCells, fz, [...stairRooms, ...roomsW].filter(r => r.gameplay).concat({ cells: floorCells.filter(c => floorSet.has(k2(...c))) }), rng);
        if (!run) break;
        run.cells.forEach((c, i) => { for (let z = fz + 1; z <= fz + 1 + i; z++) store.set(c.x, c.y, z, MAT.stairs_stone); });
        for (const c of [run.before, run.cells[0], run.cells[1]]) store.set(c.x, c.y, fz + STOREY, AIR);
        for (const c of [run.before, ...run.cells, run.after]) { stairCells.add(k2(c.x, c.y)); reserved.add(k2(c.x, c.y)); }
        result.stairs.push({ storey: s, cells: run.cells.map(c => ({ x: c.x, y: c.y, z: c.z })), before: run.before, after: run.after, toRoof: s === storeys - 1 });
    }

    // 5. Facade: glazing chosen by the room behind each outer wall cell.
    const roomOfCell = new Map();
    roomsW.forEach(r => r.cells.forEach(([x, y]) => roomOfCell.set(k2(x, y), r)));
    const doorNear = (x, y) => [...exterior, ...doorsW].some(dr => Math.abs(dr.x - x) + Math.abs(dr.y - y) <= 1);
    for (let s = 0; s < storeys; s++) {
        const fz = baseZ + STOREY * s;
        for (const side of ['n', 'e', 's', 'w']) {
            // Runs of outer-wall cells that may take glass, grouped by the treatment of the room behind them.
            const runs = [];
            let cur = null;
            for (const [x, y] of sideCells({ x0, y0, w, d }, side).slice(1, -1)) {
                const [dx, dy] = SIDES[side];
                const inner = k2(x - dx, y - dy);
                const room = roomOfCell.get(inner);
                const kind = room ? (s > 0 && prog.upper ? (prog.upper[room.kind] || room.kind) : room.kind) : null;
                const ok = room && !wallSet.has(inner) && !doorNear(x, y) && !stairCells.has(inner) && store.get(x, y, fz + 1) === MAT[wallKey];
                const g = ok && room?.gameplay !== false ? (spec.glaze?.[kind] || GLAZE[kind] || 'punched') : null;
                if (!g) { cur = null; continue; }
                if (!cur || cur.g !== g) runs.push(cur = { g, cells: [] });
                cur.cells.push([x, y]);
            }
            for (const { g, cells } of runs) cells.forEach(([x, y], i) => {
                const n = cells.length;
                const put = zs => { for (const z of zs) {store.set(x, y, z, MAT.glass);hints[`${x},${y},${z}`]={windowStyle:g==='full'?'curtain':g==='band'?'ribbon':g==='clerestory'?'factory':'sash'};} result.windows.push({ x, y, z: zs[0], side, storey: s, full: zs.length > 1 });if(zs.length===1)store.windowOpenings.set(`${x},${y},${fz}`,side==='n'||side==='s'?'y':'x'); };
                if (g === 'full' && !(n > 4 && i % 4 === 3)) put([fz + 1, fz + 2]);
                else if (g === 'band' && !(n > 5 && i % 5 === 4)) put([fz + 2]);
                else if (g === 'punched' && (n <= 2 ? i === 0 : i % 3 === 1)) put([fz + 2]);
                else if (g === 'clerestory' && i % 3 !== 2) put([fz + 2]);
            });
        }
    }

    // 6. Furniture and decor.
    if (spec.furnish !== false) for (let s = 0; s < storeys; s++) {
        const fz = baseZ + STOREY * s;
        const obstacles = new Set(), clear = new Set();
        for (const run of result.stairs) {
            if (run.storey === s) { run.cells.forEach(c => obstacles.add(k2(c.x, c.y))); [run.before, run.after].forEach(c => clear.add(k2(c.x, c.y))); }
            if (run.storey === s - 1) { [run.before, run.cells[0], run.cells[1]].forEach(c => obstacles.add(k2(c.x, c.y))); [run.cells[2], run.after].forEach(c => clear.add(k2(c.x, c.y))); }
        }
        // Half windows are alternate entrances; keep a standing landing behind their sills.
        for(const window of result.windows.filter(w=>w.storey===s&&!w.full)) {
            const [dx,dy]=SIDES[window.side];clear.add(k2(window.x-dx,window.y-dy));
        }
        const keepFree = new Set([...reserved, ...obstacles, ...clear]);
        furnish(store, { floorSet, rooms: byStorey[s], fz, keepFree, obstacles, rng, hints, decor });
    }
    // Decor placed early can be covered by furniture placed later, or fall outside the room: keep what sits free.
    const mine = new Set(result.rooms.map(r => r.id));
    for (let i = decor.length - 1; i >= 0; i--) {
        const dd = decor[i];
        if (!mine.has(dd.room)) continue;
        const x = Math.floor(dd.x + 0.5), y = Math.floor(dd.y + 0.5);
        if (store.get(x, y, dd.z) !== AIR || (dd.kind !== 'wall_art' && !store.isSolid(x, y, dd.z - 1))) decor.splice(i, 1);
    }
    result.entry = exterior.find(e => e.entry) || exterior[0];
    result.exits = exterior;
    result.floorCells = floorCells;
    return result;
}

function inward(door) { if (!door) return null; const [dx, dy] = SIDES[door.side]; return { x: door.x - dx, y: door.y - dy }; }
function sideCells({ x0, y0, w, d }, side) {
    const out = [];
    if (side === 'n' || side === 's') { const y = side === 'n' ? y0 : y0 + d - 1; for (let x = x0; x < x0 + w; x++) out.push([x, y]); }
    else { const x = side === 'w' ? x0 : x0 + w - 1; for (let y = y0; y < y0 + d; y++) out.push([x, y]); }
    return out;
}

function buildRoof(store, { x0, y0, w, d }, top, style, wallKey) {
    if (style === 'pitched') {
        for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) store.set(x, y, top, MAT.roof);
        for (let layer = 1; layer <= 3; layer++) {
            if (w - layer * 2 < 1 || d - layer * 2 < 1) break;
            for (let y = y0 + layer; y < y0 + d - layer; y++) for (let x = x0 + layer; x < x0 + w - layer; x++) store.set(x, y, top + layer, MAT.roof);
        }
        return;
    }
    const slab = style === 'metal' ? 'roof_metal' : 'concrete';
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) {
        store.set(x, y, top, MAT[slab]);
        const edge = x === x0 || y === y0 || x === x0 + w - 1 || y === y0 + d - 1;
        if (edge && style !== 'metal') store.set(x, y, top + 1, MAT[wallKey]);     // parapet; the tile set gives it a dark cap
    }
}

// ------------------------------------------------------------------------------------------------ plan
/** Fractions (< 1) share what fixed sizes (≥ 1 cells) leave; every part gets at least 2 cells. */
function split(total, parts) {
    const n = parts.length, avail = total - (n - 1);
    const fixed = parts.reduce((s, p) => s + (p >= 1 ? p : 0), 0);
    const fsum = parts.reduce((s, p) => s + (p < 1 ? p : 0), 0) || 1;
    const sizes = parts.map(p => (p >= 1 ? p : Math.max(2, Math.round((avail - fixed) * p / fsum))));
    const sum = () => sizes.reduce((a, b) => a + b, 0);
    for (let guard = 0; guard < 64 && sum() > avail; guard++) {
        const i = sizes.indexOf(Math.max(...sizes));
        if (sizes[i] <= 2) break;
        sizes[i]--;
    }
    for (let guard = 0; guard < 64 && sum() < avail; guard++) {
        let i = parts.length - 1;
        while (i > 0 && parts[i] >= 1) i--;
        sizes[i]++;
    }
    return sizes;
}

/** Rooms, partitions, interior doors and exterior door slots in local interior coordinates. */
export function planRows(IW, ID, prog, spec = {}) {
    const rows = prog.rows.map(r => {
        if (r.rooms === 'units' || r.rooms === 'baths') {
            const n = Math.max(2, Math.floor((IW + 1) / 5));
            return { depth: r.depth, rooms: Array.from({ length: n }, () => ({ kind: r.rooms === 'units' ? 'unit' : 'bath', w: 1 / n })) };
        }
        return r;
    });
    // A narrow interior holds at most ⌊(n + 1) / 3⌋ rooms across (two cells each plus a partition): keep that many
    // rows / rooms instead of letting split() overflow them through the outer wall (real geo footprints are narrow).
    const fit = n => Math.max(1, Math.floor((n + 1) / 3));
    rows.splice(fit(ID));
    rows.forEach((r, i) => { if (r.rooms.length > fit(IW)) rows[i] = { ...r, rooms: r.rooms.slice(0, fit(IW)) }; });
    const vs = split(ID, rows.map(r => r.depth));
    const rooms = [], walls = new Set(), cellRoom = new Map();
    let v = 0;
    rows.forEach((row, ri) => {
        const v0 = v, v1 = v + vs[ri] - 1;
        const us = split(IW, row.rooms.map(r => r.w));
        let u = 0;
        row.rooms.forEach((rm, k) => {
            const u0 = u, u1 = u + us[k] - 1, cells = [];
            for (let vv = v0; vv <= v1; vv++) for (let uu = u0; uu <= u1; uu++) { cells.push([uu, vv]); cellRoom.set(k2(uu, vv), rooms.length); }
            rooms.push({ kind: rm.kind, gameplay: spec.gameplayRooms?.includes(rm.kind) || (rm.gameplay !== false && !spec.closedRooms?.includes(rm.kind) && !['bathroom', 'bath', 'restroom', 'utility'].includes(rm.kind)), u0, u1, v0, v1, cells, row: ri, col: k });
            u = u1 + 1;
            if (k < row.rooms.length - 1) { for (let vv = v0; vv <= v1; vv++) walls.add(k2(u, vv)); u++; }
        });
        v = v1 + 1;
        if (ri < rows.length - 1) { for (let uu = 0; uu < IW; uu++) walls.add(k2(uu, v)); v++; }
    });
    // Adjacency through partitions: wall cells with room A and room B straight across.
    const pairs = new Map();
    for (const c of walls) {
        const [u, vv] = c.split(',').map(Number);
        for (const [[ax, ay], [bx, by]] of [[[u - 1, vv], [u + 1, vv]], [[u, vv - 1], [u, vv + 1]]]) {
            const a = cellRoom.get(k2(ax, ay)), b = cellRoom.get(k2(bx, by));
            if (a == null || b == null || a === b) continue;
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (!pairs.has(key)) pairs.set(key, { a: Math.min(a, b), b: Math.max(a, b), cells: [] });
            pairs.get(key).cells.push([u, vv]);
        }
    }
    const openPair = (a, b) => (prog.open || []).some(([p, q]) => (rooms[a].kind === p && rooms[b].kind === q) || (rooms[a].kind === q && rooms[b].kind === p));
    const doors = [], doorCount = new Map(), linked = new Set();
    const addDoor = (pair) => {
        const cs = pair.cells.slice().sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
        // Not at a partition junction: both neighbours along the wall must be wall cells too.
        const mid = cs[Math.floor(cs.length / 2)];
        if (openPair(pair.a, pair.b) && cs.length >= 3) {
            const i = Math.floor(cs.length / 2);
            doors.push({ iu: cs[i - 1][0], iv: cs[i - 1][1], open: true, a: pair.a, b: pair.b }, { iu: cs[i][0], iv: cs[i][1], open: true, a: pair.a, b: pair.b });
        } else doors.push({ iu: mid[0], iv: mid[1], open: false, a: pair.a, b: pair.b });
        for (const r of [pair.a, pair.b]) doorCount.set(r, (doorCount.get(r) || 0) + 1);
        linked.add(`${pair.a}|${pair.b}`);
    };
    // Exterior door slots.
    const exits = [];
    const hub = new Set(['living', 'sales', 'dining', 'lobby', 'hall', 'loading', 'open_office', 'warehouse', 'workshop']);
    const addExit = (room, side, entry = false) => {
        const r = rooms[room];
        if (!r.gameplay) return false;
        let u, v;
        const along = (a0, a1, t) => Math.max(a0, Math.min(a1, Math.round(a0 + (a1 - a0) * t)));
        if (side === 'front') { if (r.v0 !== 0) return false; u = along(r.u0, r.u1, entry ? (spec.entryAt ?? 0.5) : 0.5) + 1; v = 0; }
        else if (side === 'back') { if (r.v1 !== ID - 1) return false; u = along(r.u0, r.u1, 0.5) + 1; v = ID + 1; }
        else if (side === 'left') { if (r.u0 !== 0) return false; v = along(r.v0, r.v1, 0.5) + 1; u = 0; }
        else { if (r.u1 !== IW - 1) return false; v = along(r.v0, r.v1, 0.5) + 1; u = IW + 1; }
        if (exits.some(e => Math.abs(e.u - u) + Math.abs(e.v - v) <= 2)) return false;
        exits.push({ u, v, room, entry, roller: !!prog.rollers && ['loading', 'warehouse', 'workshop'].includes(rooms[room].kind) && (side === 'front' || side === 'back') });
        doorCount.set(room, (doorCount.get(room) || 0) + 1);
        return true;
    };
    if (prog.unitsPerFront) rooms.forEach((r, i) => { if (r.kind === 'unit') addExit(i, 'front', i === 0); });
    else {
        const preferredEntry = rooms.findIndex(r => r.gameplay && r.kind === prog.entry && r.v0 === 0);
        const entryRoom = preferredEntry >= 0 ? preferredEntry : rooms.findIndex(r => r.gameplay && r.v0 === 0);
        if (entryRoom < 0) throw new Error('Building needs a playable front entry');
        addExit(entryRoom, 'front', true);
        for (const kind of prog.back || []) { const i = rooms.findIndex(r => r.kind === kind && r.v1 === ID - 1); if (i >= 0 && addExit(i, 'back')) break; }
        for (const kind of prog.side || []) {
            const i = rooms.findIndex(r => r.kind === kind && (r.u0 === 0 || r.u1 === IW - 1));
            if (i >= 0 && (addExit(i, rooms[i].u0 === 0 ? 'left' : 'right') || addExit(i, rooms[i].u1 === IW - 1 ? 'right' : 'left'))) break;
        }
    }
    // Spanning tree from rooms with exits, open-plan pairs and hubs first; then loops for breaching.
    const reached = new Set(exits.map(e => e.room));
    const plist = [...pairs.values()].filter(p => rooms[p.a].gameplay && rooms[p.b].gameplay).sort((p, q) => score(q) - score(p));
    function score(p) { return (openPair(p.a, p.b) ? 10 : 0) + (hub.has(rooms[p.a].kind) || hub.has(rooms[p.b].kind) ? 5 : 0) + Math.min(4, p.cells.length) * 0.1; }
    if (!reached.size) reached.add(0);
    for (let guard = 0; guard < 64 && reached.size < rooms.filter(r => r.gameplay).length; guard++) {
        const p = plist.find(p => !linked.has(`${p.a}|${p.b}`) && reached.has(p.a) !== reached.has(p.b));
        if (!p) { // a room no partition reaches (motel units): it has its own exit
            const lone = rooms.findIndex((r, i) => r.gameplay && !reached.has(i));
            if (lone < 0) break;
            reached.add(lone); continue;
        }
        addDoor(p); reached.add(p.a); reached.add(p.b);
    }
    // Second ways in.
    for (const p of plist) {
        const wantA = (doorCount.get(p.a) || 0) < 2, wantB = (doorCount.get(p.b) || 0) < 2;
        if (linked.has(`${p.a}|${p.b}`) || !(wantA || wantB)) continue;
        if (rooms[p.a].kind === 'bath' && rooms[p.b].kind === 'bath') continue;
        addDoor(p);
    }
    // Decorative rooms get a closed, locked door; they never form a route or a second entrance.
    rooms.forEach((r, i) => {
        if (r.gameplay) return;
        const pair = [...pairs.values()].find(p => (p.a === i && rooms[p.b].gameplay) || (p.b === i && rooms[p.a].gameplay));
        if (!pair) return;
        const [iu, iv] = pair.cells[Math.floor(pair.cells.length / 2)];
        doors.push({ iu, iv, a: pair.a, b: pair.b, open: false, locked: true });
    });
    // Doors may not sit on a partition junction (a wall cell touching 3+ wall cells) — slide along the wall.
    for (const dr of doors) {
        const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([du, dv]) => walls.has(k2(dr.iu + du, dr.iv + dv))).length;
        if (n <= 2) continue;
        const pair = pairs.get(`${dr.a}|${dr.b}`);
        const alt = pair.cells.find(([u, vv]) => !doors.some(o => o.iu === u && o.iv === vv) && [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([du, dv]) => walls.has(k2(u + du, vv + dv))).length <= 2);
        if (alt) { dr.iu = alt[0]; dr.iv = alt[1]; }
    }
    return { rooms, walls, doors, exits, cellRoom, IW, ID };
}

// ------------------------------------------------------------------------------------------------ stairs
function placeStairRun(floorSet, reserved, stairCells, fz, roomOrder, rng) {
    const dirs = ['east', 'west', 'south', 'north'];
    const seen = new Set();
    for (const room of roomOrder) {
        if (seen.has(room)) continue; seen.add(room);
        const roomSet = new Set(room.cells.map(([x, y]) => k2(x, y)));
        // Runs hug a wall: prefer origins whose side neighbour is outside the room.
        const origins = room.cells.slice().sort((a, b) => wallSides(roomSet, b) - wallSides(roomSet, a));
        for (const [ox, oy] of origins) for (const direction of dirs) {
            const run = createStairRun({ origin: { x: ox, y: oy }, direction, rise: STOREY, footprintSet: roomSet, reserved: stairCells, baseZ: fz });
            if (!run || [run.before, ...run.cells, run.after].some(c => reserved.has(k2(c.x, c.y)))) continue;
            const lower = new Set([...run.cells.map(c => k2(c.x, c.y)), ...stairCells]);
            if (!connected(floorSet, lower, [run.before.x, run.before.y])) continue;
            const upper = new Set([k2(run.cells[0].x, run.cells[0].y), k2(run.cells[1].x, run.cells[1].y), k2(run.before.x, run.before.y), ...stairCells]);
            if (!connected(floorSet, upper, [run.after.x, run.after.y])) continue;
            return run;
        }
    }
    return null;
}
const wallSides = (set, [x, y]) => Object.values(SIDES).filter(([dx, dy]) => !set.has(k2(x + dx, y + dy))).length;

export function connected(floorSet, blocked, start) {
    const k0 = k2(start[0], start[1]);
    if (!floorSet.has(k0) || blocked.has(k0)) return false;
    const seen = new Set([k0]), q = [start];
    while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const k = k2(x + dx, y + dy);
            if (!seen.has(k) && floorSet.has(k) && !blocked.has(k)) { seen.add(k); q.push([x + dx, y + dy]); }
        }
    }
    let total = 0; for (const k of floorSet) if (!blocked.has(k)) total++;
    return seen.size === total;
}

// ------------------------------------------------------------------------------------------------ furnish
export function furnish(store, { floorSet, rooms, fz, keepFree, obstacles, rng, hints, decor, wfc = false }) {
    const kits = wfc ? solveDressing(rooms, ROOM_FURNITURE, `dressing:${fz}:${rng.next()}`) : null;
    const blocked = new Set(obstacles);
    let parts = components(floorSet, blocked);
    for (const room of rooms) {
        if (room.gameplay === false) continue;
        const roomSet = new Set(room.cells.map(([x, y]) => k2(x, y)));
        const isFree = (x, y) => roomSet.has(k2(x, y)) && !keepFree.has(k2(x, y)) && !blocked.has(k2(x, y)) && store.get(x, y, fz + 1) === AIR;
        const wallAt = (x, y) => !roomSet.has(k2(x, y)) && store.isSolid(x, y, fz + 1) && store.get(x, y, fz + 1) !== MAT.door;
        const cap = Math.ceil(room.cells.length * 0.38);
        let used = 0;
        const list = kits ? kits.get(room).items : (ROOM_FURNITURE[room.kind] || []);
        // Long axis of the room (centre items run along it).
        const xs = room.cells.map(c => c[0]), ys = room.cells.map(c => c[1]);
        const longX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
        for (const itemKey of list) {
            const item = ITEMS[itemKey];
            if (!item || used >= cap) continue;
            const options = [];
            for (const [x, y] of rng.shuffle(room.cells.slice())) {
                if (item.place === 'wall') {
                    for (const side of ['n', 'e', 's', 'w']) {
                        const [bx, by] = SIDES[side];
                        if (!wallAt(x + bx, y + by)) continue;
                        // Along the wall: perpendicular to the back direction. Away: opposite the back.
                        options.push({ x, y, along: [-by, bx], away: [-bx, -by], back: side });
                    }
                } else options.push({ x, y, along: longX ? [1, 0] : [0, 1], away: longX ? [0, 1] : [1, 0], back: longX ? 's' : 'e', center: true });
                if (options.length > 48) break;
            }
            let placed = null;
            for (const o of options) {
                for (const len of [item.len, item.minLen].filter((v, i, a) => v && a.indexOf(v) === i)) {
                    const cells = [];
                    for (let i = 0; i < len; i++) for (let j = 0; j < item.dep; j++) cells.push({ x: o.x + o.along[0] * i + o.away[0] * j, y: o.y + o.along[1] * i + o.away[1] * j, i, j });
                    if (!cells.every(c => isFree(c.x, c.y))) continue;
                    if (o.center && !cells.every(c => Object.values(SIDES).every(([dx, dy]) => {
                        const k = k2(c.x + dx, c.y + dy);
                        return roomSet.has(k) && (!blocked.has(k) || cells.some(o2 => k2(o2.x, o2.y) === k));
                    }))) continue;
                    if (item.place === 'wall' && !cells.filter(c => c.j === 0).every(c => wallAt(c.x + SIDES[o.back][0], c.y + SIDES[o.back][1]))) continue;
                    // Keep the cell in front of the item open (you can sit down / reach it).
                    const fx = o.away[0] * item.dep, fy = o.away[1] * item.dep;
                    if (!o.center && !cells.filter(c => c.j === item.dep - 1).some(c => isFree(c.x + fx, c.y + fy) || keepFree.has(k2(c.x + fx, c.y + fy)))) continue;
                    for (const c of cells) blocked.add(k2(c.x, c.y));
                    const after = components(floorSet, blocked);
                    if (after > parts) { for (const c of cells) blocked.delete(k2(c.x, c.y)); continue; }
                    parts = after;
                    placed = { o, cells, len }; break;
                }
                if (placed) break;
            }
            if (!placed) continue;
            used += placed.cells.length;
            const { o, cells, len } = placed;
            // Yaw: the piece's front (−Z in piece space) faces away from the wall; its +X runs along the wall.
            const yaw = Math.atan2(-o.along[1], o.along[0]);
            for (const c of cells) for (let h = 0; h < item.h; h++) {
                store.set(c.x, c.y, fz + 1 + h, MAT[item.mat]);
                const piece = item.piece(c.i, c.j, len, h);
                if (piece) hints[`${c.x},${c.y},${fz + 1 + h}`] = { piece, yaw };
            }
            const f = footprintApi(o, cells, len, item.dep, fz, yaw);
            const add = (kind, p, extra = {}) => { if (p) decor.push({ kind, x: p.x, y: p.y, z: p.z ?? fz + 1, yaw: p.yaw ?? yaw, ...extra, room: room.id }); };
            if (item.top) add(item.top, f.top((len - 1) / 2));
            item.decor?.(f, add);
        }
        // Plants in free corners of living spaces.
        if (PLANTS.has(room.kind)) {
            const corners = room.cells.filter(([x, y]) => isFree(x, y) && Object.values(SIDES).filter(([dx, dy]) => wallAt(x + dx, y + dy)).length >= 2);
            for (const [x, y] of corners.slice(0, 1 + (rng.next() < 0.5 ? 1 : 0))) decor.push({ kind: rng.next() < 0.5 ? 'plant' : 'plant_tall', x, y, z: fz + 1, yaw: rng.next() * 6.28, room: room.id });
        }
        if (room.kind === 'living' || room.kind === 'bedroom' || room.kind === 'lobby') {
            const wallCells = room.cells.filter(([x, y]) => Object.values(SIDES).some(([dx, dy]) => wallAt(x + dx, y + dy)));
            const [x, y] = wallCells[Math.floor(rng.next() * wallCells.length)] || [];
            if (x != null) {
                const side = Object.entries(SIDES).find(([, [dx, dy]]) => wallAt(x + dx, y + dy))[0];
                decor.push({ kind: 'wall_art', x, y, z: fz + 2, yaw: YAW_OF[side] + Math.PI / 2, side, room: room.id });
            }
        }
    }
}

/** Number of 4-connected pieces of floor left once `blocked` cells are taken out (furniture may never split one). */
function components(floorSet, blocked) {
    const seen = new Set();
    let n = 0;
    for (const k of floorSet) {
        if (seen.has(k) || blocked.has(k)) continue;
        n++; seen.add(k);
        const q = [k.split(',').map(Number)];
        while (q.length) {
            const [x, y] = q.pop();
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const kk = k2(x + dx, y + dy);
                if (!seen.has(kk) && floorSet.has(kk) && !blocked.has(kk)) { seen.add(kk); q.push([x + dx, y + dy]); }
            }
        }
    }
    return n;
}

/** Positions relative to a placed item, in world cells (fractional where useful). */
function footprintApi(o, cells, len, dep, fz, yaw) {
    const base = (i, j) => ({ x: o.x + o.along[0] * i + o.away[0] * j, y: o.y + o.along[1] * i + o.away[1] * j });
    return {
        len, dep,
        /** In front of the item, `dist` cells out from its front row, at position i along it (default: centre). */
        front: (dist, i = (len - 1) / 2, turn = 0) => ({ ...base(i, dep - 1 + dist), z: fz + 1, yaw: yaw + turn }),
        /** Beside the item: i < 0 left of its first cell, i > 0 right of its last cell. */
        beside: (i) => ({ ...base(i < 0 ? i : len - 1 + i, 0), z: fz + 1 }),
        /** On top of cell i. */
        top: (i, turn = 0) => ({ ...base(i, 0), z: fz + 2, yaw: yaw + turn })
    };
}

// Every material a program or furniture recipe names must exist (a typo would silently write air).
for (const p of Object.values(PROGRAMS)) for (const k of [p.wall, p.floor, p.wet]) if (k && MAT[k] == null) throw new Error(`ModernBuilder: unknown material ${k}`);
for (const [id, it] of Object.entries(ITEMS)) if (MAT[it.mat] == null) throw new Error(`ModernBuilder: item ${id} uses unknown material ${it.mat}`);

// Shared with the PLAN-04 furnishing WFC (shared/mapgen/FurnishSolver.js), which places the same pre-baked clusters.
export { ITEMS as FURNITURE_ITEMS, footprintApi, components as floorComponents, PLANTS as PLANT_ROOMS, YAW_OF, SIDES as BUILD_SIDES };
