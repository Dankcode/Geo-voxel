// PLAN-07 balance: generated districts field three enemy pods (7 hostiles) plus, since PLAN-09, one walker monster, like the hand-built maps (Cedar Close: 7
// in 4 pods). Two pods hold the farthest buildings, one patrols the street near the target end of the map.
export const DISTRICT_PODS = Object.freeze([
    { group: 0, units: ['warden_foe', 'cultist', 'archer'] },
    { group: 1, units: ['brute', 'cultist'] },
    { group: 2, units: ['archer', 'cultist'], street: true },
    // PLAN-09: a walker monster prowls the street (melee; smashes through buildings). Left out if it cannot fit.
    { group: 5, units: ['wall_strider'], street: true, monster: true }
]);
/**
 * far: buildings sorted farthest first; fallback: [{x,y,z}, {x,y,z}] when a pod has no building; street: {x,y,z}.
 * Returns spawn specs for MissionCommon (room specs spread over the building's rooms by index).
 */
export function districtPods(far, { fallback = [], street = null } = {}) {
    const out = [];
    DISTRICT_PODS.forEach((pod, p) => {
        pod.units.forEach((type, i) => {
            if (pod.street) {
                const s = street || fallback[1] || fallback[0];
                if (s) out.push({ type, group: pod.group, at: pod.monster ? { x: s.x, y: s.y - 6, z: s.z } : { x: s.x + (i % 2 ? 2 : -2), y: s.y + (i > 1 ? 2 : 0), z: s.z } });
                return;
            }
            const b = far[p];
            if (b) out.push({ type, group: pod.group, room: { building: b.id, index: i } });
            else if (fallback[p]) out.push({ type, group: pod.group, at: { x: fallback[p].x + i * 2, y: fallback[p].y, z: fallback[p].z } });
        });
    });
    return out;
}
