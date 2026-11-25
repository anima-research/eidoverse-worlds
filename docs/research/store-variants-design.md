# server/store-variants.ts — design notes

The why behind the store's serving shadows, kept out of the code (see also optimize-design-notes.md).

## Why a store upload gets a KTX2 shadow

Before it, a KTX2-capable client asking for a store upload fell through to the store-min (webp) shadow. webp decodes to
full RGBA8 on the GPU (a 1024² map with mips is ~5.3 MB of VRAM) where KTX2 stays block-compressed (~1.4 MB) and skips
createImageBitmap entirely (§20: 1.0–1.2 s per GLB of decode, 4–8× the VRAM). Library models had the variant from the
start; the conjured props that actually fill a world did not.

## The texel budget (KTX2_TEXEL_CAP)

The unflagged answer (the webp shadow) is capped at 1024² (optimize.ts `resize: [1024, 1024]`). That is the house
budget: what a model is allowed to look like here. Encoding the KTX2 arm from the full-resolution source instead (a
Tripo conjure's three 2048² maps, two UASTC) made the "variant" 1.5× the ORIGINAL on the wire, which the size gate
refused, and a flagged fetch became a silent quality upgrade at ~13× the bytes of the webp shadow. So the KTX2 arm takes
the same budget, GPU-native: downscale (never up) so the longest side is the cap, 4-aligned for the block format.

Size verdicts carry the recipe stamp so that a recipe change makes every size refusal a question again, re-measured once
with no operator step. Content verdicts carry no stamp and stand.

## The LOD screen-space budget (LOD_GEN 3)

A LOD is built for the closest distance the 'auto' dial shows it (shared/lod-distance.js lodNearest), at a headset's
pixel density (LOD_PPD, a Quest 3's centre):

- geometry: simplification error ≤ LOD_PX screen pixels there, as one absolute world-space bound for the whole model
  (gen 2 used 1% of each primitive's own extent: a bolt on a truck got 1% of the bolt);
- textures: ≥ LOD_TEXELS_PER_PX texels per screen pixel there over the model's least densely mapped part, from its own
  UV texel density; mip levels the LOD can never sample are dropped (gen 2 shipped the full 1024² chain).

The 'eco' dial and device pressure show the LOD at half that distance (lod_policy.js PRESSURE_EDGE): 4 px and half a
texel per pixel there, the trade those modes exist to make. On look sheets, 2 px kept every model's look and 3 px tore
the seams on stacked pallets; 1 texel/px looked the same as 2 even at the eco distance, at a quarter of the memory.

Earlier generations: gen 2 added the Permissive retry, the GPU gate (it replaced the byte gate), and honoured the texel
cap on `ktx create` hosts (gen-1 LODs built there were 2048² under a texel1024 name).

**Texture-only LODs (LOD_TEX_ONLY).** A model whose vertices can't come under 0.6× still gets a LOD when its textures
come to at most this share of the full tier's GPU texture memory: a wall gate that keeps 85% of its vertices but drops
1024² maps to 128² is worth fetching.

**The vertex floor (LOD_MIN_VERTS = 12,000).** A 1,000 floor was considered for worlds of thousands of objects; with
texture-only LODs both floors save the same texture memory, and the geometry 1k–12k adds was ~5% of placed Commons
vertices at LOD distance. The real geometry lever is a LOD CHAIN (several levels by screen coverage, no 25% floor past
the first): a follow-up, not this floor.

**The recipe derives from every parameter** (generation, ratio, budget, texel cap, floor, and the client's residency
distance), and the recipe is in the URL and every filename. When the floor lived only in the marker's text, lowering it
under the same string would have left every "already light" verdict standing and the sweep skipping exactly the models
the change was for.

## Standing verdicts

A flagged fetch that falls through is provisional, so a later variant is never locked out of a pinned cache entry. A
typed refusal about content (a body, a prop under the floor) is not "not yet": both the content (store hash) and the
recipe are in the URL, so it may be final and cacheable. Refusals that depend on something the URL doesn't carry stay
provisional: "reduction ineffective" and a preservation failure depend on the reducer, the GPU gate on the encoder and
host (whether the texel cap could be honoured). Anything unclassified stays provisional.

## Source identity: freshness by equality, never mtime order

A variant or verdict is about one source file (the one the pump handed the CLI). When the pump writes either, it records
that file's identity as it stood when the pass STARTED; the derived file is fresh iff that identity EQUALS the source's
now. "Marker newer than source" (make-style ordering) was wrong both ways: a replacement that keeps or restores an older
mtime (cp -p, rsync -a, tar, a sync) kept a stale verdict standing forever, and a marker written in the same mtime tick
as its source read as not fresh. Comparing a recorded stat tuple (the redo / Syncthing rule) is cheap per request.

Identity = size + mtimeMs + sha256. The stat pair alone is not identity: a same-size replacement with a restored mtime
matches it while the bytes differ. The digest is cached per path under a cheap invalidator (size, mtimeMs, ino,
ctimeMs): ctime can't be set from userspace and a rename-replace changes the inode, so any change to the bytes re-hashes.
The RECORD holds only (size, mtimeMs, sha), so a restore or volume move re-hashes once and still matches. A record with
no sha compares on the stat pair; a derived file with no record at all keeps the old strictly-newer rule, so the change
landed without re-sweeping anything.

## The verdict record

A `.failed` marker used to be the CLI's stderr tail, and each reader re-derived the verdict's class from prose with its
own regexes: two classifiers that disagreed, and every new phrase a silent miss. The standard is a typed record whose
machine identity is a closed enum and whose human text is display only (RFC 9457 §3.1.4: consumers SHOULD NOT parse
"detail"; REAPI's ActionResult keeps exit_code/status typed and stdout/stderr as blobs):

- the CLI names each refusal's kind where it mints the phrase, on a `[verdict] {json}` line after the human one;
- the pump writes the marker as JSON `{v, kind, reason, stamp, recipe, toolsDigest, tools, source, exit, tail, at}`;
  `reason` is display, `tail` the raw stderr, `stamp` the old text form for grep;
- readVerdict is the ONE parser: a JSON marker, else a `[verdict]` line, else the legacy text grammar, so nothing on
  disk was re-swept by the format change.

`failure` (any exit but 2) is its own kind, never a verdict: never final, re-asked when the tools change (REAPI: a non-OK
status "MUST NOT be cached").
