// Dense, mutable voxel grid for a mission map.
//
// Coordinates: x (east), y (south), z (up). Voxel (x, y, z) fills [x, x+1) × [y, y+1) × [z, z+1).
// A unit "at" (x, y, z) stands ON TOP of the surface voxel z (vibe-game convention), so its feet are
// at height z + 1.
//
// The store implements the parts of vibe-game's VoxelWorld interface that the copied
// TraversalRules / PathSearch use (`surfaces`, `isSolid`), so movement reuses that code unchanged.
import { MATERIALS, MAT, AIR, materialById } from './Materials.js';

export const CHUNK = 16;
const HP_INF = 0xffff;

export class VoxelStore {
    constructor(width, depth, height) {
        this.width = width; this.depth = depth; this.height = height;
        const n = width * depth * height;
        this.mat = new Uint8Array(n);
        this.hp = new Uint16Array(n);
        this.surfaceCache = new Map();
        this.profileSurfaceCache = new Map();     // agent profile → (x + y·W → admissible surfaces), TraversalRules
        this.dirtyChunks = new Set();
        this.version = 0;
        // "x,y" cells drawn with straight edges: the whole footprint of every old building (BuildingEra.js). The name
        // predates eras, when only outside corners could be square; snapshots and the battle hash keep it.
        this.squareCorners = new Set();
        this.windowOpenings = new Map(); // half-window sill cells → crossing axis; survives shattered glazing
        // PLAN-07 visible damage (gameplay-neutral, shared so every peer and snapshot shows the same marks):
        //   scars   cells whose voxel was shot or blown out; surviving neighbours show a broken edge toward them
        //   scorch  solid cells blackened by blasts and fire, "x,y,z" → 1..3
        this.scars = new Set();
        this.scorch = new Map();
        this.marksVersion = 0;
        this.listeners = new Set();
        this.recording = null;
        this.rooms = new Int16Array(n).fill(-1);   // interior room id per air voxel (-1 = outside)
    }
    index(x, y, z) { return (z * this.depth + y) * this.width + x; }
    inBounds(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.depth && z < this.height; }
    get(x, y, z) { return this.inBounds(x, y, z) ? this.mat[this.index(x, y, z)] : (z < 0 ? MAT.bedrock : AIR); }
    material(x, y, z) { return materialById(this.get(x, y, z)); }
    hpAt(x, y, z) { if (!this.inBounds(x, y, z)) return 0; const h = this.hp[this.index(x, y, z)]; return h === HP_INF ? Infinity : h; }

