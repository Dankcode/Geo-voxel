import reference from './reference/more-maps-pack.json' with {type:'json'};
// Adapt the exposed XCOM 2 plot/parcel/PCP selection contracts, using this game's own assets.
import { hashString } from '../util/Rng.js';
export function parseXcomMapDefinitions(files) {
    const parcels=[],plots=[],coverPieces=[];
    for(const [file,text] of Object.entries(files)) {
        const active=text.split(/\r?\n/).filter(line=>!/^\s*;/.test(line)).join('\n').replace(/\\\s*\n/g,' ');
        const declarations=/\+(arrAllParcelDefinitions|arrPlots|arrAllPCPDefs)\s*=\s*\(/g;let match;
        while((match=declarations.exec(active))) {
            let i=declarations.lastIndex,depth=1,quoted=false;
            for(;i<active.length&&depth;i++){const c=active[i];if(c==='"')quoted=!quoted;if(!quoted){if(c==='(')depth++;if(c===')')depth--;}}
            if(depth)throw Error(`Unclosed parcel declaration in ${file}`);
            const body=active.slice(declarations.lastIndex,i-1),value=name=>body.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([^,\\s)]+))`))?.slice(1).find(v=>v!==undefined),values=name=>[...body.matchAll(new RegExp(`${name}\\[\\d+\\]\\s*=\\s*"([^"]+)"`,'g'))].map(m=>m[1]);
            const id=value('MapName');if(!id)throw Error('Definition has no MapName');
            const common={id,source:file,objectiveTags:values('ObjectiveTags')};
            if(match[1]==='arrAllParcelDefinitions')parcels.push({...common,size:value('eSize')?.replace('eParcelSizeType_','').toLowerCase(),plotTypes:[...body.matchAll(/strPlotType\s*=\s*"([^"]+)"/g)].map(m=>m[1]),zones:values('arrZoneTypes'),facing:value('eFacing')?.replace('EParcelFacingType_','').toLowerCase()||null,entrances:[...body.matchAll(/bHasEntrance([NESW])(\d+)\s*=\s*true/g)].map(m=>({side:m[1].toLowerCase(),socket:Number(m[2])})),allowNonObjectiveOverride:value('bAllowNonObjectiveOverride')==='true'});
            if(match[1]==='arrPlots')plots.push({...common,plotType:value('strType'),biomes:values('ValidBiomes')});
            if(match[1]==='arrAllPCPDefs')coverPieces.push({...common,plotTypes:values('arrPlotTypes'),type:value('strPCPType'),turn:value('strTurnType'),width:Number(value('iWidth')),length:Number(value('iLength')),checkpoint:value('bAdventCheckpoint')==='true'});
            declarations.lastIndex=i;
        }
    }
    return {version:1,parcels,plots,coverPieces};
}
export const GAME_PARCELS=[
    {id:'small-retail',size:'small',plotTypes:['SmallTown','Slums'],zones:['Retail','Commercial'],programs:['shop','garage'],objectiveTags:[],allowNonObjectiveOverride:true,wall:'brick',entrances:['street','service']},
    {id:'medium-retail',size:'medium',plotTypes:['SmallTown','Slums'],zones:['Retail','Commercial'],programs:['shop','garage','diner'],objectiveTags:['Recover','Hack'],allowNonObjectiveOverride:true,wall:'stucco',entrances:['street','service']},
    {id:'medium-security',size:'medium',plotTypes:['SmallTown','Wilderness'],zones:['Retail','Neighborhood'],programs:['office'],objectiveTags:['Recover','Hack'],allowNonObjectiveOverride:true,wall:'concrete_wall',entrances:['street','service']},
    {id:'large-retail',size:'large',plotTypes:['SmallTown','Slums'],zones:['Retail','Commercial'],programs:['shop','warehouse'],objectiveTags:['Recover'],allowNonObjectiveOverride:true,wall:'brick',entrances:['street','service']},
];
/** Hard compatibility first; stable seeded choice then balances neighbouring architectural styles. */
export function selectParcel(slot,catalog=GAME_PARCELS,seed=1,used=new Map()) {
    if(!reference.parcels.some(p=>p.size===slot.size))throw Error(`parcel.size: unknown imported size ${slot.size}`);
    const pool=catalog.filter(p=>p.size===slot.size&&p.plotTypes.includes(slot.plotType)&&p.zones.includes(slot.zone)&&(!slot.program||p.programs.includes(slot.program))&&(!slot.objectiveTag||p.objectiveTags.includes(slot.objectiveTag))&&(slot.objectiveTag||!p.objectiveTags.length||p.allowNonObjectiveOverride)&&(!slot.entrances||slot.entrances.every(e=>p.entrances.includes(e))));
    if(!pool.length)throw Error(`parcel.compatibility: no ${slot.size}/${slot.plotType}/${slot.zone}/${slot.program} for ${slot.id}`);
    pool.sort((a,b)=>(used.get(a.id)||0)-(used.get(b.id)||0)||hashString(`${seed}:${slot.id}:${a.id}`)-hashString(`${seed}:${slot.id}:${b.id}`));
    const p=pool[0];used.set(p.id,(used.get(p.id)||0)+1);
    const source=reference.parcels.find(r=>r.size===slot.size&&r.plotTypes.includes(slot.plotType)&&r.zones.includes(slot.zone)&&(!slot.objectiveTag||r.objectiveTags.includes(slot.objectiveTag)));
    const sides=['n','e','s','w'],rotation=(sides.indexOf(slot.front)-sides.indexOf(source?.facing||'s')+4)%4;
    const sourceProfile=source?.id||null;
    return {sourceProfile,rotation,slot:slot.id,prototype:p.id,size:p.size,plotType:slot.plotType,zone:slot.zone,program:slot.program||p.programs[0],front:slot.front,wall:p.wall,objectiveTag:slot.objectiveTag||null,entrances:slot.entrances||[]};
}
export function solveReferenceParcels(site,buildings,seed=1) {
    if(!site.parcelPlan)return [];
    const used=new Map();return buildings.map(b=>{
        const slot=site.parcelPlan.slots.find(s=>s.id===b.id);if(!slot)throw Error(`parcel.slot: missing reference building ${b.id}`);
        return selectParcel({...slot,program:b.program,front:b.front,plotType:slot.plotType||site.parcelPlan.plotType},GAME_PARCELS,seed,used);
    });
}
