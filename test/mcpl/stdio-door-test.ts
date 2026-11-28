// stdio-door-test — the plain-MCP stdio door, proven over its actual wire.
//
//   bun test/mcpl/stdio-door-test.ts
//
// mcpl/server.ts serves tools.ts's shared table (toolList + handleTool), not a
// copy of its own. This spawns the real process against a scratch sequencer
// and speaks real newline-delimited JSON-RPC over its stdin/stdout: initialize,
// tools/list (the full shared table, travel absent, pending_pings present),
// and calls through the shared dispatcher.

import { scratchSequencer, mkCheck, ROOT } from '../harness/harness.ts';
import { tryUntil } from '../gate/wait.ts';
import { join } from 'node:path';

// a scratch sequencer with the door's world founded up front for owner stdiobot (TRUST_NAMES: the agent's typed name
// is its account, so it is that owner and may light the lamp below); no browser is involved
const { PORT, cleanup, die } = await scratchSequencer('stdiodoor', { worlds: ['stdiodoor'], owner: 'stdiobot', serverEnv: { TRUST_NAMES: '1', SKIP_OPT_SWEEP: '1' } });
const { check, tally } = mkCheck();

const child = Bun.spawn([process.execPath, join(ROOT, 'mcpl', 'server.ts')], {
  cwd: join(ROOT, 'mcpl'),
  env: {
    ...process.env,
    WORLD_URL: `ws://127.0.0.1:${PORT}/ws`,
    WORLD_NAME: 'stdiodoor',
    AGENT_NAME: 'stdiobot',
    EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(ROOT, '..', 'eidoverse-video'),
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});

// newline-delimited JSON-RPC over the child's stdio — the MCP stdio framing
const pending = new Map<number, (v: any) => void>();
let nextId = 0;
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      } catch { /* not a frame */ }
    }
  }
})();
function rpc(method: string, params: unknown = {}, timeoutMs = 15000): Promise<any> {
  const id = ++nextId;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, timeoutMs);
  });
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stdio-door-test', version: '0' },
  }, 30000);
  check('initialize answers with the server identity',
    init.result?.serverInfo?.name === 'eidoverse-worlds', JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list');
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  check('the shared table serves this door (≥26 tools)', names.length >= 26, `${names.length}: ${names.join(',')}`);
  const gained = ['anim', 'reach', 'measure', 'world_history', 'world_debug',
    'library', 'set_avatar', 'catch_up', 'activity'];   // the surface folds: clear_*/posture/ragdoll are anim's modes, pose/animate are anim, light is create
  const missing = gained.filter((n) => !names.includes(n));
  check('every formerly-missing tool is listed', missing.length === 0, missing.join(' '));
  check('pending_pings (the polling wake surface) is listed', names.includes('pending_pings'));
  check('travel is NOT listed (session machinery this door does not carry)', !names.includes('travel'));
  check('every tool carries a schema', (list.result?.tools ?? []).every((t: any) => t.inputSchema?.type === 'object'));

  const toolText = (r: any) => r.result?.content?.find((c: any) => c.type === 'text')?.text ?? '';

  const look = await rpc('tools/call', { name: 'look', arguments: {} });
  check('look answers through the shared dispatcher', /stdiobot|stdiodoor/.test(toolText(look)), toolText(look).slice(0, 80));

  const say = await rpc('tools/call', { name: 'say', arguments: { text: 'the stdio door speaks' } });
  check('say lands', toolText(say) === 'said', toolText(say));

  // a tool the OLD door never had: the shared dispatcher answers it now
  const posture = await rpc('tools/call', { name: 'anim', arguments: { name: 'sit' } });
  check('anim {name: sit} (gained in the unification) answers', !posture.result?.isError && /sit/.test(toolText(posture)), toolText(posture));

  const pose = await rpc('tools/call', { name: 'anim', arguments: { joints: { leftUpperArm: [0, 0, -0.9, 0.44] } } });
  check('anim {joints} (gained) validates and reports', !pose.result?.isError && /live/.test(toolText(pose)), toolText(pose));

  const pings = await rpc('tools/call', { name: 'pending_pings', arguments: {} });
  check('pending_pings answers (door-local vocabulary)', /no pending pings|reach|mention/.test(toolText(pings)), toolText(pings));

  // activity on a push-less host: the held-digest truth, straight from the ctx
  const act = await rpc('tools/call', { name: 'activity', arguments: {} });
  check('activity tells the pollless-host truth (held digests)', /HELD|held/.test(toolText(act)), toolText(act).slice(0, 120));

  // the inspector, for models: inspect / edit / hierarchy read ONE shared
  // declaration (shared/editschema.js) — the same one the browser renders
  check('inspect · edit · hierarchy are listed', ['inspect', 'edit', 'hierarchy'].every((n) => names.includes(n)));
  const lit = await rpc('tools/call', { name: 'create', arguments: { components: { light: { color: 0xff8800, intensity: 16, range: 6 } }, at: [1, 2, 3] } });
  check('a lamp is created through the door (create {components: {light}})', !lit.result?.isError, toolText(lit));
  const LAMP = /— id (\S+)/.exec(toolText(lit))?.[1] ?? 'no-id';   // ids are minted (writers never choose one)
  // poll for the fold echo instead of guessing a sleep
  let ins: any = null;
  await tryUntil('the fold echoes the lamp', async () => /light\.intensity = 16$/m.test(toolText(ins = await rpc('tools/call', { name: 'inspect', arguments: { id: LAMP } }))), { ms: 6000, step: 200 });
  check('inspect reads the FOLDED light (intensity 16, range 6 m, colour) — not the thinned perception view', /light\.intensity = 16$/m.test(toolText(ins)) && /light\.range = 6 m$/m.test(toolText(ins)) && /0xff8800/.test(toolText(ins)) && /pos\.y = 2 m/.test(toolText(ins)), toolText(ins).slice(0, 200));
  const dry = await rpc('tools/call', { name: 'edit', arguments: { id: LAMP, dry: true, set: { 'pos.x': '+=1', 'pos.z': 0, 'light.intensity': '+=25%' } } });
  // a lamp is a thing with a light component: the edit is ONE door batch, a transform set (the whole pose) and a
  // light set (the bag, merged)
  check('edit dry: three edits → ONE batch: set transform (full pose) + set light', (toolText(dry).match(/would send/g) ?? []).length === 1 && /would send batch .*"component":"transform","value":\{"pos":\[2,2,0\]/.test(toolText(dry)) && /"component":"light","value":\{[^}]*"intensity":20[,}]/.test(toolText(dry)), toolText(dry));
  const ed = await rpc('tools/call', { name: 'edit', arguments: { id: LAMP, set: { 'light.intensity': '+=4', 'flags.label': 'the porch lamp' } } });
  check('edit sends (one batch: the label and the light)', /sent batch .*"component":"label","value":"the porch lamp"/.test(toolText(ed)) && /"component":"light"/.test(toolText(ed)), toolText(ed));
  let ins2: any = null;
  await tryUntil('the fold echoes the edit', async () => { ins2 = await rpc('tools/call', { name: 'inspect', arguments: { id: LAMP } }); return /light\.intensity = 20$/m.test(toolText(ins2)) && /porch lamp/.test(toolText(ins2)); }, { ms: 6000, step: 200 });
  check('…and the fold came back with 20 and the label', /light\.intensity = 20$/m.test(toolText(ins2)) && /"the porch lamp"/.test(toolText(ins2)), toolText(ins2).slice(0, 160));
  // (a lamp is a thing: it has a heading, so pos.yaw is no longer the field it lacks)
  const bad = await rpc('tools/call', { name: 'edit', arguments: { id: LAMP, set: { 'light.flicker': 2 } } });
  check('a field a light does not have is refused by name, nothing sent, marked isError', /refused: light\.flicker/.test(toolText(bad)) && !/sent/.test(toolText(bad)) && bad.result?.isError === true, toolText(bad));
  const hier = await rpc('tools/call', { name: 'hierarchy', arguments: {} });
  check('hierarchy lists the lamp with its label (an Empty with a light component)', new RegExp(`\\[${LAMP.slice(0, 4)}[^\\]]*\\] "the porch lamp" (model · )?(empty · )?light`).test(toolText(hier)), toolText(hier).slice(0, 300));
  const hf = await rpc('tools/call', { name: 'hierarchy', arguments: { filter: 'nothing-like-this' } });
  check('a filter with no match says so', /no placed thing matches/.test(toolText(hf)), toolText(hf));
  const lk = await rpc('tools/call', { name: 'look', arguments: {} });
  check('look() carries the label too', /"the porch lamp"/.test(toolText(lk)), toolText(lk).slice(0, 200));

  // one line of stdin is one message: a call as long as upload's largest file is read and answered (the sdk's own cap,
  // 10 MiB a line, closes the transport for good on a longer one). These bytes are no model, so the world's store
  // refuses them in its own words and keeps nothing
  const { UPLOAD_DATA_BYTES } = await import('../../mcpl/tools.ts');
  const long = rpc('tools/call', { name: 'upload', arguments: { data: Buffer.alloc(UPLOAD_DATA_BYTES, 0x61).toString('base64') } }, 60000);
  await child.stdin.flush();
  const big = await long.catch((e) => ({ error: String(e) }));
  check(`a tool call as long as upload's largest file (${(UPLOAD_DATA_BYTES / 1e6).toFixed(1)} MB, base64 in one line) is read and answered, in the store's words`,
    big.result?.isError === true && /not a GLB container/.test(toolText(big)), JSON.stringify(big).slice(0, 200));
  const still = await rpc('tools/call', { name: 'look', arguments: {} }).catch((e) => ({ error: String(e) }));
  check('…and the door answers the call after it', /stdiobot|stdiodoor/.test(toolText(still)), JSON.stringify(still).slice(0, 120));

  const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  check('an unknown tool is a marked error', unknown.result?.isError === true || !!unknown.error,
    JSON.stringify(unknown).slice(0, 120));
} catch (e) {
  check('door conversation completed', false, String(e));
  const err = await new Response(child.stderr).text().catch(() => '');
  console.error(err.slice(-2000));
}

child.kill();
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
if (tally.failed) await die(1, 'stdio-door-test: FAILED');
await cleanup();
process.exit(0);
