import reference from './reference/more-maps-pack.json' with {type:'json'};
import {MAT} from '../voxel/Materials.js';
/** Original connecting modules: rotated footprints and matching surface/lower-level sockets.
 * The imported PCP declaration supplies a selection contract, never Unreal geometry. */
export const CONNECTOR_PARCELS=Object.freeze({
    street_portal:{id:'street-underpass-portal',width:5,length:4,type:'Straight',surface:4,lower:1},
    service_headhouse:{id:'service-headhouse',width:5,length:5,type:'Terminal',surface:4,lower:1},
    freight_ramp:{id:'freight-loading-ramp',width:5,length:4,type:'Straight',surface:4,lower:1}
});
export function connectionContract(entrance,index=0) {
    const template=entrance.kind==='manhole'?CONNECTOR_PARCELS.service_headhouse:CONNECTOR_PARCELS.street_portal;
    return {id:`connector-${index}`,template:template.id,sourceProfile:reference.coverPieces[0]?.id||null,
        x:entrance.x,y:entrance.y,dir:entrance.dir||null,sockets:[{level:'street',x:entrance.x+(entrance.kind==='manhole'?1:(entrance.dir?.[0]||0)*3),y:entrance.y+(entrance.kind==='manhole'?0:(entrance.dir?.[1]||0)*3),z:4},{level:'lower',x:entrance.x,y:entrance.y,z:1}],width:template.width,length:template.length};
}
/**
 * PLAN-13: street-level finish of an underground access, modelled on open metro entrances (an open stair well in
 * the pavement between waist-high railings, open at the top step) instead of the old roofed portal,
 * whose roof slab was clipped by the line of play into a canopy floating over the street. A manhole keeps only its
 * shaft and ladder. Railings are low see-through cover; they never stand on a line-of-play cell or a building.
 */
export function finishConnectionParcel(m,entrance,dir,index) {
    m.connectorFootprint ||= new Set();
    const s=m.store,contract=connectionContract({...entrance,dir},index),cells=[];
    const G=4;
    const put=(x,y,z,mat)=>{if(!s.inBounds(x,y,z)||m.connectorPaths?.has(`${x},${y}`))return;if(m.buildings.some(b=>x>=b.x0-1&&x<=b.x0+b.w&&y>=b.y0-1&&y<=b.y0+b.d))return;
        if(!s.isSolid(x,y,z-1)||s.isSolid(x,y,z))return;s.set(x,y,z,mat);cells.push([x,y,z]);};
    if(entrance.kind!=='manhole') {
        const [dx,dy]=dir;
        // The well is the stair cells below street level (i = 0..2); i = 3 is the top step, flush with the street.
        // Railings line both sides of the upper well (beside the top flights); the deep end stays open on three
        // sides as a drop-in (a jump down into the stairs is the quick way into the tunnel, and the flank budget is
        // measured with it).
        for(let i=1;i<3;i++)for(const side of [-1,1])put(entrance.x+dx*i-dy*side,entrance.y+dy*i+dx*side,G+1,MAT.railing);
    }
    for(const [x,y] of cells){m.connectorFootprint.add(`${x},${y}`);m.reserve(x,y,x,y);}
    return {...contract,cells};
}
