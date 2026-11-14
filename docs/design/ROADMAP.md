# Roadmap: what DESIGN.md describes that isn't built

DESIGN.md holds only what is built. These are the ideas it carried that aren't, each with its state. A design doc
of its own, where one exists, is named.

- **Automata.** Self-animating things (`makeCreature`/`makeBot`): autonomous motion plus a command surface, ownable
  and possessable. State: not started; eidoverse-video has the creature code, nothing here runs it.
- **Regions as capability scopes.** Named volumes ("the kitchen", a private room) that scope rights and fire
  triggers. State: not started; rights are per world (DESIGN.md, Permissions).
- **Composed Layer-1 behaviours.** A trigger→action vocabulary (proximity, sit, timer, phrase, region enter/leave →
  play clip, move, particles, sound, say, give, teleport), authorable by anyone from the panel UI or by request.
  State: not started; `reactions` has a fixed set of handlers and new behaviour is a script.
- **Layer 2 extends Layer 1.** Someone writes the fishing-rod behaviour once and publishes it as a Layer-1
  behaviour with knobs; anyone then attaches "fishable" to any pond with no code, and the world's vocabulary grows
  from play (a missing affordance is felt, described, authored). Every published behaviour carries a
  plain-language description by its author. State: not started; scripts run, publishing them as vocabulary doesn't.
- **More script triggers.** Proximity, phrase and region triggers. State: not started; the built triggers are in
  DESIGN.md, Components.
- **Retroactive filming.** Re-render any moment that ever happened, offline at production quality, by pointing the
  eidoverse batch renderer at a replay (the toolkit as camera crew, replay-to-cinema). State: not started; the log
  makes it possible, no bridge exists.
- **More surfaces.** A headless batch renderer (the film crew), a text/narrative client, a map view. State: not
  started.
- **The video-to-3D reality pipeline.** Phone video → video-to-3D reconstruction → a hierarchy-of-meshes GLB that
  enters as entities (room shell, table and mug as separate, grabbable nodes, readable by text-tier perception),
  used while standing in the world. Chosen over splats, which are rasters you can stand inside. Hybrid worlds
  (procedural gardens through scanned windows), a rescanned place's diffable chronicle, and per-place visibility
  (private / invited / open) follow. State: not started.
- **Semantic search over open collections.** The fetch_model pipeline as an in-world catalogue: Poly Haven,
  Smithsonian and NASA, theme-ranked, in the spawn palette. State: not started.
- **Video-to-motion.** Animations contributed by performing them on camera. State: not started.
- **Presence in several worlds at once.** A participant holding presence in more than one world, visibly
  (presence never lies about attention). State: not started; `travel` moves a body between worlds on one server.
- **Identity across servers.** Keys per participant, aligned with the connectome Archipelago design (keys →
  attestation → domain trust); federation of worlds across hosts, and travel between servers, follow from it.
  State: not started; an identity belongs to one server (docs/research/portable-identity.md).
