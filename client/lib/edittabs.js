// edittabs — which page of the edit workspace's left column a viewer sees
// (design §5: "B enters build mode on the Build tab; the last tab used is
// remembered after that"). Pure, so a test can hold the rule without a DOM;
// editlayout.js keeps the layout in localStorage (per viewer, client-only,
// never on the wire) and asks here.

/** The left column's top pane, one page at a time: [id, title]. */
export const TABS = [['build', 'Build'], ['hierarchy', 'Hierarchy']];
/** Bumped when the tab set changes meaning: a layout saved before Build
 *  existed (its leftTab was the old default, 'hierarchy', or the retired
 *  'create') opens on Build once, and is remembered from then on. */
export const TAB_V = 2;
const known = (id) => TABS.some(([t]) => t === id);

/** The tab a stored layout opens on. Nothing stored, or a layout from before
 *  the Build tab: Build. Otherwise the tab last used. */
export function openingTab(stored) {
  if (!stored || typeof stored !== 'object' || stored.tabV !== TAB_V) return 'build';
  return known(stored.leftTab) ? stored.leftTab : 'build';
}

/** The layout after the viewer picks tab `id` (an unknown id changes nothing). */
export function useTab(layout, id) {
  return known(id) ? { ...layout, leftTab: id, tabV: TAB_V } : { ...layout };
}
