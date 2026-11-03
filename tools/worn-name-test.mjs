// The 'avatar-worn' payload comes in two shapes (a string from setMe, { name, path } from announceWorn); every
// listener that keys storage by body name must see the same name. Round-1 B2: xr.js keyed a per-body scale by
// '[object Object]'.
import { wornNameOf } from '../client/lib/base.js';
let pass = 0, fail = 0; const ok = (c, n) => { if (c) pass++; else fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); };
ok(wornNameOf('aporia') === 'aporia', 'a string is its own name');
ok(wornNameOf({ name: 'tigerbee', path: 'eidoverse/assets/vrms/tigerbee.vrm' }) === 'tigerbee', '{ name, path } yields the name');
ok(wornNameOf(undefined) === '' && wornNameOf(null) === '' && wornNameOf({}) === '', 'nothing yields the empty string, never "[object Object]"');
ok(String(wornNameOf({ name: undefined })) !== '[object Object]', 'an object never leaks as a key');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
