// plate — the words on a body's nameplate (avatar.js draws them). Pure, so the rule is testable without a renderer.
/** name, then ` ≈` for a seated approximation (#101), then ` · AI` for a self-declared agent (§6a; decision row 15, R 10-30). */
export const plateText = (name, { approx = false, ai = false } = {}) => `${name}${approx ? ' ≈' : ''}${ai ? ' · AI' : ''}`;
/** Whether a door declaration (§6a `declares`, any word) is the one the AI tag shows for. */
export const declaresAI = (declares) => declares === 'agent';
