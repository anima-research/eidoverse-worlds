// htmlmesh-pick-probe — a VR panel click picks what a browser's hit test would (client/lib/vendor/htmlmesh.js, EIDO 7).
// Real client page, the real HTMLMesh; a synthetic panel inside a pointer-events:none stage (as domquad stages them):
//   clip — a row scrolled up out of a scroll box, later in document order, overlaps the header button above the box:
//          the click must reach the BUTTON (the clipped row is not visible there).
//   pe   — a pointer-events:none overlay sibling covers a button: the click must reach the BUTTON, not the overlay.
//   base — a plain button in the inherited-none stage is still clickable (the stage's inherited none is neutral).
//   bun tools/htmlmesh-pick-probe.mjs   (with SKIP_OPT_SWEEP=1 its server starts no asset-optimizer jobs)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=pickprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => !!globalThis.EW?.renderer, null, { timeout: 120000 });
  const r = await pg.evaluate(async () => {
    const { HTMLMesh } = await import('./lib/vendor/htmlmesh.js');
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:99999';
    const frame = document.createElement('div');
    frame.style.cssText = 'position:relative;width:300px;height:200px;background:#222;font:14px sans-serif;overflow:hidden';
    frame.innerHTML = `
      <button id="hdr" style="position:absolute;left:0;top:0;width:300px;height:40px">header</button>
      <div id="box" style="position:absolute;left:0;top:40px;width:300px;height:60px;overflow:auto">
        <div style="height:40px"></div><button id="row" style="display:block;width:300px;height:40px">row</button><div style="height:400px"></div>
      </div>
      <button id="under" style="position:absolute;left:0;top:140px;width:300px;height:40px">under</button>
      <div id="veil" style="position:absolute;left:0;top:140px;width:300px;height:40px;pointer-events:none"></div>`;
    stage.appendChild(frame); document.body.appendChild(stage);
    // scroll the box so #row sits ABOVE the box's top edge, i.e. over the header (rows are 40px; box starts at 40px)
    frame.querySelector('#box').scrollTop = 60;
    const rowR = frame.querySelector('#row').getBoundingClientRect(), hdrR = frame.querySelector('#hdr').getBoundingClientRect();
    const overlaps = rowR.top < hdrR.bottom && rowR.bottom > hdrR.top;
    const hits = [];
    for (const id of ['hdr', 'row', 'under', 'veil']) frame.querySelector(`#${id}`).addEventListener('click', () => hits.push(id));
    const mesh = new HTMLMesh(frame);
    const click = (px, py) => { hits.length = 0; mesh.dispatchEvent({ type: 'click', data: { x: px / 300, y: py / 200 } }); return [...hits]; };
    const clip = click(150, 30);      // inside the header, where the scrolled-out row's rect also lies
    const pe = click(150, 160);       // on the veil over #under
    const base = click(150, 10);
    mesh.material.map?.dispose?.(); stage.remove();
    return { overlaps, rowTop: rowR.top, clip, pe, base };
  });
  console.log('  ·', JSON.stringify(r));
  check('(setup) the scrolled row\'s rect really overlaps the header', r.overlaps, JSON.stringify(r));
  check('clip: the click reaches the visible header, not the row scrolled out of its box', JSON.stringify(r.clip) === '["hdr"]', JSON.stringify(r.clip));
  check('pe: a pointer-events:none overlay does not swallow the click; the button under it gets it', JSON.stringify(r.pe) === '["under"]', JSON.stringify(r.pe));
  check('base: a button in the pointer-events:none stage is still clickable', JSON.stringify(r.base) === '["hdr"]', JSON.stringify(r.base));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
