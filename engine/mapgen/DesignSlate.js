// The designed slate uses exact integer voxel coordinates. Renderers and authoring previews never rescale it.
import { materialById } from '../voxel/Materials.js';
export function designSlate(mission) {
    const {store}=mission;
    const floors=[...new Set([mission.meta.streetDatum||1,...mission.rooms.map(r=>r.floorZ)])].sort((a,b)=>a-b);
    return { version:1,width:store.width,depth:store.depth,height:store.height,worldUnitsPerTile:1,
        matrix:Array.from(store.mat), // index = x + y*width + z*width*depth
        buildings:mission.buildings.map(({id,x0,y0,w,d,baseZ,storeys,front,program})=>({id,x0,y0,w,d,baseZ,storeys,front,program})),
        layers:floors.map(z=>({z,tiles:Array.from({length:store.depth},(_,y)=>Array.from({length:store.width},(_,x)=>store.get(x,y,z)))})),
        rooms:mission.rooms.map(r=>({id:r.id,kind:r.kind,z:r.floorZ,gameplay:r.gameplay!==false,cells:r.cells})),
        flow:mission.meta.flow || [],flowRoutes:mission.meta.flowRoutes || [],doors:mission.buildings.flatMap(b=>b.doors),
        cover:Array.from({length:store.depth},(_,y)=>Array.from({length:store.width},(_,x)=>store.get(x,y,(mission.meta.streetDatum||1)+1))) };
}
export function slateSvg(slate) {
    const size=16, w=slate.width*size,d=slate.depth*size;
    const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const cells=slate.layers[0].tiles.flatMap((row,y)=>row.map((id,x)=>`<rect x="${x*size}" y="${y*size}" width="${size}" height="${size}" fill="#${materialById(id).color.toString(16).padStart(6,'0')}"/>`)).join('');
    const cover=slate.cover.flatMap((row,y)=>row.map((id,x)=>id&&materialById(id).solid?`<rect x="${x*size+2}" y="${y*size+2}" width="12" height="12" fill="#${materialById(id).color.toString(16).padStart(6,'0')}" stroke="#24313b"/>`:'')).join('');
    const labels=slate.rooms.filter(r=>r.z===slate.layers[0].z).map(r=>{const x=r.cells.reduce((s,c)=>s+c[0]+0.5,0)/r.cells.length*size,y=r.cells.reduce((s,c)=>s+c[1]+0.5,0)/r.cells.length*size;return `<text x="${x}" y="${y}" fill="${r.gameplay?'#ffffff':'#eab794'}" text-anchor="middle" font-size="10">${esc(r.kind)}${r.gameplay?'':' · LOCKED'}</text>`;}).join('');
    const routes = slate.flowRoutes?.length ? slate.flowRoutes : [slate.flow.map(([x,y])=>({x,y}))];
    const lines = routes.map(route => {
        const points=route.map(({x,y})=>`${(x+0.5)*size},${(y+0.5)*size}`).join(' ');
        return `<polyline points="${points}" fill="none" stroke="#6bd8e9" stroke-width="3"/>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${d}" viewBox="0 0 ${w} ${d}"><title>One tile equals one voxel: combat design slate</title>${cells}${cover}${lines}${labels}</svg>`;
}
