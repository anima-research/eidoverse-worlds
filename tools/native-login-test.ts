// Pure isolated HTTP handler tests: no auth.ts runtime import or session/world files.
import { strict as assert } from "node:assert";
import { createNativeLogin } from "../server/native-login.ts";
import type { HnSession } from "../server/auth.ts";
let time = 1_000_000, issued: HnSession[] = [];
let browser: HnSession | null = { sub: "human:test", name: "Test Diver", scopes: ["worlds:join", "worlds:spectate", "admin"], exp: time + 3600_000 };
const origin = "https://eidoverse.animalabs.ai";
const handler = createNativeLogin({ origin, login: "https://id.animalabs.ai/login?audience=eidoverse", enabled: true,
  now: () => time, session: c => c === "browser" ? browser : null,
  issue: s => { issued.push(s); return "a".repeat(64); } });
async function post(path: string, body = {}, headers: Record<string,string> = {}) {
  return handler(new Request(origin + path, {method:"POST", headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)}));
}
const approveHeaders = { origin, cookie: "browser" };
const start = async () => (await post("/native/start")).json();
const poll = (p: any) => post("/native/poll", {device_code:p.device_code});
let checks = 0;
const status = async (r: Promise<Response>, expected: number) => { assert.equal((await r).status,expected); checks++; };
const p = await start();
assert.match(p.device_code,/^[a-f0-9]{64}$/); assert.match(p.user_code,/^[A-F0-9]{5}-[A-F0-9]{5}$/); checks+=2;
await status(poll(p),202); assert.equal(issued.length,0); checks++;
await status(poll(p),429); time+=2001;
await status(post("/native/poll", {device_code:p.user_code}),410);
await status(post("/native/approve",{user_code:p.user_code}),403);
await status(post("/native/approve",{user_code:p.user_code},{origin:"https://evil.test",cookie:"browser"}),403);
await status(post("/native/approve",{user_code:p.user_code},{origin}),401);
await status(post("/native/approve",{user_code:p.user_code},approveHeaders),200);
await status(post("/native/approve",{user_code:p.user_code},approveHeaders),410);
const granted = await poll(p); assert.equal(granted.status,200);
assert.match(granted.headers.get("set-cookie")!,/HttpOnly; SameSite=Lax;.*Secure/);
assert.equal(issued[0].nativeWorld,"water"); assert.deepEqual(issued[0].scopes,["worlds:join","worlds:spectate"]);
assert.equal(issued[0].exp,browser!.exp); assert.equal(browser!.nativeWorld,undefined); checks+=6;
await status(poll(p),410);
const expired = await start(); time+=300001; await status(poll(expired),410);
const cancelled = await start(); await status(post("/native/cancel",{device_code:cancelled.device_code}),200); await status(poll(cancelled),410);
const denied = await start(); await status(post("/native/deny",{user_code:denied.user_code},approveHeaders),200); await status(poll(denied),403);
const revoked = await start(); await status(post("/native/approve",{user_code:revoked.user_code},approveHeaders),200); browser=null; await status(poll(revoked),403);
browser={sub:"human:test",name:"Test",scopes:["worlds:spectate"],exp:time+3600_000};
const limited = await start(); await status(post("/native/approve",{user_code:limited.user_code},approveHeaders),403);
browser.scopes=["worlds:join"]; browser.nativeWorld="water"; await status(post("/native/approve",{user_code:limited.user_code},approveHeaders),403);
await status(post("/native/start",{oversize:"x".repeat(2048)}),413);
await status(post("/native/start",{}, {origin:"null"}),403);
await status(handler(new Request(origin+"/native/approve")),405);
const page = await handler(new Request(origin+"/native")); const html=await page.text();
assert.match(page.headers.get("content-security-policy")!,/frame-ancestors 'none'/);
assert.ok(html.includes("Authorize Unreal for water")&&!html.includes(p.device_code)); checks+=2;
time+=60_001; for(let i=0;i<30;i++) await status(post("/native/start"),200); await status(post("/native/start"),429);
console.log(`Native login: ${checks} checks passed; no filesystem or production access.`);
