import {remixParameters} from '../mapgen/DistrictRemix.js';
import {registerRoads} from '../mapgen/StreetDressing.js';
import {createMap} from './modern/MapKit.js';
import {MAT} from '../voxel/Materials.js';
import {reachable,nodeKey,pathTo} from '../world/PathSearch.js';
import {AGENT_PROFILES} from '../world/TraversalRules.js';
import {initDistrict,tag,tagRect,put,registerSolids} from '../mapgen/district/Core.js';
import {plantTree} from '../mapgen/district/Props.js';
import {snapshotGround,fillDistrict,finishDistrict} from '../mapgen/district/District.js';
import {mergeShells} from '../mapgen/district/MixSolver.js';
import {buildTerraceDistrict} from '../mapgen/district/TerraceLevels.js';
import {districtPods} from '../mapgen/district/Pods.js';
import {interiorHoldZone,secureHoldSpawns} from '../mapgen/district/HoldZone.js';

/** Every map id built by the district generator (descriptors carry width/depth/shape/remix for these). */
export const DISTRICT_MAP_IDS=Object.freeze(['park-district','mall-district','drainage-district','terrace-district','suburb-district','downtown-district','dockside-district','highway-district']);
// PLAN-06: large districts are a road skeleton plus landmark features (the merged arcade, the
// drainage channels, the insertion cordon), and everything between the roads is solved as parcel mixes. There is
// no scatter pass and no free-placed cover: every prop has an origin, every vehicle a slot.

