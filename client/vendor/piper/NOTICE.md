# Vendored: piper_phonemize WebAssembly build

Two files, served locally so voice synthesis works offline and hits no CDN
at runtime (the whole point of a local voice is that it is local):

| file | sha256 | bytes |
|---|---|---|
| `piper_phonemize.wasm` | `b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6` | (espeak-ng phonemizer, compiled) |
| `piper_phonemize.data` | `29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c` | (espeak-ng voice/dictionary data) |

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

To re-verify: `sha256sum client/vendor/piper/piper_phonemize.*` against
`https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/…`.
