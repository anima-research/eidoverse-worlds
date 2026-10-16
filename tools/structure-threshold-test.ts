// bun tools/structure-threshold-test.ts — real planner, WorldAgent ticks and tool.
// Renderer/server-free. The route oracle computes wall crossings independently
// of the planner, from authored edges, so a shared predicate bug cannot pass it.
import { strict as assert } from "node:assert";
import { planStructure, planRouteLocal, prepareRouteLocal, routeLocal, localizePoint } from "../shared/structure.js";
import { NON_FINITE_ENDPOINT } from "../shared/structure-route.js";
import { WorldAgent, WALK_ARGS_REASON } from "../mcpl/agent.ts";
import { handleTool } from "../mcpl/tools.ts";
process.env.AGENT_BODY_ENGINE = "verlet";
let checks = 0;
function check(ok: unknown, name: string) { assert.ok(ok, name); checks++; console.log("✓ " + name); }
const house = { levels: [{ y: 0,
  tiles: Array.from({ length: 8 }, (_, i) => [i % 4, Math.floor(i / 4)]),
  walls: [...Array.from({ length: 4 }, (_, x) => [0,x,0]), ...Array.from({ length: 4 }, (_, x) => [0,x,2]),
    [1,0,0],[1,0,1],[1,4,0],[1,4,1],[1,2,0],[1,2,1]],
  apertures: [[0,0,0,"door"],[1,2,0,"door"]],
}] };
type P = [number, number];
function crosses(data: any, a: P, b: P) {
  const tile = data.tile ?? 1;
  return data.levels[0].walls.some(([axis,x,z]: number[]) => {
    if (data.levels[0].apertures?.some(([k,i,j,kind]: any[]) => k===axis && i===x && j===z && (kind==="door" || kind==="arch"))) return false;
    // Parametric line at the wall, checked against the wall's closed span.
    const A = axis === 0 ? 0 : 1;
    const B = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? -1 : 1;
    const C = (axis === 0 ? z : axis === 1 ? x : axis === 2 ? x-z : x+z+1) * tile;
    const v0 = A*a[0]+B*a[1]-C, v1 = A*b[0]+B*b[1]-C;
    if (v0*v1 > 0 || Math.abs(v0-v1)<1e-10) return false;
    const t = v0/(v0-v1), px = a[0]+t*(b[0]-a[0]), pz = a[1]+t*(b[1]-a[1]);
    if (t < -1e-8 || t > 1+1e-8) return false;
    return axis===0 ? px>=x*tile-1e-8 && px<=(x+1)*tile+1e-8 :
      axis===1 ? pz>=z*tile-1e-8 && pz<=(z+1)*tile+1e-8 :
      px>=x*tile-1e-8 && px<=(x+1)*tile+1e-8 && pz>=z*tile-1e-8 && pz<=(z+1)*tile+1e-8;
  });
}
function valid(data: any, points: number[][]) {
  return points.slice(1).every((p,i) => !crosses(data,points[i] as P,p as P));
}
function route(data: any, from: P, to: P, name: string) {
  const result = planRouteLocal(planStructure(data),...from,...to);
  check(result.kind !== "blocked", name + ": finds a route");
  check(result.points[0][0]===from[0] && result.points[0][1]===from[1] && result.points.at(-1)![0]===to[0] && result.points.at(-1)![1]===to[1], name + ": preserves endpoints");
  check(valid(data,result.points), name + ": every actual leg respects authored walls");
  return result.points;
}
const p = planStructure(house);
route(house,[.5,-3],[3.5,.5],"north entry");
route(house,[3.5,3],[3.5,.5],"far-side door approach");
route(house,[3.5,.5],[3.5,3],"exit to far side");
route(house,[-1,1.5],[5,1.5],"both outside across building");
route(house,[.15,1.88],[3.85,1.12],"off-center interior endpoints");
route(house,[-100000,1.5],[3.5,.5],"distant start uses bounded local region");
route(house,[3.5,.5],[100000,1.5],"distant destination uses bounded local region");
check(planRouteLocal(p,-2,-2,-1,-1).kind==="clear","unobstructed outdoors is a direct leg");

