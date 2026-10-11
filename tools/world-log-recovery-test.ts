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
  // A non-empty authored log keeps its snapshot and poses, and boot starts
  // from them: the quarantine is for derived files with no log.
  {
    const kept = new WorldLog("kept");
    kept.append("owner","spawn",{id:"kept-thing",lib:"kept.glb"});
    kept.fold("fixture");
    const dir=join(scratch,"worlds","kept");
    writeFileSync(join(dir,"poses.json"),JSON.stringify({keeper:{p:[1,2,3]}}));
    kept.flushLog();
    const snapshotBytes=readFileSync(join(dir,"snapshot.json"));
    const again = new WorldLog("kept");
    assert.deepEqual(again.poses,{keeper:{p:[1,2,3]}},"kept: poses are used"); checks++;
    assert.ok(again.snapSeq>=0,"kept: boot starts from the snapshot, not a full replay"); checks++;
    assert.ok(again.state.entities["kept-thing"],"kept: the snapshot's state is there"); checks++;
    assert.deepEqual(readFileSync(join(dir,"snapshot.json")),snapshotBytes,"kept: the snapshot stays where it was"); checks++;
    assert.ok(!readdirSync(dir).some(n=>n.startsWith("orphaned-derived-")),"kept: nothing is quarantined"); checks++;
  }
  // A crash right after the quarantine, before the fresh genesis is on disk:
  // the next start finds no log and no derived files, and the old poses stay
  // out of the new epoch.
  {
    const old = new WorldLog("crash-after-quarantine");
    old.append("owner","spawn",{id:"old-thing",lib:"old.glb"});
    old.fold("fixture");
    const dir=join(scratch,"worlds","crash-after-quarantine");
    writeFileSync(join(dir,"poses.json"),JSON.stringify({oldPerson:{p:[9,9,9]}}));
    mkdirSync(join(dir,"erased-crash"));
    renameSync(join(dir,"log.jsonl"),join(dir,"erased-crash","log.jsonl"));
    new WorldLog("crash-after-quarantine"); // quarantines, appends genesis in memory, then the process dies unflushed
    assert.ok(!existsSync(join(dir,"poses.json")) && !existsSync(join(dir,"snapshot.json")),"crash: derived files retired before genesis"); checks++;
    const restarted = new WorldLog("crash-after-quarantine");
    assert.deepEqual(restarted.poses,{},"crash: the restart has no old poses"); checks++;
    assert.ok(!restarted.state.entities["old-thing"],"crash: nor the old snapshot's state"); checks++;
    const copies=readdirSync(dir).filter(n=>n.startsWith("orphaned-derived-"));
    assert.equal(copies.length,1,"crash: one quarantine, kept"); checks++;
    assert.deepEqual(JSON.parse(readFileSync(join(dir,copies[0],"poses.json"),"utf8")),{oldPerson:{p:[9,9,9]}},"crash: the old poses are preserved there"); checks++;
  }
  passed = true;
  console.log("PASS " + checks + " durable orphan-recovery assertions");
} finally {
  if (passed) rmSync(scratch,{recursive:true,force:true});
  else console.error("Failure evidence retained at "+scratch);
}
process.exit(0);
