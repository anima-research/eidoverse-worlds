# Modding the client UI

Two surfaces, deliberately small. (Shape borrowed from the systems that aged
well: WoW's frames — the default UI is itself an addon consuming the same API
— and Resonite's slot-component model — everything is slots you can reparent
and restyle. Ours is the humble web cousin of both.)

## 1. The token sheet — restyle everything, touch nothing

Every color in the client resolves through the `:root` token block at the top
of `client/index.html` (roles documented inline there: brand = identity &
liveness, attn = needs-your-attention, ink ladder = content, surfaces,
interaction whites). JS-drawn chrome (mic/ear glyphs, nameplates) reads the
same tokens at draw time.

Live-override from anywhere:

    document.documentElement.style.setProperty('--brand', '#b39dff');

The in-client **settings → style** section is exactly this, with swatches and
persistence (`ew-style-tokens`). If your restyle misses an element, that's a
bug in our sweep — file it; hex outside the token sheet is a defect.

## 2. `eido.ui.registerPanel` — add a real panel

    eido.ui.registerPanel({
      id: 'fishlog',            // unique; also the menu row name
      icon: 'scroll',           // Phosphor fill name from icons.js registry
      title: 'fish log',
      w: 280, h: 220, x: 80, y: 80,
      mount(body, frame) {      // body: the frame's content element
        body.textContent = 'no fish yet';
      },
    });

What you get for free: a draggable/resizable frame with the standard chrome,
a row in the ∃ menu (click toggles, pin keeps it on the rail), arrange-mode
tabs, layout lock/reset participation, viewport caging, edge stickiness —
everything the built-in panels get, because the built-ins go through the same
registry. There is no second-class citizenship.

Rules of the road:
- panels persist position by `id` — namespace yours (`myMod:fishlog`);
- read tokens for any color; never hex;
- the world state you can touch is the same lawful surface everyone has
  (verbs over the socket, behaviors server-side — see AGENTS.md). The UI
  registry grants no extra authority, only a place to stand.
