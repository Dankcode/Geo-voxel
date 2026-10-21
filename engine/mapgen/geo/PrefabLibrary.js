// The building prefab library: real buildings baked by the geo pipeline (client/public/assets/buildings/), reusable in
// any map. Register prefabs (browser: fetch index.json + files; Node: read them), query them, and place one into a
// lot so its shopfront faces the street you name.
import { stampPrefab, transformFor, PREFAB_FORMAT } from './BuildingPrefab.js';

const LIB = new Map();
export function registerPrefab(pf) { if (pf?.format !== PREFAB_FORMAT) throw Error(`prefab: unknown format ${pf?.format}`); LIB.set(pf.id, pf); return pf; }
export function getPrefab(id) { return LIB.get(id) || null; }
export function clearPrefabs() { LIB.clear(); }
/** Prefabs matching { program, storeys, place, fits: [w, d] (either orientation) }. */
export function findPrefabs({ program = null, storeys = null, place = null, fits = null } = {}) {
    return [...LIB.values()].filter(p => (!program || p.program === program) && (!storeys || p.storeys === storeys) && (!place || p.source?.place === place)
        && (!fits || (p.size[0] <= fits[0] && p.size[1] <= fits[1]) || (p.size[1] <= fits[0] && p.size[0] <= fits[1])));
}
/** Browser: load the library index and every prefab file (or only `ids`). */
export async function loadPrefabLibrary({ base = '/assets/buildings', ids = null, fetchFn = globalThis.fetch } = {}) {
    const idx = await (await fetchFn(`${base}/index.json`)).json();
    const want = idx.prefabs.filter(p => !ids || ids.includes(p.id));
    await Promise.all(want.map(async p => registerPrefab(await (await fetchFn(p.file.startsWith('/') ? p.file : `${base}/${p.file}`)).json())));
    return want.length;
}

const ROT_FOR = { n: { n: 0, e: 3, s: 2, w: 1 }, e: { n: 1, e: 0, s: 3, w: 2 }, s: { n: 2, e: 1, s: 0, w: 3 }, w: { n: 3, e: 2, s: 1, w: 0 } };
/**
 * Place a prefab into the lot rectangle { x0, y0, w, d } with its front facing `face` ('n'|'e'|'s'|'w'), set back
 * `setback` cells from that edge and centred along it. Returns the stamped records, or null when it does not fit.
 */
export function placePrefabInLot(m, pf, lot, { face = 's', z = m.G ?? 1, setback = 2, mirror = false, as = null, register = null } = {}) {
    const rot = ROT_FOR[face][pf.front || 's'];
    const [W, D] = transformFor(pf.size.slice(0, 2), { rot, mirror }).size;
    if (W > lot.w || D > lot.d) return null;
    const cx = lot.x0 + Math.floor((lot.w - W) / 2), cy = lot.y0 + Math.floor((lot.d - D) / 2);
    const x = face === 'w' ? lot.x0 + Math.min(setback, lot.w - W) : face === 'e' ? lot.x0 + lot.w - W - Math.min(setback, lot.w - W) : cx;
    const y = face === 'n' ? lot.y0 + Math.min(setback, lot.d - D) : face === 's' ? lot.y0 + lot.d - D - Math.min(setback, lot.d - D) : cy;
    return stampPrefab(m, pf, { x, y, z, rot, mirror, as: as || `${pf.id}@${x},${y}`, register });
}
