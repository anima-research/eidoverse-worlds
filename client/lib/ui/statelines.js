// "world:" / "you:" — what the log says, and (only while it differs) what THIS client is showing instead and why.
// Writes only on change: in VR a panel write re-rasterises the whole panel quad.

export function stateLines() {
  const el = document.createElement('div');
  el.className = 'state-lines';
  el.style.cssText = 'font-size:11px;color:var(--dim);padding:2px 2px 6px;line-height:1.35';
  const world = document.createElement('div');
  world.className = 'state-world';
  const you = document.createElement('div');
  you.className = 'state-you';
  you.style.color = 'var(--accent)';
  you.hidden = true;
  el.append(world, you);
  const set = (worldText, youText) => {
    const w = `world: ${worldText}`;
    if (world.textContent !== w) world.textContent = w;
    const y = youText ? `you: ${youText}` : '';
    if (you.textContent !== y) you.textContent = y;
    if (you.hidden !== !youText) you.hidden = !youText;
  };
  return { el, set };
}
