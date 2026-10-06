// tools/v4/inspectharness.ts — the client's edit path (client/lib/inspect.js → v4edit.js) headless, against the REAL
// door on a scratch v4 world (tools/v4/scratchdoor.ts). Import this BEFORE importing client/lib/inspect.js: it
// registers the Bun plugin that stubs the page around them. What is real: inspect.js, v4edit.js (send, expect, the
// lock dialog's three answers, undo/redo by act), the shared planners, the door. What is stubbed, from client/lib:
//   net.js     requestV4 → the scratch door, as the signed-in person `actor`; v4.st = the door's v4 state (kept in
//              sync after every request, as the live client's fold is); isV4 → true; sendDrag records
//   state.js   state.st = the door's state as the view (shared/v4/record.js viewState), what the panels read
//   world.js   the realized objects (a Map the test fills)
//   ui.js, confirmcenter.js, panels.js   toasts and hints recorded; the lock dialog answers `H.choose`
//   realize/models.js (from inspect.js)  boxOf → null (the realizer is three.js and the GPU; not under test)
// client/lib/realize/structure.js imports '../../shared/structure.js', which the browser resolves from the web root
// and the filesystem doesn't (client/shared/ doesn't exist): that one path is redirected to the repo's shared/.
// @ts-nocheck
import { plugin } from "bun";
import path from "node:path";
import { scratchWorld } from "./scratchdoor.ts";
import { viewState } from "../../shared/v4/record.js";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);

export function inspectHarness(tag = "inspect", { actor = "olive" } = {}) {
  const W = scratchWorld(tag, { owner: "olive" });
  W.call("set", { id: "@world", component: "roles:bob", value: { role: "builder" } });   // the "someone else" of H.other
  const H = globalThis.__ih = {
    W, actor, sent: [], toasts: [], hints: [], asked: [], drags: [], choose: "cancel",
    entities: new Map(), state: { st: viewState(W.state()) }, v4: { st: W.state() },
    sync() { H.state.st = viewState(W.state()); H.v4.st = W.state(); },
    /** settle the async sends (requestV4 answers at once; the lock dialog is a promise) */
    flush: () => new Promise((r) => setTimeout(r, 10)),
    /** someone else writes (another person at the door) */
    other(tool, args, who = "bob") { const r = W.call(tool, args, who); if (!r.ok) throw new Error(`H.other: ${who}'s ${tool} refused: ${JSON.stringify(r.refused)}`); H.sync(); return r; },
  };
  plugin({
    name: "inspect-harness",
    setup(b) {
      b.onResolve({ filter: /^\.\/(world|state|net|panels|ui|confirmcenter)\.js$/ }, (a) =>
        (a.importer.startsWith(path.join(ROOT, "client/lib/")) && !a.importer.includes("/realize/") ? { path: a.path, namespace: "inspect-harness" } : undefined));
      // the realizer (three.js, the GPU paths) is not under test: inspect.js asks it only for a model's box
      b.onResolve({ filter: /^\.\/realize\/models\.js$/ }, (a) => (a.importer.endsWith("/client/lib/inspect.js") ? { path: "realize-models", namespace: "inspect-harness" } : undefined));
      b.onResolve({ filter: /^\.\.\/\.\.\/shared\/structure\.js$/ }, (a) => (a.importer.includes("/client/lib/realize/") ? { path: path.join(ROOT, "shared/structure.js") } : undefined));
      b.onLoad({ filter: /.*/, namespace: "inspect-harness" }, (a) => {
        if (a.path === "realize-models") return { contents: "export const boxOf = () => null;", loader: "js" };
        const m = a.path.match(/(world|state|net|panels|ui|confirmcenter)/)[1];
        // every name client/lib imports from these modules exists (no-ops where the edit path never calls them)
        const noop = (names) => names.map((n) => `export const ${n} = () => {};`).join(" ");
        const src = {
          world: `const H = globalThis.__ih; export const entities = H.entities; export const entityMeta = new Map(); export const comps = new Map(); export const avatarMounts = new Map(); export const editHolds = new Map(); export const behaviors = new Map();
            export const findPart = () => null; ${noop(["mountTransform", "setBodySeat", "socketWorldPos"])}`,
          state: `export const state = globalThis.__ih.state; export const onWorldChange = () => () => {}; ${noop(["applyView", "foldLive", "hydrate", "reset"])}`,
          net: `const H = globalThis.__ih;
            export const net = { myId: H.actor, myRights: { role: 'owner' } };
            export const v4 = H.v4; export const isV4 = () => true;
            export const sendDrag = (...a) => { H.drags.push(a); };
            export const requestV4 = async (tool, args) => { H.sent.push({ tool, args: JSON.parse(JSON.stringify(args ?? {})) }); const r = H.W.call(tool, args, H.actor); H.sync(); return r; };
            ${noop(["requestDebug", "requestHistory", "say", "sendAnim", "sendBodyDrag", "sendLease", "sendRelayCredRequest", "sendTyping", "sendVoiceConsent"])}`,
          panels: `export const SCRUB_SPEEDS = {}; ${noop(["renderDOM", "getScrubFeel", "hitRegion", "makeSchemaFrame", "renderCanvas", "resolveDelta", "setScrubFeel"])}`,
          ui: `const H = globalThis.__ih; export const flashHint = (t) => H.hints.push(t); export const toast = (t) => H.toasts.push(t); export const escapeHtml = (s) => String(s); export const isOverlayOpen = () => false;
            ${noop(["collapseAll", "dockPins", "makeSection", "paintRangesIn", "panelFrame", "setAmbientHint"])}`,
          confirmcenter: "const H = globalThis.__ih; export const chooseCenter = async (q) => { H.asked.push(q); return H.choose; }; export const confirmCenter = async () => false;",
        }[m];
        return { contents: src, loader: "js" };
      });
    },
  });
  return H;
}
