import {WorldAgent} from '../mcpl/agent.ts';
import {handleTool} from '../mcpl/tools.ts';
import {scratchSequencer,mkCheck} from './harness.ts';
const {check,tally}=mkCheck();
const h=await scratchSequencer('walk-precision',{portFrom:9380,serverEnv:{SKIP_OPT_SWEEP:'1'}});
const a=new WorldAgent({url:h.BASE.replace('http','ws')+'/ws',world:'precision',name:'precision-owner'});
const b=new WorldAgent({url:h.BASE.replace('http','ws')+'/ws',world:'precision',name:'precision-observer'});
const ctx={agent:a,canPush:()=>false,heldActivity:[],cursor:{caughtUpTo:null}};
try{
 await a.connect();await b.connect();
 const r=await handleTool(ctx,'walk_to',{x:.2,z:0});
 check('sub-40cm request moves through the real tool and body ticks',Math.abs(a.pos.x-.2)<=.01,r.content[0].text);
 await h.sleep(150);
 check('peer receives the final precise position',Math.abs((b.people.get(a.name)?.pose?.p[0]??-1)-.2)<=.01);
 await handleTool(ctx,'walk_to',{x:.65,z:0});
 check('requested 45cm displacement is not shortened by the arrival radius',Math.abs(a.pos.x-.65)<=.01);
 const before=a.pos.x;
 await handleTool(ctx,'walk_to',{x:.8,z:0,tolerance:.4});
 check('caller may explicitly request coarse arrival',a.pos.x===before);
 const bad=await handleTool(ctx,'walk_to',{x:0,z:0,tolerance:-1});
 check('invalid tolerance refuses without moving',bad.isError===true&&a.pos.x===before);
 const exact=await handleTool(ctx,'walk_to',{x:.7,z:.025,tolerance:0});
 check('zero tolerance reaches exact finite destination',Math.hypot(a.pos.x-.7,a.pos.z-.025)<1e-12,exact.content[0].text);
 check('small destinations are reported without decimetre rounding',exact.content[0].text.includes('0.700, 0.025'));
}finally{a.close();b.close();await h.cleanup(tally.failed?1:0);}
console.log(`${tally.passed} passed, ${tally.failed} failed`);process.exit(tally.failed?1:0);
