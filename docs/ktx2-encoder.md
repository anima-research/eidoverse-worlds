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

## Either platform

`KTX2_TOKTX` may point at either `toktx` or the newer `ktx` binary — the
probe (`findKtx2Encoder`) detects which by name. Without the env it also
checks PATH for both. The sweep runs once per boot, serial, ~5-30s per
model; variants land in `assets/opt/` beside the paths they shadow.
