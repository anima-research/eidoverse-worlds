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
- espeak-ng (https://github.com/espeak-ng/espeak-ng): GPL-3.0, data and library. **Both files are
  GPL-3.0**: the `.data` bundle is espeak-ng's data, and the `.wasm` is the piper-phonemize CLI with
  libespeak-ng statically linked in (`strings piper_phonemize.wasm` shows "Failed to initialize eSpeak",
  `--espeak_data`). The MIT parts above stay MIT inside it. The pair is loaded by the browser at runtime;
  the sequencer neither links nor derives from it.

## License compliance (r3 B5 — operator decision required to merge)

Both files carry espeak-ng (the `.data` its data, the `.wasm` its library), licensed **GPL-3.0**. Distributing
these bytes from this repository is *binary distribution of a GPL-3.0-covered
work*, so the repository operator must explicitly accept the obligations or
choose not to vendor. What this directory now carries toward compliance:

- `LICENSE-GPL-3.0.txt` — the full license text (GPLv3 §4 requires conveying
  it with the work).
- **Corresponding source** (GPLv3 §6): the exact sources are public —
  [espeak-ng](https://github.com/espeak-ng/espeak-ng) (the data and library) and
  [rhasspy/piper-phonemize](https://github.com/rhasspy/piper-phonemize) +
  [diffusion-studio/piper-wasm](https://github.com/diffusion-studio/piper-wasm)
  (the build recipe producing exactly these artifacts, pinned at
  `@diffusionstudio/piper-wasm@1.0.0`). A repo distributing the binaries
  should keep this written offer accurate, or mirror the sources.
- The MIT parts (`piper-phonemize`, `piper-wasm`) need only attribution,
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
