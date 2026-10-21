// Voxel materials for the tactical layer.
//
// Every voxel stores one material id (0 = air). The element field reuses vibe-game's ELEMENTS
// (shared/world/TileRegistry.js), so the elemental rules in shared/elements/ can treat terrain,
// buildings and props the same way vibe-game treats its tiles.
//
//   solid       blocks movement and can be stood on
//   opaque      blocks line of sight
//   projectile  'block' stops a bullet, 'pass' lets it through
//   shatters    cosmetic: a bullet crossing it breaks it (glass panes; no cover, never stops a shot)
//   hp          damage the voxel absorbs before it is destroyed (Infinity = indestructible)
//   part        vibe-game BUILDING_PARTS code, read by the copied TraversalRules (2 door, 4 stairs)
import { ELEMENTS } from '../elements/ElementIds.js';

const M = [];
/**
 * PLAN-07: penetration resistance (energy a round spends to pass through one voxel of it). Missing = Infinity: ground,
 * floors, slabs, steel and stone masses always stop a bullet. Rounds carry their energy in content/calibers.js.
 */
export const RESISTANCE = Object.freeze({
    fence: 1, crate: 1, pallet: 1, shelving: 1, furniture: 1, sofa: 1, bed: 1, desk: 1, bin: 1, stall: 1, hay: 1, ash: 1,
    lantern: 1, emergency_light: 1, barrel_powder: 1,
    door: 2, timber: 2, roof: 2, privacy_fence: 2, car_cabin: 2, appliance: 2, siding: 2, roof_metal: 2, shelf: 2,
    cabinet: 2, bench: 2, cart: 2, barrel_water: 2, ice: 2, deep_ice: 2,
    stucco: 3, plaster: 3, crystal: 3, pump: 3,
    dumpster: 4, container: 4, trunk: 4, rubble: 4,
    car_body: 6,
    brick: 6, sandbag: 6, stone: 7, drystone: 7,
    concrete_wall: 9, planter: 9,
    jersey: 14, city_wall: 14
});
function def(key, o) {
    const id = M.length;
    const m = Object.freeze({
        id, key, label: o.label || key, element: o.element ?? ELEMENTS.GEO, color: o.color ?? 0xff00ff,
        hp: o.hp ?? 4, solid: o.solid ?? true, opaque: o.opaque ?? (o.solid ?? true),
        projectile: o.projectile ?? ((o.solid ?? true) ? 'block' : 'pass'), flammable: !!o.flammable,
        render: o.render ?? ((o.solid ?? true) ? 'solid' : 'none'), moveCost: o.moveCost ?? 1, traversal: o.traversal ?? null,
        liquid: !!o.liquid, part: o.part ?? 0, debris: o.debris ?? null, explosive: o.explosive ?? null,
        burnTo: o.burnTo ?? null, meltTo: o.meltTo ?? null, freezeTo: o.freezeTo ?? null, structural: o.structural ?? (o.solid ?? true),
        shatters: !!o.shatters, light: o.light ?? 0, concealment: o.concealment ?? 0, family: o.family ?? 'earth', walkable: o.walkable ?? (o.solid ?? true),
        resistance: o.resistance ?? RESISTANCE[key] ?? Infinity
    });
    M.push(m);
    return m;
}

