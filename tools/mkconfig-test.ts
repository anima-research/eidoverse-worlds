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
//      becomes 127.0.0.1, and an IPv4 bind is left as it is;
//   G. a user of `any`, or a path of `all_others` or its aliases `all` and
//      `~^.*$`, names the template already holds, is refused with exit 2
//      (mediamtx would refuse the file);
//   H. the read key (the video sequencer's): a network bind without one is
//      refused, a loopback one mints it; it lands as the reader's password,
//      is checked as the publish key is, and the VIDEO_SOURCES entry printed
//      for the operator names the API only where the sequencer can reach it
//      (a loopback appliance), its source id checked before any file is
//      written, and a path that makes no valid id still renders, saying so.
//
//   bun tools/mkconfig-test.ts   (E and F parse with Bun.YAML, Bun 1.2.21 or later)
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const SCRIPT = fileURLToPath(new URL('../deploy/projector/mkconfig.sh', import.meta.url));
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

const READ = 'fedcba9876543210';
const base = { PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: '0123456789abcdef', PROJECTOR_READ_KEY: READ };

console.log('— B. an explicit key of the allowed set lands verbatim —');
for (const key of ['0123456789abcdef', 'Ab0/=._-9xyz12Qr', 'dGhpcyBpcyBhIHRlc3Q=', 'url-safe_key.v2/ok']) {
  const r = render({ ...base, PROJECTOR_PUBLISH_KEY: key });
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
  hostile.push([`PROJECTOR_READ_KEY with ${label}`, 'PROJECTOR_READ_KEY', { ...base, PROJECTOR_READ_KEY: `abcdefgh${bad}ijklmnop` }]);
  hostile.push([`PROJECTOR_READ_USER with ${label}`, 'PROJECTOR_READ_USER', { ...base, PROJECTOR_READ_USER: `rea${bad}der` }]);
  hostile.push([`PROJECTOR_BIND with ${label}`, 'PROJECTOR_BIND', { ...base, PROJECTOR_BIND: `0.0.0.0${bad}` }]);
}
for (const port of ['PROJECTOR_API_PORT', 'PROJECTOR_RTSP_PORT', 'PROJECTOR_RTMP_PORT', 'PROJECTOR_HLS_PORT', 'PROJECTOR_WEBRTC_PORT', 'PROJECTOR_WEBRTC_UDP_PORT']) {
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
  const k = parsed(render({ ...base, PROJECTOR_PUBLISH_KEY: zeros }));
  check('a 16-zero key is the string, not the number 0', k?.authInternalUsers?.[0]?.pass === zeros, JSON.stringify(k?.authInternalUsers?.[0]?.pass));
  for (const path of ['123', 'true']) {
    const c = parsed(render({ ...base, PROJECTOR_PATH: path }));
    const perms = (c?.authInternalUsers ?? []).flatMap((u: any) => u.permissions ?? []).filter((x: any) => x.action !== 'api').map((x: any) => x.path);
    check(`path ${JSON.stringify(path)} is the string, as the paths key and in each permission`,
      !!c && Object.keys(c.paths ?? {}).includes(path) && perms.length === 3 && perms.every((x: unknown) => x === path), JSON.stringify({ paths: Object.keys(c?.paths ?? {}), perms }));
  }
  // mediamtx's YAML reader also takes YAML 1.1's yes/no/on/off, unquoted, as
  // booleans, keys included; a YAML 1.2 parser like Bun's reads them as
  // strings either way, so for these the rendered lines are read as text
  for (const word of ['on', 'yes']) {
    const r = render({ ...base, PROJECTOR_PUBLISH_USER: word, PROJECTOR_PATH: word });
    check(`user and path ${JSON.stringify(word)} are written quoted, as the paths key too`,
      !!r.yaml && r.yaml.includes(`user: "${word}"\n`) && r.yaml.includes(`\n  "${word}":\n`) && (r.yaml.match(new RegExp(`path: "${word}"\n`, 'g')) ?? []).length === 3,
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
  const v6 = render({ ...base, PROJECTOR_BIND: 'fe80::1' });
  const c = parsed(v6);
  check('fe80::1 renders', v6.code === 0, v6.stderr);
  check('each address on the bind is [fe80::1]:port',
    c?.rtmpAddress === '[fe80::1]:1935' && c?.hlsAddress === '[fe80::1]:8888' && c?.webrtcAddress === '[fe80::1]:8889' && c?.webrtcLocalUDPAddress === '[fe80::1]:8189',
    JSON.stringify(c && [c.rtmpAddress, c.hlsAddress, c.webrtcAddress, c.webrtcLocalUDPAddress]));
  check('the caption tap stays on IPv4 loopback', c?.rtspAddress === '127.0.0.1:8554', String(c?.rtspAddress));
  const lo = parsed(render({ PROJECTOR_BIND: '::1' }));
  check('::1 still becomes 127.0.0.1, unbracketed', lo?.rtmpAddress === '127.0.0.1:1935', String(lo?.rtmpAddress));
  const ipFour = parsed(render(base));
  check('an IPv4 bind is left as it is', ipFour?.rtmpAddress === '0.0.0.0:1935', String(ipFour?.rtmpAddress));
}

console.log('— G. the template\'s own names are refused by name (#288) —');
const catchAll = /mediamtx reads 'all', 'all_others' and '~\^\.\*\$' as one catch-all path, and the template already holds it; unset it \(screen\) or choose another name/;
for (const [variable, value, why] of [['PROJECTOR_PUBLISH_USER', 'any', /'any' is the template's own reader.*unset it \(publisher\) or choose another name/], ['PROJECTOR_PATH', 'all_others', catchAll], ['PROJECTOR_PATH', 'all', catchAll], ['PROJECTOR_PATH', '~^.*$', /PROJECTOR_PATH must be \[A-Za-z0-9_-\]\+/]] as const) {
  const r = render({ ...base, [variable]: value });
  check(`${variable}=${value} is refused with exit 2, the variable and the reason named, no file`, r.code === 2 && r.stderr.includes(variable) && why.test(r.stderr) && r.yaml === null, `exit=${r.code} ${r.stderr} file=${r.yaml === null ? 'absent' : 'PRESENT'}`);
}
for (const [variable, value] of [['PROJECTOR_PUBLISH_USER', 'anyone'], ['PROJECTOR_PATH', 'all_others2'], ['PROJECTOR_PATH', 'All']] as const) {
  const r = render({ ...base, [variable]: value });
  check(`…but ${variable}=${value} renders`, r.code === 0, r.stderr);
}

console.log('— H. the read key, and the VIDEO_SOURCES entry printed for the operator —');
{
  const entry = (r: ReturnType<typeof render>) => {
    const line = r.stderr.split('\n').find((l) => /^\s*"[^"]+": \{ "whep"/.test(l));
    try { return line ? JSON.parse(`{${line.trim()}}`) : null; } catch { return null; }
  };
  const lo = render({});
  const reader = parsed(lo)?.authInternalUsers?.find((u: any) => u.user === 'reader');
  check('a loopback appliance mints a read key, the reader\'s password', /^[0-9a-f]{48}$/.test(reader?.pass ?? ''), JSON.stringify(reader?.pass));
  const le = entry(lo);
  check('a loopback appliance\'s entry names the API and the path, on loopback', le?.screen?.api === 'http://127.0.0.1:9997' && le?.screen?.path === 'screen' && le?.screen?.whep === 'http://127.0.0.1:8889/screen/whep', JSON.stringify(le));
  check('…and carries the read key', le?.screen?.pass === reader?.pass && le?.screen?.user === 'reader', JSON.stringify(le));
  const net = render({ PROJECTOR_BIND: '0.0.0.0', PROJECTOR_PUBLISH_KEY: '0123456789abcdef' });
  check('a network bind without a read key is refused with exit 2, naming it, and leaves no file', net.code === 2 && /PROJECTOR_READ_KEY/.test(net.stderr) && net.yaml === null, `exit=${net.code} ${net.stderr}`);
  const n = render(base);
  const ne = entry(n);
  check('a network appliance\'s entry carries the read key and no API (the API answers on loopback only)', ne?.screen?.pass === READ && ne?.screen && !('api' in ne.screen) && !('path' in ne.screen), JSON.stringify(ne));
  check('…and says a sequencer on the same machine may add the API', /same machine.*"api": "http:\/\/127\.0\.0\.1:9997", "path": "screen"/.test(n.stderr), n.stderr);
  const plus = render({ ...base, PROJECTOR_READ_KEY: 'abcdefgh+ijklmnop' });
  check('a read key with `+` is refused and leaves no file, without showing the key', plus.code === 2 && /PROJECTOR_READ_KEY may not contain '\+'/.test(plus.stderr) && plus.yaml === null && !/abcdefgh|ijklmnop/.test(plus.stderr), `exit=${plus.code} ${plus.stderr}`);
  const badId = render({ ...base, PROJECTOR_SOURCE_ID: 'Bad_Id' });
  check('an explicit source id that isn\'t a source id is refused before any file is written', badId.code === 2 && /PROJECTOR_SOURCE_ID/.test(badId.stderr) && badId.yaml === null, `exit=${badId.code} ${badId.stderr} file=${badId.yaml === null ? 'absent' : 'PRESENT'}`);
  const digits = render({ ...base, PROJECTOR_PATH: '123' });
  check('a path that makes no source id still renders, and says to set PROJECTOR_SOURCE_ID', digits.code === 0 && !!digits.yaml && /set PROJECTOR_SOURCE_ID/.test(digits.stderr) && entry(digits) === null, `exit=${digits.code} ${digits.stderr}`);
  const long = render({ ...base, PROJECTOR_SOURCE_ID: 'a'.repeat(41) });
  check('a source id longer than the registry reads (40) is refused before any file is written', long.code === 2 && /PROJECTOR_SOURCE_ID/.test(long.stderr) && long.yaml === null, `exit=${long.code} ${long.stderr}`);
  const longPath = render({ ...base, PROJECTOR_PATH: 'p'.repeat(65) });
  check('a path longer than the registry reads (64) is refused before any file is written', longPath.code === 2 && /PROJECTOR_PATH is at most 64/.test(longPath.stderr) && longPath.yaml === null, `exit=${longPath.code} ${longPath.stderr}`);
  const at64 = entry(render({ ...base, PROJECTOR_PATH: 'p'.repeat(64) }));
  check('…and one of exactly 64 renders, its derived id cut to 40', at64?.['p'.repeat(40)]?.path === undefined && !!at64?.['p'.repeat(40)], JSON.stringify(at64).slice(0, 120));
  const named = entry(render({ ...base, PROJECTOR_PATH: '123', PROJECTOR_SOURCE_ID: 'lobby-feed' }));
  check('…and with one set, the entry is under it', named?.['lobby-feed']?.whep === 'http://127.0.0.1:8889/123/whep', JSON.stringify(named));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
