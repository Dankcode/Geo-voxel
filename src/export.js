// Exporters: MagicaVoxel .vox (opens in MagicaVoxel, Blender via add-ons, Godot/Unity/Unreal importers) and a PNG
// review slate (top material × hill shade). No dependencies beyond node:zlib.
import { deflateSync } from 'node:zlib';
import { PALETTE } from './grid.js';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const chunk = (id, content, children = Buffer.alloc(0)) => Buffer.concat([Buffer.from(id, 'ascii'), u32(content.length), u32(children.length), content, children]);

/** MagicaVoxel .vox of the grid (each dimension ≤ 256; z up, north = +y). */
export function toVox(grid) {
    const { width: W, depth: D, height: H } = grid;
    if (W > 256 || D > 256 || H > 256) throw Error(`vox: ${W}×${D}×${H} exceeds MagicaVoxel's 256 per axis`);
    const xyz = [];
    for (let z = 0; z < H; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) { const m = grid.get(x, y, z); if (m) xyz.push(x, D - 1 - y, z, m); }
    const size = Buffer.concat([u32(W), u32(D), u32(H)]);
    const vox = Buffer.concat([u32(xyz.length / 4), Buffer.from(xyz)]);
    const rgba = Buffer.alloc(256 * 4);
    PALETTE.forEach(([, c], i) => { if (i) { rgba[(i - 1) * 4] = c[0]; rgba[(i - 1) * 4 + 1] = c[1]; rgba[(i - 1) * 4 + 2] = c[2]; rgba[(i - 1) * 4 + 3] = 255; } });
    const children = Buffer.concat([chunk('SIZE', size), chunk('XYZI', vox), chunk('RGBA', rgba)]);
    return Buffer.concat([Buffer.from('VOX ', 'ascii'), u32(150), chunk('MAIN', Buffer.alloc(0), children)]);
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };

/** PNG review slate: top material colour × hill shade, `scale` pixels per cell. */
export function toSlatePNG(grid, { scale = 4 } = {}) {
    const { width: W, depth: D } = grid, PW = W * scale, PH = D * scale;
    const top = (x, y) => grid.top(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(D - 1, y)));
    const raw = Buffer.alloc((PW * 3 + 1) * PH);
    for (let py = 0; py < PH; py++) {
        raw[py * (PW * 3 + 1)] = 0;
        for (let px = 0; px < PW; px++) {
            const x = Math.floor(px / scale), y = Math.floor(py / scale), z = top(x, y), c = PALETTE[grid.get(x, y, z)]?.[1] || [170, 160, 150];
            const shade = Math.max(0.55, Math.min(1.25, 1 + 0.12 * (top(x - 1, y - 1) - top(x + 1, y + 1)))), lift = 0.85 + 0.15 * Math.min(1, (z - 1) / 14);
            for (let k = 0; k < 3; k++) raw[py * (PW * 3 + 1) + 1 + px * 3 + k] = Math.max(0, Math.min(255, Math.round(c[k] * shade * lift)));
        }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(PW, 0); ihdr.writeUInt32BE(PH, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