def('air', { solid: false, opaque: false, projectile: 'pass', render: 'none', hp: 0, structural: false, element: ELEMENTS.VOID, walkable: false });
def('bedrock', { label: 'Bedrock', color: 0x4b4640, hp: Infinity, family: 'stone' });
def('soil', { label: 'Soil', color: 0x7a5a3c, hp: 5, debris: 'rubble' });
def('grass', { label: 'Grass', color: 0x6dbb4c, hp: 5, debris: 'soil' });
def('forest_floor', { label: 'Forest floor', color: 0x3f8f45, hp: 5, debris: 'soil' });
def('sand', { label: 'Sand', element: ELEMENTS.ANEMO, color: 0xe6c773, hp: 3, moveCost: 1.15 });
def('snow', { label: 'Snow', element: ELEMENTS.CRYO, color: 0xeef6fb, hp: 2, moveCost: 1.2 });
def('road', { label: 'Road', color: 0xb49a76, hp: 6, family: 'stone' });
def('cobble', { label: 'Cobblestone', color: 0x9b958a, hp: 7, family: 'stone' });
def('stone', { label: 'Stone wall', color: 0xa8a29a, hp: 9, family: 'stone', debris: 'rubble' , walkable: false});
def('city_wall', { label: 'City wall', color: 0x8f8a82, hp: 14, family: 'stone', debris: 'rubble' , walkable: false});
def('plaster', { label: 'Plaster wall', element: ELEMENTS.STRUCTURE, color: 0xe8d7b4, hp: 6, family: 'stone', debris: 'rubble' , walkable: false});
def('timber', { label: 'Timber wall', element: ELEMENTS.STRUCTURE, color: 0x9a6a43, hp: 4, flammable: true, burnTo: 'ash', family: 'wood' , walkable: false});
def('plank', { label: 'Wood floor', element: ELEMENTS.STRUCTURE, color: 0xb0814f, hp: 4, flammable: true, burnTo: 'ash', family: 'wood' });
def('stone_floor', { label: 'Stone floor', element: ELEMENTS.STRUCTURE, color: 0xb9b2a6, hp: 8, family: 'stone' });
// Walls and low cover are not walkable: they are drawn as thin, connected modules (ConnectedShapes.js), so a unit
// can't stand on them. It vaults low ones (PathSearch canVault) and goes round tall ones, as in XCOM.
// Pitched roofs are not walkable (XCOM rule: flat roofs are terrain, pitched roofs are scenery you can shoot through).
def('roof', { label: 'Roof tiles', element: ELEMENTS.STRUCTURE, color: 0xb4553f, hp: 3, family: 'wood', flammable: true, burnTo: 'ash', walkable: false });
def('glass', { solid: false, walkable: false, label: 'Glass pane', element: ELEMENTS.STRUCTURE, color: 0xbfe6f2, hp: 1, opaque: false, projectile: 'pass', shatters: true, render: 'glass', family: 'glass', structural: false });
def('door', { label: 'Door', element: ELEMENTS.STRUCTURE, color: 0x6f4526, hp: 4, solid: false, opaque: true, projectile: 'block', render: 'solid', flammable: true, part: 2, family: 'wood', structural: false, walkable: false });
def('door_open', { label: 'Open door', element: ELEMENTS.STRUCTURE, color: 0x6f4526, hp: 4, solid: false, opaque: false, projectile: 'pass', render: 'none', part: 2, family: 'wood', structural: false, walkable: false });
def('stairs_wood', { label: 'Wooden stairs', element: ELEMENTS.STRUCTURE, color: 0x8b5e3a, hp: 4, flammable: true, part: 4, burnTo: 'ash', family: 'wood' });
def('stairs_stone', { label: 'Stone stairs', element: ELEMENTS.STRUCTURE, color: 0x9d968c, hp: 8, part: 4, family: 'stone' });
def('water', { label: 'Shallow water', element: ELEMENTS.HYDRO, color: 0x3fb7d6, hp: Infinity, solid: false, opaque: false, projectile: 'pass', render: 'water', liquid: true, traversal: 'wade', moveCost: 1.8, freezeTo: 'ice', structural: false, walkable: true });
def('deep_water', { label: 'Deep water', element: ELEMENTS.HYDRO, color: 0x1d7fa6, hp: Infinity, solid: false, opaque: false, projectile: 'pass', render: 'water', liquid: true, traversal: 'blocked', freezeTo: 'deep_ice', structural: false, walkable: false });
def('ice', { label: 'Ice', element: ELEMENTS.CRYO, color: 0xcdeffd, hp: 2, moveCost: 1.4, meltTo: 'water', render: 'glass', opaque: false, family: 'ice' });
def('lava', { label: 'Lava', element: ELEMENTS.PYRO, color: 0xff6a1f, hp: Infinity, solid: false, opaque: false, render: 'water', liquid: true, traversal: 'blocked', light: 2, structural: false, walkable: false });
def('hedge', { label: 'Hedge', color: 0x2f7d3a, hp: 2, solid: true, opaque: true, projectile: 'pass', flammable: true, render: 'foliage', concealment: 2, family: 'plant', structural: false , walkable: false});
def('leaves', { label: 'Leaves', color: 0x3c9a3f, hp: 1, solid: false, opaque: true, projectile: 'pass', flammable: true, render: 'foliage', concealment: 2, family: 'plant', structural: false, walkable: false });
def('trunk', { label: 'Tree trunk', color: 0x6a4a2c, hp: 6, flammable: true, burnTo: 'ash', family: 'wood' , walkable: false});
def('furniture', { label: 'Furniture', element: ELEMENTS.STRUCTURE, color: 0x8c5a33, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});
def('shelf', { label: 'Shelf', element: ELEMENTS.STRUCTURE, color: 0x6e4a2b, hp: 4, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});
def('crate', { label: 'Crate', element: ELEMENTS.STRUCTURE, color: 0xb98a4e, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});
def('barrel_powder', { label: 'Fuel drum', element: ELEMENTS.PYRO, color: 0x8a2d1c, hp: 1, flammable: true, family: 'wood', structural: false,
    explosive: { radius: 2.6, power: 9, damage: 5, element: 'pyro' } , walkable: false});
