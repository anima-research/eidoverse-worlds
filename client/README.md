# client

The browser client. The sequencer serves this directory as static files; nothing is built or bundled.

- **Entry:** `client/index.html` loads `client/main.js`. A device that can't hold a 3D world gets `client/lite.js` instead (chat, actions, who's here); `index.html` chooses between them.
- **Read first:** `client/lib/base.js` (the renderer-free substrate: bus, config, helpers) and `client/lib/core.js` (renderer, scene, camera). A module that never touches the GPU imports `base.js`, not `core.js`.
- **`lib/` is mostly flat on purpose.** Folders exist where a domain is big enough to need one:
  - `realize/` turns stored components into scene objects and owns their lifetime (`client/lib/realize/lifecycle.js`'s `release` is the one word every registry listens for);
  - `edit/` is build mode's panels and tools;
  - `commands/` is the command bar's table (`client/lib/ui/commands/registry.js` imports nothing, on purpose) and its handlers;
  - `vegetation/`, `bodyruntimes/`.
- **The trap:** `client/lib/core.js` is not what tests and agents run. Many tests stub it with a Bun resolver, and the agent runtime swaps in `mcpl/headless-core.mjs`. A change to `core.js`'s exports needs both checked.
- **Not browser-only:** `mcpl/` imports some modules from `lib/` to run bodies headless, so a `lib/` module can't assume a DOM unless only the browser imports it.
- `client/vendor/` holds third-party code served as-is (`three-addons`, `ammo`, `piper`); `THIRD-PARTY.md` at the root records where each came from.
