// Which selection layers MY clicks in the edit viewport can land on (shared/layers.js). Per viewer, remembered here;
// 'environment' starts off (R 10-11: "people don't select the ground plane all the time").
import { bus } from './base.js';
import { LAYERS, layerOf } from '../../shared/layers.js';
const KEY = 'ew.select.mask';
let off = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (Array.isArray(v)) return new Set(v.filter((x) => LAYERS.includes(x))); } catch { /* private window */ } return new Set(['environment']); })();
export const layerOn = (layer) => !off.has(layer);
export function setLayerOn(layer, on) { if (on) off.delete(layer); else off.add(layer); try { localStorage.setItem(KEY, JSON.stringify([...off])); } catch { /* the session keeps it */ } bus.emit('select-mask', [...off]); }
/** Can my viewport click select this thing? world: the fold's entities. */
export const clickable = (world, id) => layerOn(layerOf(world, id));
