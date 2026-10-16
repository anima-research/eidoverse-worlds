// markup — the one way a string becomes HTML on the hint bar and the edit inspector.
//
// flashHint / setHint / setAmbientHint (ui.js) treat a plain string as TEXT: whatever
// is in it is shown as the characters it is, never parsed. A line that needs markup (<kbd>, <b>) says so by being
// built with the `html` tag, which escapes every interpolated value:
//
//     flashHint(html`<b>${thing}</b> placed · <kbd>Esc</kbd> cancels`)   // thing is shown as text, whatever it holds
//     flashHint(`${by} knocked you over`)                                  // text: a name with a tag in it is just shown
//
// The brand is a module-private Symbol, so nothing that arrives as data (a name, a label, a JSON message) can pass for
// markup: JSON has no symbols. A value that is itself html`` nests without escaping. No imports, on purpose.
//
// Not covered: the edit inspector (build.js showInspector, setInspectorHtml) still writes markup it builds itself;
// its callers escape every name and label they interpolate (esc() in build.js, seatedit.js).

const BRAND = Symbol('markup');
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape a value for HTML text or a quoted attribute. */
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const markup = (s) => Object.freeze({ [BRAND]: true, html: String(s), toString() { return this.html; } });
export const isMarkup = (v) => !!v && typeof v === 'object' && v[BRAND] === true;
/** Tagged template: the literal parts are markup, every ${value} is escaped unless it is itself html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += (isMarkup(vals[i]) ? vals[i].html : escapeHtml(vals[i])) + strings[i + 1];
  return markup(out);
}
/** Put a line into an element: html`` as HTML, anything else as text. */
export function paint(node, content) {
  if (isMarkup(content)) node.innerHTML = content.html;
  else node.textContent = content == null ? '' : String(content);
}
/** "Is this the same line?" — two html`` calls make two objects with the same html. */
export const lineKey = (content) => content == null ? null : isMarkup(content) ? `h:${content.html}` : `t:${content}`;