def('barrel_water', { label: 'Water drum', element: ELEMENTS.HYDRO, color: 0x3c6e8f, hp: 2, family: 'wood', structural: false,
    explosive: { radius: 1.8, power: 0, damage: 0, element: 'hydro' } , walkable: false});
def('metal', { label: 'Iron', color: 0x5b6168, hp: 16, family: 'metal' , walkable: false});
def('rubble', { label: 'Rubble', color: 0x8a8378, hp: 3, moveCost: 1.5, family: 'stone', structural: false });
def('ash', { label: 'Ash', color: 0x3d3a37, hp: 1, moveCost: 1.1, structural: false });
def('sandbag', { label: 'Sandbags', element: ELEMENTS.ANEMO, color: 0xc2a86b, hp: 6, family: 'earth', structural: false , walkable: false});
def('crystal', { label: 'Crystal node', element: ELEMENTS.CRYO, color: 0x8fd8ff, hp: 5, opaque: false, render: 'glass', family: 'ice', structural: false });
def('cloth', { label: 'Awning', element: ELEMENTS.STRUCTURE, color: 0xd9a441, hp: 1, solid: true, opaque: true, projectile: 'pass', flammable: true, burnTo: null, family: 'plant', structural: false });
def('lantern', { label: 'Light fixture', element: ELEMENTS.PYRO, color: 0xffd36b, hp: 1, light: 3, family: 'metal', structural: false,
    explosive: { radius: 1.4, power: 1, damage: 1, element: 'pyro' } , walkable: false});
def('hay', { label: 'Hay bale', element: ELEMENTS.ANEMO, color: 0xd8b860, hp: 3, flammable: true, burnTo: 'ash', family: 'plant', structural: false , walkable: false});
// Cover props (shared/mission/PropCatalog.js): each one is a real object with a gameplay job.
def('drystone', { label: 'Dry-stone wall', color: 0x9a9384, hp: 8, family: 'stone', debris: 'rubble', structural: false , walkable: false});
def('fence', { label: 'Plank fence', element: ELEMENTS.STRUCTURE, color: 0x8a6440, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});
def('rock', { label: 'Boulder', color: 0x8c877d, hp: 14, family: 'stone', debris: 'rubble', structural: false });
def('cart', { label: 'Cart', element: ELEMENTS.STRUCTURE, color: 0x8a6238, hp: 4, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});
def('stall', { label: 'Market stall', element: ELEMENTS.STRUCTURE, color: 0xa47a4a, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false , walkable: false});

