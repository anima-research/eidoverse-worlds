// deploy/projector/mkconfig.sh renders mediamtx.template.yml by splicing
// environment values into YAML with sed. Both grammars have characters that
// are syntax rather than text (`&` and `\` and the `|` delimiter on sed's
// replacement side; `#`, `:`, quotes and newlines in YAML), so a value that
// carries one renders WRONG rather than failing — `p&ss` becomes the literal
// `p${PUBLISH_KEY}ss`. The script now checks every spliced value against the
// characters inert in both and refuses by name (Mica, #187 round-two
// follow-up). What must hold:
//   A. the defaults render: exit 0, a minted hex key printed and present in
//      the YAML, no `${…}` left, mode 600;
//   B. an explicit key of the allowed set lands verbatim (hex, base64,
//      urlsafe alphabets);
//   C. each spliced value — user, key, bind, every port — refuses `&`, `|`,
//      `\`, a newline, a quote, `#`, and an out-of-range or non-numeric
//      port, with exit 2 (a refusal, not sed's exit 1), the variable named
//      in the message, and NO output file left behind;
//   D. the refusal is the validator's, not sed's: the message names the
//      variable and the offending value with its bad characters masked.
//
//   bun tools/mkconfig-test.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const SCRIPT = new URL('../deploy/projector/mkconfig.sh', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'mkconfig-'));
let n = 0;

function render(env: Record<string, string>) {
  const out = join(dir, `out-${++n}.yml`);
  const r = Bun.spawnSync(['sh', SCRIPT, out], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString().trim(), out, yaml: existsSync(out) ? readFileSync(out, 'utf8') : null };
}

console.log('— A. the defaults render —');
{
  const r = render({});
  check('exit 0', r.code === 0, r.stderr);
  check('a 48-hex key is minted and printed', /^[0-9a-f]{48}$/.test(r.stdout), r.stdout);
  check('the key is in the YAML as the publisher password', !!r.yaml && r.yaml.includes(`pass: ${r.stdout}\n`));
  check('no placeholder survives', !!r.yaml && !/^[^#\n]*\$\{/m.test(r.yaml));
  check('loopback everywhere', !!r.yaml && /rtmpAddress: 127\.0\.0\.1:1935/.test(r.yaml));
  check('mode 600', (statSync(r.out).mode & 0o777) === 0o600);
}

const base = { PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: '0123456789abcdef' };

console.log('— B. an explicit key of the allowed set lands verbatim —');
for (const key of ['0123456789abcdef', 'Ab0/+=._-9xyz12Q', 'dGhpcyBpcyBhIHRlc3Q=', 'url-safe_key.v2+ok/']) {
  const r = render({ PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: key });
  check(`${JSON.stringify(key)} renders`, r.code === 0 && !!r.yaml && r.yaml.includes(`pass: ${key}\n`) && r.stdout === key, `exit=${r.code} ${r.stderr}`);
}

{
  // empty is not hostile: the script's `${VAR:-default}` reads it as unset
  const r = render({ ...base, PROJECTOR_PUBLISH_USER: '', PROJECTOR_HLS_PORT: '' });
  check('an empty user or port takes the default, as unset would', r.code === 0 && !!r.yaml && /user: publisher\n/.test(r.yaml) && /hlsAddress: 0\.0\.0\.0:8888/.test(r.yaml), `exit=${r.code} ${r.stderr}`);
}

console.log('— C. every spliced value refuses syntax, by name, leaving no file —');
const hostile: Array<[string, string, Record<string, string>]> = [];
for (const [label, bad] of Object.entries({ ampersand: '&', pipe: '|', backslash: '\\', newline: '\n', quote: '"', hash: '#', space: ' ' })) {
  hostile.push([`PROJECTOR_PUBLISH_KEY with ${label}`, 'PROJECTOR_PUBLISH_KEY', { ...base, PROJECTOR_PUBLISH_KEY: `abcdefgh${bad}ijklmnop` }]);
  hostile.push([`PROJECTOR_PUBLISH_USER with ${label}`, 'PROJECTOR_PUBLISH_USER', { ...base, PROJECTOR_PUBLISH_USER: `pub${bad}lisher` }]);
  hostile.push([`PROJECTOR_BIND with ${label}`, 'PROJECTOR_BIND', { ...base, PROJECTOR_BIND: `0.0.0.0${bad}` }]);
}
for (const port of ['PROJECTOR_RTSP_PORT', 'PROJECTOR_RTMP_PORT', 'PROJECTOR_HLS_PORT', 'PROJECTOR_WEBRTC_PORT', 'PROJECTOR_WEBRTC_UDP_PORT']) {
  hostile.push([`${port} = 99999`, port, { ...base, [port]: '99999' }]);
  hostile.push([`${port} = 0`, port, { ...base, [port]: '0' }]);
  hostile.push([`${port} = 8554|x`, port, { ...base, [port]: '8554|x' }]);
}
let refused = 0;
for (const [name, variable, env] of hostile) {
  const r = render(env);
  const ok = r.code === 2 && r.stderr.includes(variable) && r.yaml === null;
  if (ok) refused++; else check(name, false, `exit=${r.code} stderr=${JSON.stringify(r.stderr)} file=${r.yaml === null ? 'absent' : 'PRESENT'}`);
}
check(`all ${hostile.length} hostile values refused with exit 2, the variable named, no file written`, refused === hostile.length, `${refused}/${hostile.length}`);

console.log('— D. the refusal is the validator\'s, with the bad characters masked —');
{
  const r = render({ ...base, PROJECTOR_PUBLISH_KEY: 'abcdefgh&ijklmnop' });
  check('names the allowed set and shows the value with `&` masked', /may only use \[A-Za-z0-9_.+\/=-\] \(got 'abcdefgh\?ijklmnop'\)/.test(r.stderr), r.stderr);
  const p = render({ ...base, PROJECTOR_HLS_PORT: '70000' });
  check('a port out of range says the range', /must be 1–65535 \(got 70000\)/.test(p.stderr), p.stderr);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