const sealed = structuredClone(house); sealed.levels[0].apertures = [[0,0,0,"window"],[1,2,0,"door"]];
check(planRouteLocal(planStructure(sealed),.5,-3,3.5,.5).kind==="blocked","window-only exterior refuses entry");
check(routeLocal(planStructure(sealed),.5,-3,3.5,.5)===null,"compatibility route returns null for refusal");
const sparse = { levels: [{ tiles: [], walls: [[1,0,0],[1,100000000,0]], apertures: [] }] };
const sparseResult = planRouteLocal(planStructure(sparse),-1,.5,1,.5);
check(sparseResult.kind==="blocked" && sparseResult.reason!.includes("over the 16384-cell routing limit") && sparseResult.reason!.includes("nearer endpoints won't help"),
  "huge sparse bounds return a named budget refusal that says nearer endpoints won't help");
check(planRouteLocal(planStructure(sparse),-1,-1,-2,-2).kind==="clear","clear path remains possible beside huge sparse geometry");
const wallOnly = { levels: [{ tiles: [], walls: [[1,0,0]], apertures: [] }] };
route(wallOnly,[-.5,.5],[.5,.5],"unfloored exterior wall");
for (const axis of [2,3]) {
  // One triangular room, with the other half genuinely outdoors.
  const north = [0,0,0];
  const side = axis===2 ? [1,1,0] : [1,0,0];
  const d = { levels: [{ tiles: [[0,0,"floor","A"]], walls: [[axis,0,0],north,side],
    apertures: [[axis,0,0,"door"]] }] };
  const target: P = axis===2 ? [.8,.2] : [.2,.2];
  route(d,[.5,2],target,"diagonal " + axis + " exterior doorway");
  d.levels[0].apertures = [[axis,0,0,"window"]];
  check(planRouteLocal(planStructure(d),.5,2,...target).kind==="blocked","diagonal " + axis + " window refuses passage");
}
for (const axis of [2,3]) {
  const d = { levels: [{ tiles: [[0,0]], walls: [[axis,0,0]], apertures: [] }] };
  route(d, axis===2 ? [.8,.2] : [.2,.2], axis===2 ? [.2,.8] : [.8,.8], "around solid diagonal " + axis);
}
const concave = { levels: [{ tiles: [[0,0],[1,0],[0,1]],
  walls: [[0,0,0],[0,1,0],[1,0,0],[1,0,1],[0,0,2],[1,1,1],[0,1,1],[1,2,0]],
  apertures: [[0,1,1,"arch"]] }] };