/** Bounds are gameplay geometry, rather than an invisible rectangular extension. */
export function districtParameters({width=96,depth=72,shape='rectangle',remix}={}) {
 const result={width:Math.max(96,Math.min(128,Math.round(Number(width)||96))),depth:Math.max(72,Math.min(96,Math.round(Number(depth)||72))),shape:['rectangle','L','T'].includes(shape)?shape:'rectangle'};
 if(remix)result.remix=remixParameters(remix);return result;
}
export function districtContains(p,x,y) {
 if(x<0||y<0||x>=p.width||y>=p.depth)return false;
 if(p.shape==='L')return x<64||y<48;
 if(p.shape==='T')return y<48||(x>=28&&x<68);
 return true;
}
function applyBoundary(m,p) {
 for(let y=0;y<p.depth;y++)for(let x=0;x<p.width;x++)if(!districtContains(p,x,y))for(let z=0;z<m.store.height;z++)m.store.set(x,y,z,0);
}
function connector(m,id,cells,template='district-promenade') {
 for(const c of cells)m.reserve(c.x-1,c.y-1,c.x+1,c.y+1);
 return {id,template,cells,sockets:[cells[0],cells.at(-1)]};
}
function lane(m,id,x,y,dx,dy,length,z) {
 const cells=Array.from({length},(_,i)=>({x:x+dx*i,y:y+dy*i,z}));
 for(const c of cells){m.store.set(c.x,c.y,z,MAT.paving);for(let h=1;h<=2;h++)m.store.set(c.x,c.y,z+h,0);}
 return connector(m,id,cells);
}
/** Merge adjacent shells through a wide shared passage, retaining each shop's room ownership. */
export function mergeDistrictBuildings(m,a,b) {
 if(a.baseZ!==b.baseZ||a.x0+a.w!==b.x0)throw Error('Mall parcels require aligned adjacent shells');
 return mergeShells(m,a,b);
}
function drainage(m) {
 const s=m.store,routes=[],origin='level:drainage';
 const pieces=[{id:'west-drain',x:8,y:43,dx:1,dy:0,n:49},{id:'drain-turn',x:56,y:43,dx:0,dy:1,n:23},{id:'south-drain',x:56,y:65,dx:-1,dy:0,n:23}];
 const carve=(x,y)=>{for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
  const xx=x+dx,yy=y+dy;for(let h=2;h<=4;h++)s.set(xx,yy,h,0);s.set(xx,yy,1,MAT.paving);m.reserve(xx,yy,xx,yy);tag(m,xx,yy,'channel');
 }};
 for(const p of pieces)for(let i=0;i<p.n;i++)carve(p.x+p.dx*i,p.y+p.dy*i);
 for(const p of pieces){const cells=[];for(let i=0;i<p.n;i++){
  const x=p.x+p.dx*i,y=p.y+p.dy*i;s.set(x,y,1,MAT.water);cells.push({x:x-p.dy*2,y:y+p.dx*2,z:1});
 }routes.push(connector(m,p.id,cells,'open-drainage-bank'));}
 for(const r of routes)for(const c of r.cells)s.set(c.x,c.y,c.z,MAT.paving);
 routes.push(lane(m,'north-turn-bank',54,45,1,0,5,1),lane(m,'south-turn-bank',54,63,1,0,5,1));
 for(const [x,y,dx,dy] of [[5,41,1,0],[30,69,0,-1],[59,53,-1,0]]){
  const cells=[];for(let i=0;i<4;i++)for(let w=0;w<3;w++){
   const px=x+dx*i-dy*w,py=y+dy*i+dx*w,z=4-i;
   for(let h=z+1;h<=6;h++)s.set(px,py,h,0);s.set(px,py,z,MAT.stairs_stone);m.reserve(px-1,py-1,px+1,py+1);tag(m,px,py,'level',{force:true});if(w===1)cells.push({x:px,y:py,z});
  }routes.push(connector(m,`drain-stairs-${x}-${y}`,cells,'drainage-access-stairs'));
 }
 const ladders=[[20,40,0,-1],[59,58,1,0],[42,68,0,1]];
 const bridges=[['drain-road-bridge',32,39,0,1,9],['drain-service-bridge',51,56,1,0,11]];
 return {routes,dress(){
  for(const [x,y,dx,dy] of ladders){const l=m.ladder(x,y,dx,dy);registerSolids(m,{x0:x,y0:y,w:1,d:1},`${origin}/ladder`,{z0:l.foot+1});routes.push({id:`drain-ladder-${x}`,template:'bank-service-ladder',sockets:[{x,y,z:l.foot},{x:x+dx,y:y+dy,z:l.top}]});}
  for(const [id,x,y,dx,dy,n] of bridges){
   const cells=[];for(let i=0;i<n;i++)for(let w=-1;w<=1;w++){
    const px=x+dx*i-dy*w,py=y+dy*i+dx*w;put(m,px,py,4,'paving',`${origin}/${id}`);m.reserve(px,py,px,py);tag(m,px,py,'level',{force:true});
    if(w===0)cells.push({x:px,y:py,z:4});
    if(Math.abs(w)===1&&i>0&&i<n-1)put(m,px,py,5,'railing',`${origin}/${id}`);
   }routes.push(connector(m,id,cells,'surface-bank-bridge'));
  }
  // Bank buttresses: short concrete flood walls on the channel side of the dry banks (half cover, leaves rubble).
  for(let x=12;x<=51;x+=5)for(let i=0;i<2;i++)if(!s.isSolid(x+i,46,2))put(m,x+i,46,2,'brick',`${origin}/bank-buttress`);
  for(let y=49;y<64;y+=5)if(!s.isSolid(53,y,2))put(m,53,y,2,'brick',`${origin}/bank-buttress`);
 }};
}
function dressRoofs(m) {
 for(const b of m.buildings)if(b.w>=20){const cells=[];for(let dx=0;dx<2;dx++)for(let dy=0;dy<2;dy++)for(let h=1;h<=2;h++){
  const x=b.x0+Math.floor(b.w/2)+dx,y=b.y0+Math.floor(b.d/2)+dy,z=b.top+h;if(m.store.isSolid(x,y,z))continue;m.store.set(x,y,z,MAT.appliance);cells.push([x,y,z]);
 }if(cells.length)m.object('rooftop_ac',cells,{axis:'x',dir:1,size:[2,2]});}
 for(const b of m.buildings){for(const dx of [2,5])for(const dy of [2,5])m.decorAt(dx===2?'rooftop_vent':'cable_spool',b.x0+dx,b.y0+dy,{z:b.top+1});m.decorAt('wall_sign',b.x0-.5,b.y0+3,{z:b.baseZ+2,free:true});}
}
/** Road skeleton per theme: a main street, a cross street to the north edge and (dry themes) a rear service road. */
/** The district themes: id, name, default footprint, family, the remix defaults and the road skeleton. */
export const DISTRICT_THEMES=Object.freeze({
 park:{id:'park-district',name:'Civic District',family:'mixed'},
 mall:{id:'mall-district',name:'Market Arcade',family:'retail',shape:'L'},
 drainage:{id:'drainage-district',name:'Drainage Quarter',family:'industrial',shape:'T',datum:4,bias:{motel:0.2,'car-dealership':0.4}},
 suburb:{id:'suburb-district',name:'Maple Heights',family:'suburban',remix:{maxStoreys:2,terrain:'flat',traffic:'light'}},
 downtown:{id:'downtown-district',name:'Downtown Core',family:'urban',remix:{minStoreys:2,maxStoreys:3,buildingCount:13,terrain:'flat',traffic:'heavy',pedestrian:'normal'}},
 docks:{id:'dockside-district',name:'Dockside Yards',family:'industrial',bias:{'warehouse-yard':3,'scrapyard':1.4,'bus-depot':0.6,'strip-mall':0.2,'car-wash':0.3,'office-plaza':0.4},remix:{maxStoreys:2,terrain:'flat'}},
 highway:{id:'highway-district',name:'Interstate Strip',family:'roadside',bias:{'house-plot':0.2,'townhouse-row':0.2},remix:{maxStoreys:2,terrain:'flat',traffic:'heavy'}}
});
/** Road skeleton per theme. Every theme keeps the main street on rows 34–38 so the insertion stays at the west end. */
export function districtRoads(p,theme,datum) {
 const W=p.width,D=p.depth,main={id:'main-street',axis:'x',lo:34,hi:38,from:0,to:W-1,z:datum,kind:'main',sidewalk:2};
 const service={id:'service-road',axis:'x',lo:D-9,hi:D-5,from:0,to:W-1,z:datum,kind:'service',sidewalk:1};
 if(theme==='suburb')return [main,{id:'west-avenue',axis:'y',lo:30,hi:33,from:0,to:D-1,z:datum,kind:'cross',sidewalk:2},{id:'east-avenue',axis:'y',lo:Math.round(W*0.68),hi:Math.round(W*0.68)+3,from:0,to:D-1,z:datum,kind:'cross',sidewalk:2}];
 if(theme==='downtown')return [main,{id:'centre-avenue',axis:'y',lo:44,hi:48,from:0,to:D-1,z:datum,kind:'cross',sidewalk:2},service];
 if(theme==='docks')return [main,{id:'quay-road',axis:'x',lo:7,hi:9,from:0,to:W-1,z:datum,kind:'service',sidewalk:1},{id:'yard-road',axis:'y',lo:52,hi:55,from:7,to:D-1,z:datum,kind:'cross',sidewalk:1}];
 if(theme==='highway')return [{...main,id:'interstate',lo:34,hi:43,sidewalk:2,median:true,parking:false},{id:'frontage-road',axis:'x',lo:D-9,hi:D-5,from:0,to:W-1,z:datum,kind:'service',sidewalk:1},{id:'exit-road',axis:'y',lo:58,hi:61,from:0,to:D-1,z:datum,kind:'cross',sidewalk:2}];
 const roads=[main,{id:'cross-street',axis:'y',lo:57,hi:60,from:0,to:38,z:datum,kind:'cross',sidewalk:2}];
 if(theme!=='drainage')roads.push(service);
 return roads;
}
/** Dockside: deep water along the north edge with a quay wall and mooring bollards. */
function quay(m,p) {
 const s=m.store;
 for(let y=0;y<=4;y++)for(let x=0;x<p.width;x++){s.set(x,y,1,MAT.deep_water);tag(m,x,y,'channel',{force:true});}
 for(let x=0;x<p.width;x++){tag(m,x,5,'level',{force:true});s.set(x,5,1,MAT.concrete);}
 return {routes:[],dress(){for(let x=3;x<p.width;x+=6)put(m,x,5,2,'steel_post','level:quay/mooring-bollard');}};
}
const FAMILY={mixed:'mixed',retail:'retail',industrial:'industrial',suburban:'suburban',roadside:'roadside',urban:'urban'};
const GLAZE=remix=>remix.glazing!=='mixed'?Object.fromEntries(['sales','office','lobby','meeting','hall','dining','galley','warehouse','workshop','loading','storeroom'].map(k=>[k,remix.glazing])):null;

