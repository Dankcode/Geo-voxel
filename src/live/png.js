// Minimal PNG decoder (8-bit greyscale / RGB / RGBA / palette, non-interlaced) for terrain tiles where no image API
// exists (Node). `inflate(bytes) → bytes` is passed in: zlib.inflateSync in Node, DecompressionStream in a worker.
export async function decodePNG(bytes, inflate) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 8, w = 0, h = 0, depth = 0, type = 0, palette = null; const idat = [];
    while (at < b.length) {
        const len = dv.getUint32(at), kind = String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), data = b.subarray(at + 8, at + 8 + len);
        if (kind === 'IHDR') { w = dv.getUint32(at + 8); h = dv.getUint32(at + 12); depth = b[at + 16]; type = b[at + 17]; if (b[at + 20]) throw Error('png: interlaced'); }
        else if (kind === 'PLTE') palette = data;
        else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        at += 12 + len;
    }
    if (depth !== 8) throw Error(`png: bit depth ${depth}`);
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type], stride = w * ch;
    const z = new Uint8Array(idat.reduce((a, d) => a + d.length, 0)); let o = 0; for (const d of idat) { z.set(d, o); o += d.length; }
    const raw = await inflate(z), px = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride, prev = row - stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= ch ? px[row + i - ch] : 0, up = y ? px[prev + i] : 0, c = y && i >= ch ? px[prev + i - ch] : 0;
            let v = src[i];
            if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
            else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
            px[row + i] = v & 255;
        }
    }
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        if (type === 3) { const k = px[i] * 3; rgba.set([palette[k], palette[k + 1], palette[k + 2], 255], i * 4); }
        else if (ch >= 3) { rgba[i * 4] = px[i * ch]; rgba[i * 4 + 1] = px[i * ch + 1]; rgba[i * 4 + 2] = px[i * ch + 2]; rgba[i * 4 + 3] = ch === 4 ? px[i * ch + 3] : 255; }
        else { const g = px[i * ch]; rgba.set([g, g, g, 255], i * 4); }
    }
    return { width: w, height: h, data: rgba };
}
