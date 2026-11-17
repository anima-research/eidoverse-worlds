# How /library negotiates, and why every response is cross-origin isolated (server/routes.ts)

## The /library ladder

Order, first hit wins: `?native=1` unoptimized bytes (no Draco/WebP shadow; native importers may lack those decoders;
a deliberate patch still wins inside it, so these are the patched file where one exists, not the original)
→ a deliberate upstream patch (PATCH_DIR) → the LOD variant → the KTX2 variant →
store-min (store uploads) → the optimized mirror (draco+webp, ~30x smaller) → the original.

### KTX2 is negotiated, never the unflagged answer (§20)

A KTX2 variant puts KHR_texture_basisu in `extensionsRequired`, and parsers without a KTX2 decoder (agents, tools, old
clients) throw on required extensions. Only a client that detected support asks with `?ktx2=<key>`; everyone else gets
the default bytes. The distinct URL is its own clean nginx/browser cache entry. The key is a generation
(shared/ktx2.js, [ktx2-key-generations.md](ktx2-key-generations.md)): a retired key is an unflagged fetch.

- **VRMs (§20c)** negotiate the same way, with one extra guard: bodies mutate mid-session (POST /upload?as=avatar
  broadcasts avatar-updated and every client refetches), so a variant older than the winning original is a stale body
  under a fresh `?v=`; the original is served until the next boot sweep rebuilds it.
- **Loose images (§20d)** negotiate like GLBs: a flip-baked `<rel>.ktx2` sibling answers a flagged fetch, served as
  image/ktx2. The client's loadImageTexture sniffs the container magic, so one path carries either byte shape.

### The LOD tier

It rides the ktx2 negotiation (a LOD variant carries KTX2 textures). A client asks only with the recipe /version
published, so a recipe change is a fresh URL and a fresh file. The answer is named on the wire, `x-eidoverse-lod`:

- `variant` — the reduced tier;
- `refused=<kind>` — a standing typed verdict: the original is final for this recipe (store-variants.ts lodVerdictFinal);
- `provisional` — not decided (not swept yet, a deferred pass, a verdict class that could change with the reducer, a
  marker older than a mutated source, an unrecognized generation).

Library sources are mutable, so a variant or verdict is compared by recorded identity against the file the sweep
built from (`variantSource`, never the OPT mirror) via `freshOver` — the same rule the sweep and the Build card use.
A lod ask answered by the plain ktx2 variant is provisional unless a typed verdict stands; a final answer must also
have fresh ktx2 bytes (`ktx2=stale` otherwise).

### Fall-through is provisional

A flagged fetch that falls through is provisional for that URL: the variant may still be encoding, or the box has no
encoder yet. Content-addressing does not make it final: the address is immutable, the flagged answer is not, and a
cache that pins the webp bytes under `?ktx2=` for a year never sees the variant land. So it is served `no-cache`
riding the ETag (a 304 while nothing changed; deploy/nginx-show.conf does not cache these). An unrecognized lod value is a
generation this process does not run (a pull mid-window, a buggy client): nothing is pinned under it.

## Cross-origin isolation (`isolate`)

client/lib/audio/engine-piper.js pins ORT to one thread unless `crossOriginIsolated && SharedArrayBuffer`, which need COOP + COEP.
COEP is `credentialless`, not `require-corp`: the same isolation, by stripping credentials rather than refusing any
cross-origin subresource that lacks CORP headers. What the client loads cross-origin, and how each fares:

- Draco decoder wasm from gstatic (assets.js): fine, gstatic sends `cross-origin-resource-policy: cross-origin`.
- Orrery API via fetch(credentials:'include') (client/lib/edit/generate.js): unaffected; COEP governs no-cors subresources only.
- Orrery thumbnails via `<img>`: a bare img is no-cors, so credentialless would strip the cookie; the call site uses
  `crossorigin="use-credentials"`.

COOP `same-origin` severs window.opener, so Orrery's OAuth popup cannot postMessage back; client/lib/edit/generate.js polls
/api/auth/me instead. The headers ride every response, not just the document: a worker script served without them is
not isolated.
