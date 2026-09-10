import {join} from 'node:path';
const cases=[
 {name:'coarse arrival floor',file:'mcpl/agent.ts',from:'dist <= (this.target.tolerance ?? ARRIVE)',to:'dist <= 0.4',test:'walk-precision-test.ts',witness:'sub-40cm request moves'},
 {name:'posture not applied',file:'mcpl/body-state.ts',from:'if (item.animation) this.clips.apply',to:'if (false) this.clips.apply',test:'live-contact-test.ts',witness:'sit changes the current knee'},
 {name:'live target not solved',file:'shared/reachorder.js',from:'order.push(nodes.get(key));',to:'order.unshift(nodes.get(key));',test:'live-contact-test.ts',witness:'real reach aims at the other hand live transform'},
 {name:'browser uses insertion order',file:'client/lib/avatar.js',from:'for (const { limb: key, reach: r } of plan.order)',to:'for (const { limb: key, reach: r } of [...this._reach].map(([limb, reach]) => ({ limb, reach })))',test:'reach-order-test.ts',witness:'follower-first: target is the producer'},
 {name:'elbow loses physical incumbent',file:'shared/reach.js',from:'if (Number.isFinite(o.lastGap) &&',to:'if (false &&',test:'reach-continuity-test.ts',witness:'lateral bend basis crossing'},
 {name:'palm loses continuity',file:'shared/reach.js',from:'if (Number.isFinite(o.lastTwist)) {',to:'if (false) {',test:'reach-continuity-test.ts',witness:'palm antipode'},
 {name:'wrist loses rate bound',file:'shared/reach.js',from:'if (o.lastWrist && Number.isFinite(o.dt)) handLocal',to:'if (false) handLocal',test:'reach-continuity-test.ts',witness:'wrist orientation changes stay bounded'},
];
async function run(test:string,m?:object){
 const p=Bun.spawn([process.execPath,...(m?['--preload',join(import.meta.dir,'contact-mutation-preload.ts')]:[]),join(import.meta.dir,test)],{cwd:join(import.meta.dir,'..'),env:{...process.env,...(m?{CONTACT_MUTATION:JSON.stringify(m)}:{})},stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);return {code,out,err};
}
for(const test of new Set(cases.map(c=>c.test))){const r=await run(test);if(r.code)throw new Error(`baseline ${test} failed\n${r.out}\n${r.err}`);}
for(const c of cases){const r=await run(c.test,c);const witness=r.out.split('\n').some(l=>l.includes(c.witness)&&(l.includes('FAIL')||l.includes('✗')));
 if(!r.code||!r.err.includes('CONTACT_MUTATION_APPLIED')||!witness)throw new Error(`mutation not caught: ${c.name}\n${r.out}\n${r.err}`);
 console.log(`PASS ${c.name}: expected product failure`);
}
console.log(`${cases.length}/${cases.length} mutations detected`);
