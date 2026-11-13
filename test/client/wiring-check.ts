// test/client/wiring-check.ts — "this product file still says X / no longer says Y", one table: every row carries its controls.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/wiring-check.ts
// A row passes on the real text, and each control (strip a `must` match, inject a `not` sample, add one more `count` match,
// move `before`'s first after its second) must turn it red, so a drifted anchor fails instead of passing vacuously
// (the door-media-whitelist idiom). A row with a `not` needs a positive sibling: an absent subject is not clean.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const walkJs = (d: string): string[] => readdirSync(join(ROOT, d)).flatMap((f) => { const p = `${d}/${f}`; return statSync(join(ROOT, p)).isDirectory() ? walkJs(p) : p.endsWith(".js") ? [p] : []; });
const S = suite("wiring");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

type Row = { name: string; file: string; scope?: (s: string) => string; must?: RegExp[]; not?: [RegExp, string][]; count?: [RegExp, number]; before?: [string, string] };
const fnBody = (sig: string) => (s: string) => { const a = s.indexOf(sig); return a < 0 ? "" : s.slice(a, s.indexOf("\n}", a) + 2); };
const after = (anchor: string, len: number) => (s: string) => { const a = s.indexOf(anchor); return a < 0 ? "" : s.slice(a, a + len); };
const between = (a: string, b: string) => (s: string) => { const i = s.indexOf(a), j = s.indexOf(b, i); return i < 0 || j < 0 ? "" : s.slice(i, j); };

