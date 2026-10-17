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
//   B. an explicit key of the allowed set lands verbatim (hex, base64
//      without `+`, urlsafe alphabets);
//   C. each spliced value — user, key, bind, every port — refuses `&`, `|`,
//      `\`, a newline, a quote, `#`, and an out-of-range or non-numeric
//      port, with exit 2 (a refusal, not sed's exit 1), the variable named
//      in the message, and NO output file left behind;
//   D. the refusal is the validator's, not sed's: the message names the
//      variable and the offending value with its bad characters masked;
//      a key with `+` is refused with the reason (the RTMP URL reads it as
//      a space);
//   E. every spliced value comes back as the string given when the rendered
//      file is parsed as YAML, the values YAML would otherwise type
//      (`-`, `true`, `123`, a key of zeros) included, and the YAML 1.1
//      booleans mediamtx reads (`on`, `yes`) are written quoted;
//   F. a host:port bind is refused (the ports are their own settings); an
//      IPv6 bind is written bracketed beside its port, `::1` still
//      becomes 127.0.0.1, and an IPv4 bind is left as it is.
//
//   bun tools/mkconfig-test.ts   (E and F parse with Bun.YAML, Bun 1.2.21 or later)
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
  check('the key is in the YAML as the publisher password', !!r.yaml && r.yaml.includes(`pass: "${r.stdout}"\n`));
  check('no placeholder survives', !!r.yaml && !/^[^#\n]*\$\{/m.test(r.yaml));
  check('loopback everywhere', !!r.yaml && /rtmpAddress: "127\.0\.0\.1:1935"/.test(r.yaml));
  check('mode 600', (statSync(r.out).mode & 0o777) === 0o600);
}

const base = { PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: '0123456789abcdef' };

console.log('— B. an explicit key of the allowed set lands verbatim —');
for (const key of ['0123456789abcdef', 'Ab0/=._-9xyz12Qr', 'dGhpcyBpcyBhIHRlc3Q=', 'url-safe_key.v2/ok']) {
  const r = render({ PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: key });
  check(`${JSON.stringify(key)} renders`, r.code === 0 && !!r.yaml && r.yaml.includes(`pass: "${key}"\n`) && r.stdout === key, `exit=${r.code} ${r.stderr}`);
}

{
  // empty is not hostile: the script's `${VAR:-default}` reads it as unset
  const r = render({ ...base, PROJECTOR_PUBLISH_USER: '', PROJECTOR_HLS_PORT: '' });
  check('an empty user or port takes the default, as unset would', r.code === 0 && !!r.yaml && /user: "publisher"\n/.test(r.yaml) && /hlsAddress: "0\.0\.0\.0:8888"/.test(r.yaml), `exit=${r.code} ${r.stderr}`);
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
  // wider than the shell's integer: `[ -lt ]` errors instead of comparing
  hostile.push([`${port} = 99999999999999999999`, port, { ...base, [port]: '99999999999999999999' }]);
}
let refused = 0;
for (const [name, variable, env] of hostile) {
  const r = render(env);
  const ok = r.code === 2 && r.stderr.includes(variable) && r.yaml === null;
  if (ok) refused++; else check(name, false, `exit=${r.code} stderr=${JSON.stringify(r.stderr)} file=${r.yaml === null ? 'absent' : 'PRESENT'}`);
}
check(`all ${hostile.length} hostile values refused with exit 2, the variable named, no file written`, refused === hostile.length, `${refused}/${hostile.length}`);

console.log('— D. the refusal is the validator\'s: bad characters masked, the key never shown —');
{
  const r = render({ ...base, PROJECTOR_PUBLISH_KEY: 'abcdefgh&ijklmnop' });
  check('the key refusal names the allowed set…', r.stderr.includes('PROJECTOR_PUBLISH_KEY may only use [A-Za-z0-9_./=-]'), r.stderr);
  check('…and none of the key reaches stderr (the smoke run prints it on failure)', !/abcdefgh|ijklmnop/.test(r.stderr), r.stderr);
  const plus = render({ ...base, PROJECTOR_PUBLISH_KEY: 'abcdefgh+ijklmnop' });
  check('a key with `+` is refused, saying the RTMP URL reads it as a space, and leaves no file',
    plus.code === 2 && /PROJECTOR_PUBLISH_KEY may not contain '\+'.*reads as a space/.test(plus.stderr) && plus.yaml === null, `exit=${plus.code} ${plus.stderr}`);
  check('…without showing the key', !/abcdefgh|ijklmnop/.test(plus.stderr), plus.stderr);
  const u = render({ ...base, PROJECTOR_PUBLISH_USER: 'pub&lisher' });
  check('a non-secret value is shown with `&` masked', /PROJECTOR_PUBLISH_USER may only use \[A-Za-z0-9_.-\] \(got 'pub\?lisher'\)/.test(u.stderr), u.stderr);
  const p = render({ ...base, PROJECTOR_HLS_PORT: '70000' });
  check('a port out of range says the range', /must be 1–65535 \(got 70000\)/.test(p.stderr), p.stderr);
  const w = render({ ...base, PROJECTOR_HLS_PORT: '99999999999999999999' });
  check('a port wider than the shell\'s integer says the range too, and leaves no file', w.code === 2 && /must be 1–65535 \(got 99999999999999999999\)/.test(w.stderr) && w.yaml === null, `exit=${w.code} ${w.stderr} file=${w.yaml === null ? 'absent' : 'PRESENT'}`);
}

const YAML = (Bun as unknown as { YAML?: { parse(s: string): any } }).YAML;
// a value that breaks the YAML (an unquoted `-` user does) is a failed check, not a crash
const parsed = (r: ReturnType<typeof render>) => { try { return r.yaml && YAML ? YAML.parse(r.yaml) : null; } catch { return null; } };

console.log('— E. every spliced value comes back as the string given —');
if (!YAML) check('Bun.YAML is here to parse the rendered config (Bun 1.2.21 or later)', false, `bun ${Bun.version}`);
else {
  for (const user of ['-', 'true', '123', 'null']) {
    const c = parsed(render({ ...base, PROJECTOR_PUBLISH_USER: user }));
    check(`user ${JSON.stringify(user)} is the string ${JSON.stringify(user)}`, c?.authInternalUsers?.[0]?.user === user, JSON.stringify(c?.authInternalUsers?.[0]?.user));
  }
  const zeros = '0000000000000000';
  const k = parsed(render({ PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: zeros }));
  check('a 16-zero key is the string, not the number 0', k?.authInternalUsers?.[0]?.pass === zeros, JSON.stringify(k?.authInternalUsers?.[0]?.pass));
  for (const path of ['123', 'true']) {
    const c = parsed(render({ ...base, PROJECTOR_PATH: path }));
    const perms = (c?.authInternalUsers ?? []).flatMap((u: any) => u.permissions ?? []).map((x: any) => x.path);
    check(`path ${JSON.stringify(path)} is the string, as the paths key and in each permission`,
      !!c && Object.keys(c.paths ?? {}).includes(path) && perms.length === 2 && perms.every((x: unknown) => x === path), JSON.stringify({ paths: Object.keys(c?.paths ?? {}), perms }));
  }
  // mediamtx's YAML reader also takes YAML 1.1's yes/no/on/off, unquoted, as
  // booleans, keys included; a YAML 1.2 parser like Bun's reads them as
  // strings either way, so for these the rendered lines are read as text
  for (const word of ['on', 'yes']) {
    const r = render({ ...base, PROJECTOR_PUBLISH_USER: word, PROJECTOR_PATH: word });
    check(`user and path ${JSON.stringify(word)} are written quoted, as the paths key too`,
      !!r.yaml && r.yaml.includes(`user: "${word}"\n`) && r.yaml.includes(`\n  "${word}":\n`) && (r.yaml.match(new RegExp(`path: "${word}"\n`, 'g')) ?? []).length === 2,
      r.yaml?.split('\n').filter((l) => l.includes(word)).join(' | ') ?? `exit=${r.code}`);
  }
  const d = parsed(render({}));
  check('every address is a string', !!d && ['rtspAddress', 'rtmpAddress', 'hlsAddress', 'webrtcAddress', 'webrtcLocalUDPAddress'].every((a) => typeof d[a] === 'string'), JSON.stringify(d && [d.rtspAddress, d.rtmpAddress, d.hlsAddress, d.webrtcAddress, d.webrtcLocalUDPAddress]));
}

console.log('— F. a host:port bind is refused; an IPv6 bind is bracketed beside its port —');
for (const bind of ['0.0.0.0:1935', 'localhost:8554']) {
  const hp = render({ PROJECTOR_BIND: bind, PROJECTOR_PUBLISH_KEY: '0123456789abcdef' });
  check(`${bind} is refused with exit 2 as a host:port, and leaves no file`,
    hp.code === 2 && /PROJECTOR_BIND is a host or an IPv6 address, not host:port/.test(hp.stderr) && hp.yaml === null, `exit=${hp.code} ${hp.stderr}`);
}
if (YAML) {
  const v6 = render({ PROJECTOR_BIND: 'fe80::1', PROJECTOR_PUBLISH_KEY: '0123456789abcdef' });
  const c = parsed(v6);
  check('fe80::1 renders', v6.code === 0, v6.stderr);
  check('each address on the bind is [fe80::1]:port',
    c?.rtmpAddress === '[fe80::1]:1935' && c?.hlsAddress === '[fe80::1]:8888' && c?.webrtcAddress === '[fe80::1]:8889' && c?.webrtcLocalUDPAddress === '[fe80::1]:8189',
    JSON.stringify(c && [c.rtmpAddress, c.hlsAddress, c.webrtcAddress, c.webrtcLocalUDPAddress]));
  check('the caption tap stays on IPv4 loopback', c?.rtspAddress === '127.0.0.1:8554', String(c?.rtspAddress));
  const lo = parsed(render({ PROJECTOR_BIND: '::1' }));
  check('::1 still becomes 127.0.0.1, unbracketed', lo?.rtmpAddress === '127.0.0.1:1935', String(lo?.rtmpAddress));
  const v4 = parsed(render(base));
  check('an IPv4 bind is left as it is', v4?.rtmpAddress === '0.0.0.0:1935', String(v4?.rtmpAddress));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
