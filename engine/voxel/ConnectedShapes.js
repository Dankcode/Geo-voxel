// Shared connection geometry for rendering, ray hits and cover. Coordinates are local XY in [0,1].
// Only face neighbours join; diagonal proximity never invents a wall across a walkable gap.
import { materialById } from './Materials.js';
export const WALL_THICKNESS = 0.4;
export const WALL_KEYS = new Set(['stone', 'plaster', 'timber', 'stucco', 'brick', 'concrete_wall', 'siding']);
const OPENINGS = new Set(['glass', 'door', 'door_open', 'door_locked', 'lantern']);
export const CONNECTION_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E S W N
const keyAt = (s, x, y, z) => materialById(s.get(x, y, z)).key;
export const wallLike = key => WALL_KEYS.has(key) || OPENINGS.has(key);
export function wallMask(store, x, y, z) {
    return CONNECTION_DIRS.reduce((mask, [dx, dy], i) => mask | (wallLike(keyAt(store, x + dx, y + dy, z)) ? 1 << i : 0), 0);
}

// Round only real exposed corners. Endpoints on a joined cell edge must remain exact, preventing seams.
export function roundPolygon(points, radius = 0.12, steps = 5, eligible = () => true) {
    const out = [];
    points.forEach((p, i) => {
        const prev = points[(i + points.length - 1) % points.length], next = points[(i + 1) % points.length];
        const a = Math.hypot(prev[0] - p[0], prev[1] - p[1]), b = Math.hypot(next[0] - p[0], next[1] - p[1]);
        const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
        if (Math.abs(cross) < 1e-8 || !eligible(p, i)) { out.push(p); return; }
        const r = Math.min(radius, a * 0.45, b * 0.45);
        const start = [p[0] + (prev[0] - p[0]) * r / a, p[1] + (prev[1] - p[1]) * r / a];
        const end = [p[0] + (next[0] - p[0]) * r / b, p[1] + (next[1] - p[1]) * r / b];
        for (let j = 0; j <= steps; j++) {
            const t = j / steps, u = 1 - t;
            out.push([u*u*start[0] + 2*u*t*p[0] + t*t*end[0], u*u*start[1] + 2*u*t*p[1] + t*t*end[1]]);
        }
    });
    return out;
}
const wallCache = new Map();
export const CURVED_WALL_MASKS = new Set([3,6,12,9]);
const curveCache=new Map();
/** A quarter-circle bend tangent to the adjoining tile runs, just like exposed terrain corners. */
export function curvedCornerFootprint(mask, thickness=WALL_THICKNESS, steps=12) {
    if(!CURVED_WALL_MASKS.has(mask))return null;
    const key=`${mask}|${thickness}|${steps}`;if(curveCache.has(key))return curveCache.get(key);
    const points=[],outer=.5+thickness/2,inner=.5-thickness/2;
    for(let i=0;i<=steps;i++){const a=Math.PI+i/steps*Math.PI/2;points.push([1+outer*Math.cos(a),1+outer*Math.sin(a)]);}
    for(let i=steps;i>=0;i--){const a=Math.PI+i/steps*Math.PI/2;points.push([1+inner*Math.cos(a),1+inner*Math.sin(a)]);}
    const turns={3:0,6:1,12:2,9:3}[mask];
    const poly=points.map(([x,y])=>{for(let i=0;i<turns;i++)[x,y]=[1-y,x];return [Math.max(0,Math.min(1,x)),Math.max(0,Math.min(1,y))];});
    curveCache.set(key,poly);return poly;
}
/** Wall silhouette for a connection mask. rounded (modern): curved L corners and softened ends; false (old): square. */
export function wallFootprint(mask,rounded=true) { return rounded?curvedCornerFootprint(mask)||bandFootprint(mask, WALL_THICKNESS, 0.12):bandFootprint(mask, WALL_THICKNESS, 0); }

/**
 * Grouped cover (hedges, planters, sandbags, barriers, field walls, fences) uses the same post-and-arm silhouette as
 * walls, at its own thickness: a lone piece is a rounded post, neighbours of the same family join into one run, and
 * corners, T-junctions and crossings round only their outside corners.
 */
