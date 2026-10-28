// bodyact.js — what the authority's body inbox says about my body (PROTOCOL §5): an act it delivered (`body {to, kind}` that
// my consent allowed), as the puppet message localbody.js already applies; and an act it refused (body-refused), as the
// words localbody.js shows me. A leaf: nothing from lib comes in, so tools/consent-client-test.ts can drive it.
/** A refused act on my body (`{type: "body-refused", from, class, gate}`: said once per asker per cooldown by the authority)
 *  as one sentence, or null for any other message. `nameOf` turns the asker's identity into a name here. */
export function refusedNotice(m, nameOf) {
  if (!m || m.type !== 'body-refused') return null;
  const who = nameOf(m.from) ?? 'someone', what = m.class === 'shove' || m.class === 'displace' ? 'move' : 'touch';
  return `${who} tried to ${what} you — ${m.gate === 'move' ? 'your Move me switch is off' : m.gate === 'touch' ? 'your Touch me switch is off' : 'they are on your Never allow list'}`;
}
/** An act the authority let reach my body (`{type: "body", kind, spec}`: the body verb, which my lists and gates
 *  allowed) as the puppet message localbody.js already applies, or null when there is nothing to apply here.
 *  spec is what the act carries (verbspec `body`): a pose is its bones (or {pose, merge}), an anim its tracks, a shove an
 *  optional {lean}. drag, occupy and carry are streamed live by the actor, not carried in one message. */
export function bodyActAsPuppet(m) {
  if (!m || m.type !== 'body') return null;
  const spec = m.spec && typeof m.spec === 'object' && !Array.isArray(m.spec) ? m.spec : null;
  const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (m.kind === 'pose') {
    if (!spec) return null;
    return obj(spec.pose) ? { pose: spec.pose, merge: spec.merge === true } : { pose: spec, merge: false };
  }
  if (m.kind === 'anim') return spec && obj(spec.tracks) ? { anim: spec } : null;
  if (m.kind === 'shove') {
    const l = spec?.lean;
    return { ragdoll: Array.isArray(l) && l.length === 3 && l.every(Number.isFinite) ? { lean: l.slice() } : true };
  }
  return null;
}
