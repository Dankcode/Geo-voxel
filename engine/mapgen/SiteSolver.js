import { smoothRoad } from './RoadGeometry.js';
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
const overlap = (a,b) => Math.max(0,Math.min(a.x0+a.w,b.x0+b.w)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y0+a.d,b.y0+b.d)-Math.max(a.y0,b.y0));
export const footprintIoU = (a,b) => {const n=overlap(a,b);return n/(a.w*a.d+b.w*b.d-n);};

export function solveSite(site,seed=1) {
    const frame=site.frame || {width:48,height:40};
    if (![frame.width,frame.height].every(n=>Number.isFinite(n)&&n>0)) throw Error('site.frame: positive source extents required');
    const margin=3, maxDimension=site.maxDimension??64, limit=maxDimension-2*margin, repairs=[];
    if(!Number.isInteger(maxDimension)||maxDimension<64||maxDimension>192)throw Error("site.size: maxDimension must be 64–192");
    // Grow the whole site, never an individual building, when small footprints need more resolution.
    const required=Math.max(...site.buildings.map(b=>Math.max(11/((b.bounds[2]-b.bounds[0])*frame.width),11/((b.bounds[3]-b.bounds[1])*frame.height))));
    const scale=Math.min(Math.max(1,required),limit/Math.max(frame.width,frame.height));
    if(required>1) repairs.push({kind:'uniform-upscale',required,applied:scale});
    const width=Math.ceil(frame.width*scale)+margin*2,depth=Math.ceil(frame.height*scale)+margin*2;
    const point=p=>[margin+Math.round(p[0]*frame.width*scale),margin+Math.round(p[1]*frame.height*scale)];
    const rect=b=>{const [x0,y0]=point(b.slice(0,2)),[x1,y1]=point(b.slice(2));return{x0,y0,w:x1-x0+1,d:y1-y0+1};};
    const buildings=site.buildings.map(b=>({...b,...rect(b.bounds),storeys:Math.max(1,Math.min(4,Math.round(b.storeys || 1)))}));
    const reference=buildings.map(b=>({id:b.id,x0:b.x0,y0:b.y0,w:b.w,d:b.d,storeys:b.storeys}));
    for(const b of buildings) {
        if(b.w<11||b.d<11) {
            const old={...b};b.w=Math.max(11,b.w);b.d=Math.max(11,b.d);b.x0=Math.max(2,old.x0-Math.floor((b.w-old.w)/2));b.y0=Math.max(2,old.y0-Math.floor((b.d-old.d)/2));
            repairs.push({kind:'minimum-footprint',id:b.id,before:[old.w,old.d],after:[b.w,b.d]});
        }
    }
    // Split small contacts by trimming the larger parcel; preserve the source footprint audit.
    for(let tries=0;tries<16;tries++) {
        let changed=false;
        for(let i=0;i<buildings.length;i++)for(let j=i+1;j<buildings.length;j++) {
            const a=buildings[i],b=buildings[j];if(!overlap(a,b))continue;
            const dx=Math.min(a.x0+a.w,b.x0+b.w)-Math.max(a.x0,b.x0),dy=Math.min(a.y0+a.d,b.y0+b.d)-Math.max(a.y0,b.y0);
            const trim=a.w*a.d>=b.w*b.d?a:b,other=trim===a?b:a;
            if(dx<=dy && trim.w-dx>=11){if(trim.x0<other.x0)trim.w=other.x0-trim.x0;else {trim.x0+=dx;trim.w-=dx;}}
            else if(trim.d-dy>=11){if(trim.y0<other.y0)trim.d=other.y0-trim.y0;else {trim.y0+=dy;trim.d-=dy;}}
            else throw Error(`site.contact: cannot repair ${a.id}/${b.id} within minimum floor dimensions`);
            repairs.push({kind:'split-contact',ids:[a.id,b.id],trimmed:trim.id});changed=true;
        }
        if(!changed)break;
    }
    const congruence=buildings.map(b=>({id:b.id,iou:footprintIoU(reference.find(r=>r.id===b.id),b),storeys:b.storeys}));
    for(const b of buildings)if(b.x0+b.w>width-1||b.y0+b.d>depth-1)throw Error(`site.bounds: repaired ${b.id} exceeds grid budget`);
    if(congruence.some(c=>c.iou<0.85))throw Error(`site.congruence: repair cannot preserve footprint IoU >= 0.85 (${congruence.map(c=>`${c.id}:${c.iou.toFixed(3)}`).join(', ')})`);
    const surfaces=(site.surfaces || []).map(s=>({...rect(s.bounds),material:s.material}));
    const roads=(site.roads||[]).map(r=>({id:r.id,role:r.role||"street",width:r.width*scale,points:smoothRoad(r.points.map(point))}));
    const parking=(site.parking||[]).map(p=>({...p,...rect(p.bounds)}));
    const pw=Math.ceil(width/4),pd=Math.ceil(depth/4),nodes=[],fixed=new Map();
    for(let y=0;y<pd;y++)for(let x=0;x<pw;x++) {
        const id=`${x},${y}`,cx=x*4+2,cy=y*4+2;
        nodes.push({id,neighbors:[[x-1,y],[x+1,y],[x,y-1],[x,y+1]].filter(([a,b])=>a>=0&&b>=0&&a<pw&&b<pd).map(([a,b])=>({id:`${a},${b}`}))});
        if(buildings.some(b=>cx>=b.x0&&cy>=b.y0&&cx<b.x0+b.w&&cy<b.y0+b.d))fixed.set(id,'building');
        else if(surfaces.some(s=>s.material==='asphalt'&&cx>=s.x0&&cy>=s.y0&&cx<s.x0+s.w&&cy<s.y0+s.d))fixed.set(id,'street');
    }
    const assignment=new Map(nodes.map(n=>[n.id,fixed.get(n.id)||'sidewalk']));
    return {version:2,datum:4,id:site.id,width,depth,height:18,transform:{scale,margin,frame},boundary:site.playableBoundary?.map(point),buildings,surfaces,roads,parking,flow:[site.insertion,...site.flow].map(point),reference,congruence,repairs,parcels:[...assignment].map(([id,kind])=>({id,kind}))};
}
