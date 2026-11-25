// ammo-load — opening Bullet's wasm once (headless in bun, a script tag in the browser), and the wasm temporaries.
// AMMO is a live binding: null until ensureAmmo() resolves true.

export let AMMO = null;
let ammoLoading = null;

export async function ensureAmmo() {
  if (AMMO) return true;
  if (ammoLoading) return ammoLoading;
  ammoLoading = (async () => {
    try {
      if (typeof document === 'undefined') {
        // headless (bun): the glue has a CommonJS tail
        const [{ createRequire }, { fileURLToPath }] = await Promise.all([
          import('node:module'), import('node:url'),
        ]);
        const req = createRequire(import.meta.url);
        const dir = fileURLToPath(new URL('../../vendor/ammo/', import.meta.url));
        AMMO = await req(dir + 'ammo.wasm.js')({ locateFile: (f) => dir + f });
      } else {
        // browser: classic Emscripten script, not an ES module — script tag
        if (!globalThis.Ammo) {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = '/vendor/ammo/ammo.wasm.js';
            s.onload = res;
            s.onerror = () => rej(new Error('vendor/ammo failed to load'));
            document.head.appendChild(s);
          });
        }
        AMMO = await globalThis.Ammo({ locateFile: (f) => '/vendor/ammo/' + f });
      }
      _initTemps();
      return true;
    } catch (e) {
      console.error('[ammodoll] wasm init failed — verlet stays', e);
      AMMO = null;
      return false;
    } finally {
      ammoLoading = null;
    }
  })();
  return ammoLoading;
}

export let _bv1, _bv2, _bt1, _bt2, _bq1;
function _initTemps() {
  if (_bv1) return;
  _bv1 = new AMMO.btVector3(); _bv2 = new AMMO.btVector3();
  _bt1 = new AMMO.btTransform(); _bt2 = new AMMO.btTransform();
  _bq1 = new AMMO.btQuaternion(0, 0, 0, 1);
}
