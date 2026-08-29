// uidefs — the help-overlay contract (charter §3, defs round two).
//
// The ? overlay's content is world-served data: a world can reword its own
// welcome (an agent-only world, a gallery, a classroom) without forking the
// client. Defs are server-owned — the same trust domain as the shipped
// client itself — so the HTML fragments here are trusted markup, exactly as
// they were when they lived in ui.js.

const isStr = (v) => typeof v === 'string' && v.length > 0;

/** Validate the help sidecar (defs/ui/_help.json). Empty = servable.
 *  @param {unknown} h @returns {string[]} */
export function validateUiHelp(h) {
  if (h == null || typeof h !== 'object' || Array.isArray(h)) {
    return ['_help must be a JSON object'];
  }
  const errs = [];
  if (!isStr(h.title)) errs.push('title must be a string');
  if (!isStr(h.sub)) errs.push('sub must be a string');
  if (!Array.isArray(h.keys)) errs.push('keys must be an array of [label, keys] pairs');
  else {
    h.keys.forEach((row, i) => {
      if (!Array.isArray(row) || row.length !== 2 || !isStr(row[0]) || !isStr(row[1])) {
        errs.push(`keys[${i}] must be a [label, keys] pair of strings`);
      }
    });
  }
  if (!Array.isArray(h.sections)) errs.push('sections must be an array of {h, html}');
  else {
    h.sections.forEach((s, i) => {
      if (s == null || typeof s !== 'object' || !isStr(s.h) || !isStr(s.html)) {
        errs.push(`sections[${i}] must be {h, html} with string halves`);
      }
    });
  }
  return errs;
}
