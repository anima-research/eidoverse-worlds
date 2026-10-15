// @ts-nocheck
import { sock, show } from "./atk-access-lib.ts";
let s=await sock(); await s.join("gym","marigold");
console.log("delete leftover role:", show(await s.req("delete",{id:"@world",component:"roles:u-r6mcsu5yvwf4azlcjogo"})));
const wi=await s.req("inspect",{id:"@world"});
console.log("roles now:", Object.keys(wi?.components||{}).filter(k=>k.startsWith("roles:")));
const look=await s.req("look",{});
console.log("atk-* entities now:", (look?.things||[]).filter(t=>/^atk-/.test(t.id)).map(t=>t.id));
s.close();
