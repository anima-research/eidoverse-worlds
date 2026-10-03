// bun tools/world-log-recovery-test.ts — repeated unclean startup after reset.
// Every source/derived file is tiny; constructor+flush without fold models the
// disk state a second process sees if recovery itself dies before shutdown.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
const scratch = mkdtempSync(join(tmpdir(), "ew-log-recovery-"));
Object.assign(process.env, { WORLDS_DIR: join(scratch,"worlds"), OPT_DIR: join(scratch,"opt"),
  EIDOVERSE_DIR: join(scratch,"library"), SKIP_OPT_SWEEP: "1", RECORD_FRAMES: "0" });
const { WorldLog } = await import("../server/world.ts");
let passed = false, checks = 0;
try {
  for (const mode of ["missing-log", "empty-log", "partial-quarantine"]) {
    const old = new WorldLog(mode);
    old.append("owner","spawn",{id:"old-thing",lib:"old.glb"});
    old.fold("fixture");
    const dir=join(scratch,"worlds",mode);
    writeFileSync(join(dir,"poses.json"),JSON.stringify({oldPerson:{p:[123,0,456]}}));
    writeFileSync(join(dir,"snapshot.json.tmp"),"incomplete old snapshot");
    writeFileSync(join(dir,"poses.json.tmp"),"incomplete old poses");
    const derived=["snapshot.json","poses.json","snapshot.json.tmp","poses.json.tmp"];
    const original = new Map(derived.map(f=>[f,readFileSync(join(dir,f))]));
    mkdirSync(join(dir,"erased-partial"));
    renameSync(join(dir,"log.jsonl"),join(dir,"erased-partial","log.jsonl"));
    if (mode==="empty-log") writeFileSync(join(dir,"log.jsonl"),"");
    if (mode==="partial-quarantine") {
      mkdirSync(join(dir,"orphaned-derived-interrupted"));
      renameSync(join(dir,"snapshot.json"),join(dir,"orphaned-derived-interrupted","snapshot.json"));
    }
    const first = new WorldLog(mode);
    first.flushLog(); // fresh genesis persisted, then unclean exit (no fold)
    assert.deepEqual(first.poses,{}); checks++;
    assert.ok(!first.state.entities["old-thing"]); checks++;
    const again = new WorldLog(mode);
    assert.deepEqual(again.poses,{},mode+": second startup cannot resurrect poses"); checks++;
    assert.ok(!again.state.entities["old-thing"],mode+": second startup cannot resurrect snapshot"); checks++;
    for (const file of derived) {
      assert.ok(!existsSync(join(dir,file)),mode+": derived file retired before genesis"); checks++;
      const copies=readdirSync(dir).filter(n=>n.startsWith("orphaned-derived-"))
        .map(n=>join(dir,n,file)).filter(p=>existsSync(p));
      assert.equal(copies.length,1,mode+": exactly one preserved derived copy"); checks++;
      assert.deepEqual(readFileSync(copies[0]),original.get(file),mode+": byte-identical quarantine"); checks++;
    }
    // Growing beyond the old snapshot offset must not make that cache eligible.
    again.append("new-owner","say",{text:"new epoch ".repeat(300)});
    again.flushLog();
    const third = new WorldLog(mode);
    assert.ok(!third.state.entities["old-thing"]); checks++;
    assert.deepEqual(third.poses,{}); checks++;
    assert.ok(third.entries.some(e=>e.verb==="say")); checks++;
  }
  passed = true;
  console.log("PASS " + checks + " durable orphan-recovery assertions");
} finally {
  if (passed) rmSync(scratch,{recursive:true,force:true});
  else console.error("Failure evidence retained at "+scratch);
}
process.exit(0);
