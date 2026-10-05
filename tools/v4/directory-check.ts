// tools/v4/directory-check.ts — the door directory (server/v4/directory.ts): who an identity is lives outside the log
// (§2.3), an id is reached only through an account, and typing someone's name yields nothing (round-2 review R1, R2).
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/v4/directory-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directoryAt, isMinted } from "../../server/v4/directory.ts";
import { openLive } from "../../server/v4/live.ts";
import { request } from "../../shared/v4/door.js";

let pass = 0, fail = 0;
const ok = (c: unknown, what: string, why?: unknown) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${why === undefined ? "" : ` — ${JSON.stringify(why).slice(0, 300)}`}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v4-dir-"));
const file = path.join(tmp, "worlds", ".v4-directory.json");

// ---- D: the directory itself ----
{ const d = directoryAt(file);
  const ann = d.resolve({ sub: "human:discord:111", name: "Ann" });
  ok(isMinted(ann), "D1 an account's identity is an opaque minted id (u- + 20 base32)", ann);
  ok(d.resolve({ sub: "human:discord:111", name: "Ann" }) === ann, "D2 the same account gets the same id");
  ok(d.resolve({ sub: "human:discord:111", name: "Annie" }) === ann && d.nameOf(ann) === "Annie", "D3 a rename keeps the id; the display name follows", d.nameOf(ann));
  const twin = d.resolve({ sub: "human:discord:222", name: "Annie" });
  ok(twin !== ann, "D4 two people with one name are two identities");
  const a1 = d.resolve({ name: "Ann" }), a2 = d.resolve({ name: "Ann" });
  ok(a1 !== a2 && a1 !== ann && d.entry(a1)?.kind === "anon", "D5 with no account, every connection is a fresh identity, never anyone else's", [a1, a2]);
  const bot = d.resolve({ sub: "agent:rowan", name: "Rowan", agent: true });
  ok(d.entry(bot)?.kind === "agent", "D6 an agent's account makes an agent identity");
  const leg = d.legacy("Bea"); d.bind(leg, "human:discord:333");
  ok(d.resolve({ sub: "human:discord:333", name: "Bea" }) === leg, "D7 binding an account to a legacy identity lets that account wear it");
  let threw = false; try { d.bind(leg, "human:discord:111"); } catch { threw = true; }
  ok(threw, "D8 an account can't wear two identities");
  ok((fs.statSync(file).mode & 0o777) === 0o600, "D9 the directory file is 0600", (fs.statSync(file).mode & 0o777).toString(8));
  const again = directoryAt(file);
  ok(again.resolve({ sub: "human:discord:111", name: "Annie" }) === ann && again.nameOf(twin) === "Annie", "D10 it survives a reopen");
  ok(JSON.stringify(again.names([ann, twin, "u-nobody"])) === JSON.stringify({ [ann]: "Annie", [twin]: "Annie" }), "D11 names() gives display names only (never accounts), skipping unknown ids"); }

// ---- I: the door with directory ids (R2: a role is held by an id, never by a name) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "w"), "w", { now: () => (T += 100), custodyFile: path.join(tmp, "custody.json"), nameOf: d.nameOf });
  const owner = d.resolve({ sub: "human:discord:111", name: "Annie" });
  ok(request(w, owner, "new", { title: "w" }).ok, "I1 the owner founds a world as their id");
  ok(request(w, owner, "set", { id: "@world", component: "default-role", value: { role: "visitor" } }).ok, "I1b …strangers are visitors");
  const imp = d.resolve({ name: "Annie" });   // someone typing the owner's display name, no account
  const r = request(w, imp, "set", { id: "@world", component: "about", value: { name: "mine now", text: "" } });
  ok(!r.ok && r.refused?.code === "rights", "I2 typing the owner's name (no account) gets a fresh identity with no rights", r.refused);
  const enc = request(w, "annie", "set", { id: "@world", component: "about", value: { name: "mine now", text: "" } });
  ok(!enc.ok, "I3 sending the owner's old-style name as the actor doesn't reach their role either", enc.refused);
  ok(request(w, owner, "create", { id: "lamp", model: "crate", place: { at: [0, 2] } }).ok, "I4 the owner builds");
  const lk = request(w, owner, "set", { id: "lamp", component: "lock", value: true });
  const bob = d.resolve({ sub: "human:discord:444", name: "Bob" }); request(w, owner, "set", { id: "@world", component: `roles:${bob}`, value: { role: "builder" } });
  const moved: any = request(w, bob, "delete", { id: "lamp" });
  ok(lk.ok && !moved.ok && /Annie/.test(moved.refused?.reason ?? "") && !/u-[a-z2-7]{20}/.test(moved.refused?.reason ?? ""), "I5 refusals say people's names from the directory, never their ids", moved.refused?.reason);
  const log = fs.readFileSync(path.join(tmp, "worlds", "w", "v4.jsonl"), "utf8");
  ok(!/Annie|discord/.test(log), "I6 nothing about the person (name, account) is in the log", null); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[directory-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