export function buildLargeDistrict({seed=1,theme='park',...options}={}) {
 if(theme==='terraces')return buildTerraceDistrict({seed,...options});
 const T=DISTRICT_THEMES[theme]||DISTRICT_THEMES.park;
 const p=districtParameters({...options,shape:options.shape||T.shape||'rectangle'}),datum=T.datum||1;
 const id=T.id;
 const remix=remixParameters({pedestrian:'normal',...(T.remix||{}),...(p.remix||options.remix||{})});
 const m=createMap({id,...p,height:18,seed,datum,ground:'paving'});
 initDistrict(m,{contains:(x,y)=>districtContains(p,x,y),family:remix.parts,seed});
 applyBoundary(m,p);
 const roads=districtRoads(p,theme,datum);
 for(const r of roads)r.axis==='x'?m.roadX(r.lo,r.hi,r.from,r.to):m.roadY(r.lo,r.hi,r.from,r.to);
 const connectors=[],features=[];
 // Landmark features first: they shape the blocks around them.
 if(theme==='mall'){
  const a=m.building({id:'market-west',program:'shop',x0:7,y0:7,w:24,d:22,rounded:false,furnish:remix.furnish,...(remix.wall!=='mixed'?{wall:remix.wall}:{})});
  const b=m.building({id:'market-east',program:'shop',x0:31,y0:7,w:24,d:22,rounded:false,furnish:remix.furnish,...(remix.wall!=='mixed'?{wall:remix.wall}:{})});
  for(const s of [a,b])tagRect(m,{x0:s.x0,y0:s.y0,w:s.w,d:s.d},'building',{force:true});
  if(remix.merges){const c=mergeDistrictBuildings(m,a,b);if(c)connectors.push(c);}
 }
 if(theme==='docks')features.push(quay(m,p));
 if(theme==='drainage'){const f=drainage(m);connectors.push(...f.routes);features.push(f);}
 // The insertion: a cordon of jersey barriers covering the drop zone (a story beat), and the promenade the squad
 // follows into the district.
 tagRect(m,{x0:0,y0:22,w:7,d:11},'insertion');
 m.reserve(1,23,5,32);
 const promenade=lane(m,'retail-promenade',5,33,1,0,50,datum);
 for(const c of promenade.cells)tag(m,c.x,c.y,'sidewalk',{force:true});
 connectors.unshift(promenade);
 registerRoads(m,roads);
 snapshotGround(m);
 for(const f of features){const before=f.routes.length;f.dress?.();connectors.push(...f.routes.slice(before));}
 for(const [x,y] of [[6,24],[6,25],[6,29],[6,30]])put(m,x,y,datum+1,'jersey','story:insertion-cordon');
 const spawn={x:2,y:25,z:datum},target={x:p.width-12,y:Math.floor(p.depth/2)};
 const family=FAMILY[remix.parts]||'mixed';
 const report=fillDistrict(m,{seed,remix,family:family==='mixed'?T.family:family,roads,spawn,target,hold:remix.objective==='hold',glaze:GLAZE(remix),bias:T.bias||{}});
 dressRoofs(m);applyBoundary(m,p);
 connectors.push(...m.district.connectors.filter(c=>c.sockets?.length));
 // Enemies hold the two buildings farthest from the insertion; a hold mission keeps them away from the zone.
 if(remix.objective==='hold'&&!m.district.zones.length)interiorHoldZone(m,spawn);
 const zone=m.district.zones[0];if(zone)zone.objective=true;
 const far=[...m.buildings].filter(b=>b.rooms.length&&(!zone||Math.hypot(b.x0+b.w/2-(zone.x0+zone.x1)/2,b.y0+b.d/2-(zone.y0+zone.y1)/2)>=24)).sort((a,b)=>Math.hypot(b.x0-spawn.x,b.y0-spawn.y)-Math.hypot(a.x0-spawn.x,a.y0-spawn.y));
 const enemy=districtPods(far,{fallback:[{x:p.width-10,y:15,z:datum},{x:p.width-20,y:p.depth-14,z:datum}],street:{x:p.width-12,y:Math.floor(p.depth/2)+(zone?8:0),z:datum}});
 const objective=zone?{kind:'hold',zone:{x0:zone.x0,y0:zone.y0,x1:zone.x1,y1:zone.y1,z:zone.z,dz:1},rounds:4,needed:1,text:'Take the marked ground and hold it for four rounds. Its cover will not last — fall back to the barriers if it burns.'}:{kind:'eliminate',text:'Secure the district through its linked parcels and alternate elevation routes.'};
 const result=m.finish({name:T.name,spawns:{player:[{x:2,y:25,z:datum},{x:2,y:27,z:datum},{x:3,y:26,z:datum},{x:4,y:25,z:datum},{x:4,y:27,z:datum},{x:3,y:29,z:datum}],enemy},objective,meta:{generatorVersion:'district-mix-v3',lanesGoal:zone?'objective':entryGoal(far[0]),remix,streetObjects:report.streetObjects,partAssignments:report.assignments,theme:'Large districts',lighting:'overcast',streetDatum:datum,footprint:p,connectionParcels:connectors,cutLevels:[4,7,10,13,Infinity],defaultCut:datum+3,floorNames:datum===4?{4:'Drainage banks',7:'Street district',10:'Upper interiors',13:'High floors'}:{4:'Street interiors',7:'Upper / bridge interiors',10:'Third floors',13:'High roofs'},designDecisions:[`Playable ${p.shape} footprint: ${p.width} × ${p.depth}; cells outside it are removed.`,'Parcel mixes fill every block between the roads; leftover land becomes alleys, verges, paths and greens.','No scatter pass: every prop carries an origin and every vehicle stands in a slot chosen by the noise map.',theme==='mall'?'Adjacent retail parcels merge through a three-wide indoor passage.':theme==='drainage'?'Only the drainage theme excavates lower banks, with elemental water and service ladders.':'Street-level retail, yards and service paths fill the district.']}});
 const search=reachable(result.store,result.spawns.player[0],Infinity,AGENT_PROFILES.player);
 const failures=connectors.flatMap(c=>c.sockets.filter(s=>![0,1,-1].some(dz=>search.costs.has(nodeKey({...s,z:s.z+dz})))).map(s=>({connector:c.id,socket:s})));
 result.meta.connectorValidation={pass:failures.length===0,failures};
 if(failures.length)throw Error(`${id}: unreachable district sockets ${JSON.stringify(failures)}`);
 const root=connectors[0],network=reachable(result.store,root.sockets[0],Infinity,AGENT_PROFILES.player);
 result.meta.parcelLinks=connectors.slice(1).map(c=>({from:root.id,to:c.id,path:pathTo(network,nearest(network,c.sockets[0]))}));
 if(result.meta.parcelLinks.some(l=>!l.path.length))throw Error(`${id}: disconnected parcel network`);
 result.meta.parcelGraph=result.meta.parcelLinks.map(l=>[l.from,l.to]);
 result.meta.parcelAssignments=result.buildings.map(b=>({id:b.id,program:b.program,bounds:{x:b.x0,y:b.y0,w:b.w,d:b.d},mergedWith:b.mergedWith||[]}));
 if(zone)secureHoldSpawns(result,zone);
 finishDistrict(result,m,report);
 return result;
}
/** The lanes metric aims at the main enemy building's front door (outside it), like image-generated maps do. */
const entryGoal=b=>{if(!b)return null;const e=b.exits?.find(e=>e.entry)||b.exits?.[0];if(!e)return null;const [dx,dy]={n:[0,-1],s:[0,1],e:[1,0],w:[-1,0]}[e.side]||[0,1];return {x:e.x+dx*2,y:e.y+dy*2,z:b.baseZ};};
const nearest=(search,s)=>[0,1,-1].map(dz=>nodeKey({...s,z:s.z+dz})).find(k=>search.costs.has(k))||nodeKey(s);
export const buildParkDistrict=o=>buildLargeDistrict({...o,theme:'park'});
export const buildMallDistrict=o=>buildLargeDistrict({...o,theme:'mall'});
export const buildDrainageDistrict=o=>buildLargeDistrict({...o,theme:'drainage'});
export const buildTerraceHeights=o=>buildLargeDistrict({...o,theme:'terraces'});
export const buildSuburbDistrict=o=>buildLargeDistrict({...o,theme:'suburb'});
export const buildDowntownDistrict=o=>buildLargeDistrict({...o,theme:'downtown'});
export const buildDocksideDistrict=o=>buildLargeDistrict({...o,theme:'docks'});
export const buildHighwayDistrict=o=>buildLargeDistrict({...o,theme:'highway'});
