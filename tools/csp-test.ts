// csp-test — the page's script-src hashes are the ones the browser computes. The HTML parser turns CRLF and lone CR into
// LF before a script's text exists (HTML §13.2.3.5), so a hash over the raw file bytes refuses every inline script on a
// CRLF copy of the page (CI windows-latest 10-23: "the page never booted", Chrome wanting the LF hash).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/csp-test.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inlineScriptHashes } from "../server/csp.ts";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  " + JSON.stringify(info)}`); };
const browserHash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const body = "\n  let a = 1;\n  window.x = a;\n";
check("CSP1 an LF page's inline script hashes as the browser hashes it", inlineScriptHashes(`<script>${body}</script>`)[0] === browserHash(body));
check("CSP2 the same page saved with CRLF hashes the same (the parser sees LF)",
  inlineScriptHashes(`<script>${body.replaceAll("\n", "\r\n")}</script>`)[0] === browserHash(body), inlineScriptHashes(`<script>${body.replaceAll("\n", "\r\n")}</script>`));
check("CSP3 a lone CR is a line break to the parser too", inlineScriptHashes(`<script>${body.replaceAll("\n", "\r")}</script>`)[0] === browserHash(body));
const page = readFileSync(new URL("../client/index.html", import.meta.url), "utf8");
const lf = inlineScriptHashes(page.replace(/\r\n?/g, "\n")), crlf = inlineScriptHashes(page.replace(/\r\n?/g, "\n").replaceAll("\n", "\r\n"));
check("CSP4 client/index.html gets the same policy whether it was checked out LF or CRLF", lf.length > 0 && lf.join() === crlf.join(), { lf: lf.length, crlf: crlf.length });

console.log(`[csp-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
