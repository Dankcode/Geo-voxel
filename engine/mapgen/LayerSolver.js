import { connectionContract } from './ConnectingParcels.js';
import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';
const dirs=[[1,0],[-1,0],[0,1],[0,-1]],key=(x,y)=>`${x},${y}`;
export function layerCompatible(a,b,d) {
 if(d==='side'&&((a==='street'&&b==='yard')||(b==='street'&&a==='yard')))return false;
 if(d==='up'||d==='down') {const pair=d==='up'?[a,b]:[b,a];
  if(['drop','entrance','manhole'].includes(pair[1]))return pair[0]==='tunnel'||pair[0]==='junction';
  if(pair[1]==='bridge')return ['street','sidewalk','drop'].includes(pair[0]);
  if(pair[0]==='rock')return !['drop','entrance','manhole'].includes(pair[1]);
  return true;
 }
 return true;
}
/** A single WFC graph spans all three parcel layers. Route priors pin vertical sockets, not isolated buildings. */
export function solveLayers(layout,site,seed=1,opts={}) {
 const target=layout.buildings.slice().sort((a,b)=>b.storeys-a.storeys)[0],start=layout.flow[0];
 // v3 layouts name the stairs entrance and the objective-side manhole; v2 keeps its fixed west approach.
 const a=opts.entrance||{x:start[0],y:start[1]-3},b=opts.approach||{x:target.x0-2,y:target.y0+Math.floor(target.d/2)};
 const free=(x,y)=>x>=2&&y>=2&&x<layout.width-2&&y<layout.depth-2&&!layout.buildings.some(b=>x>=b.x0-1&&x<=b.x0+b.w&&y>=b.y0-1&&y<=b.y0+b.d)&&!(opts.avoid?.(x,y));
 const queue=[a],prev=new Map([[key(a.x,a.y),null]]);
 for(let i=0;i<queue.length&&!prev.has(key(b.x,b.y));i++)for(const [dx,dy]of dirs){const p={x:queue[i].x+dx,y:queue[i].y+dy},k=key(p.x,p.y);if(free(p.x,p.y)&&!prev.has(k)){prev.set(k,queue[i]);queue.push(p);}}
 if(!prev.has(key(b.x,b.y)))throw Error('layer.socket: no flank corridor from insertion to objective approach');
 const route=[];for(let p=b;p;p=prev.get(key(p.x,p.y)))route.push(p);route.reverse();
 const pw=Math.ceil(layout.width/4),pd=Math.ceil(layout.depth/4),nodes=[],fixed=new Map(),domains=new Map();
 const kinds=[['rock','tunnel','junction'],['building','street','sidewalk','yard','drop','entrance','manhole'],['air','rooftop','bridge']];
 const prior=new Map(layout.parcels.map(p=>[p.id,p.kind]));
 const tunnel=new Set(route.map(p=>key(Math.floor(p.x/4),Math.floor(p.y/4))));
 const drop=route[Math.floor(route.length/2)],socket=new Map([[key(Math.floor(a.x/4),Math.floor(a.y/4)),'entrance'],[key(Math.floor(b.x/4),Math.floor(b.y/4)),'manhole'],[key(Math.floor(drop.x/4),Math.floor(drop.y/4)),'drop']]);
 for(let l=0;l<3;l++)for(let y=0;y<pd;y++)for(let x=0;x<pw;x++) {
  const id=`${x},${y},${l}`,neighbors=dirs.filter(([dx,dy])=>x+dx>=0&&y+dy>=0&&x+dx<pw&&y+dy<pd).map(([dx,dy])=>({id:`${x+dx},${y+dy},${l}`,direction:'side'}));
  if(l>0)neighbors.push({id:`${x},${y},${l-1}`,direction:'down'});if(l<2)neighbors.push({id:`${x},${y},${l+1}`,direction:'up'});
  nodes.push({id,neighbors});domains.set(id,kinds[l]);const k=key(x,y);
  if(l===1&&!socket.has(k)&&!['building','street'].includes(prior.get(k)))domains.set(id,['yard','sidewalk']);
  else fixed.set(id,l===0?(tunnel.has(k)?'tunnel':'rock'):l===1?(socket.get(k)||prior.get(k)||'yard'):(prior.get(k)==='building'?'rooftop':k===key(Math.floor(drop.x/4),Math.floor(drop.y/4))?'bridge':'air'));
 }
 let assignment;try{assignment=solveWaveFunctionCollapse({nodes,tiles:[...new Set(kinds.flat())].map(id=>({id,weight:id==='yard'?5:2})),domains,fixed,compatible:layerCompatible,seed:`${site.id}:layers:${seed}`});}catch(e){throw Error(`layer.socket: ${e.message}`);}
 const entrances=[{...a,kind:'stairs'},{...b,kind:'manhole'}];
 return {connectionParcels:entrances.map(connectionContract),datum:4,parcels:[...assignment].map(([id,kind])=>({id,kind})),route,entrances,drop,bridge:opts.bridge??(site.underground?.kind==='underpass'||!!site.levels?.includes('bridge')),kind:opts.kind||site.underground?.kind||'subway'};
}
