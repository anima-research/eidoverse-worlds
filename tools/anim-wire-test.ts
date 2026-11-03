// bun tools/anim-wire-test.ts — legacy packets and modern authoring through
// an isolated sequencer and real agent owners. No production connection.
process.env.AGENT_BODY_ENGINE = 'verlet';
process.env.WORLD_TOKEN = '';
const { WorldAgent } = await import('../mcpl/agent.ts');
const { handleTool } = await import('../mcpl/tools.ts');
const { scratchSequencer, mkCheck, sleep } = await import('./harness.ts');
const { check, tally } = mkCheck();
const h = await scratchSequencer('anim-wire', { serverEnv: { SKIP_OPT_SWEEP: '1' }, portFrom: 9350 });
const agents: any[] = [];
const tracks = { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }] };
const held = { hips: [0, 0, 0, 1] };
async function agent(name: string) {
  const a: any = new WorldAgent({ name, world: 'anim-test', url: h.BASE.replace('http', 'ws') + '/ws' });
  agents.push(a); await a.connect(); return a;
}
async function next(messages: any[], type: string, from: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const i = messages.findIndex(m => m.type === type && (m.id ?? m.by) === from);
    if (i >= 0) return messages.splice(i, 1)[0];
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${type} from ${from}`);
}
try {
  const sender = await agent('sender'), target = await agent('target'), observer = await agent('observer');
  const seen: any[] = [], puppets: any[] = [];
  observer.ws.addEventListener('message', (e: any) => seen.push(JSON.parse(String(e.data))));
  target.ws.addEventListener('message', (e: any) => puppets.push(JSON.parse(String(e.data))));
  for (const [label, flags, expected] of [
    ['legacy', {}, true], ['explicit merge', { replace: false }, false], ['explicit replace', { replace: true }, true],
  ] as const) {
    sender.ws.send(JSON.stringify({ type: 'anim', dur: 1, tracks, ...flags }));
    check(`${label} animation keeps its meaning through the sequencer`, (await next(seen, 'anim', 'sender')).replace === expected);
    target.setPose(held);
    sender.ws.send(JSON.stringify({ type: 'puppet', target: 'target', anim: { dur: 1, tracks, ...flags } }));
    check(`${label} puppet is normalized for the owner`, (await next(puppets, 'puppet', 'sender')).anim.replace === expected);
    check(`${label} puppet preserves/replaces the owner's held pose`, expected ? target.heldPose === null : target.heldPose === held);
    check(`${label} owner rebroadcast preserves the flag`, (await next(seen, 'anim', 'target')).replace === expected);
  }
  sender.setPose(held);
  sender.animate({ dur: 1, tracks });
  check('modern agent animate defaults to explicit merge on the wire', (await next(seen, 'anim', 'sender')).replace === false);
  check('modern agent animate keeps the held pose', sender.heldPose === held);
  const ctx = { agent: sender, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } };
  for (const replace of [false, true]) {
    target.setPose(held);
    // Omit the argument in the default case: the tool must author false itself.
    await handleTool(ctx, 'animate', { dur: 1, tracks, target: 'target', ...(replace ? { replace } : {}) });
    check(`tool target animate (${replace ? 'replace' : 'default'}) sends explicit intent`, (await next(puppets, 'puppet', 'sender')).anim.replace === replace);
    check('the target applies tool-authored intent', replace ? target.heldPose === null : target.heldPose === held);
    await next(seen, 'anim', 'target');
  }
} catch (e) {
  process.exitCode = 1;
  throw e;
} finally {
  for (const a of agents) a.close();
  await h.cleanup(tally.failed || process.exitCode ? 1 : 0);
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
