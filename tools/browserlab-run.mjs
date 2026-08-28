// browserlab-run — drive the in-page harness from outside, so the Firefox
// receipt and the Chrome receipt are produced the same way (#42).
//
// The evidence problem on #42 has never been "nobody has an FPS number". It is
// that every number was taken by a different person, in a different place, with
// a different crowd in frame. This runs client/lib/browserlab.js against the
// SAME url, the SAME camera pose and the SAME arm order in each browser, and
// writes both receipts side by side.
//
// It launches the browsers you actually have installed — `chrome` is your
// Chrome, `moz-firefox` is stock Firefox over WebDriver BiDi, not Playwright's
// patched build. That distinction is the whole point: a receipt from a bundled
// fork of Firefox would not be evidence about Firefox.
//
//   # 1. record the reference run; it fixes the camera for everything after
//   node tools/browserlab-run.mjs --browser=chrome --label=chrome
//
//   # 2. stand in exactly the same place in the other browser
//   node tools/browserlab-run.mjs --browser=moz-firefox --label=firefox \
//        --camera=tools/receipts-42/chrome.json
//
// Flags: --url --browser --secs --label --out --camera --keep-open
//
// 🔴 RUN THIS UNDER node, NOT bun. Measured on Windows 10 + bun 1.3.14:
// `chromium.launch()` starts the browser process and then hangs until the
// launch timeout — Playwright talks to it over `--remote-debugging-pipe`
// (fds 3/4) and bun's spawn does not hand those over. The same call under node
// connects in 223ms. It is a launcher problem, not a Playwright one, so a
// bun-flavoured rewrite of this file will fail the same way. (tools/probe-
// harness.mjs is exposed to the same wall on this platform.)
//
// WINDOWS STAY VISIBLE ON PURPOSE. A backgrounded or minimised tab gets no
// rAF, and the harness refuses to run in one — headless would measure a
// throttle and call it a renderer. Do not touch the window while it runs.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, firefox } from 'playwright';

const argv = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)]; }));

// ?key= is the client's door key (core.js CONFIG.token), NOT ?token=. Without
// it the page loads, boots the renderer and draws an EMPTY world — no entities,
// no grass field, every arm identical — while looking entirely healthy. The
// first three runs of this harness were measuring a lobby.
//
// There is no default WORLD any more: browserlab-seed generates a fresh one per
// run and prints the exact command, and a hardcoded name here was how the
// seeder came to have one too.
if (!argv.url && !argv.world) {
  console.error('browserlab-run: pass --url=... (or --world=... with the defaults below).');
  console.error('  seed a scratch world first:  node tools/browserlab-seed.mjs');
  console.error('  it prints the exact --url for the world it just made.');
  process.exit(1);
}
const HOST = argv.host ?? 'http://localhost:8949';
const KEY = argv.key ?? 'lab-door';
const URL_ = argv.url ?? `${HOST}/?name=${argv.name ?? 'viewer'}&world=${argv.world}&key=${KEY}`;
const BROWSER = argv.browser ?? 'chrome';
const SECS = Number(argv.secs ?? 25);
const LABEL = argv.label ?? BROWSER;
const OUT = argv.out ?? 'tools/receipts-42';
const KEEP = argv['keep-open'] === 'true';
// 🔴 FIX THE PIXEL COUNT, or the receipts are not comparable. Left to their own
// window chrome the two browsers gave 1249×1285 (Chrome) and 1280×955 (Firefox)
// on the same monitor — Firefox drawing 24% fewer pixels, which is a rendering
// advantage nobody granted it and the frame times would have absorbed silently.
// --size=WxH sets an explicit viewport in both; --size=window opts out.
const SIZE = argv.size ?? '1280x800';
const BOOT_TIMEOUT_MS = 180_000;

// chrome / msedge are Chromium channels; moz-firefox is STOCK Firefox over
// WebDriver BiDi. `chromium` / `firefox` fall back to Playwright's own builds —
// fine for checking this script runs, NOT evidence about a shipped browser.
const CHROMIUM_CHANNELS = new Set(['chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'msedge-beta']);
const FIREFOX_CHANNELS = new Set(['moz-firefox', 'moz-firefox-beta', 'moz-firefox-nightly']);

const camera = argv.camera ? (() => {
  const j = JSON.parse(readFileSync(argv.camera, 'utf8'));
  const cam = j.camera ?? j;                       // a whole receipt, or a bare pose
  if (!Array.isArray(cam.pos)) throw new Error(`--camera: no {pos,yaw,pitch,fov} in ${argv.camera}`);
  return { pos: cam.pos, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov };
})() : null;

const isFirefox = FIREFOX_CHANNELS.has(BROWSER) || BROWSER === 'firefox';
const engine = isFirefox ? firefox : chromium;
const managedBuild = !CHROMIUM_CHANNELS.has(BROWSER) && !FIREFOX_CHANNELS.has(BROWSER);
if (managedBuild) {
  console.warn(`⚠ "${BROWSER}" is Playwright's own build, not an installed browser.`);
  console.warn('  Usable to check this script runs; NOT a receipt about that browser.');
}

// ---- what code produced this receipt ---------------------------------------
//
// The committed receipts said "server build 6006d6d (DIRTY TREE)", which names
// a commit the tree is NOT and says nothing about what the difference was. A
// receipt cannot authenticate itself by later being committed, so the working
// tree gets a deterministic digest here: the commit, plus a hash over the full
// diff against it, plus every untracked file's path and content hash. Same tree
// → same digest, on any machine.
function treeDigest() {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // The receipts directory is this tool's OUTPUT, not the code under test.
  // Counting it made the digest self-referential: writing a receipt dirtied the
  // tree that the next receipt then reported as dirty, so a clean checkout
  // could never produce a receipt that said so.
  const notOutput = ['--', '.', `:(exclude)${OUT}`];
  try {
    const sha = git(['rev-parse', 'HEAD']).trim();
    const diff = git(['diff', 'HEAD', ...notOutput]);
    const untracked = git(['ls-files', '--others', '--exclude-standard', ...notOutput]).split('\n').filter(Boolean).sort();
    const parts = [`commit ${sha}`, `diff ${createHash('sha256').update(diff).digest('hex')}`];
    for (const f of untracked) {
      let h = 'unreadable';
      try { h = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16); } catch { /* keep */ }
      parts.push(`untracked ${f} ${h}`);
    }
    const clean = diff.length === 0 && untracked.length === 0;
    return {
      sha, clean,
      digest: createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16),
      digestOf: clean ? `clean checkout (excluding ${OUT})` : `${diff.split('\n').length - 1} diff lines + ${untracked.length} untracked, excluding ${OUT}`,
    };
  } catch (e) {
    return { sha: null, clean: null, digest: null, digestOf: `git unavailable: ${String(e).slice(0, 80)}` };
  }
}
const TREE = treeDigest();
console.log(`[browserlab-run] code under test: ${TREE.sha ?? '?'} ${TREE.clean ? '(clean)' : `+ local changes, digest ${TREE.digest}`}`);

