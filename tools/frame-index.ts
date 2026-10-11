// Offline archive index (read-only): bun tools/frame-index.ts worlds/<world>
// Null metadata with no metadataError means a missing/legacy index; otherwise
// the per-file error names its damaged metadata. A fileError with metadata
// means an index whose frames file was never created. logState/logPaths
// identify matching current/erased authored logs, or unresolved identity;
// logErrors lists every log that couldn't be identified. sizeMismatch flags a
// closed index whose byte count isn't its file's. state=open means unclosed,
// and state=interrupted means a write or close failed, so either may end in
// a torn batch: inspect complete JSONL lines to recover its tail. Do not
// treat its missing final sequence/count as an empty segment.
import { archiveIndex } from "../server/frame-archive.ts";
if (process.argv.length !== 3) {
  console.error("usage: bun tools/frame-index.ts <world-directory>");
  process.exit(1);
}
console.log(JSON.stringify(archiveIndex(process.argv[2]), null, 2));