// Modern kit materials are appended so existing recorded material IDs remain stable.
def('stucco', { label: 'Stucco wall', color: 0xe5e3da, hp: 6, family: 'stone', debris: 'rubble' , walkable: false});
def('concrete', { label: 'Concrete paving', color: 0xc3c6c2, hp: 10, family: 'stone', debris: 'rubble' });
def('asphalt', { label: 'Asphalt', color: 0x424c52, hp: 8, family: 'stone' });
def('oak_floor', { label: 'Oak floor', color: 0xc3a47e, hp: 5, family: 'wood', flammable: true, burnTo: 'ash' });
def('ceramic', { label: 'Ceramic tile', color: 0xd8dfdb, hp: 6, family: 'stone' });
def('lawn', { label: 'Lawn', color: 0x839578, hp: 5, debris: 'soil' });
def('sofa', { label: 'Sofa', color: 0x537e7c, hp: 3, family: 'wood', flammable: true, burnTo: 'ash', structural: false, walkable: false });
def('cabinet', { label: 'Kitchen cabinet', color: 0xe3e5de, hp: 5, family: 'wood', flammable: true, structural: false, walkable: false });
def('bed', { label: 'Bed', color: 0xa8b9ad, hp: 3, family: 'wood', flammable: true, structural: false, walkable: false });
def('desk', { label: 'Desk', color: 0xb99870, hp: 3, family: 'wood', flammable: true, structural: false, walkable: false });
def('planter', { label: 'Concrete planter', color: 0xafb7b1, hp: 8, family: 'stone', debris: 'rubble', structural: false, walkable: false });
def('privacy_fence', { label: 'Privacy fence', color: 0x9a795b, hp: 4, family: 'wood', flammable: true, structural: false, walkable: false });
def('car_body', { label: 'Parked car', color: 0xaabcc1, hp: 7, family: 'metal', structural: false, walkable: false });
def('appliance', { label: 'Appliance', color: 0xd5dad7, hp: 7, family: 'metal', structural: false, walkable: false });
def('road_mark', { label: 'Road marking', color: 0xe1dfcb, hp: 8, family: 'stone' });
// Modern set, pass 2: themed ground, walls and real-object cover (shared/mission/themes/*).
def('paving', { label: 'Paving slabs', color: 0xb9bcb8, hp: 10, family: 'stone', debris: 'rubble' });
def('deck', { label: 'Timber deck', element: ELEMENTS.STRUCTURE, color: 0x9a8268, hp: 4, flammable: true, burnTo: 'ash', family: 'wood' });
def('gravel', { label: 'Gravel', color: 0x9b968d, hp: 6, moveCost: 1.05, family: 'stone' });
def('brick', { label: 'Brick wall', element: ELEMENTS.STRUCTURE, color: 0x9b5a45, hp: 9, family: 'stone', debris: 'rubble' , walkable: false});
def('concrete_wall', { label: 'Concrete wall', color: 0xb4b5b0, hp: 12, family: 'stone', debris: 'rubble' , walkable: false});
def('siding', { label: 'Metal siding', color: 0x8d969a, hp: 5, family: 'metal' , walkable: false});
def('roof_metal', { label: 'Metal roof', color: 0x7c868b, hp: 4, family: 'metal', walkable: false });
def('car_cabin', { label: 'Car cabin', color: 0x7c8a90, hp: 5, family: 'metal', structural: false, walkable: false });
def('container', { label: 'Shipping container', color: 0x9c4b3a, hp: 20, family: 'metal', structural: false });
def('dumpster', { label: 'Dumpster', color: 0x3f6a4e, hp: 9, family: 'metal', structural: false, walkable: false });
def('jersey', { label: 'Concrete barrier', color: 0xbcbcb4, hp: 14, family: 'stone', debris: 'rubble', structural: false, walkable: false });
def('bench', { label: 'Bench', element: ELEMENTS.STRUCTURE, color: 0x8a6a48, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false, walkable: false });
def('bin', { label: 'Wheelie bin', color: 0x3d4a52, hp: 2, family: 'wood', flammable: true, structural: false, walkable: false });
def('pump', { label: 'Fuel pump', element: ELEMENTS.PYRO, color: 0xc8c8c0, hp: 4, family: 'metal', structural: false,
    explosive: { radius: 2.8, power: 8, damage: 6, element: 'pyro' }, walkable: false });
