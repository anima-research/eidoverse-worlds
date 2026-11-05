// tools/protocol/migrate-genesis.ts — RETIRED (minor 1, docs/DESIGN-log-vocabulary.md D1). It moved a pre-release genesis (shape A:
// the §3d port; shape B: {version: 4, minor, …}) to the minor-0 shape and rewrote only the `world` field. Every such log also spells
// its entries in minor 0, so the one path forward is the whole-log migration: tools/protocol/migrate-minor-1 (reads minor 0, writes
// minor 1, publishes the receipt). This name runs nothing and says so.
//   bun tools/protocol/migrate-genesis.ts [--apply] <world dir>…      → exit 2, nothing read, nothing written
console.error("migrate-genesis is retired: a pre-release genesis (shape A or B) is a minor-0 world, and minor-0 worlds are migrated whole by tools/protocol/migrate-minor-1 (docs/DESIGN-log-vocabulary.md D1, §4.6). Nothing was read or changed.");
process.exit(2);
