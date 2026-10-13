// tools/protocol/inspectharness.ts — the client's edit path (client/lib/inspect.js → editwrites.js) headless, against the REAL
// door on a scratch world (tools/protocol/scratchworld.ts). Import this BEFORE importing client/lib/inspect.js: it
// registers the Bun plugin that stubs the page around them. What is real: inspect.js, editwrites.js (send, expect, the
// lock dialog's three answers, undo/redo by act), the shared planners, the authority. What is stubbed, from client/lib:
//   net.js     sendRequest → the scratch world, as the signed-in person `actor`; replica.st = the authority's state (kept in
//              sync after every request, as the live client's fold is); replicaActive → true; sendDrag records
//   state.js   state.st = the authority's state as the view (shared/protocol/view.js viewState), what the panels read
//   world.js   the realized objects (a Map the test fills)
//   ui.js, confirmcenter.js, panels.js   toasts and hints recorded; the lock dialog answers `H.choose`
//   xrask.js   a headset is never presenting (the ask goes to confirmcenter)
//   realize/models.js (from inspect.js)  boxOf → null (the realizer is three.js and the GPU; not under test)
//   core.js    three.js without a renderer (inspect.js reads THREE; nothing here draws)
//   emitters.js, matoverride.js   no stored effect document is loaded; a realized object's materials → none
// client/lib/loadwork.js (reached through realize/structure.js) starts a frame-gap watch on requestAnimationFrame at import:
// headless, the clock never answers (a timer-backed shim would re-arm forever and hold the process open).
// @ts-nocheck
import { plugin } from "bun";
import path from "node:path";
import { scratchWorld } from "./scratchworld.ts";
import { viewState } from "../../shared/protocol/view.js";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);

export function inspectHarness(tag = "inspect", { actor = "olive" } = {}) {
  globalThis.requestAnimationFrame ??= () => 0;
  const W = scratchWorld(tag, { owner: "olive" });
  W.call("set", { id: "@world", component: "roles:bob", value: { role: "builder" } });   // the "someone else" of H.other
  const H = globalThis.__ih = {
    W, actor, sent: [], toasts: [], hints: [], asked: [], drags: [], choose: "cancel",
    entities: new Map(), state: { st: viewState(W.state()) }, replica: { st: W.state() },
    sync() { H.state.st = viewState(W.state()); H.replica.st = W.state(); },
    /** settle the async sends (sendRequest answers at once; the lock dialog is a promise) */
    flush: () => new Promise((r) => setTimeout(r, 10)),
    /** someone else writes (another person at the authority) */
    other(verb, args, who = "bob") { const r = W.call(verb, args, who); if (!r.ok) throw new Error(`H.other: ${who}'s ${verb} refused: ${JSON.stringify(r.refused)}`); H.sync(); return r; },
  };
  plugin({
    name: "inspect-harness",
    setup(b) {
      b.onResolve({ filter: /^\.\/(world|state|net|panels|ui|confirmcenter|xrask|core|emitters|matoverride)\.js$/ }, (a) =>
        (a.importer.startsWith(path.join(ROOT, "client/lib/")) && !a.importer.includes("/realize/") ? { path: a.path, namespace: "inspect-harness" } : undefined));
      // the realizer (three.js, the GPU paths) is not under test: inspect.js asks it only for a model's box
      b.onResolve({ filter: /^\.\/realize\/models\.js$/ }, (a) => (a.importer.endsWith("/client/lib/inspect.js") ? { path: "realize-models", namespace: "inspect-harness" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "inspect-harness" }, (a) => {
        if (a.path === "realize-models") return { contents: "export const boxOf = () => null; export const previewMesh = () => {};", loader: "js" };
        const m = a.path.match(/(world|state|net|panels|ui|confirmcenter|xrask|core|emitters|matoverride)/)[1];
        // every name client/lib imports from these modules exists (no-ops where the edit path never calls them)
        const noop = (names) => names.map((n) => `export const ${n} = () => {};`).join(" ");
        const src = {
          world: `const H = globalThis.__ih; export const entities = H.entities; export const bagOf = (id) => H.replica.st?.entities?.[id]?.c ?? null; export function* bags() { for (const [k, e] of Object.entries(H.replica.st?.entities ?? {})) if (k !== '@world') yield [k, e.c]; } export const metaOf = () => null; export const avatarMounts = new Map(); export const editHolds = new Map(); export const behaviors = new Map();
            export const findPart = () => null; ${noop(["mountTransform", "setBodySeat", "socketWorldPos"])}`,
          state: `export const state = globalThis.__ih.state; export const onWorldChange = () => () => {}; ${noop(["applyView", "foldLive", "hydrate", "reset"])}`,
          net: `const H = globalThis.__ih;
            export const net = { myId: H.actor, myRights: { role: 'owner' } };
            export const replica = H.replica; export const replicaActive = () => true;
            export const sendDrag = (...a) => { H.drags.push(a); };
            export const sendRequest = async (verb, args) => { H.sent.push({ verb, args: JSON.parse(JSON.stringify(args ?? {})) }); const r = H.W.call(verb, args, H.actor); H.sync(); return r; };
            ${noop(["requestDebug", "requestHistory", "say", "sendAnim", "sendBodyDrag", "sendLease", "sendRelayCredRequest", "sendTyping", "sendVoiceConsent"])}`,
          panels: `export const SCRUB_SPEEDS = {}; ${noop(["renderDOM", "getScrubFeel", "hitRegion", "makeSchemaFrame", "renderCanvas", "resolveDelta", "setScrubFeel"])}`,
          ui: `const H = globalThis.__ih; export const flashHint = (t) => H.hints.push(t); export const toast = (t) => H.toasts.push(t); export const escapeHtml = (s) => String(s); export const isOverlayOpen = () => false;
            export const claimStatus = (k, s) => H.toasts.push(s?.content); ${noop(["collapseAll", "dockPins", "makeSection", "paintRangesIn", "panelFrame", "releaseStatus", "setAmbientHint"])}`,
          confirmcenter: "const H = globalThis.__ih; export const chooseCenter = async (q) => { H.asked.push(q); return H.choose; }; export const confirmCenter = async () => false;",
          core: `import * as THREE_ from '${path.join(ROOT, "client/node_modules/three/build/three.module.js")}'; export const THREE = { ...THREE_, MeshBasicNodeMaterial: THREE_.MeshBasicMaterial }; export const scene = new THREE_.Scene(); export const camera = new THREE_.PerspectiveCamera();
            export const renderer = { info: { memory: { total: 0 } }, domElement: null, xr: {} }; export const canvas = null; export const CONFIG = {}; export const report = () => {}; export const sun = null; export const ground = null; export const TSL = {}; export const BASE_PIXEL_RATIO = 1; export const XR_BOOT = false;`,
          emitters: "export const effectLookup = () => null;",
          matoverride: "export const materialsOf = () => [];",
          xrask: `export const xrActive = () => false; export const chooseXR = async () => null; export const xrAskState = () => null; ${noop(["initXRAsk", "xrAnswer"])}`,
        }[m];
        return { contents: src, loader: "js" };
      });
    },
  });
  return H;
}
