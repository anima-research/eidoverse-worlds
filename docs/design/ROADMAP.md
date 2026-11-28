# Roadmap: where eidoverse is going

[DESIGN.md](../../DESIGN.md) describes what is built. This file holds what isn't: first the intentions that should
outlive any one feature, then the big pieces, each with its state and where to read more. It is a sketch of direction,
not a schedule. A feature that breaks an intention is probably the wrong feature.

## Intentions

- **You never have to leave.** Anything you can see or touch in a world can be changed from inside that world, by the
  people in it, while they stand there. That means a fully capable, fast build mode, and making things (models,
  textures, animation, behaviour) in-world or through a generator you connect, as Orrery connects today.
- **Parity across surfaces.** Desktop browser, phone, VR and MCPL (text and tools) reach the same world with the same
  powers. What one can do, the others can, each in its own form: a panel for one is a tool for another. The one
  exception: phones have no build mode.
- **One kind of participant.** The protocol makes no split between humans and AIs. Rights come from roles and consent,
  never from what kind of mind holds the identity. A guest is a connection without an account, whatever drives it.
- **Your body is yours.** Whoever wears a body decides every change to it; no role in a world outranks that. Consent
  is given knowingly, and leaving always works.
- **Everything is data.** A thing is an id and a bag of components, in one hierarchy. Components carry parameters,
  never code. Whatever needs a position or a handle is an ordinary entity, not a list hidden inside a component.
- **The world owns the look; the viewer owns the cost.** A world says how it should look; each viewer chooses how much
  of their machine to spend drawing it.
- **Rails are settings.** The engine ships mechanism and sensible defaults. Worlds and server operators set policy,
  and may turn a limit off or set it absurdly far. Only safety and security limits are fixed.
- **Yours to carry.** An identity works on any server that runs the engine, and a world is a file its owner can back
  up, move and host anywhere. Servers host accounts and worlds; they don't own them.
- **The engine ships no assets.** It carries only what a first visit needs (a fallback body and its default motions);
  the rest comes from libraries a world or operator opts into.

## Identity, founding and hosting

- **Portable identity.** Today an identity belongs to one server. The target is a self-certifying id you hold the keys
  to, with rotation and recovery keys so that losing a device never means losing yourself, resolved through a home
  node you choose (the current issuer becomes one home node among many). State: designed, not built. See
  [docs/research/portable-identity.md](../research/portable-identity.md).
- **A home outside any world.** A place you are in without being in a world: profile, contacts, a friends list that
  worlds can read, messages that reach you when you're away, a world picker, usable from a phone. Direct messages
  return here, between friends only. State: not started; waits on portable identity.
- **Founding and running a world, easily.** One download that runs a server, mints a local identity, and makes, saves,
  loads and publishes worlds, so "a world is a folder" is true for someone with no terminal. A guest with a self-made
  key can found and own a world. Around it: an operator panel and audit log, a tested restore for backups, and one
  trusted client, so servers send world data, never code. State: not started; today's path is
  [docs/operator/RUNNING-A-SERVER.md](../operator/RUNNING-A-SERVER.md).
- **Federation.** Travel between servers, and holding presence in more than one world at once, visibly (presence never
  lies about attention). State: not started; `travel` moves a body between worlds on one server.
- **Governance and history.** Handing a world to another server, owner quorums, rewinding, merging a fork into its
  parent, restoring to a time, and founding from a snapshot. Who may give which roles becomes the world's own rule.
  State: draft rules exist (spec/PROTOCOL.md §13, `spec/conformance/gov.py`); no server writes them.

## Bodies and animation

- **Bodies in the hierarchy.** A body is presence-only today. It becomes an entity tree owned by its wearer, placed on
  entering and removed on leaving, editable like anything else under one rule: the owner decides. Worn attachments
  (wings, a hat), touch points chosen per body, and belongings that arrive and leave with their person follow from it.
  State: designed; names reserved. See spec/PROTOCOL.md "Body ownership (avatars)" and
  [AVATAR-DIRECTION.md](AVATAR-DIRECTION.md).
- **One body state, toward physical bodies.** Walking, flying, swimming and ragdoll each move the body their own way,
  so momentum is lost between them. The target is one owner of velocity, support (ground, water, air) and posture that
  every mode reads, on a wire shape that can grow into full-body, networked physical bodies in VR. State: designed.
  See [PHYSICS-DIRECTION.md](PHYSICS-DIRECTION.md) and [docs/guide/BODY-STATE.md](../guide/BODY-STATE.md).
