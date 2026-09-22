// guard-label-test substitutes this for everything build.js AND scenegraph.js
// import — the build-gate stub plus the handful of symbols scenegraph.js
// wants that build.js never did. placer.js is NOT stubbed: it is the module
// under test, reading the stubbed world/net exactly as the real panels do.
export * from './build-gate-stub.mjs';

// scenegraph.js: world.js
export const avatarMounts = new Map();
// build.js select() calls editHolds.add — world.js keeps a Set (the gate stub
// says Map, which build-gate-test never exercises); a local export shadows
// the star re-export
export const editHolds = new Set();
// scenegraph.js: inspect.js — no evaluator registered any editor here
export const editorsFor = () => [];
// pictures.js: inspect.js — its editor block registers at import; leg E
// renders it directly with the fixture instead of through the scene panel
export const editors = [];
export const registerEditor = (fn) => { editors.push(fn); };
// pictures.js: assets.js / ui.js — hang() primes the image; upload failures toast
export const primeFiles = async () => {};
export const toast = () => {};
// scenegraph.js: net.js — the roster fetch behind the 📜 badges
export const requestDebug = async () => ({ events: [] });
// scenegraph.js: base.js
export const CONFIG = {};
// scenegraph.js: chat.js
export const logChat = () => {};

// ui.js makeSection, faithfully enough: toggle(true) runs onOpen
// SYNCHRONOUSLY up to its first await (the real one does too — that is what
// lets sceneSelect paint before the roster round-trip lands), and the body
// is a real element so paintScene has somewhere to write.
export const sections = new Map();
export function makeSection(title, onOpen, { id = '' } = {}) {
  const body = document.createElement('div');
  document.body.appendChild(body);
  const api = {
    body, isOpen: false,
    async toggle(force) {
      api.isOpen = force ?? !api.isOpen;
      if (api.isOpen) await onOpen?.(body);
    },
  };
  sections.set(id, api);
  return api;
}
