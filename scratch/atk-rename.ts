// @ts-nocheck
import { sock } from "./atk-access-lib.ts";
const X = "rnacct"+Date.now().toString(36);   // one stable account
const N = (s)=>s+Date.now().toString(36).slice(-3);
const jn = async (id, acct=X, extra={}) => { const s=await sock(); const j=await s.join("gym", id, { account: acct, ...extra });
  const sn=j.snapshot||{}; return { s, you:sn.you, refused:sn.renameRefused, after:sn.after??sn.renameAfter, days:sn.renameCooldownDays, errs:j.errors, closed:s.closed }; };
const p = (tag,r)=>console.log(`  ${tag.padEnd(40)} you=${r.you} ${r.refused?`RENAME-REFUSED(tried=${r.refused.tried})`:""} days=${r.days} errs=${JSON.stringify(r.errs)}`);

const n1="Alpha", n2="Bravo", n3="Charlie", n4="Delta";
let a=await jn(n1); p("1. first join as "+n1, a);
console.log("   cooldown active?", a.days>0);
let b=await jn(n2); p("2. rename -> "+n2, b);
let c=await jn(n3); p("3. rename -> "+n3+" (within cooldown?)", c);
a.s.close(); b.s.close(); c.s.close();
// ATTACK 1: revert to old name, then rename again
let d=await jn(n1); p("4. revert -> "+n1+" (old name)", d);
let e=await jn(n4); p("5. after-revert rename -> "+n4, e);
d.s.close(); e.s.close();
// collision suffix then rename
const Y="other"+Date.now().toString(36);
let base=await jn("Clash", X);           // X wears Clash
let coll=await jn("Clash", Y);           // Y collides -> suffixed
p("6a. X as Clash", base); p("6b. Y as Clash (collision)", coll);
let coll2=await jn("ClashRenamed", Y);   // Y renames from suffixed name
p("6c. Y suffixed->ClashRenamed (cooldown?)", coll2);
base.s.close(); coll.s.close(); coll2.s.close();
// supersede: same account new socket; old socket told?
let o1=await jn("Zeta", X);
let o2=await jn("Zeta", X);   // same acct+name, new socket -> takeover
await new Promise(r=>setTimeout(r,300));
console.log("  7. supersede: old socket closed code =", o1.s.closed, " new you=", o2.you);
o1.s.close(); o2.s.close();
