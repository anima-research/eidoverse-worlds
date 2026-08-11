# Vendored: piper_phonemize WebAssembly build

Two files, served locally so voice synthesis works offline and hits no CDN
at runtime (the whole point of a local voice is that it is local):

| file | sha256 | bytes |
|---|---|---|
| `piper_phonemize.wasm` | `b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6` | 635,212 (espeak-ng phonemizer, compiled) |
| `piper_phonemize.data` | `29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c` | 18,077,249 (espeak-ng voice/dictionary data) |

**Source**: npm package [`@diffusionstudio/piper-wasm@1.0.0`](https://www.npmjs.com/package/@diffusionstudio/piper-wasm)
(`build/piper_phonemize.{wasm,data}`), the same URLs `@mintplex-labs/piper-tts-web@1.0.4`
loads from jsDelivr when not overridden. **Provenance verified by digest**,
not recollection: the vendored bytes are sha256-identical to the registry
artifacts (checked 2026-08-11).

**Licenses**:
- `@diffusionstudio/piper-wasm`: MIT (https://github.com/diffusion-studio/piper-wasm)
- Upstream `piper-phonemize` (rhasspy): MIT (https://github.com/rhasspy/piper-phonemize)
- The `.data` bundle contains espeak-ng data: GPL-3.0 (https://github.com/espeak-ng/espeak-ng) —
  espeak-ng's data and library are GPLv3; it reaches the browser as a
  self-contained wasm+data pair loaded at runtime by MIT-licensed glue.
  This repository does not link against it server-side; nothing of the
  sequencer derives from it.

## License compliance (r3 B5 — operator decision required to merge)

The `.data` bundle embeds espeak-ng data, licensed **GPL-3.0**. Distributing
these bytes from this repository is *binary distribution of a GPL-3.0-covered
work*, so the repository operator must explicitly accept the obligations or
choose not to vendor. What this directory now carries toward compliance:

- `LICENSE-GPL-3.0.txt` — the full license text (GPLv3 §4 requires conveying
  it with the work).
- **Corresponding source** (GPLv3 §6): the exact sources are public —
  [espeak-ng](https://github.com/espeak-ng/espeak-ng) (the data) and
  [rhasspy/piper-phonemize](https://github.com/rhasspy/piper-phonemize) +
  [diffusion-studio/piper-wasm](https://github.com/diffusion-studio/piper-wasm)
  (the build recipe producing exactly these artifacts, pinned at
  `@diffusionstudio/piper-wasm@1.0.0`). A repo distributing the binaries
  should keep this written offer accurate, or mirror the sources.
- The MIT glue (`piper-phonemize`, `piper-wasm`) needs only attribution,
  carried above.

**The alternative, if the operator declines**: do not vendor — the loader
already accepts any wasm/data location, so a deployment can fetch these two
files at install time (a `postinstall` curl of the pinned jsDelivr URLs,
digest-checked against the table above) and the repository itself
distributes nothing GPL. Functionality is identical; offline-first is then a
deployment property instead of a checkout property. This maintainer decision
is deliberately not made here.

To re-verify provenance: `sha256sum client/vendor/piper/piper_phonemize.*`
against `https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/…`.
