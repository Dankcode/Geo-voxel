// A plain voxel grid: x east, y south, z up; one byte per voxel indexing a named palette.
export const PALETTE = [
    // name, rgb
    ['air', [0, 0, 0]], ['bedrock', [40, 40, 44]], ['stone', [110, 108, 104]], ['soil', [110, 86, 60]], ['grass', [96, 150, 80]],
    ['asphalt', [60, 62, 66]], ['kerb', [150, 150, 146]], ['sidewalk', [176, 172, 164]], ['lot', [66, 68, 72]], ['stripe', [230, 228, 220]],
    ['floor', [160, 150, 136]], ['wall', [150, 80, 60]], ['wall_concrete', [130, 132, 135]], ['wall_stucco', [200, 185, 150]], ['wall_siding', [180, 190, 200]],
    ['glass', [120, 170, 200]], ['door', [90, 60, 40]], ['roof', [206, 204, 200]], ['parapet', [120, 70, 60]], ['planter', [175, 183, 177]], ['trunk', [96, 70, 48]], ['leaves', [70, 120, 60]]
];
export const M = Object.fromEntries(PALETTE.map(([n], i) => [n, i]));

/** palette: [[name, [r, g, b]], …] — index 0 is air. Defaults to the real-place PALETTE; the town engine passes its own. */
export class VoxelGrid {
    constructor(width, depth, height, palette = PALETTE) { this.width = width; this.depth = depth; this.height = height; this.palette = palette; this.data = new Uint8Array(width * depth * height); }
    index(x, y, z) { return (z * this.depth + y) * this.width + x; }
    inBounds(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.depth && z < this.height; }
    get(x, y, z) { return this.inBounds(x, y, z) ? this.data[this.index(x, y, z)] : 0; }
    set(x, y, z, m) { if (this.inBounds(x, y, z)) this.data[this.index(x, y, z)] = typeof m === 'string' ? (this.palette === PALETTE ? M[m] : this.palette.findIndex(([n]) => n === m)) : m; }
    top(x, y) { for (let z = this.height - 1; z >= 0; z--) if (this.get(x, y, z)) return z; return -1; }
    /** Run-length JSON: { width, depth, height, palette: names, runs: [count, index, …] } (z, y, x order). */
    toJSON() {
        const runs = [];
        for (let i = 0; i < this.data.length;) { let j = i + 1; while (j < this.data.length && this.data[j] === this.data[i]) j++; runs.push(j - i, this.data[i]); i = j; }
        return { format: 'geo-voxels/grid@1', width: this.width, depth: this.depth, height: this.height, palette: this.palette.map(([n]) => n), colors: this.palette === PALETTE ? undefined : this.palette.map(([, c]) => c), runs };
    }
    static fromJSON(o) {
        const pal = o.colors ? o.palette.map((n, i) => [n, o.colors[i]]) : PALETTE;
        const g = new VoxelGrid(o.width, o.depth, o.height, pal); let at = 0;
        for (let i = 0; i < o.runs.length; i += 2) { g.data.fill(o.runs[i + 1], at, at + o.runs[i]); at += o.runs[i]; }
        return g;
    }
}
