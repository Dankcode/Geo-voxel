// PLAN-04 §5.1 — the uniform kit metric. Every generated module snaps to these units so nothing ever resizes:
// a fire-escape storey, a facade bay or a lot is the same number of voxels on every map.
export const CELL = 1;          // one voxel, ≈ 0.9 m
export const STOREY = 3;        // slab + 2 voxels of headroom
export const BAY = 2;           // facade opening + pier, interior partitions sit on bay lines
export const LOT = 8;           // a parcel, 4 × 4 bays
export const BLOCK = 16;        // 2 × 2 lots
export const MAX_STOREYS = 4;

/** Cells of a footprint that spans `bays` bays plus its one-cell wall shell (walls land on bay lines). */
export const bayCells = bays => bays * BAY + 1;
/** Whole bays inside a footprint of `cells` (cells must be odd: n bays + shell). */
export const cellsToBays = cells => (cells - 1) / BAY;
/** Snap a length to an odd count (n bays + shell), never below `min`. */
export function oddAtLeast(cells, min = 7) { const n = Math.max(min, Math.round(cells)); return n % 2 ? n : n + 1; }
/** Round a map extent up to whole lots, within the 64-cell budget. */
export const lotSpan = cells => Math.min(64, Math.ceil(cells / LOT) * LOT);
export const storeyZ = (datum, storey) => datum + STOREY * storey;
