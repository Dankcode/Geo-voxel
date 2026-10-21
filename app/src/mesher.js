// Voxel grid → three.js geometry: one face per exposed voxel side, vertex colours carrying the palette colour, a
// little per-voxel variation and corner ambient occlusion. Opaque and see-through (glass, water) faces are split so
// the transparent pass draws on top. `cut` hides everything above a level (XCOM-style floor cutaway).
import * as THREE from 'three';

// voxel axes: x east, y south, z up → three: X = x, Y = z, Z = y
const FACES = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.86 }, { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.8 },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.9 }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.76 },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 1 }, { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.55 }
];
const toThree = p => [p[0], p[2], p[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
for (const f of FACES) {
    // corners (u, v) ∈ {0,1}² in this order, at the face's plane; fix the winding so three.js sees it front-facing
    const o = f.n.map(c => (c > 0 ? 1 : 0)), at = (a, b) => o.map((c, i) => c + a * f.u[i] + b * f.v[i]);
    f.corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const p = f.corners.map(([a, b]) => toThree(at(a, b))), nn = toThree(f.n), c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    f.flip = c[0] * nn[0] + c[1] * nn[1] + c[2] * nn[2] < 0;
    f.origin = o;
}
const AO = [0.5, 0.68, 0.84, 1];

/**
 * grid { width, depth, height, data }, palette [{ color, render, glass, liquid }], { cut = Infinity }
 * → { opaque: BufferGeometry, clear: BufferGeometry } (positions in cells; 1 cell = 1 unit)
 */
export function meshGrid(grid, palette, { cut = Infinity } = {}) {
    const { width: W, depth: D, height: H, data } = grid;
    const kind = palette.map(p => (p.key === 'air' || p.render === 'none' ? 0 : p.glass || p.liquid ? 2 : 1));   // 0 empty · 1 opaque · 2 clear
    const top = Math.min(H - 1, cut);
    const get = (x, y, z) => (x < 0 || y < 0 || x >= W || y >= D || z < 0 || z > top ? 0 : data[(z * D + y) * W + x]);
    const solid = (x, y, z) => kind[get(x, y, z)] === 1;
    const out = [{ pos: [], col: [], idx: [] }, { pos: [], col: [], idx: [] }];
    const colors = palette.map(p => p.color.map(c => (c / 255) ** 2.2));   // sRGB → linear for the renderer
    for (let z = 0; z <= top; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const m = data[(z * D + y) * W + x], k = kind[m];
        if (!k) continue;
        const base = colors[m], jitter = 1 + (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 255) / 255 * 0.08 - 0.04;
        const buf = out[k - 1];
        for (const f of FACES) {
            const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2], nk = kind[get(nx, ny, nz)];
            if (nk === 1 || (k === 2 && nk === 2)) continue;
            const start = buf.pos.length / 3;
            for (const [a, b] of f.corners) {
                const p = [x + f.origin[0] + a * f.u[0] + b * f.v[0], y + f.origin[1] + a * f.u[1] + b * f.v[1], z + f.origin[2] + a * f.u[2] + b * f.v[2]];
                buf.pos.push(p[0], p[2], p[1]);
                // corner AO from the three voxels touching this corner in the layer in front of the face
                const su = a ? 1 : -1, sv = b ? 1 : -1;
                const s1 = solid(nx + su * f.u[0], ny + su * f.u[1], nz + su * f.u[2]), s2 = solid(nx + sv * f.v[0], ny + sv * f.v[1], nz + sv * f.v[2]);
                const c = solid(nx + su * f.u[0] + sv * f.v[0], ny + su * f.u[1] + sv * f.v[1], nz + su * f.u[2] + sv * f.v[2]);
                const ao = k === 2 ? 1 : AO[s1 && s2 ? 0 : 3 - (s1 + s2 + c)], l = f.shade * ao * jitter;
                buf.col.push(base[0] * l, base[1] * l, base[2] * l);
            }
            if (f.flip) buf.idx.push(start, start + 2, start + 1, start, start + 3, start + 2);
            else buf.idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
    }
    const geo = b => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
        g.setIndex(b.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        return g;
    };
    return { opaque: geo(out[0]), clear: geo(out[1]) };
}
