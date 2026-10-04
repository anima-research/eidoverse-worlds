// snap-at-probe — `snapshot {at: <thing>}` frames a placed thing from where the asker stands.
//
//   bun tools/snap-at-probe.mjs          (owns its scratch sequencer; one headless renderer)
//
// The gap it closes (notes/eidoverse/AGENT-ONLY-GAPS-glowing-tree-2026-10-04.md): an agent could only snapshot
// through its own eyes / shoulder / a selfie, so checking something it built meant walking there, or reaching
// into the client. Setup: an agent at the origin faces +z; a red crate sits 6 m BEHIND it. A first-person snap
// must not see the crate (control); `at: crate` must put it in the middle of the frame. Before the change the
// `at` parameter is ignored, the frame is first person, and the middle is not red: watched failing.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const W = `snapat-${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(world.origin.replace('http', 'ws') + '/ws');
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: 'join', world: W, id: 'agent', token: world.key }));
await sleep(800);
ws.send(JSON.stringify({ type: 'pose', pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: 'idle' } }));
ws.send(JSON.stringify({ type: 'verb', verb: 'spawn', args: { id: 'crate1', lib: 'eidoverse/assets/models/crate_large_red.glb', pos: [0, 0, -6], yaw: 0 } }));
await sleep(500);

const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  await pg.goto(`${world.origin}/?renderer&name=rend&world=${W}&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 90000 });
  // keep the agent alive + posed while the renderer loads the crate
  const keep = setInterval(() => ws.send(JSON.stringify({ type: 'pose', pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: 'idle' } })), 500);
  const redMiddle = async (q) => {
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${world.origin}/snap?world=${W}&follow=agent${q}`);
      if (r.ok) {
        const png = Buffer.from(await r.arrayBuffer());
        if (process.env.SNAP_DUMP) await Bun.write(`${process.env.SNAP_DUMP}/snap${q.replace(/[^a-z0-9]/gi, '_')}.png`, png);
        // decode in the page: count strongly red pixels in the middle third
        return await pg.evaluate(async (b64) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const x = c.getContext('2d'); x.drawImage(img, 0, 0);
          const d = x.getImageData(img.width / 3, img.height / 3, img.width / 3, img.height / 3).data;
          let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 110 && d[i] > d[i + 1] * 1.8 && d[i] > d[i + 2] * 1.8) red++;
          return red / (d.length / 4);
        }, png.toString('base64'));
      }
      await sleep(1500);
    }
    return -1;
  };
  await sleep(8000);
  const first = await redMiddle('&view=first');
  const at = await redMiddle('&at=crate1');
  const missing = await fetch(`${world.origin}/snap?world=${W}&follow=agent&at=nope`);
  clearInterval(keep);
  check('control: the first-person snap does not see the crate behind the agent', first >= 0 && first < 0.02, `red=${first}`);
  check('snapshot at: crate1 puts the red crate in the middle third of the frame', at > 0.25, `red=${at}`);
  check('an unknown thing is a clear refusal, not a picture of nothing', !missing.ok && /not a placed thing/.test(await missing.text()), String(missing.status));
} finally {
  await browser.close(); ws.close(); await world.close();
}
done();
