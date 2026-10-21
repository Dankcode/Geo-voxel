// Terrain without keys or Blender: AWS Terrain Tiles (Mapzen "terrarium" encoding, public, CORS-enabled) at zoom 15
// (≈ 4 m a pixel at 30° latitude). In the US the source is USGS 3DEP (bare earth); elsewhere mostly SRTM (a surface
// model, so the generator's DSM filter applies). elevation (m) = R × 256 + G + B / 256 − 32768.
export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ZOOM = 15;

const worldPx = (lon, lat, z) => {
    const n = 256 * 2 ** z, s = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
};
/** Rough 3DEP coverage (conterminous US, Alaska, Hawaii): DTM there, DSM elsewhere. */
export const inUS = (lat, lon) => (lat > 24 && lat < 50 && lon > -125.5 && lon < -66) || (lat > 51 && lat < 72 && lon > -170 && lon < -129) || (lat > 18.5 && lat < 22.6 && lon > -160.5 && lon < -154.5);

/**
 * Heights over a lat/lon box. getTile(z, x, y) → Promise<{ width, height, data: RGBA }>.
 * Returns sample(lon, lat) → metres (bilinear), plus the tile list for attribution.
 */
export async function terrainSampler({ south, west, north, east }, getTile, { zoom = TERRAIN_ZOOM } = {}) {
    const [x0, y0] = worldPx(west, north, zoom), [x1, y1] = worldPx(east, south, zoom);
    const tx0 = Math.floor(x0 / 256) , tx1 = Math.floor(x1 / 256), ty0 = Math.floor(y0 / 256), ty1 = Math.floor(y1 / 256);
    const tiles = new Map(), jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(getTile(zoom, tx, ty).then(t => tiles.set(`${tx},${ty}`, t)));
    await Promise.all(jobs);
    const h = (px, py) => {
        const tx = Math.floor(px / 256), ty = Math.floor(py / 256), t = tiles.get(`${tx},${ty}`);
        if (!t) return null;
        const ix = Math.min(255, Math.max(0, Math.floor(px - tx * 256))), iy = Math.min(255, Math.max(0, Math.floor(py - ty * 256))), i = (iy * t.width + ix) * 4;
        return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
    };
    const sample = (lon, lat) => {
        const [px, py] = worldPx(lon, lat, zoom), fx = px - 0.5, fy = py - 0.5, ax = Math.floor(fx), ay = Math.floor(fy), u = fx - ax, v = fy - ay;
        const a = h(ax, ay), b = h(ax + 1, ay), c = h(ax, ay + 1), d = h(ax + 1, ay + 1);
        if ([a, b, c, d].some(q => q == null)) return a ?? b ?? c ?? d;
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
    return { sample, tiles: [...tiles.keys()].map(k => `${zoom}/${k.replace(',', '/')}`), zoom };
}