def('pallet', { label: 'Pallet stack', element: ELEMENTS.STRUCTURE, color: 0xb08a5c, hp: 3, flammable: true, burnTo: 'ash', family: 'wood', structural: false, walkable: false });
def('shelving', { label: 'Store shelving', color: 0x9aa3a8, hp: 5, family: 'metal', structural: false, walkable: false });
def('chainlink', { label: 'Chain-link fence', color: 0x8f989c, hp: 2, solid: true, opaque: false, projectile: 'pass', family: 'metal', structural: false, walkable: false });
def('carpet', { label: 'Carpet', element: ELEMENTS.STRUCTURE, color: 0x7d7f86, hp: 5, flammable: true, burnTo: 'ash', family: 'wood' });
def('tile_dark', { label: 'Floor tiles', element: ELEMENTS.STRUCTURE, color: 0x5d6266, hp: 7, family: 'stone' });
// A fixed steel ladder: not a surface, never cover; units climb it between its foot and the ledge its top rung is
// level with (PathSearch.ladderMoves).
def('ladder', { label: 'Ladder', element: ELEMENTS.STRUCTURE, color: 0x8a9196, hp: 3, solid: false, opaque: false, projectile: 'pass', render: 'none', family: 'metal', structural: false, walkable: false });
// Ice over deep water remembers its depth: it melts back into deep water, not a wadeable shallow.
def('deep_ice', { label: 'Ice (over deep water)', element: ELEMENTS.CRYO, color: 0xbfe6f7, hp: 2, moveCost: 1.4, meltTo: 'deep_water', render: 'glass', opaque: false, family: 'ice' });

// Locked background-room doors cannot be opened or destroyed into accidental gameplay routes.
def('door_locked', { label: 'Locked service-room door', color: 0x666b70, hp: Infinity, family: 'metal', walkable: false, structural: false });

// Supported steel circulation: grate passes bullets, railing is low see-through cover.
def('grate', { label:'Steel grate',color:0x667680,hp:4,opaque:false,projectile:'pass',family:'metal',structural:true });
def('steel_stair', { label:'Steel stairs',color:0x667680,hp:6,part:4,opaque:false,projectile:'pass',family:'metal' });
def('steel_post', { label:'Steel post',color:0x53636f,hp:12,family:'metal',walkable:false });
def('railing', { label:'Steel railing',color:0x8999a2,hp:4,opaque:false,projectile:'pass',concealment:2,family:'metal',walkable:false,structural:false });

def('emergency_light',{label:'Emergency light',color:0xff493e,hp:1,light:3,family:'metal',structural:false,walkable:false});

export const MATERIALS = Object.freeze(M);
export const MAT = Object.freeze(Object.fromEntries(M.map(m => [m.key, m.id])));
export const materialById = id => M[id] || M[0];
export const materialByKey = key => M[MAT[key]] || M[0];
export const AIR = 0;

/** How much a voxel of this material covers a body standing behind it. */
export function coverWeight(m) {
    if (!m || m.id === AIR) return 0;
    if (m.projectile === 'block' || m.key === 'railing') return 1;
    return m.concealment ? 0.35 : 0;
}
