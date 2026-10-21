// Ammunition. Gun damage comes from the round, not the gun: every ballistic weapon names a `caliber` and takes its
// per-projectile damage, armour pierce and wall damage from here. Guns differ in how they deliver the round
// (projectiles per shot, spread, range, AP, magazine, noise).
//
// Scale: every character has 30 HP (shared/content/units.js). Part HP are shares of that pool (head 12, arms 12,
// legs 17, torso 30). Armour subtracts from each projectile after `pierce`, so heavy rounds keep their damage through
// plates and buckshot loses most of it.
//
//   damage  per projectile that hits a body part, before armour
//   pierce  armour points ignored per projectile
//   voxel   damage to a voxel the projectile hits (wall penetration feel; the voxel's hp absorbs it)
//
// Ids are stable (weapons, tests, the sim report); names are what the player sees.
export const CALIBERS = Object.freeze({
    '9mm': { id: '9mm', name: '9×19 mm', damage: 10, pierce: 0, voxel: 2, energy: 3 },
    '5.56': { id: '5.56', name: '5.56×45 mm NATO', damage: 10, pierce: 2, voxel: 2, energy: 6 },
    '300blk': { id: '300blk', name: '.300 BLK subsonic', damage: 10, pierce: 2, voxel: 2, energy: 5 },
    '7.62x39': { id: '7.62x39', name: '7.62×39 mm', damage: 10, pierce: 2, voxel: 3, energy: 8 },
    '7.62': { id: '7.62', name: '7.62×51 mm NATO', damage: 10, pierce: 3, voxel: 3, energy: 10 },
    '338': { id: '338', name: '.338 Lapua Magnum', damage: 30, pierce: 5, voxel: 6, energy: 22 },
    '12g': { id: '12g', name: '12-gauge 00 buckshot', damage: 3.75, pierce: 0, voxel: 1, energy: 1 }
});

/** Fill a ballistic weapon's damage, pierce and voxel from its caliber (explicit fields on the weapon win). */
export function withCaliber(w) {
    const c = w.caliber && CALIBERS[w.caliber];
    if (!c) return w;
    return { damage: c.damage, pierce: c.pierce, voxel: c.voxel, energy: c.energy ?? 0, ...w };
}
