// PLAN-06 §5.5 — vehicles come from the noise map, and only ever stand in the slots a parcel or a street rule made.
//
//   V(x, y) = fbm(seed, 'vehicles') × (0.5 + slot priority) × pocketWeight(x, y)
// Each slot group (one lot, one kerb run, one dock row) fills its slots in descending V until it reaches its target
// occupancy, which depends on the slot kind, the traffic setting and the time of day ('retail': a shopping-centre
// lot — big and never more than about a third full, and not thinned further at dusk).
// Priority encodes real use:
// stalls near the shop door fill first, the front of a driveway before the back. pocketWeight lifts slots on the
// line of play so parked cars become cover where the fight needs it.
import { fbm } from '../Fields.js';
import { hashString } from '../../util/Rng.js';
import { placeStreetVehicle, VEHICLE_SPECS } from '../StreetDressing.js';
import { registerCells } from './Core.js';

export const OCCUPANCY = Object.freeze({
    stall: [0.35, 0.7], kerb: [0.3, 0.5], driveway: [0.5, 0.85], dock: [0.5, 0.85], salvage: [1, 1], forecourt: [0.4, 0.8],
    queue: [0.5, 0.8], pump: [0.3, 0.6], retail: [0.25, 0.4], site: [1, 1], lane: [0.3, 0.6], 'bus-stop': [1, 1], service: [0.5, 0.8], display: [0.85, 1]
});
const TRAFFIC = Object.freeze({ none: 0, light: 0.6, normal: 1, heavy: 1.35 });
const NIGHT = new Set(['night', 'night-ops', 'dusk']);

/** Line-of-play weighting: 1 off the line, up to 1.8 on it. */
export function pocketWeight(a, b) {
    if (!a || !b) return () => 1;
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    return (x, y) => { const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)); const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y); return 1 + 0.8 * Math.exp(-((d / 8) ** 2)); };
}

export function placeVehicles(m, { seed = 1, traffic = 'normal', timeOfDay = 'day', pocket = () => 1 } = {}) {
    const t = TRAFFIC[traffic] ?? 1, placed = [];
    if (!t) return placed;
    const groups = new Map();
    for (const s of m.district.stalls) { const g = s.origin || s.kind; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    for (const [origin, stalls] of [...groups].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
        const kind = stalls[0].kind, [lo, hi] = OCCUPANCY[kind] || [0.4, 0.6];
        const n0 = fbm(`${seed}:occupancy`, stalls[0].x, stalls[0].y, { frequency: 1 / 20 });
        let target = (lo + (hi - lo) * n0) * (kind === 'salvage' || kind === 'site' || kind === 'bus-stop' ? 1 : t);
        if (NIGHT.has(timeOfDay)) target *= kind === 'driveway' ? 1.2 : kind === 'stall' ? 0.6 : 1;
        const count = Math.min(stalls.length, Math.round(target * stalls.length + (kind === 'salvage' || kind === 'site' || kind === 'bus-stop' ? 0.5 : 0)));
        const scored = stalls.map(s => ({ s, v: fbm(`${seed}:vehicles`, s.x, s.y, { frequency: 1 / 6 }) * (0.5 + s.priority) * pocket(s.x + 1, s.y + 1) }))
            .sort((a, b) => b.v - a.v || a.s.x - b.s.x || a.s.y - b.s.y);
        for (const { s } of scored.slice(0, count)) {
            const types = s.types.filter(ty => VEHICLE_SPECS[ty] && VEHICLE_SPECS[ty].length <= s.length);
            if (!types.length) continue;
            const type = types[hashString(`${seed}:${s.x},${s.y}:type`) % types.length];
            const v = placeStreetVehicle(m, type, s.x, s.y, { axis: s.axis, z: s.z });
            if (!v) continue;
            const cells = [];
            const L = VEHICLE_SPECS[type].length;
            for (let i = 0; i < L; i++) for (let j = 0; j < 2; j++) for (let h = 1; h <= 2; h++) cells.push(s.axis === 'x' ? [s.x + i, s.y + j, s.z + h] : [s.x + j, s.y + i, s.z + h]);
            registerCells(m, cells.filter(([x, y, z]) => m.store.isSolid(x, y, z)), `vehicle:${kind}:${origin}`);
            const rec = { ...v, kind, origin };
            placed.push(rec); m.district.vehicles.push(rec);
        }
    }
    return placed;
}
