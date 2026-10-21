# eido: URIs — content references that survive leaving the host (first draft)

**Status: informative** (recut C14, 2026-10-21). No reader resolves an `eido:` URI today, so this file isn't part of the
normative set (spec/NORMATIVE.md). It becomes normative when a world needs portable blobs.

**License: CC0 1.0 (public domain)**, same terms as `PROTOCOL.md` beside it.
Status: DRAFT for review against the store's actual shapes. The words
MUST/SHOULD/MAY are used in the RFC-2119 sense.

## 0. The one idea

A path is a location; a hash is an identity. Today a log references
`store/<sha256-16>.glb` — an identity wearing a location's clothes, legible
only to the host that dressed it. An `eido:` URI is the identity itself,
resolvable at any host, verifiable by anyone, so **a world is one JSONL log
plus blobs that can live anywhere**. Hosts become interchangeable resolvers;
"where the bytes live" becomes a late, reversible decision.

## 1. Syntax

```
eido:<alg>/<digest-hex>
eido:sha256/9f2c4a1b0e8d7c6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f
```

- `<alg>`: lowercase digest algorithm. `sha256` is the only algorithm in this draft
  and the only one an implementation MUST support; the segment exists so a
  future algorithm is an addition, not a migration.
- `<digest-hex>`: the **full** lowercase hex digest (64 chars for sha256).
- No authority component, no query, no fragment, no parameters in this draft. The
  URI names bytes and nothing else; media type and role travel in the
  *reference envelope* (§2a), which is a normative part of this spec — "the
  reference knows" is a contract there, not a shrug here.
- Truncated forms are display sugar and MUST NOT appear on the wire or in
  logs. (The store's 16-hex filenames are safe within one host's namespace;
  64 bits is not a global identity — the full digest is.)

## 1a. Which bytes? — variants are distinct identities

The reference implementation already holds two byte strings per logical
upload: the original in `store/`, and an optimized draco+webp shadow in
`store-min/` that `/library` serves *preferentially at the same path*. That
substitution is exactly what an `eido:` URI makes impossible, on purpose:

- An eido digest names **one byte string**. The authored reference identifies
  the bytes ingestion hashed — the **original upload**. (This is already the
  hash the store computes; nothing new to compute.)
- An optimized/re-encoded variant is a different byte string and therefore a
  **different identity**, never a silent stand-in. A host that optimizes
  SHOULD record the derivation so the small form is *findable by name*:

  ```
  set {id: "@world", component: "variants:<orig hex>",
       value: {"opt/draco-webp@1024": "eido:sha256/<min>"}}
  ```

  one keyed component per original, mapping each kind of derivation to its
  own name (world scope; a later write replaces it). Clients MAY prefer a declared variant for bandwidth the
  way they prefer `store-min` today — but by its own verified name, chosen in
  the open, instead of by a server swapping bytes under a fixed path.
- Consequently the §3 endpoint MUST serve exactly the named bytes. (Client-
  side verification enforces this anyway — a substituted shadow hashes wrong
  and reads as a miss; the rule here just keeps hosts from wasting everyone's
  requests.)

## 2. Resolution

A client resolving `eido:sha256/<hex>` tries, in order, until bytes verify:

1. any local store or cache;
2. the origin host of the world that referenced it:
   `GET /eido/sha256/<hex>`;
3. each entry of the world's declared resolver list (§4), in order;
4. anything else it knows (mirrors, a friend, a future DHT — out of scope).

**Verification is client-side and mandatory**: the resolver MUST hash the
received bytes and compare to the URI before using or caching them. A
mismatch is treated as a miss (keep trying), never an error surfaced from
the blob. This is the load-bearing property: because every reference is
self-verifying, **resolvers are untrusted by design** — any mirror, CDN, or
stranger's box may serve blobs, and the worst a hostile one can do is waste
a request. Trust lives in the log; the store is just bytes.

## 2a. The reference envelope — where type and role live

Current loaders dispatch on `.glb`/`.vrm`/script paths; a digest carries no
extension, and Content-Type is an untrusted hint from an untrusted resolver.
So the type contract is: **media lives beside the reference, in the log.**

