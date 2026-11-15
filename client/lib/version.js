// version — the running server's /version, asked once per page (no-store: it differs between a pull and a restart); null
// when it doesn't answer. assets.js (the KTX2 key, the LOD recipe), chat.js and main.js read this one answer; the About
// menu asks again when opened (ui/ui-menu.js buildInfo).
export const versionReady = fetch('/version', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
