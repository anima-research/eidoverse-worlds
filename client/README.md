# client

The browser client. The sequencer serves this directory as static files; nothing is built or bundled.

- **Entry:** `client/index.html` loads `client/main.js`. A device that can't hold a 3D world gets `client/lite.js` instead (chat, actions, who's here); `index.html` chooses between them.
- **Read first:** `client/lib/base.js` (the renderer-free substrate: bus, config, helpers) and `client/lib/core.js` (renderer, scene, camera). A module that never touches the GPU imports `base.js`, not `core.js`.
- **`lib/` is grouped by job.** The 25 files at its root are the world and the wire, which everything imports: `base.js`, `core.js`, `net.js`, `state.js`, `world.js`, `terrain.js`, `colliders.js` and their neighbours. No two files in `lib/` share a basename, so a search by file name still finds anything. The folders:
  - `ui/` is everything on screen that isn't the 3D scene: `ui.js` and its pieces, windows, chat, the command bar and its table `ui/commands/` (`client/lib/ui/commands/registry.js` imports nothing, on purpose), the action bar, settings panels, profile, people;
  - `render/` is the frame: the render path, materials, lights, the frame loop and its budget, the governor, the warm and load queues, capture;
  - `player/` is a person's body as it is controlled and synced: `controller.js`, `localbody.js`, `mybody.js`, `remotes.js`, consent, seats, climbing, vehicles;
  - `avatar/` draws a person (with `avatar/bodyruntimes/`); `ragdoll/` is a body falling; `xr/` is the headset; `audio/` is the mic, speech in and out, voice and the page's AudioContext (placed world sound is `client/lib/realize/sounds.js`); `sky/`; `vegetation/`;
  - `realize/` turns stored components into scene objects and owns their lifetime (`client/lib/realize/lifecycle.js`'s `release` is the one word every registry listens for);
  - `edit/` is build mode's panels and tools;
  - `debug/` is what a normal visit never opens, with one exception: `client/lib/avatar/avatar-thumbnail.js` loads `client/lib/debug/perfscope.js` for `statsOf`, to stamp a body's perf numbers once per version.
- **The trap:** `client/lib/core.js` is not what tests and agents run. Many tests stub it with a Bun resolver, and the agent runtime swaps in `mcpl/headless-core.mjs`. A change to `core.js`'s exports needs both checked.
- **Not browser-only:** `mcpl/` imports some modules from `lib/` to run bodies headless, so a `lib/` module can't assume a DOM unless only the browser imports it.
- `client/vendor/` holds third-party code served as-is (`three-addons`, `ammo`, `piper`); `THIRD-PARTY.md` at the root records where each came from.
