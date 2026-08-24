# Getting a KTX2 encoder (toktx/ktx)

The §20 texture pipeline needs KTX-Software's `toktx` (or `ktx`) CLI to
build compressed variants. It is strictly optional: without it the server
boots, logs one line, skips the sweep, and serves originals — see
`server/optimize.ts` (exit 3) and `server/upload.ts`.

Homebrew does **not** carry it (we said `brew install ktx` in a few places
before checking — it doesn't exist). The source is the official release:
https://github.com/KhronosGroup/KTX-Software/releases (v4.4.2 verified).

## macOS, Apple Silicon — WITHOUT Rosetta

The `Darwin-arm64.pkg`'s payload is fully native arm64 (verified: every
binary and dylib carries the arm64 Mach-O header), but its installer
metadata is missing `hostArchitectures="arm64"`, so macOS Installer wrongly
demands Rosetta. Skip the installer entirely:

```sh
cd ~/Downloads
pkgutil --expand-full KTX-Software-4.4.2-Darwin-arm64.pkg ktx-expand
mkdir -p ~/ktx-tools
cp -R ktx-expand/KTX-Software-4.4.2-Darwin-arm64-tools.pkg/Payload/usr/local/bin ~/ktx-tools/bin
cp -R ktx-expand/KTX-Software-4.4.2-Darwin-arm64-library.pkg/Payload/usr/local/lib ~/ktx-tools/lib
xattr -dr com.apple.quarantine ~/ktx-tools
~/ktx-tools/bin/toktx --version     # toktx v4.4.2
```

The `bin/` + `lib/` sibling layout is load-bearing: the tools link
`@rpath/libktx.4.dylib` with an `@executable_path/../lib` rpath. If
Gatekeeper still refuses ("killed"): `codesign --force --sign - ~/ktx-tools/bin/*`.

Then run the sequencer with:

```sh
KTX2_TOKTX=~/ktx-tools/bin/toktx bun server/server.ts
```

## Windows — portable, no install

The NSIS installer extracts with 7-Zip:

```sh
curl -LO https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Windows-x64.exe
7z x -oktx KTX-Software-4.4.2-Windows-x64.exe
# binaries at ktx/bin/toktx.exe — point KTX2_TOKTX at it
```

## Linux (the show VPS is Ubuntu) — the .deb, or portable

The release ships `Linux-x86_64` as `.deb`, `.rpm` and `.tar.bz2`. The .deb
puts `toktx` and `ktx` on PATH, which is all the probe needs:

```sh
curl -LO https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.deb
sudo apt install ./KTX-Software-4.4.2-Linux-x86_64.deb
toktx --version                    # toktx v4.4.2
```

Portable, no root: `tar xjf KTX-Software-4.4.2-Linux-x86_64.tar.bz2` and
point `KTX2_TOKTX` at `<extracted>/bin/toktx` (the `bin/` + `lib/` sibling
layout is load-bearing here too — the tools find `libktx` by rpath).

Under systemd the sequencer's PATH is not your shell's (the same reason
upload.ts spawns `process.execPath` and not `bun`): put
`Environment=KTX2_TOKTX=/usr/bin/toktx` in the unit, or the boot sweep logs
`no encoder` and every `?ktx2=1` answer stays webp. That is the show box's
state as of 2026-08-24 — verified from outside: every library and store
model fetched with `?ktx2=1` came back `EXT_texture_webp`, none
`KHR_texture_basisu`. The §20 arc is built and dormant there until this
lands.

## Either platform

The negotiation key a client sends (`?ktx2=<key>`) is a generation, defined
once in `shared/ktx2.js` and imported by both the client and the sequencer.
Bump it when a flagged answer has been served with the wrong caching — the
old key's cache entries are simply never asked for again (a purge cannot
reach browsers). The fall-through answer under the current key is served
`no-cache` until a variant exists, then the variant is served immutable.

`KTX2_TOKTX` may point at either `toktx` or the newer `ktx` binary — the
probe (`findKtx2Encoder`) detects which by name. Without the env it also
checks PATH for both. The sweep runs once per boot, serial, ~5-30s per
model; variants land in `assets/opt/` beside the paths they shadow.
