// stdio-door-test — the plain-MCP stdio door, proven over its actual wire.
//
//   bun tools/stdio-door-test.ts
//
// Born with the §24r unification (mcpl/server.ts registers from tools.ts's
// shared TOOLS + handleTool instead of its own hand-copied 16-tool subset).
// The stdio door had NO test in its whole life as a drifting copy — this one
// spawns the real process against a scratch sequencer and speaks real
// newline-delimited JSON-RPC over its stdin/stdout: initialize, tools/list
// (the full shared table, travel absent, pending_pings present), and calls
// through the shared dispatcher — including tools that never existed on this
// door before the unification.

import { scratchBench, mkCheck, sleep, ROOT } from './harness.ts';
import { join } from 'node:path';

const { PORT, cleanup, die } = await scratchBench('stdiodoor');
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
  const gained = ['pose', 'clear_pose', 'reach', 'clear_reach', 'emote', 'animate', 'posture',
    'ragdoll', 'measure', 'world_history', 'world_debug', 'library_sheet', 'library_preview',
    'set_avatar', 'light', 'catch_up', 'activity', 'whisper'];
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
  const posture = await rpc('tools/call', { name: 'posture', arguments: { kind: 'sit' } });
  check('posture (gained in the unification) answers', /sit down/.test(toolText(posture)), toolText(posture));

  const pose = await rpc('tools/call', { name: 'pose', arguments: { bones: { leftUpperArm: [0, 0, -0.9, 0.44] } } });
  check('pose (gained) validates and reports', /holding a pose over 1 bone/.test(toolText(pose)), toolText(pose));

  const pings = await rpc('tools/call', { name: 'pending_pings', arguments: {} });
  check('pending_pings answers (door-local vocabulary)', /no pending pings|reach|mention/.test(toolText(pings)), toolText(pings));

  // activity on a push-less host: the held-digest truth, straight from the ctx
  const act = await rpc('tools/call', { name: 'activity', arguments: {} });
  check('activity tells the pollless-host truth (held digests)', /HELD|held/.test(toolText(act)), toolText(act).slice(0, 120));

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
