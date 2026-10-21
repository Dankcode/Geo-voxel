// Decor (the engine's visual-only props: street lights, signals, awnings, furniture …) as simple instanced shapes.
// An engine with its own prop library replaces this with its models; `kind` is the key.
import * as THREE from 'three';

// kind → [width, depth, height, colour, lift (height of the base above the floor), emissive]
const SHAPES = {
    streetlight: [0.16, 0.16, 4.6, 0x3a3f45], traffic_signal: [0.22, 0.22, 4.2, 0x2b2f33], stop_sign: [0.5, 0.08, 2.4, 0xb3261e],
    street_sign: [0.6, 0.08, 2.6, 0x2f7d4a], utility_pole: [0.26, 0.26, 6.2, 0x6b5440], bus_stop: [2.2, 0.9, 2.4, 0x55606a],
    storefront_awning: [1, 0.8, 0.18, 0x8a2f2a, 2.6], shopping_cart: [0.55, 0.38, 0.55, 0x9aa2aa], rooftop_vent: [0.9, 0.9, 0.7, 0x8a8f94],
    cable_spool: [0.8, 0.8, 0.6, 0x7a5a3a], hydrant: [0.3, 0.3, 0.7, 0xc23b22], bench: [1.4, 0.5, 0.5, 0x6b4f37],
    plant: [0.45, 0.45, 0.6, 0x4e8a3e], plant_tall: [0.5, 0.5, 1.4, 0x3f7a34], rug: [1, 1, 0.03, 0x7d3b3b], floor_lamp: [0.25, 0.25, 1.5, 0xd9cfa8],
    wall_art: [0.7, 0.06, 0.5, 0x6d5a8a, 1.2], office_chair: [0.5, 0.5, 0.9, 0x2a2d31], monitor: [0.5, 0.15, 0.35, 0x111316, 0.8],
    register: [0.45, 0.35, 0.3, 0x2d3034, 0.9], coffee_table: [0.9, 0.5, 0.4, 0x6e4e36], cafe_table: [0.7, 0.7, 0.75, 0x6e4e36], stool: [0.35, 0.35, 0.65, 0x4a4f55],
    nightstand: [0.45, 0.4, 0.55, 0x6e4e36], tv: [0.9, 0.1, 0.55, 0x0e0f11, 0.6]
};
const LIGHT_HEAD = { streetlight: [0.7, 0.3, 0.12, 0xffd58a], traffic_signal: [0.3, 0.3, 0.9, 0xd94a2a] };

/** decor [{ kind, x, y, z, yaw, w, d }] → THREE.Group of instanced meshes (cut: hide props in cells above it). */
export function buildProps(decor, { cut = Infinity } = {}) {
    const group = new THREE.Group(), byKind = new Map();
    for (const d of decor) { if (d.z > cut) continue; if (!byKind.has(d.kind)) byKind.set(d.kind, []); byKind.get(d.kind).push(d); }
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const add = (list, [w, dd, h, color, lift = 0, glow = false], scaleFrom, headOf = null) => {
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...(glow ? { emissive: color, emissiveIntensity: 2.2 } : {}) });
        const mesh = new THREE.InstancedMesh(box, mat, list.length);
        list.forEach((d, i) => {
            q.setFromAxisAngle(up, -(d.yaw || 0));
            const sx = scaleFrom && d.w ? d.w : w, sz = scaleFrom && d.d ? d.d : dd;
            const y = d.z + lift + (headOf ? headOf : 0);
            m4.compose(new THREE.Vector3(d.x + 0.5, y, d.y + 0.5), q, new THREE.Vector3(sx, h, sz));
            mesh.setMatrixAt(i, m4);
        });
        mesh.castShadow = !glow; mesh.receiveShadow = true;
        group.add(mesh);
    };
    for (const [kind, list] of byKind) {
        const s = SHAPES[kind] || [0.5, 0.5, 0.5, 0x777c82];
        add(list, s, kind === 'rug' || kind === 'storefront_awning');
        if (LIGHT_HEAD[kind]) { const [w, d, h, c] = LIGHT_HEAD[kind]; add(list, [w, d, h, c, 0, true], false, s[2] - h); }
    }
    return group;
}
export const LIGHT_KINDS = ['streetlight'];
