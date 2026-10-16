# Registry changelog

Every re-pin of spec/registry-pin.json that changed, removed or narrowed a trial or reserved component (PROTOCOL §4 Status;
docs/COMPONENT-LADDER.md). Written by `bun tools/protocol/pretrans-check.ts --pin --ack "<why>"`, newest last.

- 2026-10-16: shape audit wave 1 (R 10-16): training-consent removed (a server's terms); imported-epoch merged into imported:epoch; roles.sub dropped (no person data); capacity and script-settings are policy numbers with no pinned defaults (absent = this server's default), script-settings trimmed to {run, max, budget, cpu}. First pin with status, ranges, required, keyPattern/maxKeys, itemEnums, scopeFields and writtenBy.
  - imported-epoch: the name is gone (a registered name is read forever)
  - roles.sub: type any → gone
  - training-consent: the name is gone (a registered name is read forever)
  - capacity.entities: default 10000 → gone
  - capacity.guestEntities: default 500 → gone
  - capacity.avatar: default 2000 → gone
  - script-settings.install: type string → gone
  - script-settings.rate: type int → gone
  - script-settings.depth: type int → gone
  - script-settings.fails: type int → gone
  - script-settings.runs: type int → gone
  - script-settings.run: default true → gone
  - script-settings.install: default "builder" → gone
  - script-settings.max: default 12 → gone
  - script-settings.budget: default 600 → gone
  - script-settings.rate: default 6 → gone
  - script-settings.depth: default 8 → gone
  - script-settings.fails: default 5 → gone
  - script-settings.cpu: default 2000 → gone
  - script-settings.runs: default 60 → gone
  - script-settings.install: "builder" is no longer allowed
  - script-settings.install: "owner" is no longer allowed
