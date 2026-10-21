import { MAT } from '../voxel/Materials.js';
const DIRS=[[1,0],[0,1],[-1,0],[0,-1]];
/** One fixed backing side for the complete connected column, also used by the renderer. */
export function ladderAttachment(store,x,y,z) {
    if(store.get(x,y,z)!==MAT.ladder)return null;
    let lo=z,hi=z;while(store.get(x,y,lo-1)===MAT.ladder)lo--;while(store.get(x,y,hi+1)===MAT.ladder)hi++;
    const backing=DIRS.find(([dx,dy])=>{for(let h=lo;h<=hi;h++)if(!store.isSolid(x+dx,y+dy,h))return false;return true;})||null;
    if(backing)return backing;
    // Facade-bolted escape ladders attach at their platform, without a full-height support beam.
    const group=(store.supportGroups||[]).find(g=>g.ladder?.x===x&&g.ladder.y===y&&z>=g.ladder.lo&&z<=g.ladder.hi);
    if(!group||!group.anchors.some(p=>store.isSolid(...p)))return null;
    const mount=group.ladder;
    if(!DIRS.some(([dx,dy])=>store.get(x+dx,y+dy,mount.hi)===MAT.grate))return null;
    for(let h=mount.lo;h<=mount.hi;h++)if(store.get(x,y,h)!==MAT.ladder)return null;
    return mount.backing;
}
export function validateLadders(store) {
    for(let z=0;z<store.height;z++)for(let y=0;y<store.depth;y++)for(let x=0;x<store.width;x++)if(store.get(x,y,z)===MAT.ladder&&store.get(x,y,z-1)!==MAT.ladder&&!ladderAttachment(store,x,y,z))throw Error(`ladder.attachment: unsupported column ${x},${y},${z}`);
    return true;
}
