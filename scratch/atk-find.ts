// @ts-nocheck
import { sock } from "./atk-access-lib.ts";
let s=await sock(); await s.join("gym","riannon");
for (const q of ["ball","pyramid","sphere","small","apple","die","gem"]) {
  const r=await s.req("find",{kind:"model",query:q});
  console.log(q, (r?.models||[]).slice(0,3).map(m=>`${m.model.split('/').pop()} ${JSON.stringify(m.size)}`).join(" | "));
}
s.close();
