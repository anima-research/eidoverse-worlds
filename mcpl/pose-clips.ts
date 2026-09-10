import { CLIP_FILES, CLIP_SLOTS, SEAT_CLIP_FILE } from '../shared/clipdefs.js';
import { parsePoseAnimation, retargetPoseAnimation } from '../client/lib/poseclips.js';

export class PoseClips {
  private roster: Promise<Map<string, string>> | null = null;
  private clips = new Map<string, Promise<any>>();
  private retargeted = new WeakMap<object, Map<object, any>>();
  constructor(private base: string) {}
  async load(slot: string) {
    if (slot !== 'sitchair' && !CLIP_SLOTS.includes(slot)) throw new Error(`unsupported posture clip: ${slot}`);
    const file = slot === 'sitchair' ? SEAT_CLIP_FILE : (CLIP_FILES as any)[slot] ?? slot;
    this.roster ??= fetch(`${this.base}/animations`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then(async r => r.ok ? new Map<string, string>((await r.json() as any[]).map(e => [e.name, e.path])) : new Map<string, string>())
      .catch(() => new Map<string, string>());
    const path = (await this.roster).get(file) ?? `eidoverse/assets/animations/${file}.vrma`;
    if (!this.clips.has(path)) {
      const pending = (async () => {
        const r = await fetch(`${this.base}/library/${path}`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`posture clip ${slot}: HTTP ${r.status}`);
        return parsePoseAnimation(await r.arrayBuffer());
      })();
      this.clips.set(path, pending);
      pending.catch(() => { if (this.clips.get(path) === pending) this.clips.delete(path); });
    }
    return this.clips.get(path)!;
  }

  // Evaluate the same retargeted Three tracks the browser mixer consumes.
  // No raw rest-pose knee is substituted for an unavailable posture clip.
  apply(animation: any, body: any, time: number, rigKey: object = body.av.vrm) {
    let bound = this.retargeted.get(rigKey);
    if (!bound) { bound = new Map(); this.retargeted.set(rigKey, bound); }
    if (!bound.has(animation)) {
      const clip = retargetPoseAnimation(animation, body.av.vrm);
      bound.set(animation, { clip, tracks: clip.tracks.map((track: any) => {
        const dot = track.name.lastIndexOf('.');
        return { name: track.name.slice(0, dot), property: track.name.slice(dot + 1), sample: track.createInterpolant() };
      }) });
    }
    const { clip, tracks } = bound.get(animation);
    const t = clip.duration > 0 ? ((time % clip.duration) + clip.duration) % clip.duration : 0;
    for (const { name, property, sample } of tracks) {
      const node = body.av.nodes[name];
      if (!node || !['quaternion', 'position'].includes(property)) continue;
      node[property].fromArray(sample.evaluate(t));
    }
    body.av.root.updateMatrixWorld(true);
    return { clip: animation, duration: clip.duration, time: t };
  }
}
