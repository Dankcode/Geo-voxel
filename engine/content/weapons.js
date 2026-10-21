// Weapons and throwables. Every number here is a balance tunable; the sim (tools/sim) reports them.
//
// Phoenix Point model: a shot fires `projectiles` rays inside an accuracy cone (half-angle `spread`
// degrees at 100 % accuracy). Each ray is traced through voxels and body-part hitboxes; whatever it
// meets first takes the damage. Armour per body part subtracts from each projectile, reduced by
// `pierce`; `shred` permanently strips armour. `voxel` is the damage dealt to a voxel the ray hits.
//
// Setting: present day. Ids are stable (saves, tests, sim reports); names are what the player sees.
// Gun damage, pierce and wall damage come from the round (`caliber`, shared/content/calibers.js); every character
// has 30 HP.
import { withCaliber } from './calibers.js';
const CONFIG={
 repeater:{ammoType:'ar',ammo:30,projectiles:1,perShot:1,spread:1.0,fireModes:['single','burst','auto'],defaultMode:'burst',weight:3.4},
 blunderbuss:{ammoType:'shotgun',ammo:8,pellets:8,projectiles:8,perShot:1,shellDamage:30,spread:4,weight:3.8},
 longrifle:{ammoType:'high',ammo:1,perShot:1,spread:.3,boltAction:true,scoped:true,weight:5.2},
 handcannon:{ammoType:'ar',spread:1.4,weight:.9},
 crossbow:{ammoType:'ar',ammo:30,spread:.8,fireModes:['single','burst','auto'],defaultMode:'burst',weight:2.8},
 shortbow:{ammoType:'ar',ammo:20,spread:.6,scoped:true,weight:3.6},
 musket:{ammoType:'ar',ammo:30,spread:1.0,fireModes:['single','burst','auto'],defaultMode:'burst',weight:3.7},
 firelance:{ammoType:'shotgun',ammo:10,pellets:5,shellDamage:30,spread:3.5,weight:7}
};

export const WEAPONS = Object.freeze(Object.fromEntries(Object.entries({
    repeater: { name: 'Assault Rifle', kind: 'ballistic', caliber: '5.56', ap: 2, projectiles: 3, shred: 0,
        spread: 1.6, range: 18, maxRange: 34, ammo: 9, perShot: 3, reloadAp: 1, noise: 14, element: null, cutIn: 'burst' },
    blunderbuss: { name: 'Combat Shotgun', kind: 'ballistic', caliber: '12g', ap: 2, projectiles: 8, shred: 0,
        spread: 6.5, range: 7, maxRange: 14, ammo: 4, perShot: 1, reloadAp: 1, noise: 14, element: null, cutIn: 'shot' },
    longrifle: { name: 'Sniper Rifle', kind: 'ballistic', caliber: '338', ap: 3, projectiles: 1, shred: 0,
        spread: 0.6, range: 30, maxRange: 48, ammo: 3, perShot: 1, reloadAp: 1, noise: 18, element: null, cutIn: 'heavy' },
    handcannon: { name: 'Sidearm', kind: 'ballistic', caliber: '9mm', ap: 1, projectiles: 1, shred: 0,
        spread: 1.8, range: 12, maxRange: 22, ammo: 12, perShot: 1, reloadAp: 1, noise: 12, element: null, cutIn: 'shot' },
    crossbow: { name: 'Suppressed Carbine', kind: 'ballistic', caliber: '300blk', ap: 2, projectiles: 1, shred: 0,
        spread: 0.9, range: 20, maxRange: 32, ammo: 6, perShot: 1, reloadAp: 1, noise: 2, element: null, cutIn: 'shot' },
    shortbow: { name: 'Marksman Rifle', kind: 'ballistic', caliber: '5.56', ap: 2, projectiles: 1, shred: 0,
        spread: 1.4, range: 16, maxRange: 26, ammo: 8, perShot: 1, reloadAp: 1, noise: 12, element: null, cutIn: 'shot' },
    musket: { name: 'AK Rifle', kind: 'ballistic', caliber: '7.62x39', ap: 2, projectiles: 1, shred: 0,
        spread: 1.6, range: 16, maxRange: 28, ammo: 6, perShot: 1, reloadAp: 1, noise: 14, element: null, cutIn: 'shot' },
    // Not a cartridge: fuel jets that set what they hit alight.
    firelance: { name: 'Flamethrower', kind: 'ballistic', ap: 2, projectiles: 5, damage: 4, pierce: 0, shred: 0,
        spread: 4.2, range: 8, maxRange: 12, ammo: 3, perShot: 1, reloadAp: 1, voxel: 1, noise: 10, element: 'pyro', cutIn: 'heavy' },
    sword: { name: 'Combat Knife', kind: 'melee', ap: 1, damage: 10, pierce: 2, shred: 0, reach: 1.5, voxel: 1, noise: 4, cutIn: 'melee' },
    // Walker monster: rakes anything next to its legs; the blow throws soldiers back.
    strider_claws: { name: 'Strider Claws', kind: 'melee', ap: 1, damage: 16, pierce: 4, shred: 1, reach: 2, voxel: 20, knockback: 2, noise: 12, cutIn: 'melee' },
    maul: { name: 'Sledgehammer', kind: 'melee', ap: 2, damage: 16, pierce: 3, shred: 1, reach: 1.5, voxel: 4, knockback: 2, noise: 8, cutIn: 'melee' }
}).map(([id, w]) => [id, Object.freeze({...withCaliber({ id, ...w }),critRange:5,...CONFIG[id],...(CONFIG[id]?.ammoType?{farDamage:CONFIG[id].ammoType==='high'?10:5}: {})})])));

