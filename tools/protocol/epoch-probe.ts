// tools/protocol/epoch-probe.ts — directory-check EP's child: one translateV1World call under the library and OPT_DIR the
// parent chose (server/config.ts reads EIDOVERSE_DIR and OPT_DIR at import, and the parent's own imports have already read
// them), so a physics-era world comes through with content addresses as the real importer makes them, without writing to
// this checkout's assets/. Prints one JSON line: {ok, r} or {ok: false, err}. The assertions are the parent's.
//   OPT_DIR=<scratch> EIDOVERSE_DIR=<library> bun tools/protocol/epoch-probe.ts <v1 world dir> <new world dir> [founder key]
const [src, dest, founderKey] = process.argv.slice(2);
const { translateV1World } = await import("./import-v1/world.ts");
try { const r = translateV1World(src, dest, founderKey ? { founderKey } : {}); console.log(JSON.stringify({ ok: true, r })); }
catch (e: any) { console.log(JSON.stringify({ ok: false, err: String(e?.message ?? e) })); }
