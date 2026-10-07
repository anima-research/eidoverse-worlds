// mediasrc — where a picture's or a sound's bytes may come from, and whose browser may fetch them (batch 2, R 10-07).
//
// THE HOLE THIS CLOSES. A link in the world is a fetch every visitor's browser makes: whoever runs the far server sees
// each visitor's IP address, when they came, and what browser they use. Before this, the door took any src (an https
// link included) into the log; only the browser's own allow-list kept it from being fetched.
//
// THE RULE (VRChat's convention: creators.vrchat.com/worlds/udon/video-players/www-whitelist, image-loading):
//   store   this server's own files (store/…, eidoverse/assets/…): every viewer, always. Nothing leaves the server.
//   host    an https link on a big host of the allowlist below: every viewer. The host learns who's watching, as it
//           would if they'd opened the link themselves; these are hosts people already trust with that.
//   link    any other https link: ONLY for a viewer who turned on "allow untrusted links" (Settings › 🛡 safety, off by
//           default). Everyone else's browser never contacts it: not a preload, not a HEAD, nothing (clientMayFetch).
//   bad     refused at the door: not https, a user:password@, an IP address or a local name (a visitor's router, a
//           printer: Hubs closed the same hole in 2022), a port of its own, over 2048 characters, or not a URL at all.
//
// The check is on the URL as written. The host's own redirects aren't followed or checked here: a browser follows them
// after the first contact, which already went to a host the viewer allowed.
//
// RESOLVING A PAGE. youtube.com/watch?… is a web page, not audio. VRChat runs yt-dlp on each viewer's computer; a
// browser can't, and the official players are cross-origin frames whose sound can't reach Web Audio (so they can't be
// positional). For now a link plays when it IS media (an .mp3, an .ogg, a radio stream, a VRCDN or Vimeo progressive file):
// a page link is admitted (it's on the allowlist) and the browser says it can't play pages yet. Resolving pages is a
// server-side resolver plus a proxy (Mozilla Hubs' reticulum media_resolver + CORS proxy), which R decides on.
import { allowedPictureSrc } from './picture.js';
import { allowedSoundSrc } from './sound.js';

// VRChat's video-player allowlist (2026-10), for sound; its image-loading allowlist, for pictures. Plus archive.org
// (public-domain audio and film, CORS-enabled: proposed, R decides). `*.x` matches x itself and every subdomain.
export const MEDIA_HOSTS = Object.freeze({
  audio: Object.freeze(['vod-progressive.akamaized.net', '*.facebook.com', '*.fbcdn.net', '*.googlevideo.com', '*.hyperbeam.com', '*.hyperbeam.dev',
    '*.mixcloud.com', '*.nicovideo.jp', 'soundcloud.com', '*.sndcdn.com', '*.topaz.chat', '*.twitch.tv', '*.ttvnw.net', '*.twitchcdn.net',
    '*.vrcdn.live', '*.vrcdn.video', '*.vrcdn.cloud', '*.vimeo.com', '*.youku.com', '*.youtube.com', 'youtu.be', '*.archive.org']),
  image: Object.freeze(['*.disbridge.com', 'dl.dropbox.com', 'dl.dropboxusercontent.com', '*.github.io', 'images4.imagebam.com', 'i.ibb.co',
    'images2.imgbox.com', 'i.imgur.com', 'i.postimg.cc', 'i.redd.it', 'pbs.twimg.com', '*.vrcdn.cloud', 'i.ytimg.com', '*.archive.org']),
});
// page hosts: links there are web pages a viewer's browser can't play as media (see RESOLVING A PAGE)
const PAGE_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'soundcloud.com', 'twitch.tv', 'mixcloud.com', 'facebook.com', 'nicovideo.jp', 'youku.com'];
export const MAX_URL = 2048;

const hostMatch = (host, pat) => (pat.startsWith('*.') ? host === pat.slice(2) || host.endsWith(pat.slice(1)) : host === pat);
const LOCAL = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|test|invalid|example|onion)$/i;

/** Where src comes from: {tier: 'store'} | {tier: 'host'|'link', host, page?} | {tier: 'bad', why, teach}.
 *  kind: 'audio' (a sound) or 'image' (a picture). */
export function mediaTier(src, kind) {
  if (typeof src !== 'string' || !src) return { tier: 'bad', why: 'src is missing', teach: 'a file in the store (upload it) or an https link' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    const ok = kind === 'image' ? allowedPictureSrc(src) : allowedSoundSrc(src);
    return ok ? { tier: 'store' } : { tier: 'bad', why: `${JSON.stringify(src).slice(0, 80)} isn't a file here`, teach: kind === 'image' ? 'a .png/.jpg/.webp under store/images/ or eidoverse/assets/ (upload one), or an https link' : 'a .mp3/.ogg/.opus/.wav/.webm/.m4a under store/audio/ or eidoverse/assets/ (upload one), or an https link' };
  }
  if (src.length > MAX_URL) return { tier: 'bad', why: `the link is ${src.length} characters (at most ${MAX_URL})`, teach: 'a shorter link' };
  let u; try { u = new URL(src); } catch { return { tier: 'bad', why: 'that isn\'t a link a browser can read', teach: 'https://…' }; }
  if (u.protocol !== 'https:') return { tier: 'bad', why: `${u.protocol}// links aren't played (only https)`, teach: 'an https:// link' };
  if (u.username || u.password) return { tier: 'bad', why: 'the link carries a user name or password', teach: 'a link without user:password@' };
  if (u.port) return { tier: 'bad', why: `the link names a port (:${u.port})`, teach: 'a link on the usual https port' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\[|^\d+(\.\d+){3}$|^\d+$|^0x/i.test(host) || !host.includes('.') || LOCAL.test(host))
    return { tier: 'bad', why: `${host} is an address or a local name, not a public host`, teach: 'a link to a public site by its name (a visitor\'s own network is never fetched)' };
  const hosts = MEDIA_HOSTS[kind === 'image' ? 'image' : 'audio'];
  const page = PAGE_HOSTS.some((p) => hostMatch(host, `*.${p}`)) && !/\.(mp3|ogg|opus|wav|webm|m4a|mp4|aac|flac|m3u8|png|jpe?g|webp)$/i.test(u.pathname);
  return { tier: hosts.some((p) => hostMatch(host, p)) ? 'host' : 'link', host, ...(page ? { page: true } : {}) };
}

/** May THIS viewer's browser fetch src? A link only with their own opt-in; bad never. */
export function clientMayFetch(src, kind, allowUntrusted) {
  const t = mediaTier(src, kind);
  return t.tier === 'store' || t.tier === 'host' || (t.tier === 'link' && allowUntrusted === true);
}

/** The URL a browser fetches for src (a store path is served by this server's /library/ route). */
export const mediaUrl = (src) => (/^https:/i.test(src) ? src : `/library/${src}`);

/** In words, for an editor or a note: who hears/sees this. */
export function tierWords(t, kind = 'audio') {
  const v = kind === 'image' ? 'see' : 'hear';
  if (t.tier === 'store') return `a file on this server: everyone can ${v} it`;
  if (t.tier === 'host') return `${t.host} is a trusted host: everyone can ${v} it${t.page ? ' once pages can be played (this is a page link, not a media file)' : ''}`;
  if (t.tier === 'link') return `${t.host} isn't a trusted host: only people who allow untrusted links (Settings › 🛡 safety) ${v} it; nobody else's browser contacts it`;
  return t.why;
}
