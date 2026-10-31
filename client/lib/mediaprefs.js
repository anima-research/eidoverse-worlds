// mediaprefs — what THIS viewer lets their browser fetch, and what they've muted for themselves (batch 2, R 10-07).
// Local preferences, never logged, never sent, never seen by anyone else.
//
//   allow untrusted links   off by default. A picture or sound whose src is an https link to a host that isn't on the
//                           trusted list (shared/mediasrc.js) is never fetched by this browser (not a preload, not a
//                           HEAD) unless it's on. VRChat's "Allow Untrusted URLs" (Settings › Comfort & Safety) is the
//                           precedent; ours lives in Settings › 🛡 safety, beside nothing else that could be confused
//                           with it, and in VR on the same panel (registerXRPanel).
//   mute this for me        per thing, per world: a sound you never want to hear again here. Like the Hierarchy's eye
//                           (myview.js): your view, nobody else's.
import { bus, CONFIG } from './base.js';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
export const UNTRUSTED_KEY = 'eido.allowUntrustedLinks';

export const allowUntrusted = () => lsGet(UNTRUSTED_KEY) === '1';
export function setAllowUntrusted(on) { lsSet(UNTRUSTED_KEY, on ? '1' : '0'); bus.emit('media:trust', { allowUntrusted: !!on }); }

const muteKey = () => `ew-mymuted-${CONFIG.world ?? ''}`;
let muted = new Set();
try { muted = new Set(JSON.parse(lsGet(muteKey()) ?? '[]')); } catch { /* none */ }
export const isMineMuted = (id) => muted.has(id);
export function toggleMineMuted(id) { if (muted.has(id)) muted.delete(id); else muted.add(id); lsSet(muteKey(), JSON.stringify([...muted])); bus.emit('media:mute', { id, muted: muted.has(id) }); return muted.has(id); }

/** R 10-07: no license form, a warning, before the file picker opens. */
export const RIGHTS_WARNING = 'Make sure you own the rights to this before you upload it.';

/** The words the Settings row and the editor use for the setting. */
export const UNTRUSTED_WORDS = {
  label: 'Allow untrusted links',
  hint: 'Pictures and sounds can link to other websites. Trusted big hosts (YouTube, Twitch, Vimeo, SoundCloud, VRCDN and the like) always play. Any other site sees your address when your browser fetches from it, so links to them play only if this is on. Off by default; only your browser is affected.',
};
