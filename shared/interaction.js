/** A primary use affordance from ordinary component data. */
export function interactionAction(entity) {
  const comp = entity?.comp;
  const declared = comp?.interaction;
  const reactions = comp?.reactions;
  const keys = reactions && typeof reactions === 'object' ? Object.keys(reactions) : [];
  const action = declared?.action ?? (keys.length === 1 ? keys[0] : null);
  if (typeof action !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(action)) return null;
  const label = typeof declared?.label === 'string' && declared.label.trim()
    ? declared.label.trim().slice(0, 100) : action;
  return { action, label };
}