export const THROWABLES = Object.freeze({
    medkit: {id:'medkit',name:'Medical Kit',kind:'gadget',ap:1,range:1.5,heal:8},
    fire_flask: { id: 'fire_flask', name: 'Incendiary Grenade', ap: 2, range: 12, radius: 2.2, damage: 6, power: 2, element: 'pyro', noise: 10, cutIn: 'throw' },
    frost_flask: { id: 'frost_flask', name: 'Cryo Canister', ap: 2, range: 12, radius: 2.5, damage: 5, power: 1, element: 'cryo', noise: 8, cutIn: 'throw' },
    water_flask: { id: 'water_flask', name: 'Extinguisher Grenade', ap: 1, range: 12, radius: 2.6, damage: 0, power: 0, element: 'hydro', noise: 4, cutIn: 'throw' },
    gale_flask: { id: 'gale_flask', name: 'Concussion Grenade', ap: 2, range: 12, radius: 2.5, damage: 4, power: 2, element: 'anemo', knockback: 2, noise: 8, cutIn: 'throw' },
    powder_bomb: { id: 'powder_bomb', name: 'Frag Grenade', ap: 2, range: 11, radius: 2.6, damage: 14, power: 8, element: 'geo', shred: 1, noise: 18, cutIn: 'throw' },
    smoke_pot: { id: 'smoke_pot', name: 'Smoke Grenade', ap: 1, range: 12, radius: 3, damage: 0, power: 0, element: null, smoke: 3, noise: 4, cutIn: 'throw' },
    breach_charge: { id: 'breach_charge', name: 'Breaching Charge', ap: 2, range: 1.6, radius: 1.7, damage: 8, power: 16, element: 'geo', placed: true, noise: 16, cutIn: 'breach' }
});

export const ARMOR = Object.freeze({
    light: { head: 0, torso: 2, armL: 0, armR: 0, legs: 1, mobility: 0 },
    medium: { head: 1, torso: 3, armL: 2, armR: 2, legs: 2, mobility: -0.2 },
    heavy: { head: 2, torso: 4, armL: 3, armR: 3, legs: 3, mobility: -0.4 },
    hide: { head: 0, torso: 1, armL: 0, armR: 0, legs: 0, mobility: 0 },
    plate: { head: 3, torso: 6, armL: 4, armR: 4, legs: 4, mobility: -0.4 },
    drone: { head: 0, torso: 0, armL: 0, armR: 0, legs: 0, mobility: 0 }   // PLAN-14: search drones — one hit
});
