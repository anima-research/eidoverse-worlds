// bun tools/drawbench.ts [--out /tmp/drawbench]
// Owned, isolated WebGPU pixel + actual draw-call comparison; no sequencer or
// live world needed. SFU_TEST_CHROME selects a browser; otherwise Playwright's.
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';

const root = resolve(import.meta.dir, '..');
const at = process.argv.indexOf('--out');
const out = at >= 0 ? resolve(process.argv[at+1]) : null;
if (out) mkdirSync(out, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  const file = resolve(root, path === '/' ? 'tools/drawbench/bench.html'
    : path.startsWith('/node_modules/') ? `client${path}` : `.${path}`);
  if (!file.startsWith(root+'/')) return new Response('', { status:403 });
  return new Response(Bun.file(file));
} });
const chrome = process.env.SFU_TEST_CHROME
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let browser;
const errors = [];
const receipts = [];
try {
  browser = await chromium.launch({ executablePath: chrome, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage({ viewport: { width:800, height:600 } });
  page.on('pageerror', (e) => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', (m) => { if(m.type()==='error') { errors.push(m.text()); console.error(m.text()); } });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  for (const name of ['base','motion','hidden','layers','frustum','shadow-only','transparent','cutout','tangents','overlap','mirrored','sheared','removed']) {
    await page.evaluate((n) => window.setCase(n), name);
    const before = await page.evaluate(() => window.capture(false));
    const after = await page.evaluate(() => window.capture(true));
    const b = Buffer.from(before.png.split(',')[1], 'base64');
    const a = Buffer.from(after.png.split(',')[1], 'base64');
    const bp = PNG.sync.read(b), ap = PNG.sync.read(a);
    let changed = 0, sum = 0, max = 0, over2 = 0;
    for (let i=0; i<bp.data.length; i+=4) {
      let pixelMax = 0;
      for(let c=0;c<3;c++) { const d = Math.abs(bp.data[i+c]-ap.data[i+c]); sum+=d; max=Math.max(max,d); pixelMax=Math.max(pixelMax,d); }
      if(pixelMax) changed++;
      if(pixelMax>2) over2++;
    }
    const pixels = bp.width*bp.height;
    const receipt = { name, before: before.drawCalls, after: after.drawCalls,
      trianglesBefore:before.triangles, trianglesAfter:after.triangles,
      changedPixels:changed, over2Fraction:over2/pixels, meanChannelError:sum/(pixels*3), max,
      batching:after.batches };
    receipts.push(receipt);
    console.log(JSON.stringify(receipt));
    if(out) { await Bun.write(join(out,`${name}-before.png`),b); await Bun.write(join(out,`${name}-after.png`),a); }
    // Subpixel rounding at an edge is tolerable; broad shading changes are not.
    if(receipt.over2Fraction > 0.001 || receipt.meanChannelError > 0.05) errors.push(`${name}: pixel parity failed`);
    if(name==='base' && after.drawCalls > before.drawCalls*0.3) errors.push('base: draw reduction below 70%');
  }
  if(out) await Bun.write(join(out,'receipt.json'),JSON.stringify({receipts,errors},null,2));
  if(errors.length) throw new Error(errors.join('\n'));
  console.log('drawbench: WebGPU draw reduction and pixel parity passed');
} finally {
  await browser?.close();
  server.stop(true);
}
