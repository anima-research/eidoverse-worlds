// Product-door receipt for the source-preserving standalone Eanpa import.
// Requires EANPA_DONOR_DIR pointing at the paired eidoverse-video donor branch.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const SOURCE = 'a197d3dc42577e9b870b471a39d6b1710c5b5633';
const QUALITY = process.env.EANPA_QUALITY ?? 'medium';
const QUERY = process.env.EANPA_QUERY ?? '';
const WEBGL = QUERY.includes('webgl=1');
const EXPECTED_MODE = { low: 'live-volume', medium: WEBGL ? 'live-volume' : 'banded-world-direction-cloud-panorama', high: 'live-volume' }[QUALITY];
if (!EXPECTED_MODE) throw new Error(`unsupported EANPA_QUALITY ${QUALITY}`);
const { check, done } = checker();
const world = await ownedWorld({ env: { EIDOVERSE_DIR: process.env.EIDOVERSE_DIR, SKIP_OPT_SWEEP: '1' } });
const { page, close } = await launchBrowser();
try {
  const pg = await page();
  const errors = [], logs = [], net = [];
  pg.on('pageerror', (error) => errors.push(error.message));
  pg.on('console', (message) => logs.push(message.text()));
  pg.on('requestfailed', (request) => net.push(`FAILED ${request.url()} ${request.failure()?.errorText ?? ''}`));
  pg.on('response', (response) => { if (response.status() >= 400) net.push(`${response.status()} ${response.url()}`); });
  await pg.goto(`${world.origin}/?world=staging&name=eanpa-current&key=${world.key}${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone'), null, { timeout: 90_000 });
  // A scratch world has no authored sky. Exercise the browser's real local
  // preview door (the same render/build path, without requiring a durable
  // world mutation) rather than treating terminal boot as a sky receipt.
  await pg.evaluate((quality) => import('/lib/sky.js').then(async (sky) => {
    if (sky.getCloudQuality() !== quality) await sky.setCloudQuality(quality);
    await sky.previewSky({ system: 'eidoverse', world: 'earth', hours: 12, weather: 'clear', clouds: 'cumulus', quality });
  }), QUALITY);
  const state = await pg.evaluate(async (source) => {
    const sky = await import('/lib/sky.js');
    const manifestResponse = await fetch('/vendor/eanpa/MANIFEST.json');
    const moduleResponse = await fetch(`/vendor/eanpa/engine/sky_system.js?source=${source.slice(0, 12)}`);
    let manifest = null;
    try { manifest = await manifestResponse.json(); } catch {}
    return {
      impl: sky.skyImpl(),
      backend: globalThis.EW.renderer.backend?.isWebGLBackend ? 'webgl' : 'webgpu',
      preloaded: globalThis.__EANPA_CURRENT_PRELOADED === true,
      source: sky.eanpaActiveSource?.() ?? null,
      cachedCloudCapable: sky.eanpaDebug?.().cachedCloudCapable ?? false,
      displayMode: sky.eanpaDebug?.().displayMode ?? null,
      captureStats: sky.eanpaDebug?.().captureStats ?? null,
      manifestStatus: manifestResponse.status,
      manifestCommit: manifest?.commit ?? null,
      moduleStatus: moduleResponse.status,
      moduleType: moduleResponse.headers.get('content-type') ?? '',
    };
  }, SOURCE);
  check('paired donor manifest is served', state.manifestStatus === 200, JSON.stringify(state));
  check('paired donor manifest names the frozen standalone commit', state.manifestCommit === SOURCE, JSON.stringify(state));
  check('native ESM module is served as JavaScript', state.moduleStatus === 200 && /javascript/.test(state.moduleType), JSON.stringify(state));
  check('the host selected current standalone Eanpa, not retained v0.1', state.preloaded, JSON.stringify(state));
  check('the requested renderer backend was used', state.backend === (QUERY.includes('webgl=1') ? 'webgl' : 'webgpu'), JSON.stringify(state));
  check('the detailed Eidoverse sky completed', state.impl === 'eidoverse', JSON.stringify(state) + '\n' + logs.filter((x) => /sky|Eanpa|weather/i.test(x)).slice(-30).join(' | ') + '\nNET ' + net.slice(-30).join(' | '));
  check('the source receipt reached the realized engine', state.source === SOURCE, JSON.stringify(state));
  check('the realized engine carries the current cached-cloud seam', state.cachedCloudCapable, JSON.stringify(state));
  check(`${QUALITY} realizes its declared cloud display mode`, state.displayMode === EXPECTED_MODE, JSON.stringify(state));
  if (QUALITY === 'medium' && !WEBGL) {
    check('at least one complete cached panorama published without failure',
      state.captureStats?.captures >= 1 && state.captureStats?.failures === 0, JSON.stringify(state));
    const firstCaptures = state.captureStats?.captures ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const later = await pg.evaluate(async () => (await import('/lib/sky.js')).eanpaDebug());
    check('the host frame loop advances and publishes a later complete panorama',
      later.captureStats?.captures > firstCaptures && later.captureStats?.failures === 0, JSON.stringify({ firstCaptures, later }));
  } else check(`${QUALITY} owns no cached Performance target`, state.captureStats === null, JSON.stringify(state));
  check('the source receipt was printed on the real build path', logs.some((line) => line.includes(`[sky] Eanpa source ${SOURCE.slice(0, 12)}`)), logs.filter((x) => /Eanpa|sky/.test(x)).slice(-12).join(' | '));
  check('no Eanpa build/reflection fallback was reported',
    !logs.some((line) => /eidoverse sky \(falling back\)|sky reflections unavailable/i.test(line)),
    logs.filter((line) => /sky|Eanpa|weather/i.test(line)).slice(-30).join(' | '));
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await close();
  await world.close();
}
done();
