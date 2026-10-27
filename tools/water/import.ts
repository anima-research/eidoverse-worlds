// bun tools/water/import.ts MANIFEST --dry                         print the requests, nothing sent (no server needed)
// bun tools/water/import.ts MANIFEST SERVER WORLD [--apply]        preflight (read-only), or upload the files and send them
// A manifest carries its `requests` (prepare.ts writes them), or main's `verbs` (world-data/water/manifest.json), which
// requests.js maps (the old-world translator's own mapping). Features this protocol doesn't carry yet (none in #248's world
// now) are listed and never sent; --apply refuses while any remain. Credentials come only from EIDO_TOKEN.
// @ts-nocheck
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { requestsOf } from './requests.js';

const argv = process.argv.slice(2), flags = new Set(argv.filter((a) => a.startsWith('--'))), [file, server, world] = argv.filter((a) => !a.startsWith('--'));
const dry = flags.has('--dry'), apply = flags.has('--apply');
if (!file || (!dry && (!server || !world))) throw Error('usage: import.ts MANIFEST --dry | import.ts MANIFEST SERVER WORLD [--apply]');
const manifest = JSON.parse(readFileSync(file, 'utf8'));

const files = manifest.files ?? [], bytes = new Map(), absent = [];
for (const f of files) {
  const p = resolve(dirname(file), f.file);
  if (!existsSync(p)) { absent.push(f.file); continue; }
  const data = readFileSync(p);
  if (createHash('sha256').update(data).digest('hex') !== f.sha256) throw Error(`asset hash mismatch: ${f.file}`);
  bytes.set(f.path, data);
}
const req = manifest.requests ? { batch: manifest.requests[0], deferred: manifest.deferred ?? [], mapped: manifest.mapped ?? [], unmapped: manifest.unmapped ?? [] } : requestsOf(manifest.verbs, world ?? 'water');
if (dry) {
  console.log(JSON.stringify({ requests: [req.batch], mapped: req.mapped, unmapped: req.unmapped ?? [], deferred: req.deferred, files: { checked: bytes.size, absent } }, null, 1));
  process.exit(0);
}
const base = new URL(server);
console.log(JSON.stringify({ world, server: base.origin, apply, files: bytes.size, absent: absent.length, ops: req.batch.args.ops.length, deferred: req.deferred.length, coordinateSystem: manifest.coordinateSystem }, null, 2));
if (!apply) process.exit(0);
if (req.deferred.length) throw Error(`not sent: ${req.deferred.length} use(s) of features this protocol doesn't carry yet (${[...new Set(req.deferred.map((u) => u.feature))].join(', ')}); see --dry`);
if (absent.length) throw Error(`not sent: ${absent.length} file(s) missing beside the manifest`);
const token = process.env.EIDO_TOKEN ?? '';
// the files first: each manifest path becomes the library path the server stored it under
const pathOf = new Map();
for (const f of files) {
  const u = new URL('/upload', base); u.searchParams.set('token', token); u.searchParams.set('name', f.file);
  let r; for (let retry = 0; retry < 5; retry++) { r = await fetch(u, { method: 'POST', body: bytes.get(f.path), headers: { 'content-type': 'model/gltf-binary' } }); if (r.status !== 429) break; console.log('waiting for the upload rate window'); await Bun.sleep(15000); }
  if (!r.ok) throw Error(`asset upload failed: HTTP ${r.status}`);
  pathOf.set(f.path, (await r.json()).path);
}
const swap = (v) => (typeof v === 'string' ? pathOf.get(v) ?? v : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
const batch = swap(req.batch);
const url = new URL('/ws', base); url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(url);
await new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(Error('cannot connect')); });
try {
  const reply = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Error('no reply in 30 s; look at the world before retrying')), 30000);
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data));
      if (m.type === 'error') { clearTimeout(timer); rej(Error(m.error ?? 'refused')); }
      if (m.type === 'snapshot') ws.send(JSON.stringify({ type: 'request', id: 'water-import', ...batch }));
      if (m.type === 'reply' && m.id === 'water-import') { clearTimeout(timer); res(m); } };
    ws.onclose = () => rej(Error('the server closed the connection'));
    ws.send(JSON.stringify({ type: 'join', world, id: 'water-import', token }));
  });
  console.log(JSON.stringify({ ok: reply.ok, refused: reply.reply?.refused ?? null, ids: reply.reply?.ids ?? null }, null, 1));
  if (!reply.ok) process.exit(1);
} finally { ws.close(); }