route(concave,[2.5,1.5],[.25,1.75],"concave outline to reentrant arch");
const courtyard = { levels: [{ tiles: [[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[1,2],[2,2]],
  walls: [[0,1,1],[0,1,2],[1,1,1],[1,2,1]], apertures: [[0,1,1,"door"]] }] };
route(courtyard,[1.5,1.5],[3.5,1.5],"unfloored courtyard through its door");
check(planRouteLocal(p,NaN,0,1,1).kind==="blocked"&&planRouteLocal(p,NaN,0,1,1).reason===NON_FINITE_ENDPOINT,"non-finite endpoints are refused, with the router's one reason for them");
// A terrain leg along a wall's projection is refused even when the wall is
// overhead: point queries can't bound the terrain over the whole overlap. The
// walk is routed away from the wall's line instead.
const overhead={levels:[{y:3,tiles:[],walls:[[0,0,0]],apertures:[]}]};
check(planRouteLocal(planStructure(overhead),-1,.5,2,.5).kind==="clear","an overhead wall's crossing leaves a terrain leg clear");
const along=planRouteLocal(planStructure(overhead),-1,0,2,0);
check(along.kind==="routed"&&!along.points.some((q:number[],i:number)=>i>0&&along.points[i-1][1]===0&&q[1]===0
  &&Math.min(along.points[i-1][0],q[0])<1&&Math.max(along.points[i-1][0],q[0])>0),
  "a terrain leg along a projected wall is routed away from its line");

// Floor-mode tests supply an explicit support owner/height. They do not
// manufacture elevated standing on main, whose body remains terrain-clamped.
const upper = structuredClone(house.levels[0]); upper.y = 3;
const stacked = { levels: [{ ...structuredClone(house.levels[0]), y: 0 }, upper] };
const floorRoute = (data: any, from: P, to: P, level=1, height=3.1) =>
  prepareRouteLocal(planStructure(data),{kind:"floor",level,height,step:.5}).route(...from,...to);
const upstairs = floorRoute(stacked,[.5,1.5],[3.5,1.5]);
check(upstairs.kind === "routed" && upstairs.points.every(([x,z])=>x>=0&&x<=4&&z>=0&&z<=2),
  "upper-storey routes stay on the floor instead of using an outdoor shortcut");
upper.apertures = [[0,0,0,"door"]]; // a ground-level exterior exit is air upstairs
check(floorRoute(stacked,[.5,1.5],[3.5,1.5]).kind === "blocked",
  "upper-storey sealed partition cannot be bypassed across air");
check(floorRoute(stacked,[.5,1.5],[.5,-2]).kind === "blocked",
  "upper-storey exterior destination is a refusal, not vertical navigation");

check(floorRoute(stacked,[.2,.2],[.2,.2]).kind === "clear",
  "same upper-floor point does not detour through the cell center");
check(floorRoute(stacked,[.2,.2],[.4,.3]).kind === "clear",
  "clear same-cell upper-floor positioning keeps its direct segment");

const agents: WorldAgent[] = [];
function agent() {
  const a = new WorldAgent({ name: "walker", avatar: "", world: "test" });
  agents.push(a); a.joined = true; return a;
}
function entity(data=house, id="house", pos=[0,0,0], yaw=0, scale=1): any {
  return { id, lib: "", pos, yaw, scale, comp: { structure: data } };
}
function worldPoint(e: any, p: P): P {
  const c=Math.cos(e.yaw),s=Math.sin(e.yaw);
  return [e.pos[0]+(p[0]*c+p[1]*s)*e.scale,e.pos[2]+(-p[0]*s+p[1]*c)*e.scale];
}
async function walk(a: WorldAgent, to: P, tolerance=0, iterations=2000) {
  const samples: P[] = [[a.pos.x,a.pos.z]];
  const promise=a.walkTo(...to,true,10000,tolerance);
  // The waypoints as planned: the first target, then the legs after it.
  const planned: P[] = (a as any).target ? [(a as any).target,...(a as any).legs].map((q:any)=>[q.x,q.z] as P) : [];
  for (let i=0;i<iterations && (a as any).target;i++) {
    (a as any).tick(); samples.push([a.pos.x,a.pos.z]);
  }
  if ((a as any).target) { a.stop(); throw new Error("walk failed to finish within bounded ticks"); }
  return { arrived: await promise, samples, planned };
}
// A body held on an upper floor. Main's body stands on terrain only, so these
// bodies are given the floor support the storey-standing work (#200) supplies,
// as walkSupport answers it there; walkTo's floor branch serves that answer.
function standOn(a: WorldAgent, entity: string, level: number, height: number) {
  (a as any).walkSupport=()=>({kind:"floor",height,entity,level});
}
try {
  for (const [label, e] of [["base",entity()],["transformed",entity(house,"house",[10,0,-5],Math.PI/3,2)]] as const) {
    const a=agent(); a.entities.set(e.id,e);
    const from=worldPoint(e,[3.5,3]), to=worldPoint(e,[3.5,.5]); a.pos.x=from[0]; a.pos.z=from[1];
    const w=await walk(a,to,.4);
    check(w.arrived,label+": actual walkTo/ticks arrive");
    const local=w.samples.map(([x,z])=>{const [lx,,lz]=localizePoint(e,x,0,z);return [lx,lz];});
    check(valid(house,local),label+": actual tick trajectory with tolerance 0.4 crosses no wall");
    check(Math.hypot(a.pos.x-to[0],a.pos.z-to[1])<=.4,label+": destination tolerance remains honored");
    // Only the destination takes the caller's tolerance: the body stands on
    // each corner exactly before it turns.
    check(w.planned.length>2&&w.planned.slice(0,-1).every(([x,z])=>w.samples.some(([sx,sz])=>sx===x&&sz===z)),
      label+": every intermediate waypoint is reached exactly despite tolerance 0.4");
  }
  const a=agent(); a.pos={x:.5,y:0,z:-3};
  a.entities.set("junk",entity("junk" as any,"junk",[500,0,500]));
  a.entities.set("irrelevant",entity(house,"irrelevant",[100,0,100]));
  a.entities.set("house",entity());
  check((await walk(a,[3.5,.5])).arrived,"irrelevant and primitive structure data do not prevent the real route");

  const b=agent(); b.entities.set("sealed",entity(sealed,"sealed")); b.pos={x:.5,y:0,z:-3};
  const old=b.walkTo(-3,-3,true);
  const result=await walk(b,[3.5,.5]);
  check(!result.arrived && !(await old) && !(b as any).target && !(b as any).legs.length,"refused replacement settles both walks and clears old target/legs");
  const before=[b.pos.x,b.pos.z]; (b as any).tick();
  check(b.pos.x===before[0]&&b.pos.z===before[1],"refused replacement cannot keep walking toward old target");
  const ctx={agent:b,canPush:()=>false,heldActivity:[],cursor:{caughtUpTo:null}};
  const reply=await handleTool(ctx,"walk_to",{x:3.5,z:.5});
  check(reply.content[0].text.includes("no route") && reply.content[0].text.includes("sealed"),"actual walk_to tool explains sealed-building refusal");

  const badArgs=await handleTool(ctx,"walk_to",{x:NaN,z:.5});
  check(badArgs.isError===true && badArgs.content[0].text===WALK_ARGS_REASON,"the tool and walkTo refuse bad arguments in the same words");

  const c=agent(); c.pos={x:-1,y:0,z:.5};
  c.entities.set("sparse",entity(sparse as any,"sparse"));
  const cap=await handleTool({...ctx,agent:c},"walk_to",{x:1,z:.5});
  check(cap.content[0].text.includes("cells") && !(c as any).target,"actual tool reports budget refusal without movement");

  {
  // A foreign wall's detour must not discharge the floor-only constraint
  // imposed by the structure supporting the start.
  const support=agent(); support.pos={x:.5,y:3.1,z:.5}; standOn(support,"floor",1,3.1);
  const floor={levels:[{y:0,tiles:[],walls:[],apertures:[]},
    {y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]}]};
  const foreign={levels:[{y:3,tiles:[[10,10]],walls:[[1,1,0]],apertures:[]}]};
  support.entities.set("floor",entity(floor as any,"floor"));
  support.entities.set("foreign",entity(foreign as any,"foreign"));
  const unsupported=await walk(support,[2.5,.5]);
  check(!unsupported.arrived && !!support.walkRefusal,
    "foreign building candidate cannot override supporting upper-floor refusal");
  check(unsupported.samples.every(([x,z])=>x===.5&&z===.5),"foreign detour refusal leaves the body where it stands");
  floor.levels[1].tiles=[[0,0],[0,1],[0,2],[1,2],[2,2],[2,1],[2,0]];
  // Replace component identity too, so #200's plan cache sees the changed floor.
  support.entities.set("floor",entity(structuredClone(floor) as any,"floor"));
  support.pos={x:.5,y:3.1,z:.5};
  const supported=await walk(support,[2.5,.5]);
  const cells=new Set(floor.levels[1].tiles.map(([x,z])=>x+","+z));
  check(supported.arrived && supported.samples.every(([x,z])=>cells.has(Math.floor(x)+","+Math.floor(z))),
    "longer supported route wins over a shorter foreign unsupported shortcut");

  const nearby=agent(); nearby.pos={x:.2,y:3.1,z:.2}; standOn(nearby,"nearby",1,3.1);
  const oneFloor={levels:[{y:0,tiles:[],walls:[],apertures:[]},
    {y:3,tiles:[[0,0]],walls:[],apertures:[]}]};
  nearby.entities.set("nearby",entity(oneFloor as any,"nearby"));
  nearby.entities.set("distant",entity(oneFloor as any,"distant",[100,0,100]));
  const localMove=await walk(nearby,[.3,.3]);
  check(localMove.arrived && localMove.samples.every(([x,z])=>x>=.2&&x<=.3&&z>=.2&&z<=.3),
    "unrelated upper floor cannot veto a direct walk on the supporting floor");
  const stay=await walk(nearby,[.3,.3]);
  check(stay.arrived && stay.samples.every(([x,z])=>x===.3&&z===.3),
    "unrelated upper floor cannot veto a stationary supported walk");
  const free=agent(); free.pos={x:5,y:0,z:5};
  free.entities.set("distant",entity(oneFloor as any,"distant",[100,0,100]));
  check((await walk(free,[5.2,5.2])).arrived,"unrelated upper floor alone cannot veto a clear ground walk");
  const upperWall=structuredClone(oneFloor);
  upperWall.levels[1].tiles=[[10,10]]; upperWall.levels[1].walls=[[1,1,0]];
  check(prepareRouteLocal(planStructure(upperWall),{kind:"floor",height:3.1}).route(.5,.5,2.5,.5).kind==="blocked",
    "an upper floor not supporting the origin still reports a real wall obstruction");

  }
  // Two structures offer individually legal but mutually conflicting routes.
  const base=entity(house,"one"); const two=entity(house,"two",[-1,0,0]);
  const d=agent(); d.entities.set("one",base); d.entities.set("two",two);
  d.pos={x:-2,y:0,z:1.5};
  const outcome=await walk(d,[5,1.5]);
  check(!outcome.arrived && !!d.walkRefusal?.includes("multi-building"),"conflicting second structure gets explicit local-search refusal");
  check(/\[(one|two)\]'s route is obstructed by \[(one|two)\]/.test(d.walkRefusal!),"the refusal names which structure obstructed which route: "+d.walkRefusal);
  // A third structure, over the search limit, keeps its own reason beside them.
  d.entities.set("huge",entity({ levels: [{ tiles: [], walls: [[1,3,1],[1,100000000,0]], apertures: [] }] } as any,"huge"));
  d.pos={x:-2,y:0,z:1.5};
  const withHuge=await walk(d,[5,1.5]);
  check(!withHuge.arrived && d.walkRefusal!.includes("multi-building") && d.walkRefusal!.includes("[huge]: its footprint")
    && d.walkRefusal!.includes("over the 16384-cell routing limit"),"an over-limit structure's own reason survives the generic refusal");
  {
    // A body held on an upper floor of a stacked house.
    const u=agent();
    const above=structuredClone(house.levels[0]); above.y=3;
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    u.pos={x:.2,y:3.1,z:.2}; standOn(u,"stacked",1,3.1);
    const stationary=await walk(u,[.2,.2]);
    check(stationary.arrived && stationary.samples.every(([x,z])=>x===.2&&z===.2),
      "a floor-held body stays put for an off-center stationary walk request");
    u.pos={x:.5,y:3.1,z:.5};
    const out=await walk(u,[.5,-2]);
    check(!out.arrived && !!u.walkRefusal?.includes("the destination isn't on this floor"),"a floor-held body is refused an upper destination beyond the floor");
    check(u.pos.x===.5 && u.pos.z===.5 && u.pos.y===3.1,"and the refusal leaves it standing where it was upstairs");
    u.pos={x:-.5,y:3.1,z:.5};
    const offStart=await walk(u,[.5,.5]);
    check(!offStart.arrived && !!u.walkRefusal?.includes("the start isn't on this floor") && !u.walkRefusal?.includes("destination isn't"),
      "a floor-held body standing off the floor is told the start is the endpoint off it");
    u.pos={x:.5,y:3.1,z:.5};
    above.tiles=[[0,0],[2,0]]; above.walls=[]; above.apertures=[];
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    const gap=await walk(u,[2.5,.5]);
    check(!gap.arrived && !(u as any).target,"a floor-held body is refused crossing a gap in sparse upper floors");
    check(!!u.walkRefusal?.includes("a hole in the floor can divide it"),"...and told a hole can divide a floor, not only its walls");
  }

  // A structure the agent can't check (its geometry isn't finite: a 10 m
  // tile at x = 1e308) is skipped for every walk, and logged once: it
  // neither refuses an unrelated walk nor stops a real route elsewhere.
  const warned: string[] = [], warn=console.warn;
  console.warn=(...args: unknown[])=>{ warned.push(args.map(String).join(" ")); };
  try {
    const s=agent(); s.pos={x:.5,y:0,z:-3};
    s.entities.set("house",entity());
    s.entities.set("broken",entity({ tile: 10, levels: [{ tiles: [], walls: [[0,1e308,0]], apertures: [] }] } as any,"broken"));
    check((await walk(s,[3.5,.5])).arrived,"an unplannable structure doesn't stop a real route elsewhere");
    s.pos={x:-5,y:0,z:-5};
    check((await walk(s,[-6,-6])).arrived && s.walkRefusal===null,"nor refuse an unrelated walk");
    check(warned.filter(l=>l.includes("[broken]")).length===1,"and the operator's log names it once");
  } finally { console.warn=warn; }

  // A structure carried by another is checked where it is now (the carrier's
  // place), not at its own rest pose.
  const carried=agent();
  carried.entities.set("cart",{ id:"cart", lib:"", pos:[10,0,0], yaw:0, scale:1 } as any);
  carried.entities.set("house",entity());
  carried.mounts.set("house",{ to:"cart" });
  carried.pos={x:10.5,y:0,z:-3};
  const here=await walk(carried,[13.5,.5]);
  const local=here.samples.map(([x,z])=>[x-10,z] as P);
  check(here.arrived && here.planned.length>1 && valid(house,local),"a carried structure's walls are checked at its carrier's place");
  carried.pos={x:.5,y:0,z:-3};
  const rest=await walk(carried,[3.5,.5]);
  check(rest.arrived && rest.planned.length===1,"and its rest pose, where nothing stands now, is walked straight across");

  // A body standing in a wall (a door edited to a window under its feet)
  // steps out to the nearest clear point beside it, and is routed from there.
  const inWall=agent(); inWall.entities.set("house",entity()); inWall.pos={x:0,y:0,z:1.5};
  const out2=await walk(inWall,[3.5,.5]);
  const step=out2.planned[0];
  check(out2.arrived && Math.hypot(step[0],step[1]-1.5)<=.5 && step[0]>0,"a body standing in a wall steps out beside it, toward its destination");
  check(valid(house,out2.samples.slice(1)),"and walks on without crossing a wall");
  const shut={ levels: [{ tiles: [[0,0]], walls: [[0,0,0],[0,0,1],[1,0,0],[1,1,0]], apertures: [] }] };
  const vault={ levels: [{ tiles: [[0,0]], walls: [[0,0,0],[0,0,1],[1,0,0],[1,1,0]], apertures: [] }] };
  const stuck=agent(); stuck.entities.set("shut",entity(shut as any,"shut")); stuck.entities.set("vault",entity(vault as any,"vault",[10,0,10]));
  stuck.pos={x:0,y:0,z:.5};
  const nowhere=await walk(stuck,[10.5,10.5]);
  check(!nowhere.arrived && stuck.walkRefusal!.startsWith("the body stands in a wall, and from beside it: ") && stuck.walkRefusal!.includes("[vault]")
    && stuck.walkRefusal!.includes("; from another side: "),
    "a body in a wall with no route from either side gives each side's reason: "+stuck.walkRefusal);
  console.log("PASS " + checks + " threshold routing checks");
} finally { for (const a of agents) a.close(); }
process.exit(0);
