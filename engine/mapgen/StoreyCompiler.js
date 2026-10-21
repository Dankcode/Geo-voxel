// The floor graph, shell, facade and vertical circulation all compile into the same collision/cover matrix.
// Layout v2 (PLAN-02/03: one facade for all storeys, fixed W/E exits) and v3 (PLAN-04: per-storey facade bays,
// exits by lot sockets, stacked stair core anywhere, district wall materials, planned access modules) share it.
import { MAT, AIR } from '../voxel/Materials.js';
import { createStairRun } from '../world/StairRun.js';
import { furnish } from '../mission/modern/ModernBuilder.js';
import { createRng, hashString } from '../util/Rng.js';
import { placeFireEscape, placeRoofLadder, compileFireEscape, validateAccessModule, facadeOrigin, roofLadderTemplate, reserveFireEscape, SIDE_FRAME } from './AccessModules.js';
import { STOREY } from './KitMetric.js';
import { buildingEra, markBuildingEdges } from '../mission/BuildingEra.js';
import { furnishBuilding } from './FurnishSolver.js';
const key=(x,y)=>`${x},${y}`;
const WALLS=new Set(['stucco','brick','concrete_wall','siding']);
const SIDE_OUT={n:[0,-1],s:[0,1],e:[1,0],w:[-1,0]};

/** Which side of the footprint a perimeter cell (local) lies on. Corners report the first matching side. */
export function perimeterSide(b,x,y){return y===0?'n':y===b.d-1?'s':x===0?'w':x===b.w-1?'e':null;}

