import { solveWaveFunctionCollapse } from '../generation/WaveFunctionCollapse.js';

// Pre-authored furnishing recipes choose baked pieces; placement still obeys the builder's
// collision, door clearance and connected-circulation gates. Adjacent dense rooms are forbidden.
export const DRESSING_KITS = Object.freeze([
    {id:'circulation', kinds:['hall'], items:[], density:'open', weight:1},
    {id:'office-work', kinds:['office','study','open_office'], items:['desk','server_rack','filing'], density:'dense', weight:2},
    {id:'office-aid', kinds:['office','study','open_office'], items:['desk','aid_station'], density:'open', weight:1},
    {id:'storage-stock', kinds:['storeroom','storage','utility','warehouse'], items:['wall_shelf','crates','server_rack'], density:'dense', weight:2},
    {id:'storage-maintenance', kinds:['storeroom','storage','utility','warehouse'], items:['workbench','tool_chest'], density:'open', weight:1},
    {id:'living-home', kinds:['living','lounge'], items:['sofa','tv','loveseat'], density:'dense', weight:2},
    {id:'living-evacuation', kinds:['living','lounge'], items:['loveseat','aid_station'], density:'open', weight:1},
]);
const key=(x,y)=>`${x},${y}`;
export function solveDressing(rooms, defaults, seed) {
    const cellRooms=new Map();
    rooms.forEach((r,i)=>r.cells.forEach(([x,y])=>cellRooms.set(key(x,y),String(i))));
    const neighbors=rooms.map(()=>new Set());
    rooms.forEach((r,i)=>r.cells.forEach(([x,y])=>{
        for(const [dx,dy] of [[2,0],[-2,0],[0,2],[0,-2],[1,0],[-1,0],[0,1],[0,-1]]) {
            const j=cellRooms.get(key(x+dx,y+dy)); if(j!=null&&j!==String(i))neighbors[i].add(j);
        }
    }));
    const fallback=rooms.map((r,i)=>({id:`default-${i}`,items:defaults[r.kind]||[],density:'open',weight:1}));
    const tiles=[...DRESSING_KITS,...fallback], byId=new Map(tiles.map(k=>[k.id,k]));
    const domains=new Map(rooms.map((r,i)=>{
        const kits=r.gameplay===false?[]:DRESSING_KITS.filter(k=>k.kinds.includes(r.kind));
        return [String(i),kits.length?kits.map(k=>k.id):[fallback[i].id]];
    }));
    const assignment=solveWaveFunctionCollapse({nodes:rooms.map((r,i)=>({id:String(i),neighbors:[...neighbors[i]].map(id=>({id,direction:'adjacent'}))})),tiles,domains,seed,
        compatible:(a,b)=>!(byId.get(a).density==='dense'&&byId.get(b).density==='dense')});
    return new Map(rooms.map((r,i)=>[r,byId.get(assignment.get(String(i)))]));
}
