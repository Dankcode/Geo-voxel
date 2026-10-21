// Level design for generated operations (PLAN-04): per-floor room programmes sized to each footprint, the
// objective (on the landmark's top floor), located story beats, and enemy pods — inside buildings and at the
// engagement pockets along the line of play (pods spawn at pockets, PLAN-04 §5.4).
import { bayGridOf } from './InteriorPlanSolver.js';
import { hashString } from '../util/Rng.js';

const unit = s => (hashString(s) >>> 0) / 4294967296;
const pick = (list, key) => list[Math.floor(unit(key) * list.length) % list.length];
// Room kinds per programme and floor, most important first; '*' marks a locked service room.
const PROGRAMMES = {
    office: { ground: ['lobby', 'office', 'meeting', 'restroom*'], upper: ['open_office', 'office', 'meeting', 'restroom*'], top: ['office', 'meeting', 'open_office', 'restroom*'] },
    apartment: { ground: ['lobby', 'unit', 'storeroom', 'utility*'], upper: ['unit', 'bedroom', 'kitchen', 'bathroom*'], top: ['unit', 'bedroom', 'study', 'bathroom*'] },
    house: { ground: ['living', 'kitchen', 'study', 'bathroom*'], upper: ['bedroom', 'study', 'bedroom', 'bathroom*'], top: ['bedroom', 'study', 'bedroom', 'bathroom*'] },
    shop: { ground: ['sales', 'storeroom', 'office', 'restroom*'], upper: ['storeroom', 'office', 'unit', 'restroom*'], top: ['office', 'storeroom', 'unit', 'restroom*'] },
    diner: { ground: ['dining', 'galley', 'office', 'restroom*'], upper: ['office', 'storeroom', 'unit'], top: ['office', 'storeroom'] },
    warehouse: { ground: ['warehouse', 'loading', 'office', 'utility*'], upper: ['office', 'storeroom', 'meeting', 'utility*'], top: ['office', 'meeting', 'storeroom'] },
    garage: { ground: ['workshop', 'storeroom', 'office', 'utility*'], upper: ['office', 'storeroom'], top: ['office', 'storeroom'] },
    // PLAN-14 building types, from room kinds the planner and furnisher already know.
    motel: { ground: ['lobby', 'unit', 'unit', 'utility*'], upper: ['unit', 'unit', 'bathroom*'], top: ['unit', 'unit', 'bathroom*'] },
    bar: { ground: ['dining', 'galley', 'storeroom', 'restroom*'], upper: ['office', 'storeroom', 'unit'], top: ['office', 'unit'] }
};
const CODE_A = ['Iron', 'Silent', 'Grey', 'Night', 'Glass', 'Cold', 'Black', 'Copper', 'Ashen', 'Low', 'Broken', 'Last'];
const CODE_B = ['Ledger', 'Harbor', 'Lantern', 'Viaduct', 'Canopy', 'Signal', 'Gutter', 'Spire', 'Ward', 'Switchyard', 'Crossing', 'Furnace'];
const ORDINAL = ['ground', 'first', 'second', 'third'];

/** Room count that fits a floor: about one room per five free bays, 2–5 rooms. */
export function roomsFor(b) {
    const { nbx, nby } = bayGridOf(b.w, b.d), core = b.storeys >= 2 ? 6 : 0, rest = nbx * nby - core;
    const corridor = rest > 12 ? Math.max(nbx, nby) - 1 : 0;
    return Math.max(1, Math.min(4, Math.round((rest - corridor) / 6)));
}