export function compileBuilding(m,b,{roomById=id=>m.ctx.rooms.find(r=>r.id===id)}={}) {
    const {store,ctx}=m,{x0,y0,w,d,storeys}=b,top=m.G+STOREY*storeys;
    if(storeys<1||storeys>4||b.floors.length!==storeys)throw Error('compile.storeys: requires all 1–4 floor layouts');
    const wallKey=WALLS.has(b.wall)?b.wall:'stucco',WALL=MAT[wallKey];
    const out={id:b.id,name:b.id,program:b.program,role:b.program,x0,y0,w,d,baseZ:m.G,top,storeys,front:b.front,wall:wallKey,district:b.district||null,era:buildingEra(b),rooms:[],doors:[],windows:[],stairs:[],escapes:[],approach:[],exits:[],access:[]};
    out.rounded=out.era==='modern';markBuildingEdges(store,out,out.era);
    const world=([x,y])=>[x+x0,y+y0];
    for(let y=y0;y<y0+d;y++)for(let x=x0;x<x0+w;x++) {
        for(let z=m.G;z<=top+2;z++)store.set(x,y,z,AIR);
        for(let s=0;s<=storeys;s++) {
            const fz=m.G+s*STOREY;store.set(x,y,fz,s===storeys?MAT.concrete:MAT.oak_floor);
            if(s<storeys&&(x===x0||y===y0||x===x0+w-1||y===y0+d-1))for(let h=1;h<=2;h++)store.set(x,y,fz+h,WALL);
        }
    }
    const perStorey=b.facade.some(p=>p.storey!=null);
    for(const f of b.floors) {
        const fz=m.G+STOREY*f.floor;
        // v3 partitions are plaster (breakable drywall); the shell keeps the district's wall material.
        const PART=f.layout==='v3'?MAT.plaster:WALL;
        for(const [x,y] of f.walls.map(world))for(let h=1;h<=2;h++)store.set(x,y,fz+h,PART);
        for(const r of f.rooms) {
            const rec={id:ctx.nextRoomId(),name:r.id,buildingId:b.id,storey:f.floor,kind:r.kind,gameplay:r.gameplay!==false,cells:r.cells.map(world),floorZ:fz,lit:true,doors:[]};
            for(const [x,y] of rec.cells) {
                for(let h=1;h<=2;h++)store.rooms[store.index(x,y,fz+h)]=rec.id;
                if(['bathroom','restroom','kitchen','utility','galley'].includes(r.kind))store.set(x,y,fz,MAT.ceramic);
            }
            out.rooms.push(rec);ctx.rooms.push(rec);
        }
        for(const door of f.doors) {
            const x=x0+door.x,y=y0+door.y;
            for(let h=1;h<=2;h++)store.set(x,y,fz+h,door.locked?MAT.door_locked:MAT.door);
            out.doors.push({x,y,z:fz,storey:f.floor,locked:door.locked,exterior:false});
        }
        for(const panel of b.facade) {
            if(perStorey&&panel.storey!==f.floor)continue;
            const x=x0+panel.x,y=y0+panel.y;
            const windowStyle={window:'sash',band:'ribbon',storefront:'curtain',glazing:'curtain'}[panel.kind];
            if(windowStyle)for(const h of ['storefront','glazing'].includes(panel.kind)?[1,2]:[2])ctx.hints[`${x},${y},${fz+h}`]={windowStyle};
            if(panel.kind==='window'||panel.kind==='band'){store.set(x,y,fz+2,MAT.glass);out.windows.push({x,y,z:fz+2,storey:f.floor,kind:panel.kind});}
            else if(panel.kind==='storefront'||panel.kind==='glazing'){for(const h of [1,2])store.set(x,y,fz+h,MAT.glass);out.windows.push({x,y,z:fz+2,storey:f.floor,kind:panel.kind});}
            else if(panel.kind==='sign'||panel.kind==='vent'){const side=perimeterSide(b,panel.x,panel.y);if(side)ctx.decor.push({kind:panel.kind==='sign'?'wall_sign':'wall_vent',x:x+SIDE_OUT[side][0]*0.55,y:y+SIDE_OUT[side][1]*0.55,z:fz+(panel.kind==='sign'?2:1),yaw:Math.atan2(SIDE_OUT[side][0],SIDE_OUT[side][1]),side,free:true,...(panel.kind==='sign'&&b.accent?{tint:b.accent}:{})});}
        }
    }
    const doorAt=(x,y,floor,side)=> {
        const z=m.G+STOREY*floor;for(let h=1;h<=2;h++)store.set(x,y,z+h,MAT.door);
        const rec={x,y,z,storey:floor,side,exterior:true};out.doors.push(rec);return rec;
    };
    // Exterior exits: v3 layouts name them by lot socket; v2 layouts keep the mid-wall west/east pair.
    const exits=b.exits?.length?b.exits:[{x:0,y:b.floors[0].core?.mid??Math.floor(d/2),side:'w'},{x:w-1,y:b.floors[0].core?.mid??Math.floor(d/2),side:'e'}];
    for(const ex of exits) {
        const [dx,dy]=SIDE_OUT[ex.side],x=x0+ex.x,y=y0+ex.y;
        const e=doorAt(x,y,0,ex.side);out.exits.push(e);out.approach.push([x+dx,y+dy],[x+2*dx,y+2*dy]);
        m.reserve(Math.min(x,x+2*dx)-(dy?1:0),Math.min(y,y+2*dy)-(dx?1:0),Math.max(x,x+2*dx)+(dy?1:0),Math.max(y,y+2*dy)+(dx?1:0));
    }
    out.entry=out.exits[0];
    // Stacked switchback core: alternating parallel runs inside a 5 × 3 core; upper holes never eat the next flight.
    const core=b.floors[0].core?.x!=null&&b.floors[0].core?.y!=null&&b.floors[0].core.layout==='v3'?b.floors[0].core:{x:1,y:(b.floors[0].core?.mid??Math.floor(d/2))-1};
    const coreSet=new Set();for(let y=core.y;y<core.y+3;y++)for(let x=core.x;x<core.x+5;x++)coreSet.add(key(x0+x,y0+y));
    for(let s=0;s<storeys-1;s++) {
        const fz=m.G+STOREY*s,even=s%2===0;
        const run=createStairRun({origin:{x:x0+core.x+(even?1:3),y:y0+core.y+(even?0:2)},direction:even?'east':'west',rise:STOREY,baseZ:fz,footprintSet:coreSet});
        if(!run)throw Error(`compile.stairs: ${b.id} floor ${s} cannot fit core`);
        for(const c of [run.before,run.cells[0],run.cells[1]])store.set(c.x,c.y,fz+STOREY,AIR);
        for(const c of run.cells) {
            for(let z=fz+1;z<=c.z;z++)store.set(c.x,c.y,z,MAT.stairs_stone);
            for(let h=1;h<=2;h++)store.set(c.x,c.y,c.z+h,AIR);
        }
        out.stairs.push({storey:s,...run});
    }
    // PLAN-11 note: no balustrade voxels across the stair core — the middle row is the only walkway across it on upper
    // floors (a railing there cut floors in half). The stray "second staircase" was a renderer bug (KitView stairs).
    // Parapet.
    for(let y=y0;y<y0+d;y++)for(let x=x0;x<x0+w;x++)if(x===x0||x===x0+w-1||y===y0||y===y0+d-1)store.set(x,y,top+1,WALL);
    // Uniform vertical access (PLAN-04 §5.2): 3–4 storeys get the fire-escape module, 1–2 storey flat roofs a roof ladder.
    const blocked=(x,y)=>m.escapeBlocked?.(x,y)||false;
    const prefer=b.access?.side?[b.access.side]:undefined;
    // PLAN-14: the core's last flight climbs from the top floor through a hatch onto the roof; railings guard the hatch
    // on the roof, open at the top step. Used for tall blocks without a fire escape and for low blocks with no room
    // for a roof ladder.
    const roofStair=()=>{
        const fz=m.G+STOREY*(storeys-1),even=(storeys-1)%2===0;
        const run=createStairRun({origin:{x:x0+core.x+(even?1:3),y:y0+core.y+(even?0:2)},direction:even?'east':'west',rise:STOREY,baseZ:fz,footprintSet:coreSet});
            if(!run)throw Error(`compile.stairs: ${b.id} roof flight cannot fit core`);
            const hole=[run.before,run.cells[0],run.cells[1]];
            for(const c of hole)store.set(c.x,c.y,top,AIR);
            for(const c of run.cells){for(let z=fz+1;z<=c.z;z++)store.set(c.x,c.y,z,MAT.stairs_stone);for(let h=1;h<=2;h++)store.set(c.x,c.y,c.z+h,AIR);}
            out.stairs.push({storey:storeys-1,roof:true,...run});
            const holeSet=new Set(hole.map(c=>key(c.x,c.y))),railed=[];
            for(const c of [...hole,run.cells[2]].filter(Boolean))for(const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]){
                const x=c.x+dx,y=c.y+dy;
                if(holeSet.has(key(x,y))||run.cells.some(r=>r.x===x&&r.y===y)||(run.after&&run.after.x===x&&run.after.y===y))continue;
                if(x<=x0||y<=y0||x>=x0+w-1||y>=y0+d-1||!store.isSolid(x,y,top)||store.get(x,y,top+1)!==AIR)continue;
                store.set(x,y,top+1,MAT.railing);railed.push([x,y]);
            }
            const landing=run.after?{x:run.after.x,y:run.after.y,z:top}:{x:run.cells.at(-1).x,y:run.cells.at(-1).y,z:top};
            const rec={module:'roof_stair',landing,railed};out.roofAccess=rec;out.access.push(rec);
    };
    if(storeys>=3&&b.access?.module==='roof_stair') roofStair();
    else if(storeys>=3) {
        let rec;
        if(b.access?.module==='fire_escape'&&b.access.offset!=null) {
            const params={side:b.access.side,origin:facadeOrigin(out,b.access.side,b.access.offset),datum:m.G,storeys,doors:b.access.doors||{}};
            rec=compileFireEscape(store,params);
            const f={...SIDE_FRAME[params.side],origin:params.origin},at=(u,r)=>[params.origin[0]+f.a[0]*u+f.o[0]*r,params.origin[1]+f.a[1]*u+f.o[1]*r];
reserveFireEscape(m,f);
            const [fx,fy]=at(0,1);rec.foot={x:fx,y:fy,z:m.G};
        } else rec=placeFireEscape(m,out,{prefer,exitFloors:b.access?.exitFloors,blocked,roomById});
        for(const l of rec.landings) {
            if(l.door!=null){const f={...SIDE_FRAME[rec.params.side],origin:rec.params.origin},x=rec.params.origin[0]+f.a[0]*l.door,y=rec.params.origin[1]+f.a[1]*l.door;out.doors.push({x,y,z:l.z,storey:l.storey,side:rec.params.side,exterior:true,escape:true});}
            out.escapes.push({floor:l.storey,toRoof:l.toRoof,landing:l.stand,cells:l.cells,door:l.door});
        }
        out.access.push(rec);
    } else if(b.roof!=='pitched') {
        let rec;
        if(b.access?.module==='roof_ladder'&&b.access.offset!=null) {
            const params={side:b.access.side,origin:facadeOrigin(out,b.access.side,b.access.offset),datum:m.G,storeys};
            const cells=roofLadderTemplate(params).cells;for(const c of cells)store.set(c.x,c.y,c.z,c.mat);
            const {x,y}=cells[0];
            rec={module:'roof_ladder',params,x,y,foot:m.G,top,landing:{x:params.origin[0],y:params.origin[1],z:top}};m.reserve(x-2,y-2,x+2,y+2);
        } else {
            // PLAN-14: merged parcels can leave a low block no blank facade for a ladder: a two-storey block then takes
            // the roof flight; a single storey keeps an unreachable low roof (exempt from roofsReachable).
            try { rec=placeRoofLadder(m,out,{prefer,blocked}); } catch(e) { if(storeys>=2){roofStair();rec=null;} else {out.lowRoof=true;rec=null;} }
        }
        if(rec){out.roofAccess=rec;out.access.push(rec);}
    }
    for(const rec of out.access)if(rec.module!=='roof_stair')validateAccessModule(store,rec);
    if(b.wingOf)out.wing=b.wingOf;   // PLAN-14: an attached wing (its low roof need not be reachable)
    dressRoof(m,out);
    if(b.floors.some(f=>f.layout==='v3'))furnishBuilding(m,b,out,{beats:(m.beats||[]).filter(bt=>bt.building===b.id)});
    else for(const f of b.floors) {
        const rooms=out.rooms.filter(r=>r.storey===f.floor),floorSet=new Set(rooms.filter(r=>r.gameplay).flatMap(r=>r.cells.map(c=>key(...c))));
        const keepFree=new Set((rooms.find(r=>r.kind==='hall')?.cells||[]).map(c=>key(...c))),obstacles=new Set();
        for(const dr of out.doors.filter(dr=>dr.storey===f.floor&&!dr.locked)) {
            floorSet.add(key(dr.x,dr.y));
            for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)keepFree.add(key(dr.x+dx,dr.y+dy));
        }
        for(const run of out.stairs)if(run.storey===f.floor||run.storey===f.floor-1)for(const c of [run.before,...run.cells,run.after]){keepFree.add(key(c.x,c.y));obstacles.add(key(c.x,c.y));}
        // PLAN-10: keep a vault landing inside every ground-floor window.
        if(f.floor===0)for(const w of out.windows.filter(w=>w.storey===0&&(w.kind==='window'||w.kind==='band')))for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])if(floorSet.has(key(w.x+dx,w.y+dy)))keepFree.add(key(w.x+dx,w.y+dy));
        furnish(store,{floorSet,rooms,fz:m.G+STOREY*f.floor,keepFree,obstacles,rng:createRng(hashString(`${m.id}:${m.seed}:${b.id}:${f.floor}`)),hints:ctx.hints,decor:ctx.decor,wfc:true});
    }
    out.floorCells=out.rooms.filter(r=>r.storey===0&&r.gameplay).flatMap(r=>r.cells);
    m.buildings.push(out);return out;
}

