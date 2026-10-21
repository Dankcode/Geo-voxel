// Source centerlines become connected carriageways and curbs. All coordinates use one site transform.
export function smoothRoad(points,steps=10) {
    const out=[];
    for(let i=0;i<points.length-1;i++) {
        const p0=points[Math.max(0,i-1)],p1=points[i],p2=points[i+1],p3=points[Math.min(points.length-1,i+2)];
        for(let j=0;j<steps;j++){const t=j/steps,t2=t*t,t3=t2*t;out.push([0,1].map(k=>.5*((2*p1[k])+(-p0[k]+p2[k])*t+(2*p0[k]-5*p1[k]+4*p2[k]-p3[k])*t2+(-p0[k]+3*p1[k]-3*p2[k]+p3[k])*t3)));}
    }
    out.push(points.at(-1));return out;
}
export function roadSamples(road,step=.5) {
    const out=[];let distance=0;
    for(let i=1;i<road.points.length;i++) {
        const a=road.points[i-1],b=road.points[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
        const count=Math.max(1,Math.ceil(len/step));for(let j=0;j<count;j++){const t=j/count;out.push({x:a[0]+(b[0]-a[0])*t,y:a[1]+(b[1]-a[1])*t,distance:distance+len*t,dx:(b[0]-a[0])/(len||1),dy:(b[1]-a[1])/(len||1)});}distance+=len;
    }
    return out;
}
export function rasterRoadNetwork(roads,w,h,{blocked=()=>false}={}) {
    const cells=new Map();
    for(const road of roads)for(const p of roadSamples(road)) {
        const radius=road.width/2;
        for(let y=Math.max(0,Math.floor(p.y-radius-1.5));y<=Math.min(h-1,Math.ceil(p.y+radius+1.5));y++)for(let x=Math.max(0,Math.floor(p.x-radius-1.5));x<=Math.min(w-1,Math.ceil(p.x+radius+1.5));x++) {
            if(blocked(x,y))continue;const d=Math.hypot(x-p.x,y-p.y);if(d>radius+1.5)continue;
            const roadCell=d<=radius,old=cells.get(`${x},${y}`);
            if(!old||roadCell&&!old.road||roadCell===old.road&&d<old.distance)cells.set(`${x},${y}`,{x,y,road:roadCell,material:roadCell?'asphalt':'concrete',id:road.id,distance:d,edge:radius-d,axis:Math.abs(p.dx)>=Math.abs(p.dy)?'x':'y'});
        }
    }
    // Dashed lane dividers are ground markings, never obstacles.
    for(const road of roads)for(const p of roadSamples(road,.6))if(Math.floor(p.distance)%8<4) {
        const x=Math.round(p.x),y=Math.round(p.y),c=cells.get(`${x},${y}`);if(c?.road)c.material='road_mark';
    }
    return [...cells.values()];
}
export function pointInRegion(points,x,y) {
    if(!points?.length)return true;let inside=false;
    for(let i=0,j=points.length-1;i<points.length;j=i++) {
        const a=points[i],b=points[j],cross=(x-a[0])*(b[1]-a[1])-(y-a[1])*(b[0]-a[0]);
        if(Math.abs(cross)<1e-7&&x>=Math.min(a[0],b[0])-1e-7&&x<=Math.max(a[0],b[0])+1e-7&&y>=Math.min(a[1],b[1])-1e-7&&y<=Math.max(a[1],b[1])+1e-7)return true;
        if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }return inside;
}