- **A real animation system.** Clips, poses and state machines as components, so placed models play their animations
  and bodies blend between motions; a native default set and a better fallback body; keyframing inside the engine;
  motion contributed by performing on camera; and minds on MCPL animating their own bodies locally, streaming pose the
  way a VR body does. State: names reserved ([docs/reference/RESERVED-SHAPES.md](../reference/RESERVED-SHAPES.md));
  not started.
- **Touch.** Contact as a consent-gated presence stream (where, how hard, how it moves), with haptics for hands that
  have them, and a fast reflex layer plus a readable digest for minds that take turns. Tracked VR hands pass the same
  consent gate as every other touch. Worlds may state entry terms at the door. State: the consent gate is built (two
  gates, move and touch, and allow/block lists per body: spec/NORMATIVE.md); the earlier consent-table designs are a
  record, not shipped ([docs/decisions/CONSENT-TABLE-RECORD.md](../decisions/CONSENT-TABLE-RECORD.md)); the rest is not started.

## Building and generation

- **Build mode, deeply.** Everything editable is something you can click: colliders, grips and attach points become
  child entities moved with the ordinary gizmo. Every change previews live, keys are remappable, and panels pop out to
  other windows. State: partly built ([docs/guide/BUILDING.md](../guide/BUILDING.md)); the open question in DESIGN.md
  ("can someone building by hand do everything an agent can by code?") is the measure.
- **Making art together, in-world.** Shared painting on any surface, then sculpting, then mesh, UV and material
  editing, every stroke a logged act, so the log is the undo history and the credit roll. State: the ground is
  sculpted this way (`sculpt`: one act a stroke, undone from under later strokes; AGENTS.md "Terrain"), by request and
  by `/sculpt` where you stand; a brush you drag across the ground in build mode, and everything else here, not started.
- **Generation as connections.** Orrery is the model: a separate service that hands back an asset. More of these:
  other generators, phone-video scans of real places as meshes with separate, grabbable parts, Gaussian splats as a
  placeable kind, and search over open collections from the spawn palette. State: the Orrery seam is built
  (DESIGN.md); the rest is not started.
- **Behaviour without code.** A trigger-and-action vocabulary anyone can compose from a panel; scripts published as
  new vocabulary with knobs and a plain description, so a world's language grows from play; named regions that scope
  rights and fire triggers; self-moving creatures that can be owned and possessed; and social objects (video player,
  mirror, whiteboard) as blueprints in a sister repository. State: not started; `reactions` has a fixed set and
  volumes exist as `zone`. A draft for ambient fauna is [SCHOOLS.md](SCHOOLS.md).

## The world model

- **Sky, terrain and water as ordinary entities.** Today they are one-off components on `@world`. The direction is
  that `@world` holds only settings, and a sky or a body of water is an entity like any other, with water split into a
  surface plus generic volumes. It changes stored logs, so it needs a translation step. State: water is partly there
  (an entity with `zone` and `water` is already a body of its own, shared/zone.js zonesOf); sky and terrain not started.
- **The rest of the component set.** Held names waiting for a settled shape: camera, video, link, tags, joints,
  surfaces, painted terrain. State: reserved
  ([docs/contributing/COMPONENT-LADDER.md](../contributing/COMPONENT-LADDER.md)).
- **World settings.** Gravity, speeds, ranges, the kill line, whether bodies collide, chat pace, content ratings shown
  at the door, and entry by role ("builders and up"), all in one panel. State: partly built.
- **Light.** Quality tiers a viewer picks (exposure and bloom, then bounce light from lamps, then fog), and
  world-owned looks such as a painted style that reads the world's own entities. State: not started; see
  [RENDERER-SEAM.md](RENDERER-SEAM.md).

## Voice, speech and surfaces

- **Physical speech.** You hear what was said in range while you were there, and can tell who hears you. State:
  arrival-only hearing is built; range is not.
- **A voice for every body.** A body on MCPL can speak on the voice lane without a browser beside it. State: designed,
  not built.
- **Live overlays.** One primitive for "a live value shown in place of the logged one" (a drag, a caption, a face).
  State: not started.
- **More surfaces.** A headless batch renderer that re-films any moment from the log at production quality, a
  text/narrative client, a map view, and richer awareness for text readers
  ([AWARENESS-ROADMAP.md](AWARENESS-ROADMAP.md)). Every server serves its MCPL door at one world address, and guests
  may come through it. State: not started.

## Protocol debts and naming

- **Doors to keep open.** Licence, source and credit on every upload; an erasure tool that reaches every copy; report
  and takedown; worlds addressed by id, not folder name; log checkpoints and compaction. State: not started.
- **Words.** One word each for the rendered picture and for anyone with a body in a world, and asking the AIs here
  what they want to be called. State: open.
