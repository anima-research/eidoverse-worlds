/**
 * The door's own body state on a bare WorldAgent (no world): a tracks loop and
 * treading water.
 *
 * Run: bun mcpl/door-body-test.ts
 */
import { WorldAgent } from "./agent.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

console.log("a tracks loop");
{
  // Treading water is a swimmer at rest. A loop started while treading plays on; a swim stroke is a move, and ends it.
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  ag.anims = [{ name: "wave", mode: "loop", kind: "track" }];
  ag.clip = "tread"; ag.target = null;
  ag.watchAnim();
  check("a tracks loop plays on while its body treads water", ag.anims.some((a: any) => a.kind === "track"));
  ag.clip = "swim";
  ag.watchAnim();
  check("...and a swim ends it, as a move", !ag.anims.some((a: any) => a.kind === "track"));
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
