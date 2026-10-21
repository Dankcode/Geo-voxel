// Signs as textured planes: shop fascias in their brand colour, street-name blades, STOP / YIELD / speed limits,
// house numbers, billboards. One canvas texture per distinct sign face.
import * as THREE from 'three';

const cache = new Map();
function face(kind, text, colour) {
    const key = `${kind}|${text}|${colour}`;
    if (cache.has(key)) return cache.get(key);
    const big = kind === 'shop' || kind === 'billboard' || kind === 'street_name';
    const c = document.createElement('canvas'); c.width = big ? 512 : 128; c.height = kind === 'street_name' ? 64 : kind === 'shop' ? 96 : big ? 256 : 128;
    const g = c.getContext('2d'), W = c.width, H = c.height;
    const fit = (t, max, weight = 700, family = 'Inter, Helvetica, Arial, sans-serif') => { let s = H * 0.62; g.font = `${weight} ${s}px ${family}`; while (g.measureText(t).width > max && s > 8) { s -= 2; g.font = `${weight} ${s}px ${family}`; } };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'shop') { g.fillStyle = colour || '#2b3a4a'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; fit(text, W * 0.9); g.fillText(text, W / 2, H / 2 + 2); }
    else if (kind === 'street_name') { g.fillStyle = '#1f6b3a'; g.fillRect(0, 0, W, H); g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(4, 4, W - 8, H - 8); g.fillStyle = '#fff'; fit(text, W * 0.88, 600); g.fillText(text, W / 2, H / 2 + 2); }
    else if (kind === 'stop') { g.fillStyle = '#b8231b'; g.beginPath(); for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; g.lineTo(W / 2 + Math.cos(a) * W * 0.48, H / 2 + Math.sin(a) * H * 0.48); } g.fill(); g.fillStyle = '#fff'; g.font = `800 ${H * 0.3}px Inter, Arial`; g.fillText('STOP', W / 2, H / 2 + 2); }
    else if (kind === 'yield') { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(4, 8); g.lineTo(W - 4, 8); g.lineTo(W / 2, H - 6); g.fill(); g.strokeStyle = '#b8231b'; g.lineWidth = 14; g.stroke(); g.fillStyle = '#b8231b'; g.font = `800 ${H * 0.16}px Inter, Arial`; g.fillText('YIELD', W / 2, H * 0.36); }
    else if (kind === 'speed') { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.strokeStyle = '#111'; g.lineWidth = 5; g.strokeRect(6, 6, W - 12, H - 12); g.fillStyle = '#111'; g.font = `700 ${H * 0.13}px Inter, Arial`; g.fillText('SPEED', W / 2, H * 0.2); g.fillText('LIMIT', W / 2, H * 0.36); g.font = `800 ${H * 0.42}px Inter, Arial`; g.fillText(text, W / 2, H * 0.7); }
    else if (kind === 'house_number') { g.fillStyle = '#1d2a3a'; g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; fit(text, W * 0.85); g.fillText(text, W / 2, H / 2 + 2); }
    else { g.fillStyle = kind === 'billboard' ? '#20262e' : '#f2f2ee'; g.fillRect(0, 0, W, H); g.fillStyle = kind === 'billboard' ? '#f5c36a' : '#111'; fit(text, W * 0.88); g.fillText(text, W / 2, H / 2); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    cache.set(key, tex);
    return tex;
}

/** signs (cell coordinates) → THREE.Group. cut: hide signs above it. */
export function buildSigns(signs, { cut = Infinity } = {}) {
    const group = new THREE.Group(), post = new THREE.MeshStandardMaterial({ color: 0x5b6168, roughness: 0.6 });
    for (const s of signs || []) {
        if (s.z > cut + 1) continue;
        const pole = ['stop', 'yield', 'speed', 'traffic', 'street_name', 'billboard'].includes(s.kind);
        const top = pole ? (s.kind === 'street_name' ? 2.9 : s.kind === 'billboard' ? 3.2 : 2.1) : 0;
        const holder = new THREE.Group(); holder.position.set(s.x, s.z, s.y); const [fx, fy] = s.facing || [0, 1]; holder.rotation.y = Math.atan2(fx, fy);
        if (pole) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, top, 6), post); p.position.y = top / 2; p.castShadow = true; holder.add(p); }
        const planes = s.kind === 'street_name' && s.lines?.length === 2 ? [[s.lines[0], 0, 0], [s.lines[1], Math.PI / 2, 0.32]] : [[s.text, 0, 0]];
        for (const [text, rot, dy] of planes) {
            const mat = new THREE.MeshStandardMaterial({ map: face(s.kind, text, s.colour), roughness: 0.55, side: THREE.DoubleSide, emissive: s.kind === 'shop' ? 0x222222 : 0, emissiveMap: s.kind === 'shop' ? face(s.kind, text, s.colour) : null });
            const m = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
            m.position.y = pole ? top + s.h / 2 - 0.05 - dy : 0; m.rotation.y = rot; m.castShadow = true;
            holder.add(m);
        }
        group.add(holder);
    }
    return group;
}