export const BANDS = {
    steel_post:{thickness:.15,radius:.02,family:new Set(['steel_post'])},
    railing: { thickness:0.08,radius:0.03,family:new Set(['railing']) },
    hedge: { thickness: 0.86, radius: 0.3, family: new Set(['hedge']) },
    planter: { thickness: 0.8, radius: 0.16, family: new Set(['planter']) },
    sandbag: { thickness: 0.62, radius: 0.22, family: new Set(['sandbag']) },
    drystone: { thickness: 0.62, radius: 0.18, family: new Set(['drystone']) },
    jersey: { thickness: 0.62, radius: 0.12, family: new Set(['jersey']) },
    privacy_fence: { thickness: 0.14, radius: 0.05, family: new Set(['privacy_fence']) },
    fence: { thickness: 0.14, radius: 0.05, family: new Set(['fence']) },
    chainlink: { thickness: 0.08, radius: 0.03, family: new Set(['chainlink']) }
};
export function bandMask(store, x, y, z, family) {
    return CONNECTION_DIRS.reduce((mask, [dx, dy], i) => mask | (family.has(keyAt(store, x + dx, y + dy, z)) ? 1 << i : 0), 0);
}
export function bandFootprint(mask, thickness, radius = 0.12) {
    const cacheKey = `${mask}|${thickness}|${radius}`;
    if (wallCache.has(cacheKey)) return wallCache.get(cacheKey);
    const a = (1 - thickness) / 2, b = 1 - a, v = [0, a, b, 1];
    const occupied = (x, y) => x === 1 && y === 1 || y === 1 && (x === 2 && (mask & 1) || x === 0 && (mask & 4)) || x === 1 && (y === 2 && (mask & 2) || y === 0 && (mask & 8));
    const edges = new Map();
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        if (!occupied(x, y)) continue;
        const cs = [[v[x],v[y]], [v[x+1],v[y]], [v[x+1],v[y+1]], [v[x],v[y+1]]];
        [[0,-1],[1,0],[0,1],[-1,0]].forEach(([dx,dy], i) => {
            if (occupied(x+dx,y+dy)) return;
            const p=cs[i], q=cs[(i+1)%4]; edges.set(p.join(','), q);
        });
    }
    const start = edges.keys().next().value, points = [];
    let k = start;
    do { points.push(k.split(',').map(Number)); k = edges.get(k).join(','); } while (k !== start);
    // Remove collinear vertices so rounding doesn't vary with the little construction grid.
    const simple = points.filter((p, i) => {
        const a=points[(i+points.length-1)%points.length], b=points[(i+1)%points.length];
        return Math.abs((p[0]-a[0])*(b[1]-p[1])-(p[1]-a[1])*(b[0]-p[0])) > 1e-8;
    });
    const poly = roundPolygon(simple, radius, 5, p => p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1);
    wallCache.set(cacheKey, poly); return poly;
}
export function openingAxis(store, x, y, z) {
    for (const dz of [0, -1, 1]) {
        const mask = wallMask(store, x, y, z + dz);
        if (mask & 5) return 'x';
        if (mask & 10) return 'y';
    }
    return 'x';
}
/** null means an ordinary full voxel. Movement continues to reserve wall cells, including their thin margins. */
export function collisionFootprint(store, x, y, z) {
    const key = keyAt(store, x, y, z);
    if (key === 'ice' || key === 'deep_ice') return liquidFootprint(store,x,y,z);
    const band = BANDS[key];
    if (band) return bandFootprint(bandMask(store, x, y, z, band.family), band.thickness, band.radius);
    if (WALL_KEYS.has(key)) return wallFootprint(wallMask(store, x, y, z),!store.squareCorners?.has(`${x},${y}`));
    if (key === 'glass' || key === 'door' || key === 'door_locked') {
        const t = key === 'glass' ? 0.035 : 0.08, a = (1-t)/2, b=1-a;
        if(key==='glass'&&!store.squareCorners?.has(`${x},${y}`)){const curve=curvedCornerFootprint(wallMask(store,x,y,z),t);if(curve)return curve;}
        return openingAxis(store,x,y,z) === 'x' ? [[0,a],[1,a],[1,b],[0,b]] : [[a,0],[b,0],[b,1],[a,1]];
    }
    return null;
}
export function containsPoint(poly, x, y) {
    let inside = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
        const a=poly[i], b=poly[j];
        if ((a[1]>y)!==(b[1]>y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
    }
    return inside;
}
/** Ray/prism intersection restricted to this DDA cell interval. Returns distance and voxel-space normal. */
export function intersectCellShape(store, x, y, z, origin, dir, enter, exit) {
    const poly = collisionFootprint(store,x,y,z);
    if (!poly) return { t: enter, normal: null };
    const px = origin[0]-x, py=origin[1]-y;
    const at = t => containsPoint(poly,px+dir[0]*t,py+dir[1]*t);
    if (at(enter+1e-7)) return { t: enter, normal: null };
    let best = null;
    for (let i=0;i<poly.length;i++) {
        const a=poly[i], b=poly[(i+1)%poly.length], ex=b[0]-a[0], ey=b[1]-a[1];
        const det=dir[0]*ey-dir[1]*ex;
        if (Math.abs(det)<1e-10) continue;
        const ax=a[0]-px, ay=a[1]-py;
        const t=(ax*ey-ay*ex)/det, u=(ax*dir[1]-ay*dir[0])/det;
        if (t<enter-1e-8 || t>exit+1e-8 || u<0 || u>1 || !at(t+1e-7)) continue;
        if (!best || t<best.t) { const l=Math.hypot(ex,ey); best={t,normal:[ey/l,-ex/l,0]}; }
    }
    return best;
}

/** Water/ice join into one body. Only outside corners round; shared edges remain full width. */
export function liquidFootprint(store, x, y, z) {
    const key=keyAt(store,x,y,z), family = key === 'lava' ? new Set(['lava']) : new Set(['water','deep_water','ice','deep_ice']);
    const joined=(dx,dy)=>family.has(keyAt(store,x+dx,y+dy,z));
    const corners=[[-1,-1],[1,-1],[1,1],[-1,1]];
    return roundPolygon([[0,0],[1,0],[1,1],[0,1]],0.28,6,(_,i)=>!joined(corners[i][0],0)&&!joined(0,corners[i][1]));
}
