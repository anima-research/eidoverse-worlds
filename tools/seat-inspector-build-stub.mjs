// seat-inspector-text-test's stand-in for build.js (seatedit.js and build.js import each other): a recorder for the
// one call under test, and no-ops for the rest.
export const inspectorHtml = [];
export const setInspectorHtml = (h) => { inspectorHtml.push(String(h)); };
export const hideInspector = () => {};
export const setEditMode = () => {};
export const isEditing = () => true;
export const deselect = () => {};
export const pushUndo = () => {};