console.log(`[browserlab-run] launching ${BROWSER} (headed) → ${URL_}`);
const browser = await engine.launch({
  headless: false,
  ...(managedBuild ? {} : { channel: BROWSER }),
  timeout: 90_000,
});
const viewport = SIZE === 'window' ? null : (() => {
  const m = /^(\d+)x(\d+)$/.exec(SIZE);
  if (!m) throw new Error(`--size wants WxH (e.g. 1280x800) or "window", got "${SIZE}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
})();
const context = await browser.newContext({ viewport, deviceScaleFactor: viewport ? 1 : undefined });
const page = await context.newPage();

// Console + page errors from OUTSIDE the page, alongside the harness's own
// in-page capture: this side sees uncaught errors and load failures the page
// cannot report about itself.
const consoleLines = [];
page.on('console', (m) => { if (consoleLines.length < 400) consoleLines.push({ type: m.type(), text: m.text().slice(0, 400) }); });
page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e).slice(0, 400) }));

let lab = null;
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.bringToFront();

  console.log('[browserlab-run] waiting for the world to boot and draw…');
  await page.waitForFunction(
    () => !!globalThis.EW?.browserlab && (globalThis.EW.renderer?.info?.render?.calls ?? 0) > 0,
    null, { timeout: BOOT_TIMEOUT_MS, polling: 500 },
  );

  // Drawing is not the same as having joined. Refuse to measure an empty world
  // unless the caller says the world really is empty — a lobby renders fine and
  // reports three identical arms.
  if (argv['allow-empty'] !== 'true') {
    await page.waitForFunction(() => (globalThis.EW?.entities?.size ?? 0) > 0, null,
      { timeout: 60_000, polling: 500 }).catch(() => {
      throw new Error('no entities folded after 60s — the page is in an empty world. '
        + 'Check the ?key= door key in --url, or pass --allow-empty=true if that is really the scene.');
    });
    await page.waitForTimeout(4000);   // let the grass field and models finish building
  }

  // The harness refuses a hidden tab; check here too, with a better error.
  if (await page.evaluate(() => document.hidden)) {
    throw new Error('the page reports document.hidden — the window is minimised or fully occluded. '
      + 'Leave it visible and on top for the whole run.');
  }

  const total = SECS * 3 + 8;
  console.log(`[browserlab-run] running 3 arms × ${SECS}s (~${total}s). Do not touch the window.`);
  lab = await page.evaluate(
    ({ secs, label, cam, build }) => globalThis.EW.browserlab({ secs, label, buildStamp: build, ...(cam ? { camera: cam } : {}) }),
    { secs: SECS, label: LABEL, cam: camera, build: TREE },
  );
} finally {
  if (!KEEP) await browser.close();
  else console.log('[browserlab-run] --keep-open: leaving the browser up; close it yourself');
}

if (!lab) { console.error('[browserlab-run] no receipt produced'); process.exit(1); }

lab.driver = {
  browserChannel: BROWSER, playwrightManagedBuild: managedBuild, url: URL_, viewport: viewport ?? 'window',
  cameraFrom: argv.camera ?? null, launcher: `node ${process.version}`,
  consoleLines: consoleLines.slice(0, 60),
};

mkdirSync(OUT, { recursive: true });
const base = join(OUT, LABEL.replace(/[^a-z0-9._-]/gi, '_'));
writeFileSync(`${base}.json`, JSON.stringify(lab, null, 2));
writeFileSync(`${base}.md`, lab.markdown + '\n');
console.log(`\n${lab.markdown}\n`);
console.log(`[browserlab-run] wrote ${base}.json and ${base}.md`);
if (lab.tainted) { console.error(`[browserlab-run] TAINTED: ${lab.tainted}`); process.exit(2); }
if (!camera) console.log(`[browserlab-run] next: --browser=<other> --camera=${base}.json  ← stands in the same place`);
