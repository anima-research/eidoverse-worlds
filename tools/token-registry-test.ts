import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupToken, readTokenRegistry } from "../mcpl/token-registry.ts";

let passed = 0;
const check = (condition: unknown, name: string) => {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
};
const root = mkdtempSync(join(tmpdir(), "eido-token-registry-"));
const live = join(root, "tokens.json");
const example = join(root, "tokens.example.json");
const messages: string[] = [];
const log = { error: (m: unknown) => messages.push(String(m)), warn: (m: unknown) => messages.push(String(m)) };
try {
  writeFileSync(example, JSON.stringify({ "public-example": { id: "example", name: "Example", world: "commons" } }));

  check(Object.keys(readTokenRegistry(live, example, log)).length === 0, "missing live registry authorizes nobody");
  writeFileSync(live, "{");
  check(Object.keys(readTokenRegistry(live, example, log)).length === 0, "malformed live registry authorizes nobody");

  writeFileSync(live, JSON.stringify({
    "public-example": { id: "example", name: "Example", world: "commons" },
    "private-random": { id: "resident", name: "", world: "commons" },
    "malformed-private": { name: "No ID" },
  }));
  const accepted = readTokenRegistry(live, example, log);
  check(Object.getPrototypeOf(accepted) === null, "accepted registry has no prototype chain");
  check(lookupToken(accepted, "__proto__") === undefined, "__proto__ cannot authenticate through prototype chain");
  check(lookupToken(accepted, "constructor") === undefined, "constructor cannot authenticate through prototype chain");
  check(lookupToken(accepted, "toString") === undefined, "toString cannot authenticate through prototype chain");
  check(!accepted["public-example"], "tracked example credential is rejected");
  check(accepted["private-random"]?.id === "resident", "private credential remains accepted");
  check(accepted["private-random"]?.name === "resident", "empty name falls back to id");
  check(!accepted["malformed-private"], "malformed private credential is ignored");
  check(messages.some((m) => m.includes("public example credential")), "example rejection is logged");

  rmSync(example);
  check(Object.keys(readTokenRegistry(live, example, log)).length === 0, "missing example registry fails closed");
  writeFileSync(example, "{");
  check(Object.keys(readTokenRegistry(live, example, log)).length === 0, "malformed example registry fails closed");

  console.log(`${passed}/13 token-registry tests passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
