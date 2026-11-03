// icons — the shipped attention glyphs exist as real, distinct path data.
//
//   bun tools/icons-test.ts
//
// Why this test is shaped like this: the bug that motivated icons.js was
// canvas fillText of an emoji painting NOTHING when the platform lacks the
// glyph — no error, just empty pixels, invisible to any CI that runs on a
// machine with good font coverage. Path data can't fail that way at the
// platform level, but it CAN fail at the registry level: an entry deleted in
// a refactor, an empty array, two states accidentally sharing one glyph. This
// pins the registry. (A true raster assertion — stroke the Path2D and count
// non-zero pixels per icon layer — needs a browser; we run that in our
// downstream playwright rig, where it reports distinct per-icon pixel counts.
// This repo's suite stays browser-free, so the registry contract lives here.)

import * as I from "../client/lib/icons.js";
const { has, svg } = I as any;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// the three states the typing relay actually admits, and the hear glyph pair (HUD toggle, nameplate mark, hover card)
const SHIPPED = ["ear", "think", "wrench", "headphones", "headphonesOff"];

const rendered: Record<string, string> = {};
for (const name of SHIPPED) {
  check(`${name} exists in the registry`, has(name));
  const markup = svg(name);
  rendered[name] = markup;
  const ds = [...markup.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]).join(" ");
  // real Lucide glyphs are multi-command paths; a stub or truncation isn't
  const commands = (ds.match(/[MLHVCSQTAZmlhvcsqtaz]/g) ?? []).length;
  check(`${name} has substantive path data`, commands >= 4, `${commands} commands`);
  check(`${name} carries path geometry, not empty markup`, ds.length >= 20, `${ds.length} chars`);
}

// distinct states must be distinct glyphs — two states sharing one path is
// the "which is it?" failure a viewer can't diagnose
for (let i = 0; i < SHIPPED.length; i++)
  for (let j = i + 1; j < SHIPPED.length; j++)
    check(`${SHIPPED[i]} ≠ ${SHIPPED[j]}`, rendered[SHIPPED[i]] !== rendered[SHIPPED[j]]);

// and nothing shipped may depend on an entry that isn't there: the registry
// is allowed to carry spares, but ICON_FOR (avatar.js) may only name real ones
const avatarSrc = await Bun.file(new URL("../client/lib/avatar.js", import.meta.url)).text();
const iconFor = avatarSrc.match(/ICON_FOR = \{([^}]*)\}/)?.[1] ?? "";
for (const m of iconFor.matchAll(/:\s*'(\w+)'/g))
  check(`ICON_FOR '${m[1]}' resolves in the registry`, has(m[1]));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