    /** Low-level write. Records the change, marks the render chunk dirty and drops cached surfaces. */
    set(x, y, z, id, hp = null) {
        if (!this.inBounds(x, y, z)) return false;
        const i = this.index(x, y, z), before = this.mat[i];
        const m = MATERIALS[id] || MATERIALS[0];
        this.mat[i] = id;
        this.hp[i] = hp != null ? Math.min(HP_INF, hp) : (m.hp === Infinity ? HP_INF : m.hp);
        if (before !== id) {
            this.version++;
            if (id !== AIR && this.scars.size && this.scars.delete(`${x},${y},${z}`)) this.marksVersion++;
            this.markDirty(x, y, z);
            this.surfaceCache.delete(x + y * this.width);
            for (const m of this.profileSurfaceCache.values()) m.delete(x + y * this.width);
            if (this.recording) this.recording.push([x, y, z, before, id]);
            for (const l of this.listeners) l(x, y, z, before, id);
        }
        return true;
    }
    /** Mark a destroyed cell (Destruction.destroyVoxel). */
    markScar(x, y, z) { const k = `${x},${y},${z}`; if (!this.scars.has(k)) { this.scars.add(k); this.marksVersion++; this.markDirty(x, y, z); } }
    /** Blacken a solid cell; keeps the strongest level. */
    addScorch(x, y, z, level) {
        if (!this.inBounds(x, y, z) || level <= 0) return;
        const m = materialById(this.get(x, y, z));
        if (!m.solid || m.liquid) return;
        const k = `${x},${y},${z}`, cur = this.scorch.get(k) || 0, next = Math.min(3, Math.max(cur, level));
        if (next !== cur) { this.scorch.set(k, next); this.marksVersion++; this.markDirty(x, y, z); }
    }
    /** Sorted plain copy for hashes and snapshots. */
    marksSnapshot() { return { scars: [...this.scars].sort(), scorch: [...this.scorch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) }; }
    setKey(x, y, z, key) { return this.set(x, y, z, MAT[key] ?? AIR); }
    fill(x0, y0, z0, x1, y1, z1, key) {
        const id = MAT[key] ?? AIR;
        for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
    }
    markDirty(x, y, z) {
        const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK);
        this.dirtyChunks.add(`${cx},${cy},${cz}`);
        // Neighbouring chunks share faces with this voxel.
        if (x % CHUNK === 0 && cx > 0) this.dirtyChunks.add(`${cx - 1},${cy},${cz}`);
        if (x % CHUNK === CHUNK - 1) this.dirtyChunks.add(`${cx + 1},${cy},${cz}`);
        if (y % CHUNK === 0 && cy > 0) this.dirtyChunks.add(`${cx},${cy - 1},${cz}`);
        if (y % CHUNK === CHUNK - 1) this.dirtyChunks.add(`${cx},${cy + 1},${cz}`);
        if (z % CHUNK === 0 && cz > 0) this.dirtyChunks.add(`${cx},${cy},${cz - 1}`);
        if (z % CHUNK === CHUNK - 1) this.dirtyChunks.add(`${cx},${cy},${cz + 1}`);
    }
    takeDirtyChunks() { const out = [...this.dirtyChunks]; this.dirtyChunks.clear(); return out; }
    /** Collect every write made inside fn as [x, y, z, before, after]. */
    record(fn) {
        const outer = this.recording; this.recording = [];
        try { fn(); return this.recording; } finally { const inner = this.recording; this.recording = outer; if (outer) outer.push(...inner); }
    }

    // ---- queries ---------------------------------------------------------------------------
    isSolid(x, y, z) { return materialById(this.get(x, y, z)).solid; }
    isOpaque(x, y, z) { return materialById(this.get(x, y, z)).opaque; }
    topSolid(x, y) { for (let z = this.height - 1; z >= 0; z--) if (this.isSolid(x, y, z)) return z; return -1; }
    roomAt(x, y, z) { return this.inBounds(x, y, z) ? this.rooms[this.index(x, y, z)] : -1; }

    /** vibe-game VoxelWorld#surfaces: standable tops with headroom, lowest first. */
    surfaces(x, y) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return [];
        const key = x + y * this.width;
        const cached = this.surfaceCache.get(key);
        if (cached) return cached;
        const out = [];
        for (let z = 0; z < this.height; z++) {
            const m = materialById(this.get(x, y, z));
            if (!m.walkable && !(m.liquid && m.traversal === 'wade')) continue;
            const above = materialById(this.get(x, y, z + 1));
            if (above.solid || above.liquid) continue;
            let headroom = 0;
            while (headroom < 8 && z + headroom + 1 < this.height + 2 && !materialById(this.get(x, y, z + headroom + 1)).solid) headroom++;
            out.push({ x, y, z, headroom,
                voxel: { z, element: m.element, building: m.part, walkable: true, material: m.key },
                info: { moveCost: m.moveCost, traversal: m.liquid ? m.traversal : 'walk', pattern: m.key } });
        }
        this.surfaceCache.set(key, out);
        return out;
    }
    /** The surface a unit would stand on at (x, y) closest to height z (or the highest). */
    surfaceNear(x, y, z = Infinity) {
        const s = this.surfaces(x, y);
        if (!s.length) return null;
        if (!Number.isFinite(z)) return s[s.length - 1];
        let best = null;
        for (const c of s) if (!best || Math.abs(c.z - z) < Math.abs(best.z - z)) best = c;
        return best;
    }

    /** FNV-1a over materials: two clients with the same hash see the same map. */
    hash() {
        let h = 0x811c9dc5;
        for (let i = 0; i < this.mat.length; i++) { h ^= this.mat[i]; h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16).padStart(8, '0');
    }
    clone() {
        const c = new VoxelStore(this.width, this.depth, this.height);
        c.squareCorners=new Set(this.squareCorners);
        c.windowOpenings=new Map(this.windowOpenings);
        c.scars=new Set(this.scars);c.scorch=new Map(this.scorch);
        c.datum=this.datum;c.supportGroups=structuredClone(this.supportGroups||[]);
        c.mat.set(this.mat); c.hp.set(this.hp); c.rooms.set(this.rooms);
        return c;
    }
}
