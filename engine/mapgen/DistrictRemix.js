import {solveWaveFunctionCollapse,hashWaveSeed} from '../generation/WaveFunctionCollapse.js';
export const REMIX_DEFAULTS=Object.freeze({buildingCount:14,minStoreys:1,maxStoreys:3,placement:'noise-wfc',parts:'mixed',merges:true,elevated:true,traffic:'normal',pedestrian:'light',objective:'eliminate',skybridges:true,levels:1});
export function remixParameters(r={}) {
 const n=(v,d,a,b)=>Math.max(a,Math.min(b,Math.round(Number(v)||d)));
 const minStoreys=n(r.minStoreys,1,1,3);
 return {buildingCount:n(r.buildingCount,14,3,24),minStoreys,maxStoreys:Math.max(minStoreys,n(r.maxStoreys,3,1,3)),placement:r.placement==='ordered'?'ordered':'noise-wfc',parts:['mixed','retail','industrial','suburban','roadside','urban'].includes(r.parts)?r.parts:'mixed',merges:r.merges!==false,elevated:r.elevated!==false,traffic:['none','light','normal','heavy'].includes(r.traffic)?r.traffic:'normal',pedestrian:['none','light','normal'].includes(r.pedestrian)?r.pedestrian:'light',wall:['brick','stucco','concrete_wall','siding'].includes(r.wall)?r.wall:'mixed',glazing:['full','band','punched'].includes(r.glazing)?r.glazing:'mixed',corners:['rounded','square'].includes(r.corners)?r.corners:'mixed',furnish:r.furnish!==false,terrain:r.terrain==='flat'?'flat':'terraced',objective:r.objective==='hold'?'hold':'eliminate',skybridges:r.skybridges!==false,levels:n(r.levels,1,1,3)};
}
/** Noise changes priors, not occupancy. Adjacent parcels may not both choose the tallest tile. */
export function solveDistrictParts(candidates,settings,seed) {
 const programs=settings.parts==='industrial'?['warehouse','garage','office']:settings.parts==='retail'?['shop','diner','office']:['shop','diner','office','warehouse','garage'];
 const tiles=programs.flatMap(program=>Array.from({length:settings.maxStoreys-settings.minStoreys+1},(_,i)=>({id:`${program}:${i+settings.minStoreys}`,program,storeys:i+settings.minStoreys,weight:program==='office'?1.5:1})));
 const nodes=candidates.map((p,i)=>({id:p.id,neighbors:candidates.filter((q,j)=>i!==j&&Math.hypot(p.x0-q.x0,p.y0-q.y0)<22).map(q=>({id:q.id,direction:'near'}))}));
 const lookup=new Map(tiles.map(t=>[t.id,t]));
 const solved=solveWaveFunctionCollapse({nodes,tiles,seed:`district-remix:${seed}`,compatible:(a,b)=>settings.minStoreys===settings.maxStoreys||lookup.get(a).storeys!==settings.maxStoreys||lookup.get(b).storeys!==settings.maxStoreys,nodeWeights:(node,tile)=>{
  const p=candidates.find(p=>p.id===node),t=lookup.get(tile),noise=(hashWaveSeed(`${seed}:${Math.floor(p.x0/18)}:${Math.floor(p.y0/18)}:${t.id}`)%1000)/1000;
  return t.weight*(.3+noise*2);
 }});
 return candidates.map(p=>{const {id,weight,...parts}=lookup.get(solved.get(p.id));return {...p,...parts};});
}