/**
 * Roof plant (HVAC units) on a fixed 5-cell lattice: real objects that give rooftop fights half cover. Units sit
 * one cell inside the parapet, keep two cells clear of every access landing, and never touch each other.
 */
export function dressRoof(m,out) {
    const s=m.store,z=out.top+1,h=hashString(`${m.id}:${out.id}:roof`),ox=h%3,oy=(h>>>3)%3;
    const entries=out.access.flatMap(rec=>rec.module==='fire_escape'?rec.landings.filter(l=>l.toRoof).flatMap(l=>l.cells):[[rec.landing.x,rec.landing.y]]);
    const nearEntry=(x,y)=>entries.some(([ex,ey])=>Math.max(Math.abs(ex-x),Math.abs(ey-y))<=3);
    out.roofPlant=[];
    for(let y=out.y0+2+oy;y<=out.y0+out.d-3;y+=5)for(let x=out.x0+2+ox;x<=out.x0+out.w-3;x+=5) {
        const alongX=((x+y+h)&1)===0,cells=[[x,y],alongX?[x+1,y]:[x,y+1]];
        if(cells.some(([cx,cy])=>cx>out.x0+out.w-3||cy>out.y0+out.d-3||nearEntry(cx,cy)||s.get(cx,cy,z)!==AIR||!s.isSolid(cx,cy,z-1)))continue;
        for(const [cx,cy] of cells){s.set(cx,cy,z,MAT.appliance);m.ctx.hints[`${cx},${cy},${z}`]={piece:'hvac',yaw:alongX?0:Math.PI/2};}
        out.roofPlant.push(cells);
    }
}
