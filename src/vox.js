// MagicaVoxel .vox writer — pure (Uint8Array, no Node APIs), so the CLI and the browser app share it.
// Opens in MagicaVoxel, Blender (vox importer add-ons), Godot/Unity/Unreal importers. Each axis ≤ 256.
import { PALETTE } from './grid.js';

const enc = new TextEncoder();
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const cat = parts => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const chunk = (id, content, children = new Uint8Array(0)) => cat([enc.encode(id), u32(content.length), u32(children.length), content, children]);

/** grid: { width, depth, height, get(x, y, z), palette? } (x east, y south, z up) → .vox bytes (north = +y in MagicaVoxel). */
export function toVox(grid) {
    const { width: W, depth: D, height: H } = grid, palette = grid.palette || PALETTE;
    if (W > 256 || D > 256 || H > 256) throw Error(`vox: ${W}×${D}×${H} exceeds MagicaVoxel's 256 per axis`);
    if (palette.length > 256) throw Error('vox: more than 255 materials');
    let n = 0;
    for (let i = 0; i < grid.data.length; i++) if (grid.data[i]) n++;
    const xyz = new Uint8Array(4 + n * 4); new DataView(xyz.buffer).setUint32(0, n, true);
    let at = 4;
    for (let z = 0; z < H; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
        const m = grid.data[(z * D + y) * W + x];
        if (m) { xyz[at++] = x; xyz[at++] = D - 1 - y; xyz[at++] = z; xyz[at++] = m; }
    }
    const rgba = new Uint8Array(256 * 4);
    palette.forEach(([, c], i) => { if (i) { rgba.set([c[0], c[1], c[2], 255], (i - 1) * 4); } });
    const children = cat([chunk('SIZE', cat([u32(W), u32(D), u32(H)])), chunk('XYZI', xyz), chunk('RGBA', rgba)]);
    return cat([enc.encode('VOX '), u32(150), chunk('MAIN', new Uint8Array(0), children)]);
}
