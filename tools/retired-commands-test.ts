// retired-commands-test — a removed command still answers why (house config I19, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/retired-commands-test.ts
//
// /w (whisper), /emote (now /anim) and /ghost, /unghost (removed) keep unlisted rows with a `retired` line, which chat.js
// says instead of "unknown command" (and instead of the silence a row with no handler gave /w). The registry is a pure
// table; chat.js's runCommand reads `retired` before dispatching.
import { readFileSync } from "node:fs";
const { COMMANDS, resolveCommand } = await import("../client/lib/commands/registry.js");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
for (const [w, re] of [["w", /whisper/], ["emote", /\/anim/], ["ghost", /ghost was removed/], ["unghost", /ghost was removed/]] as const) {
  const row: any = resolveCommand(w);
  check(`/${w} resolves to a retired row that says why`, !!row && row.listed === false && re.test(row.retired ?? ""), JSON.stringify(row));
}
check("no retired row is listed in autocomplete", COMMANDS.every((c: any) => !c.retired || c.listed === false));
const chat = readFileSync(new URL("../client/lib/chat.js", import.meta.url), "utf8");
check("chat.js says a retired row's line before dispatching it", /row\?\.retired\)\s*\{\s*logChat\('\*',\s*row\.retired\)/.test(chat));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
