// viewprefs — this viewer's rotate order per thing (Maya's rotateOrder). Euler channels are a view of the stored q
// (spec/PROTOCOL.md §9.1), so the order lives on this device, per world, and is never sent.
import { bus, CONFIG } from '../base.js';
import { ROT_MODES } from '../../../shared/euler.js';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const orderKey = () => `ew-rotorder-${CONFIG.world ?? ''}`;
let orders = {};
try { const o = JSON.parse(lsGet(orderKey()) ?? '{}'); if (o && typeof o === 'object' && !Array.isArray(o)) orders = o; } catch { /* none */ }

/** This viewer's rotate order for a thing (XYZ when none was chosen). */
export const rotOrderFor = (id) => (ROT_MODES.includes(orders[id]) ? orders[id] : 'XYZ');
/** Choose it: XYZ is the absence of a choice. */
export function setRotOrder(id, order) {
  if (!ROT_MODES.includes(order) || order === rotOrderFor(id)) return false;
  if (order === 'XYZ') delete orders[id]; else orders[id] = order;
  lsSet(orderKey(), JSON.stringify(orders));
  bus.emit('view-prefs', { id, rotOrder: order });
  return true;
}
