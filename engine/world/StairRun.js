const vectors = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
export function createStairRun({ origin, direction, rise, footprintSet, reserved = new Set(), baseZ = 0 }) {
    const vector = vectors[direction];
    if (!vector || !Number.isInteger(rise) || rise < 1 || rise > 32) return null;
    const [dx, dy] = vector;
    const cells = Array.from({ length: rise }, (_, i) => ({ x: origin.x + dx * i, y: origin.y + dy * i,
        z: baseZ + i + 1, height: i + 1, role: 'stair', ascent: direction, direction, rise: 1, level: i }));
    const before = { x: origin.x - dx, y: origin.y - dy, z: baseZ };
    const after = { x: origin.x + dx * rise, y: origin.y + dy * rise, z: baseZ + rise };
    if ([before, ...cells, after].some(p => !footprintSet.has(`${p.x},${p.y}`) || reserved.has(`${p.x},${p.y}`))) return null;
    return { cells, before, after, headroom: cells.flatMap(p => [1, 2].map(h => ({ x: p.x, y: p.y, z: p.z + h }))) };
}