- A component value that carries an `eido:` URI MUST carry the media type
  beside it, in a sibling `media` field (short registered form: `glb`, `vrm`,
  `js`, `png`, `jpg`, `webp`, `glsl`, …), e.g.
  `picture {src: "eido:sha256/<hex>", media: "png", …}`. A component whose
  whole value is a reference has nowhere to put a sibling, and needs none
  when its **media is fixed by its role**: `model` is always a glTF binary
  (`glb`), so `model: "eido:sha256/<hex>"` is complete (translate-v1@8–@11
  wrote models this way, review 2026-10-07; since R's ruling of 2026-10-17 a
  model is stored as its library path, the portable reference, with its
  bytes' hash beside it as `model-hash: "sha256:<hex>"`, and a stored
  `eido:` model is read, and written back as its path at first load where
  the host's index knows it). A whole-value reference
  whose media can vary needs a new versioned name with a `media` field
  (PROTOCOL §4: a changed meaning is a new name).
  Exporters that rewrite `store/<hex16>.glb` → `eido:` derive `media` from
  the extension they are erasing — the information already exists at exactly
  the moment it is needed.
- **Role** is the field itself, as today: `model` wants a model, a
  `script:<name>`'s `src` wants a script source, a picture's `src` an image.
  No new role vocabulary.
- A client MUST choose its loader from the log's declared `media`, MUST NOT
  trust the resolver's Content-Type, and MAY fall back to magic-byte sniffing
  (`glTF` container, script-as-UTF-8) only when `media` is absent — i.e. only
  for references authored outside this spec.

## 3. The resolver endpoint

A host serving blobs exposes:

```
GET /eido/<alg>/<digest-hex>
  200  exactly the named bytes (§1a — no variant substitution;
       Content-Type advisory only, see §2a)
  404  not here (a fact about this host, not about the bytes)
```

Responses are immutable by construction and SHOULD be served with
`Cache-Control: public, max-age=31536000, immutable` — the same
content-addressed-therefore-cache-forever rule the reference implementation
already applies to `store/` paths. No auth for blobs referenced by public
worlds; access-controlled blobs are a resolver capability for a later
version, not a change to the URI.

## 4. Declaring resolvers

A world MAY declare where its bytes are known to live, as an ordinary
component on `@world` (owner):

```
set {id: "@world", component: "resolvers", value: {urls: ["https://eidoverse.animalabs.ai", …]}}
```

(a later write replaces it; absent = origin only).

**No protocol change needed.** `resolvers` and §1a's `variants:<hex>` are
components, and every reader keeps and replays components it doesn't
understand (PROTOCOL §4), so an older reader folds an imported world with
them intact and simply doesn't use them. Bare names belong to the
protocol's registry, so a host implementing this spec registers them there
(or writes them under its domain prefix until it does). Hosts implementing
this spec MUST advertise an `eido` capability in their hello/info payload so
clients can feature-detect instead of authoring blind. The exporter ALSO
writes the resolver list and variant maps into the export manifest, so an
importer that reads only the manifest loses nothing.

A forked or exported world thus carries its resolver list with it — in the
log where both ends are current, in the manifest everywhere — so the copy
knows where the original's bytes lived even before anyone mirrors them.

## 5. Migration — cheap on purpose

- Existing logs are untouched: `store/<hex16>.<ext>` references remain valid
  host-relative paths, resolvable exactly as today at their origin.
- Ingestion already computes the full sha256 before truncating to the
  filename — from the day this lands, new component values SHOULD write the
  `eido:` form in `src` / `path` fields **with the §2a `media` sibling**, and hosts continue to serve the same blob at both the old path
  and §3's endpoint.
- A reader encountering either form treats `store/<hex>` as "origin-only
  reference" and `eido:` as "resolve anywhere." Rewriting old logs is
  neither required nor recommended (the log is the log).
- One string transform in the exporter makes an *exported* world fully
  portable: emit `eido:` alongside a blob bundle, and the export is
  self-verifying on arrival regardless of where it's later hosted.

## 6. What this buys, concretely

- **Worlds travel.** A log plus a directory of blobs is a complete world on
  any host — the fork-is-a-byte-copy story extended across machines.
- **Mirrors without trust.** Anyone may serve your blobs; nobody can corrupt
  them. Bandwidth becomes donatable.
- **Cross-host dedup.** Two hosts holding the same swing hold the same
  identity, and know it without talking.
- **Provenance stays pinned.** A `script:<name>` component already pins its
  exact source by hash; this is that same discipline for every reference in
  the log.

## 6a. Security & limits

- **Resolver URL schemes:** `https:` only, plus `http:` on loopback for
  development. A resolver list entry in any other scheme (`file:`, `ftp:`,
  a browser-internal scheme) MUST be ignored, not attempted — the list is
  authored data from the log and gets the same suspicion as any other input.
- **Bounds:** clients SHOULD enforce a response-size ceiling (default 256 MB,
  configurable; abort past it — a hostile mirror can waste one request, not
  one disk) and a per-attempt timeout before moving down the §2 ladder, so a
  stalling resolver cannot pin resolution. Redirect depth is capped small;
  redirects may not change scheme class.
- **Private-world leakage:** consulting a third-party resolver reveals the
  digest and your interest in it. For worlds behind any access control,
  clients MUST resolve via the origin host only, and MUST NOT forward the
  world's resolver list to generic caches. A digest is not a secret, but the
  *association* (this key, this world, this reader, now) can be — the
  resolver list is world-scoped consent to ask strangers, and a private world
  has not given it. Blob-level auth stays a later-version resolver
  capability, as §3 says.

## 7. Non-goals in this draft

Mutable names (that is a registry's job, and registries are logs); blob
deletion semantics (a host may stop serving anything — 404 is always legal;
redaction policy lives with the log, not the URI); multihash beyond the
`<alg>` segment; private-blob auth (later, as a resolver capability).

---

*Drafted by Hesperus (Exultation side), blessed 2026-08-02; revised 2026-08-05
against antra-tess's review: variants are distinct identities (§1a), media
lives in the reference envelope (§2a), the closed verb set is named as the
protocol dependency it is (§4), and resolvers get a security clause (§6a).
Revised 2026-10-06 for the protocol: the additions are components, not new
verbs, so the old protocol dependency is gone. Where this draft and reality
disagree, reality was there first.*
