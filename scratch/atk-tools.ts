// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
const log=(t,r)=>console.log(`  ${t.padEnd(44)} ${show(r)}`);
let s=await sock(); await s.join("gym","atk-tools");
console.log("UNKNOWN / RENAMED verbs:");
log("unknown 'frobnicate'", await s.req("frobnicate",{}));
log("near-miss 'inspct'", await s.req("inspct",{id:"@world"}));
log("old/renamed 'pickup'", await s.req("pickup",{id:"x"}));
log("empty verb ''", await s.req("",{}));
console.log("JUNK SCHEMAS (known verbs, bad args):");
log("create args not needed/unknown-arg", await s.req("create",{bogus:1}));
log("set missing component", await s.req("set",{id:"@world"}));
log("set component wrong type (number)", await s.req("set",{id:"@world",component:5,value:1}));
log("inspect id as number", await s.req("inspect",{id:42}));
log("use id object", await s.req("use",{id:{a:1}}));
log("delete no id", await s.req("delete",{}));
log("say text as array", await s.req("say",{text:[1,2,3]}));
log("history limit as string", await s.req("history",{limit:"lots"}));
console.log("MALFORMED ENVELOPES (socket must survive):");
s.raw({type:"request",id:"m1",verb:12345,args:{}});            // verb not a string
s.raw({type:"request",id:"m2"});                                // no verb/args
s.raw({type:"request",id:"m3",verb:"look",args:[1,2,3]});       // args an array
s.raw({type:"request",id:"m4",verb:"look",args:null});          // args null
s.raw({type:"request",id:"m5",verb:"x".repeat(5000),args:{}});  // giant verb
s.raw("this is not json");                                      // non-JSON frame
s.raw({type:"nonsense",foo:"bar"});                             // unknown message type
await new Promise(r=>setTimeout(r,500));
console.log("  socket closed after malformed? code=", s.closed);
log("sanity: look still works after junk", await s.req("look",{}));
console.log("  replies seen for m1..m5:", s.msgs.filter(m=>m.type==="reply"&&/^m[1-5]$/.test(m.id)).map(m=>`${m.id}:${m.ok?'ok':m.reply?.refused?.code||'?'}`).join(" "));
console.log("  error msgs:", s.msgs.filter(m=>m.type==="error").map(m=>String(m.error).slice(0,60)).slice(0,6));
s.close();
