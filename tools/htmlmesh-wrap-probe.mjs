// htmlmesh-wrap-probe — a VR panel's text that WRAPS draws on its own lines, after what precedes it. Before, a wrapped
// text node was one fillText at its bounding box: a chat message began at the line's left edge, over the name, and
// the wrapped lines stayed empty (the owner's headset pass, 09-27). Real client page; the real vendored HTMLMesh.
//   bun tools/htmlmesh-wrap-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=wrapprobe&key=${world.key}&lite=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(async () => {
    const { HTMLMesh } = await import('./lib/vendor/htmlmesh.js');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:220px;padding:4px;font:14px/18px sans-serif;background:#123;color:#eee';
    el.innerHTML = '<div class="line"><span class="t">22:28</span> <b class="n">nick</b> <span class="m">BREAKTHROUGH its the grass or something on the same plane as it when I look up</span></div><div class="line2">short one</div>';
    document.body.appendChild(el);
    const calls = []; const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) { calls.push({ t, x: Math.round(x), y: Math.round(y) }); return orig.call(this, t, x, y); };
    const mesh = new HTMLMesh(el); mesh.material.map.update?.();
    await new Promise((res) => setTimeout(res, 200));
    CanvasRenderingContext2D.prototype.fillText = orig;
    const eb = el.getBoundingClientRect(), nb = el.querySelector('.n').getBoundingClientRect();
    const m = el.querySelector('.m'), rng = document.createRange(); rng.selectNodeContents(m);
    const lines = [...rng.getClientRects()].map((q) => Math.round(q.top - eb.top));
    const msgCalls = calls.filter((c) => /BREAKTHROUGH|grass|look|up/.test(c.t));
    const first = calls.find((c) => /BREAKTHROUGH/.test(c.t));
    const nameRight = Math.round(nb.right - eb.left);
    const ys = [...new Set(msgCalls.map((c) => c.y))];
    mesh.dispose?.(); el.remove();
    return { lines, nameRight, first, ys, n: calls.length, sample: calls.slice(0, 6), short: calls.find((c) => c.t === 'short one') };
  });
  console.log('  ·', JSON.stringify(r));
  check('the test message wraps in the DOM (more than one line box)', r.lines.length > 1, JSON.stringify(r.lines));
  check('its first word starts AFTER the name, not over it', r.first && r.first.x >= r.nameRight, `first x ${r.first?.x} vs name right ${r.nameRight}`);
  check('it draws on as many rows as the DOM laid it out on', r.ys.length === r.lines.length, `drawn rows ${r.ys.length}, DOM lines ${r.lines.length}`);
  check('a line that doesn\'t wrap is still one fillText', !!r.short, JSON.stringify(r.short));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
