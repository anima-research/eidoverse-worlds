// viewprefs — how THIS viewer's editor reads a thing: its rotate order (Maya's rotateOrder; PROTOCOL §9.1: Euler channels
// are a view, an editor's rotation order changes how the channels read, never the stored q). Kept on this device, per
// world and thing, never sent, never seen by anyone else (it was once written as a component, which the authority
// refuses; #260 house I242).
import { bus, CONFIG } from './base.js';
import { ROT_MODES } from '../../shared/euler.js';

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
