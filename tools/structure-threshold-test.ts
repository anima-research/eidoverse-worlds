// bun tools/structure-threshold-test.ts — real planner, WorldAgent ticks and tool.
// Renderer/server-free. The route oracle computes wall crossings independently
// of the planner, from authored edges, so a shared predicate bug cannot pass it.
import { strict as assert } from "node:assert";
import { planStructure, planRouteLocal, routeLocal, localizePoint } from "../shared/structure.js";
import { WorldAgent } from "../mcpl/agent.ts";
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
check(sparseResult.kind==="blocked" && sparseResult.reason!.includes("cells"),"huge sparse bounds return named budget refusal");
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
check(planRouteLocal(p,NaN,0,1,1).kind==="blocked","non-finite endpoints are refused");

// Main still selects its first storey (#140 is separate), so place the upper
// level first to exercise upper-floor policy independently of that selector.
const upper = structuredClone(house.levels[0]); upper.y = 3;
const stacked = { levels: [upper, { ...structuredClone(house.levels[0]), y: 0 }] };
const upstairs = planRouteLocal(planStructure(stacked), .5,1.5,3.5,1.5,3.1);
check(upstairs.kind === "routed" && upstairs.points.every(([x,z])=>x>=0&&x<=4&&z>=0&&z<=2),
  "upper-storey routes stay on the floor instead of using an outdoor shortcut");
upper.apertures = [[0,0,0,"door"]]; // a ground-level exterior exit is air upstairs
check(planRouteLocal(planStructure(stacked), .5,1.5,3.5,1.5,3.1).kind === "blocked",
  "upper-storey sealed partition cannot be bypassed across air");
check(planRouteLocal(planStructure(stacked), .5,1.5,.5,-2,3.1).kind === "blocked",
  "upper-storey exterior destination is a refusal, not vertical navigation");

check(planRouteLocal(planStructure(stacked), .2,.2,.2,.2,3.1).kind === "clear",
  "same upper-floor point does not detour through the cell center");
check(planRouteLocal(planStructure(stacked), .2,.2,.4,.3,3.1).kind === "clear",
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
  for (let i=0;i<iterations && (a as any).target;i++) {
    (a as any).tick(); samples.push([a.pos.x,a.pos.z]);
  }
  if ((a as any).target) { a.stop(); throw new Error("walk failed to finish within bounded ticks"); }
  return { arrived: await promise, samples };
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

  const c=agent(); c.pos={x:-1,y:0,z:.5};
  c.entities.set("sparse",entity(sparse as any,"sparse"));
  const cap=await handleTool({...ctx,agent:c},"walk_to",{x:1,z:.5});
  check(cap.content[0].text.includes("cells") && !(c as any).target,"actual tool reports budget refusal without movement");

  // Independent review repro: a foreign wall's detour must not discharge
  // the floor-only constraint imposed by the structure supporting the start.
  const support=agent(); support.pos={x:.5,y:3.1,z:.5};
  const floor={levels:[{y:3,tiles:[[0,0],[2,0]],walls:[],apertures:[]},
    {y:0,tiles:[],walls:[],apertures:[]}]};
  const foreign={levels:[{y:3,tiles:[[10,10]],walls:[[1,1,0]],apertures:[]}]};
  support.entities.set("floor",entity(floor as any,"floor"));
  support.entities.set("foreign",entity(foreign as any,"foreign"));
  const unsupported=await walk(support,[2.5,.5]);
  check(!unsupported.arrived && !!support.walkRefusal?.includes("upper-floor"),
    "foreign building candidate cannot override supporting upper-floor refusal");
  check(unsupported.samples.every(([x,z])=>x===.5&&z===.5),"foreign detour refusal leaves the body where it stands");
  floor.levels[0].tiles=[[0,0],[0,1],[0,2],[1,2],[2,2],[2,1],[2,0]];
  // Replace component identity too, so #200's plan cache sees the changed floor.
  support.entities.set("floor",entity(structuredClone(floor) as any,"floor"));
  support.pos={x:.5,y:3.1,z:.5};
  const supported=await walk(support,[2.5,.5]);
  const cells=new Set(floor.levels[0].tiles.map(([x,z])=>x+","+z));
  check(supported.arrived && supported.samples.every(([x,z])=>cells.has(Math.floor(x)+","+Math.floor(z))),
    "longer supported route wins over a shorter foreign unsupported shortcut");

  const nearby=agent(); nearby.pos={x:.2,y:3.1,z:.2};
  const oneFloor={levels:[{y:3,tiles:[[0,0]],walls:[],apertures:[]},
    {y:0,tiles:[],walls:[],apertures:[]}]};
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
  upperWall.levels[0].tiles=[[10,10]]; upperWall.levels[0].walls=[[1,1,0]];
  check(planRouteLocal(planStructure(upperWall),.5,.5,2.5,.5,3.1).kind==="blocked",
    "an upper floor not supporting the origin still reports a real wall obstruction");

  // Two structures offer individually legal but mutually conflicting routes.
  const base=entity(house,"one"); const two=entity(house,"two",[-1,0,0]);
  const d=agent(); d.entities.set("one",base); d.entities.set("two",two);
  d.pos={x:-2,y:0,z:1.5};
  const outcome=await walk(d,[5,1.5]);
  check(!outcome.arrived && !!d.walkRefusal?.includes("multi-building"),"conflicting second structure gets explicit local-search refusal");
  if (typeof (d as any).groundAt === "function") {
    // This branch runs in the isolated combination with PR #200. It cannot
    // claim upstairs product coverage from main's terrain-only body clamp.
    const u=agent();
    const above=structuredClone(house.levels[0]); above.y=3;
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    u.pos={x:.2,y:3.1,z:.2};
    const stationary=await walk(u,[.2,.2]);
    check(stationary.arrived && stationary.samples.every(([x,z])=>x===.2&&z===.2),
      "#200 combination stays put for an off-center stationary walk request");
    u.pos={x:.5,y:3.1,z:.5};
    const out=await walk(u,[.5,-2]);
    check(!out.arrived && !!u.walkRefusal?.includes("floored endpoints"),"#200 combination refuses an upper destination beyond the floor");
    check(u.pos.x===.5 && u.pos.z===.5 && u.pos.y===3.1,"#200 combination refusal preserves upstairs standing position");
    above.tiles=[[0,0],[2,0]]; above.walls=[]; above.apertures=[];
    u.entities.set("stacked",entity({ levels: [structuredClone(house.levels[0]),above] } as any,"stacked"));
    const gap=await walk(u,[2.5,.5]);
    check(!gap.arrived && !(u as any).target,"#200 combination refuses crossing a gap in sparse upper floors");
  } else {
    console.log("Main has no #200 standing-height resolver; combined upper-storey product checks are separate.");
  }
  console.log("PASS " + checks + " threshold routing checks");
} finally { for (const a of agents) a.close(); }
process.exit(0);
