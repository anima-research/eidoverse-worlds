// Offline archive index (read-only): bun tools/frame-index.ts worlds/<world>
// Null metadata identifies a legacy boot-only file. state=open means unclosed:
// inspect complete JSONL lines to recover its tail after a crash. Do not treat
// its missing final sequence/count as an empty segment.
import { archiveIndex } from "../server/frame-archive.ts";
if (process.argv.length !== 3) {
  console.error("usage: bun tools/frame-index.ts <world-directory>");
  process.exit(1);
}
console.log(JSON.stringify(archiveIndex(process.argv[2]), null, 2));