const ROWS: Row[] = [
  // headset-seen: the copy claims only what is known, and the stamp is a time
  { name: "core.js migrates the headset marker on read and writes the stamp back", file: "client/lib/core.js", must: [/migrateHeadsetSeen/, /setItem\(PREF_HEADSET_SEEN, migrated\)/] },
  { name: "the boot backend choice asks the headset predicate", file: "client/lib/core.js", must: [/headsetSeen: headsetSeenRecently\(\)/] },
  { name: "the Video panel says a headset has been USED here, never that one IS present", file: "client/lib/videopanel.js", must: [/has been used here/i],
    not: [[/headset is present/i, "a headset is present"], [/Right now: a headset/i, "Right now: a headset"]] },
  { name: "the no-headset branch is past-tense too", file: "client/lib/videopanel.js", must: [/No headset has been used here recently/i], not: [[/no headset sensed/i, "no headset sensed"]] },
  { name: "the WebGPU warning is past-tense", file: "client/lib/videopanel.js", must: [/A headset has been used here/], not: [[/⚠ A headset is present/, "⚠ A headset is present"]] },
  { name: "the panel asks the predicate, not the raw bit", file: "client/lib/videopanel.js", must: [/headsetSeenRecently\(\)/], not: [[/PREF_HEADSET_SEEN\) === '1'/, "getItem(PREF_HEADSET_SEEN) === '1'"]] },
  { name: "a granted session stamps the TIME at exactly two writers, never a flag", file: "client/lib/xr/xr.js", count: [/setItem\(PREF_HEADSET_SEEN, String\(Date\.now\(\)\)\)/g, 2],
    not: [[/setItem\(PREF_HEADSET_SEEN, '1'\)/, "setItem(PREF_HEADSET_SEEN, '1')"], [/setItem\('ew-headset-seen', '1'\)/, "setItem('ew-headset-seen', '1')"]] },
  // locomotion-clip: an extracted policy someone calls
  { name: "controller.js imports selectClip from the real policy module and calls it", file: "client/lib/controller.js",
    must: [/import\s*\{[^}]*\bselectClip\b[^}]*\}\s*from\s*'\.\/avatar\/locomotion_clip\.js'/, /\bselectClip\s*\(/, /setClip\([^)]*\.opts\s*\)/] },
  { name: "controller.js hands selectClip the body's size", file: "client/lib/controller.js", must: [/selectClip\(\{[^}]*\bscale:\s*me\.userScale/] },
  // scoped to the locomotion setClip call (the one with options): the flight path's me.setClip(clip, speed) takes none
  { name: "the tick hands setClip the selected opts, no fade re-derived at the call site", file: "client/lib/controller.js",
    scope: (s) => s.split("\n").find((l) => /me\.setClip\([^)]*,[^)]*,/.test(l)) ?? "", must: [/\.opts\s*\)/], not: [[/fade:/, "fade: 0.2"]] },
  // finger-curl: the filter's shape (its executed model and constants stay in finger-curl-test)
  { name: "sampleFingerCurl consults elapsed time, a speed-driven cutoff and a dt clamp", file: "client/lib/xr/xr-fingercurl.js", scope: fnBody("function sampleFingerCurl()"),
    must: [/performance\.now\(\)/, /oneEuroAlpha\(/, /CURL_MIN_CUTOFF \+ CURL_BETA \* Math\.abs\(st\.dx\)/, /Math\.min\(0\.1,/] },
  { name: "no hard jump/threshold branch survives in the filter", file: "client/lib/xr/xr-fingercurl.js", scope: fnBody("function sampleFingerCurl()"),
    must: [/oneEuroAlpha\(/], not: [[/\? raw :/, "const v = big ? raw : st.x;"], [/CURL_JUMP/, "if (d > CURL_JUMP) st.x = raw;"]] },
  // bodies-wear: the restored wear button is not a no-op
  { name: "switchAvatar's same-path early return exempts the capsule", file: "client/lib/mybody.js", must: [/if \(path === myAvatarPath && !me\?\.isCapsule\) return;/] },
  // conjure-coop: under COOP the poll owns login completion, one idempotent teardown
  { name: "login: one shared cleanup latches done, removes the listener, clears the timer", file: "client/lib/edit/generate.js", scope: between("let done = false", "} catch (e) { report('orrery login'"),
    must: [/const cleanup = \(\) => \{[^}]*done = true;[\s\S]*?removeEventListener\('message', onMsg\);[\s\S]*?clearInterval\(poll\);/] },
  { name: "login: the timeout runs the teardown (abandon), not a bare clearInterval", file: "client/lib/edit/generate.js", scope: between("let done = false", "} catch (e) { report('orrery login'"),
    must: [/tries > 45\) \{ abandon\(/], not: [[/tries > 45\) \{ clearInterval/, "if (++tries > 45) { clearInterval(poll); return; }"]] },
  { name: "login: abandon restores a retryable state, and messages are checked against the Orrery's origin", file: "client/lib/edit/generate.js", scope: between("let done = false", "} catch (e) { report('orrery login'"),
    must: [/const abandon[\s\S]*?connected = false/, /ev\.origin !== new URL\(ORRERY\)\.origin/] },
  // channel-cap-gate: typing is a notification, gated before the relay starts, handled in one place
  { name: "channels/typing is gated on channelsTyping before the relay starts", file: "mcpl/net-server.ts", scope: after("private onTyping(", 1400), before: ["capAllowed(CAP.channelsTyping)", "this.typing.start("] },
  { name: "the typing signal is handled once, in the notification listener; nothing acts on a stream chunk", file: "mcpl/net-server.ts", count: [/method\.CHANNELS_TYPING/g, 1],
    must: [/this\.conn\.on\("notification"[\s\S]{0,200}method\.CHANNELS_TYPING[\s\S]{0,200}this\.onTyping\(/], not: [[/method\.CHANNELS_OUTGOING_CHUNK/, "case method.CHANNELS_OUTGOING_CHUNK:"]] },
  { name: "this.onTyping( is called from exactly one place", file: "mcpl/net-server.ts", count: [/this\.onTyping\(/g, 1] },
  { name: "the session gives its first body a say hook that stops the relay", file: "mcpl/net-server.ts", scope: after("this.channelId = `world:${this.agent.world}`;", 400), must: [/this\.agent\.onSaid = \(\) => this\.typing\.stop\(\);/] },
  { name: "travel hands the say hook to the next body before taking it from the old one", file: "mcpl/net-server.ts", scope: after("next.onEvent = old.onEvent;", 1600), before: ["next.onSaid = old.onSaid;", "old.onSaid = null;"] },
];
// a client writer of an `until` uses serverUntil, never the raw fractional clock
const CLIENT = walkJs("client/lib");
ROWS.push({ name: "no client file writes until: serverNow() + …; serverUntil is what they use", file: CLIENT.join(" "), must: [/serverUntil\(/], not: [[/until:\s*serverNow\(\)\s*\+/, "{ until: serverNow() + ms }"]] });

const textOf = (r: Row) => { const t = r.file.split(" ").map(read).join("\n"); return r.scope ? r.scope(t) : t; };
const holds = (r: Row, s: string) => s.length > 0 && (r.must ?? []).every((m) => new RegExp(m.source, m.flags.replace("g", "")).test(s))
  && (r.not ?? []).every(([n]) => !new RegExp(n.source, n.flags.replace("g", "")).test(s))
  && (!r.count || (s.match(r.count[0]) ?? []).length === r.count[1])
  && (!r.before || (s.indexOf(r.before[0]) >= 0 && s.indexOf(r.before[1]) > s.indexOf(r.before[0])));
for (const r of ROWS) {
  const s = textOf(r);
  check(r.name, holds(r, s), s ? "" : "its scope anchor is gone");
  check(`  (a positive anchor beside every negative one)`, !r.not || !!(r.must?.length || r.count || r.before));
  const controls: [string, string][] = [
    ...(r.must ?? []).map((m): [string, string] => [`strip ${m.source.slice(0, 40)}`, s.replace(new RegExp(m.source, m.flags.includes("g") ? m.flags : m.flags + "g"), "")]),
    ...(r.not ?? []).map(([, bad]): [string, string] => [`inject "${bad}"`, `${s}\n${bad}`]),
    ...(r.count ? [[`one more ${r.count[0].source.slice(0, 40)}`, `${s}\n${s.match(r.count[0])?.[0] ?? ""}`] as [string, string]] : []),
    ...(r.before ? [[`${r.before[0]} after ${r.before[1]}`, s.replace(r.before[0], "") + r.before[0]] as [string, string]] : []),
  ];
  for (const [what, corrupt] of controls) check(`  control: ${what} → red`, !holds(r, corrupt));
}

// the MCPL dispatch, every method in it: a tools/* method consults toolsAllowed(), a channels/* method its capability,
// and an ungated one says why; a new case with no row here is red (widened from tools/list, tools/call and three channels)
{
  const src = read("mcpl/net-server.ts");
  const sw = between("switch (req.method) {", "default:")(src);
  const UNGATED: Record<string, string> = {
    '"mcpl/manifest"': "§17.4: the host fetches the manifest itself",
    "method.FEATURE_SETS_UPDATE": "the host's policy is what opens the gates",
    "method.CHANNELS_LIST": "lists the channels; publishing and opening are gated",
  };
  const CHANNEL_CAP: Record<string, string> = { CHANNELS_PUBLISH: "channelsPublish", CHANNELS_OPEN: "channelsLifecycle", CHANNELS_CLOSE: "channelsLifecycle" };
  const cases = [...sw.matchAll(/^\s*case (.+?):/gm)].map((m, i, all) => ({ label: m[1], body: sw.slice(m.index!, all[i + 1]?.index ?? sw.length) }));
  check("the dispatch is found, tools/list, tools/call and the channels cases in it", cases.length >= 6 && ["\"tools/list\"", "\"tools/call\"", "method.CHANNELS_PUBLISH"].every((l) => cases.some((c) => c.label === l)), cases.map((c) => c.label).join(" "));
  for (const { label, body } of cases) {
    const tool = /^"tools\//.test(label), chan = /^method\.(CHANNELS_\w+)$/.exec(label)?.[1];
    if (UNGATED[label]) { check(`${label} is ungated on purpose: ${UNGATED[label]}`, !tool && !body.includes("capAllowed(") && !body.includes("toolsAllowed()")); continue; }
    if (tool) { check(`${label} consults toolsAllowed()`, body.includes("toolsAllowed()")); continue; }
    if (chan) { check(`${label} is gated on ${CHANNEL_CAP[chan] ?? "a capability (none declared here)"}`, !!CHANNEL_CAP[chan] && body.includes(`capAllowed(CAP.${CHANNEL_CAP[chan]})`)); continue; }
    check(`${label}: a dispatch case with no gate declared here`, false, "add its capability check, or an UNGATED row saying why");
  }
}

S.done();
