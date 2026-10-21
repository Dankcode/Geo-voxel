// Building era decides the edge style of everything a building is made of.
//
//   modern → rounded edges everywhere: curved outside wall corners, rounded wall ends, filleted slab edges and
//            soft-edged furniture.
//   old    → straight edges everywhere, the interior included: square wall corners and ends, sharp slabs and
//            sharp-edged furniture.
//
// The style is stored per map cell (VoxelStore.squareCorners: the "x,y" cells drawn with straight edges), so two
// buildings that merge keep their own look: the old building's footprint is straight, the modern one's rounded.
// A cell both footprints share (the party wall of a merge) belongs to the old building.
export const ERAS = Object.freeze(['modern', 'old']);

/**
 * A building spec's era. An explicit `era` wins; the older `rounded` flag still works (false → old, true → modern);
 * otherwise `fallback` (present-day builders default to modern, the classic BuildingBuilder to old).
 */
export function buildingEra(spec = {}, fallback = 'modern') {
    if (ERAS.includes(spec.era)) return spec.era;
    if (spec.rounded === false) return 'old';
    if (spec.rounded === true) return 'modern';
    return fallback;
}

/** Mark an old building's whole footprint as straight-edged. Modern buildings leave the cells as they are. */
export function markBuildingEdges(store, { x0, y0, w, d }, era) {
    if (era !== 'old') return;
    for (let y = y0; y < y0 + d; y++) for (let x = x0; x < x0 + w; x++) store.squareCorners.add(`${x},${y}`);
}

/**
 * Fast per-cell lookup for renderers that test every voxel: a W×D byte grid rebuilt when the set changes size.
 * Returns (x, y) → true when the cell is drawn with straight edges.
 */
export function straightCells(store) {
    const set = store.squareCorners;
    if (!set?.size) return () => false;
    let g = store._straightGrid;
    if (!g || g.size !== set.size || g.width !== store.width) {
        const grid = new Uint8Array(store.width * store.depth);
        for (const k of set) { const i = k.indexOf(','), x = +k.slice(0, i), y = +k.slice(i + 1); if (x >= 0 && y >= 0 && x < store.width && y < store.depth) grid[x + y * store.width] = 1; }
        g = store._straightGrid = { grid, size: set.size, width: store.width };
    }
    const { grid } = g, W = store.width, D = store.depth;
    return (x, y) => x >= 0 && y >= 0 && x < W && y < D && grid[x + y * W] === 1;
}
