#!/usr/bin/env node
/**
 * reachable — the rung git cannot see, one level in.
 *
 * shipcheck.sh (2026-08-15) walks five ladders of DURABILITY: uncommitted →
 * stashed → unpushed → no-PR-claims-it → merged-but-never-imported. All five
 * are about whether code EXISTS somewhere safe. None of them asks the next
 * question, which is the one that actually bit us all night:
 *
 *     does this code ever RUN?
 *
 * The SFU night produced two bugs of exactly this shape, and neither was
 * visible to any durability check — both were committed, pushed, merged, and
 * imported:
 *
 *   - `revokeSfuLeg` was imported and never called.
 *   - `onNegotiationNeeded` fired into an empty map.
 *
 * So this reports EXPORTED FUNCTIONS WITH NO REACHABLE CALLER, and — this is
 * the part that took four tries in shipcheck and is the whole reason this file
 * is careful — it distinguishes the three ways "no caller" can be FINE:
 *
 *   1. console-exposed  (`window.voiceDiag = voiceDiag`)  — a human calls it
 *   2. test-only        (called from tools/ or *.test.*)  — a harness calls it
 *   3. re-exported      (`export { x } from './y.js'`)    — someone else's API
 *
 * What survives all three filters is one of exactly two things, and the script
 * refuses to guess which — because they need opposite fixes:
 *
 *   DEAD        — the feature is gone; delete the function.
 *   UNWIRED     — the feature was never finished; write the caller.
 *
 * `toggleMute` is the worked example: a harness proves it works while the
 * product calls micOn() instead, so its careful noise-gate reasoning about the
 * unmute leak is not on any live path. A durability checker calls that file
 * perfectly healthy.
 *
 *   node tools/reachable.mjs            # whole client
 *   node tools/reachable.mjs client/lib/voice.js
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const argv = process.argv.slice(2);

function walk(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir); } catch { return out; }
  for (const e of ents) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts)$/.test(e)) out.push(p);
  }
  return out;
}

// The whole corpus is the haystack: a caller in tools/ or server/ counts, and
// missing that was how shipcheck's first version cried wolf four times.
const corpus = [
  ...walk(join(ROOT, 'client')),
  ...walk(join(ROOT, 'server')),
  ...walk(join(ROOT, 'tools')),
];
const text = new Map();
for (const f of corpus) { try { text.set(f, readFileSync(f, 'utf8')); } catch {} }

const targets = argv.length
  ? argv.map((a) => (a.startsWith('/') ? a : join(ROOT, a)))
  : corpus.filter((f) => f.includes('/client/lib/'));

const findings = [];

for (const file of targets) {
  const src = text.get(file);
  if (!src) continue;
  const exports = [...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)]
    .map((m) => m[1]);

  for (const fn of exports) {
    // 1. console-exposed — a human is the call site, and that is legitimate.
    if (new RegExp(`window\\.${fn}\\s*=|window\\[['"\`]${fn}['"\`]\\]`).test(src)) continue;

    // 🔴 The defining file is a CALL SITE like any other. Skipping it was a real
    // bug: rebindSenders is called at voice.js:554 for the TTS takeover, and
    // this tool reported it uncalled — then I wrote that false finding into a
    // commit message before a ground-truth grep caught me. Count self-calls,
    // but not the `export function fn(` line itself.
    let callers = 0, testOnly = 0, reexport = 0;
    for (const [f, raw] of text) {
      // 🔴 Strip comments FIRST. toggleMute has exactly two mentions in the
      // tree and both are inside comments explaining what it does — counting
      // those as call sites hid a true positive (the product calls micOn(),
      // never toggleMute). Prose about a function is not a caller.
      const s = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      // 3. a re-export is not a call — it just moves the name.
      if (new RegExp(`export\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from`).test(s)) { reexport++; continue; }
      // A call is `fn(`, but a REFERENCE is a call site too and looks nothing
      // like one: addEventListener('beforeunload', sfuClose), .then(fn),
      // map(fn), { onClick: fn }. sfuClose was flagged NO CALLER while being
      // wired at voicesfubridge.js:108 exactly that way — the fifth distinct
      // legitimately-invisible pattern found while building these two tools.
      const called = (s.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || []).length;
      // Narrow: a reference is the bare name as a whole argument or value —
      // addEventListener('x', fn) / .then(fn) / { on: fn }. The first version
      // of this regex was loose enough to match nearly anything and drove
      // findings to ZERO, which is exactly as useless as crying wolf.
      const referenced = (s.match(
        new RegExp(`(?:,|\\(|:)\\s*${fn}\\s*(?:,|\\)|\\})`, 'g')
      ) || []).length;
      const selfDef = f === file
        ? (s.match(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'g')) || []).length
        : 0;
      const hits = called + referenced - selfDef;
      if (!hits) continue;
      // 2. harness callers are real, but they do not prove the LIVE path runs it.
      if (/\/tools\/|\.test\.|\.spec\./.test(f)) testOnly += hits; else callers += hits;
    }

    if (callers === 0) {
      findings.push({
        file: relative(ROOT, file), fn,
        verdict: testOnly ? 'TEST-ONLY' : reexport ? 'RE-EXPORTED ONLY' : 'NO CALLER',
        testOnly, reexport,
      });
    }
  }
}

const RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m', GRN = '\x1b[32m', OFF = '\x1b[0m';
console.log(`\n═══ reachable — exported functions with no live-path caller`);
console.log(`${DIM}    scanned ${targets.length} file(s) against ${corpus.length} corpus file(s)${OFF}\n`);

if (!findings.length) {
  console.log(`  ${GRN}✓${OFF} every exported function has a caller on the live path.\n`);
} else {
  let byFile = {};
  for (const f of findings) (byFile[f.file] ||= []).push(f);
  for (const [file, fs_] of Object.entries(byFile)) {
    console.log(`  ${file}`);
    for (const f of fs_) {
      const tag = f.verdict === 'NO CALLER' ? `${RED}${f.verdict}${OFF}` : `${YEL}${f.verdict}${OFF}`;
      const extra = f.testOnly ? ` ${DIM}(${f.testOnly} harness call${f.testOnly > 1 ? 's' : ''})${OFF}` : '';
      console.log(`      ${tag}  ${f.fn}${extra}`);
    }
  }
  console.log(`\n  ${DIM}Each is DEAD (delete it) or UNWIRED (write the caller). Those need${OFF}`);
  console.log(`  ${DIM}OPPOSITE fixes, and this script deliberately does not guess which —${OFF}`);
  console.log(`  ${DIM}open the function and decide. TEST-ONLY means a harness proves it${OFF}`);
  console.log(`  ${DIM}works while nothing in the product calls it: the most expensive kind${OFF}`);
  console.log(`  ${DIM}of green.${OFF}\n`);
}
