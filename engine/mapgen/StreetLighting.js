// Street furniture is planned along curbs, never drawn from the random cover-piece pool.
import { MAT } from '../voxel/Materials.js';
const key=(x,y)=>`${x},${y}`;
const ROAD=new Set([MAT.asphalt,MAT.road_mark]);
const DIRS=[[1,0],[0,1],[-1,0],[0,-1]];
export function planStreetLighting(store,buildings=[],{roads=[],datum=store.datum??1,spacing=12,minSpacing=8}={}) {
    const lights=[],inside=(x,y)=>buildings.some(b=>x>=b.x0&&y>=b.y0&&x<b.x0+b.w&&y<b.y0+b.d);
    const doorNear=(x,y)=>buildings.some(b=>(b.exits||b.doors||[]).some(d=>d.exterior!==false&&Math.hypot(d.x-x,d.y-y)<3));
    const clear=(x,y)=>store.inBounds(x,y,datum)&&store.isSolid(x,y,datum)&&!ROAD.has(store.get(x,y,datum))&&!inside(x,y)&&!doorNear(x,y)&&[1,2,3,4].every(h=>!store.isSolid(x,y,datum+h));
    const add=(x,y,dx,dy,route,station)=>{
        if(!clear(x,y)||lights.some(l=>Math.hypot(l.x-x,l.y-y)<minSpacing))return false;
        lights.push({kind:'streetlight',x,y,z:datum+1,yaw:Math.atan2(dx,dy),route,station,planned:true});return true;
    };
    if(roads.length) {
        for(const road of roads) {
            let distance=0,next=[spacing*.35,spacing*.85];
            for(let i=1;i<road.points.length;i++) {
                const a=road.points[i-1],b=road.points[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!len)continue;
                const tangent=[(b[0]-a[0])/len,(b[1]-a[1])/len],normal=[-tangent[1],tangent[0]];
                for(let side=0;side<2;side++)while(next[side]<=distance+len) {
                    const t=(next[side]-distance)/len,sign=side?1:-1,offset=road.width/2+1;
                    const cx=a[0]+t*(b[0]-a[0]),cy=a[1]+t*(b[1]-a[1]);
                    // Corners and junctions get a clear sight triangle. No pole at the apex or on another carriageway.
                    if(t>=0&&Math.min(next[side],road.length??Infinity)>2) {
                        const x=Math.round(cx+normal[0]*offset*sign),y=Math.round(cy+normal[1]*offset*sign);
                        add(x,y,-normal[0]*sign,-normal[1]*sign,road.id,next[side]);
                    }
                    next[side]+=spacing;
                }
                distance+=len;
            }
        }
        return lights;
    }
    // Older maps expose a road matrix rather than vector routes. Walk ordered curb runs with a common phase.
    const candidates=new Map();
    for(let y=1;y<store.depth-1;y++)for(let x=1;x<store.width-1;x++) {
        if(!clear(x,y))continue;
        const towards=DIRS.filter(([dx,dy])=>ROAD.has(store.get(x+dx,y+dy,datum)));
        if(towards.length!==1)continue;
        const [dx,dy]=towards[0];
        // At least three carriageway tiles across: exclude isolated markings and narrow drive paths.
        if(![1,2,3].every(n=>ROAD.has(store.get(x+dx*n,y+dy*n,datum))))continue;
        candidates.set(key(x,y),{x,y,dx,dy});
    }
    const seen=new Set();let route=0;
    for(const start of candidates.values()) {
        if(seen.has(key(start.x,start.y)))continue;
        const queue=[start],run=[];seen.add(key(start.x,start.y));
        for(let i=0;i<queue.length;i++){const p=queue[i];run.push(p);for(const [dx,dy] of DIRS){const k=key(p.x+dx,p.y+dy),q=candidates.get(k);if(q&&!seen.has(k)&&q.dx===p.dx&&q.dy===p.dy){seen.add(k);queue.push(q);}}}
        if(run.length<5)continue;
        run.sort((a,b)=>start.dx?a.y-b.y:a.x-b.x);
        const phase=Math.floor(spacing/3)+(route%2?Math.floor(spacing/2):0);
        for(let i=Math.min(phase,run.length-1);i<run.length;i+=spacing){const p=run[i];add(p.x,p.y,p.dx,p.dy,`curb-${route}`,i);}
        route++;
    }
    return lights;
}
export function organizeStreetLights(m,{roads=[],spacing=12}={}) {
    // Legacy hand-placed lamps and random bay lamps are replaced as one coherent network.
    const decor=m.ctx.decor;for(let i=decor.length-1;i>=0;i--)if(['streetlight','streetlight_double'].includes(decor[i].kind))decor.splice(i,1);
    const lights=planStreetLighting(m.store,m.buildings,{roads,datum:m.G,spacing});decor.push(...lights);return lights;
}