export function designProgrammes({ buildings, target, plot, seed, objectiveKind = null, timeOfDay = 'dusk', name = null }) {
    const programs = [];
    for (const b of buildings) {
        const table = PROGRAMMES[b.program] || PROGRAMMES.office, count = roomsFor(b);
        for (let floor = 0; floor < b.storeys; floor++) {
            const list = floor === 0 ? table.ground : floor === b.storeys - 1 ? table.top : table.upper;
            let kinds = list.slice(0, count);
            if (count < 3) kinds = kinds.filter(k => !k.endsWith('*'));
            if (!kinds.length) kinds = [list[0]];
            const seen = new Map();
            const rooms = kinds.map((k, i) => {
                const kind = k.replace('*', ''), n = (seen.get(kind) || 0) + 1; seen.set(kind, n);
                // PLAN-10: service rooms (WC, plant room) are ordinary small rooms with a real door and windows, never sealed.
                return { id: n > 1 ? `${kind}-${n}` : kind, kind, areaShare: i === 0 ? 0.4 : 0.6 / Math.max(1, kinds.length - 1), gameplay: true, service: k.endsWith('*') };
            });
            programs.push({ building: b.id, floor, rooms, adjacencies: [] });
        }
    }
    const top = target.storeys - 1, topRooms = programs.find(p => p.building === target.id && p.floor === top).rooms.filter(r => r.gameplay);
    const kinds = ['recover', 'recover', 'recover', 'extract', 'hold', 'hold', 'eliminate'];
    const kind = objectiveKind || pick(kinds, `${plot.family}:${seed}:objective`);
    const code = `Operation ${pick(CODE_A, `${seed}:code-a`)} ${pick(CODE_B, `${seed}:code-b:${plot.family}`)}`;
    const where = { downtown: 'downtown block', industrial: 'freight yard', suburb: 'residential close' }[plot.family] || 'city block';
    const goal = { recover: `recover the intelligence from the ${ORDINAL[top]}-floor ${topRooms[0].kind.replace('_', ' ')}`, extract: `get three soldiers to the ${ORDINAL[top]}-floor rendezvous`, hold: `take and hold the ${ORDINAL[top]}-floor ${topRooms[0].kind.replace('_', ' ')}`, eliminate: 'clear every Syndicate cell in the block' }[kind];
    const under = { subway: 'the subway tunnel', 'storm-drain': 'the storm drain' }[plot.underground] || 'the underground route';
    const design = {
        version: 1, generated: true,
        mission: { kind, title: name || code, timeOfDay, target: { building: target.id, floor: top, room: topRooms[0].id },
            briefing: `The Syndicate has fortified a ${where}. Insert on the street, push from cover to cover along the line of advance, use ${under} or a fire escape to flank the ${target.program === 'apartment' ? 'apartment block' : target.program}, and ${goal}.` },
        programs,
        beats: [
            { id: 'approach', text: 'Reach the cover outside the objective.', building: target.id, floor: 0, room: 'hall' },
            { id: 'escalation', text: 'Push past the guarded stair core.', building: target.id, floor: Math.min(1, top), room: 'hall' },
            { id: 'climax', text: kind === 'eliminate' ? 'Break the cell holding the top floor.' : 'Secure the command room.', building: target.id, floor: top, room: topRooms[0].id }
        ],
        encounters: []
    };
    let group = 0;
    const roomOn = (b, floor, prefer) => { const p = programs.find(q => q.building === b.id && q.floor === floor); const g = p.rooms.filter(r => r.gameplay); return prefer && g.find(r => r.id === prefer) ? prefer : g[Math.floor(unit(`${seed}:${b.id}:${floor}:pod`) * g.length)]?.id || 'hall'; };
    // The objective is held on every floor; the top floor's command room is the last fight.
    design.encounters.push({ group: group++, building: target.id, floor: 0, room: 'hall', types: ['cultist', 'warden_foe'] });
    if (top >= 2) design.encounters.push({ group: group++, building: target.id, floor: Math.min(2, top - 1), room: 'hall', types: ['warden_foe'] });
    design.encounters.push({ group: group++, building: target.id, floor: top, room: topRooms[0].id, types: ['archer', 'cultist'] });
    // Other buildings: a picket in the ones nearest the objective (an overwatch on the tallest).
    const others = buildings.filter(b => b !== target).sort((a, c) => Math.hypot(a.x0 - target.x0, a.y0 - target.y0) - Math.hypot(c.x0 - target.x0, c.y0 - target.y0)).slice(0, 1);
    for (const b of others) design.encounters.push({ group: group++, building: b.id, floor: b.storeys - 1, room: roomOn(b, b.storeys - 1), types: [b.storeys >= 2 ? 'archer' : 'cultist'] });
    return design;
}

/** Outdoor pods at the engagement pockets in the second half of the line of play (at most two). */
export function addPocketPods(design, pockets, seed) {
    // One outdoor pod on the last pocket before the objective (the squad's fight to get in); a second only on long routes.
    const late = pockets.filter(p => p.along >= 0.45).slice(pockets.length >= 4 ? -2 : -1);
    let group = Math.max(-1, ...design.encounters.map(e => e.group)) + 1;
    // PLAN-14: the first outdoor pod is a drone tech's crew; its search drone sweeps the street ahead of it.
    late.forEach((p, i) => design.encounters.push({ group: group++, pocket: p.id, at: { x: p.x, y: p.y }, types: i === 0 ? ['tech', 'search_drone', 'cultist'] : unit(`${seed}:pocket-pod:${p.id}`) < 0.5 ? ['cultist', 'archer'] : ['warden_foe', 'cultist'] }));
    return design;
}
