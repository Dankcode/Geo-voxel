import { finishConnectionParcel } from './ConnectingParcels.js';
import { MAT } from '../voxel/Materials.js';
/** Carve the shared voxel matrix; every socket gets real headroom, floors and an ascent. */
export function compileUnderground(m,layers) {
 if(!layers)return null;
 const s=m.store,cells=new Map(),k=(x,y)=>`${x},${y}`;
 for(const p of layers.route)for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if(s.inBounds(p.x+dx,p.y+dy,1))cells.set(k(p.x+dx,p.y+dy),{x:p.x+dx,y:p.y+dy,z:1});
 for(const p of cells.values()){s.set(p.x,p.y,1,MAT.concrete);s.set(p.x,p.y,2,0);s.set(p.x,p.y,3,0);m.reserve(p.x,p.y,p.x,p.y);}
 if(layers.kind==='storm-drain')for(const p of layers.route)s.set(p.x,p.y,1,MAT.water);
 const openings=[],connectionParcels=[];
 for(const e of layers.entrances) {
  if(e.kind==='manhole') {
   // Backing wall stays solid at every rung and its top is a real street ledge.
   const x=e.x,y=e.y;s.set(x+1,y,2,MAT.concrete);s.set(x+1,y,3,MAT.concrete);
   for(let z=2;z<=4;z++)s.set(x,y,z,MAT.ladder);
   openings.push({from:{x:x+1,y,z:4},to:{x,y,z:1},kind:'climb'});
   connectionParcels.push(finishConnectionParcel(m,e,[1,0],connectionParcels.length));
  }else {
   const candidates=[[0,-1],[-1,0],[1,0],[0,1]];
   const d=e.dir||candidates.find(([dx,dy])=>Array.from({length:4},(_,i)=>({x:e.x+dx*(i+1),y:e.y+dy*(i+1)})).every(p=>s.inBounds(p.x,p.y,4)&&!m.buildings.some(b=>p.x>=b.x0&&p.x<b.x0+b.w&&p.y>=b.y0&&p.y<b.y0+b.d)));
   if(!d)throw Error('layer.socket: stairs entrance has no street apron');
   for(let i=0;i<4;i++){const x=e.x+d[0]*i,y=e.y+d[1]*i,z=1+i;for(let h=2;h<=6;h++)s.set(x,y,h,0);for(let h=2;h<z;h++)s.set(x,y,h,MAT.stairs_stone);s.set(x,y,z,i?MAT.stairs_stone:MAT.concrete);cells.set(k(x,y),{x,y,z});m.reserve(x-1,y-1,x+1,y+1);}
   openings.push({from:{x:e.x+d[0]*3,y:e.y+d[1]*3,z:4},to:{x:e.x,y:e.y,z:1},kind:'stairs'});
   connectionParcels.push(finishConnectionParcel(m,e,d,connectionParcels.length));
  }
  m.reserve(e.x-2,e.y-2,e.x+2,e.y+2);
 }
 const p=layers.drop||layers.route[Math.floor(layers.route.length/2)];
 if(layers.drop&&layers.allowStreetDrop===true){s.set(p.x,p.y,4,0);s.set(p.x+1,p.y,4,MAT.grate);m.reserve(p.x-2,p.y-2,p.x+2,p.y+2);
 openings.push({from:{x:p.x+1,y:p.y,z:4},to:{x:p.x,y:p.y,z:1},kind:'jump'});}
 // A small raised bridge crosses the open underpass. Parallel steps leave the tunnel intact.
 if(layers.bridge) {
  for(let i=-3;i<=3;i++){const x=p.x+i,y=p.y+1,z=7-Math.max(0,Math.abs(i)-1);if(Math.abs(i)>=1)s.set(x,y,z-1,MAT.steel_post);s.set(x,y,z,Math.abs(i)>1?MAT.steel_stair:MAT.grate);m.reserve(x-1,y-1,x+1,y+1);}
  for(const dx of [-4,4])s.set(p.x+dx,p.y+1,4,MAT.concrete);
 }
 // Staggered tunnel baffles force a bend and hide most of the flank from its guarding pod.
 const baffles=layers.baffles||[.3,.6];
 // A baffle never seals the tunnel: it keeps clear of both ends and of turns, and is skipped if the walk from the
 // stairs to the manhole would no longer connect (checked on the tunnel floor).
 const walled=new Set(),route=layers.route;
 // Every open tunnel cell (not just the far end) must stay reachable from the stairs: a baffle may not cut off a pocket.
 const connected=()=>{const start=route[0],open=[...cells.keys()].filter(kk=>!walled.has(kk)&&!s.isSolid(...kk.split(',').map(Number),2)),seen=new Set([k(start.x,start.y)]),q=[start];
  for(let n=0;n<q.length;n++){const c=q[n];for(const [ax,ay] of [[1,0],[-1,0],[0,1],[0,-1]]){const kk=k(c.x+ax,c.y+ay);if(!seen.has(kk)&&cells.has(kk)&&!walled.has(kk)&&!s.isSolid(c.x+ax,c.y+ay,2)){seen.add(kk);q.push({x:c.x+ax,y:c.y+ay});}}}
  return open.every(kk=>seen.has(kk));};
 for(const [index,fraction] of baffles.entries()) {
  const at=Math.floor(route.length*fraction);
  // The nearest straight stretch (within four cells of the intended spot) takes the baffle.
  for(const di of [0,1,-1,2,-2,3,-3,4,-4]) {
   const i=at+di;
   if(i<3||i>route.length-4)continue;
   const p=route[i],next=route[i+1],prev=route[i-1];
   if((next.x-p.x)!==(p.x-prev.x)||(next.y-p.y)!==(p.y-prev.y))continue;
   const dx=next.y!==p.y?1:0,dy=dx?0:1,wall=(index%2===0?[-1,0]:[0,1]).map(o=>k(p.x+dx*o,p.y+dy*o));
   // …nor lands on the street drop's landing column (the jump would hit the wall).
   if(wall.some(w=>walled.has(w))||(layers.drop&&wall.includes(k(layers.drop.x,layers.drop.y))))continue;
   for(const w of wall)walled.add(w);
   if(!connected()){for(const w of wall)walled.delete(w);continue;}
   for(const w of wall){const [x,y]=w.split(',').map(Number);for(let z=2;z<=3;z++)s.set(x,y,z,MAT.concrete_wall);}
   break;
  }
 }
 const guard=layers.route[Math.min(layers.route.length-1,Math.max(4,layers.guardAt??Math.floor(layers.route.length*.75)))];
 let lastLight=-6,lights=0;
 for(let i=3;i<layers.route.length-3;i++) {
  if(i-lastLight<6||baffles.some(f=>Math.abs(i-Math.floor(layers.route.length*f))<2))continue;
  const p=layers.route[i],next=layers.route[i+1],dx=next.y!==p.y?-1:0,dy=dx?0:-1;
  const sides=[[dx*2,dy*2],[-dx*2,-dy*2]],side=sides.find(([ax,ay])=>!cells.has(k(p.x+ax,p.y+ay))&&s.inBounds(p.x+ax,p.y+ay,3));if(!side)continue;
  s.set(p.x+side[0],p.y+side[1],3,lights++%2===0?MAT.emergency_light:MAT.lantern);lastLight=i;
 }
 // A short, heavily baffled tunnel still gets one emergency light at its first straight cell.
 for(let i=1;!lights&&i<layers.route.length-1;i++) {
  const p=layers.route[i],next=layers.route[i+1],dx=next.y!==p.y?-1:0,dy=dx?0:-1;
  const side=[[dx*2,dy*2],[-dx*2,-dy*2]].find(([ax,ay])=>!cells.has(k(p.x+ax,p.y+ay))&&s.inBounds(p.x+ax,p.y+ay,3));
  if(side){s.set(p.x+side[0],p.y+side[1],3,MAT.emergency_light);lights++;}
 }
 return {cells:[...cells.values()].filter(p=>s.surfaces(p.x,p.y).some(q=>q.z===p.z&&q.headroom>=2)),openings,route:layers.route.map(p=>({...p,z:1})),guard:{...guard,z:1},kind:layers.kind,connectionParcels};
}
