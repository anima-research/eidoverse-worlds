// Transmission: does a transmissive glTF material actually reach the renderer
// in a class that can draw it?
//
// This exists because the failure is SILENT and looks like missing geometry.
// A plain MeshPhysicalMaterial with transmission > 0 arrives in eidoverse with
// every value correct -- transmission 1, ior 1.5, visible: true, its mesh
// present and its triangles counted -- and renders as nothing at all, because
// three's WebGPU renderer only builds the transmission graph for
// MeshPhysicalNodeMaterial. Measured on mythos-alpha's Glass: 581 triangles,
// invisible, no warning anywhere.
//
// Two properties, and the second is the one that bit me:
//   1. a transmissive material is upgraded to the node class
//   2. the upgrade carries `transmission` ACROSS -- Object.keys() does not see
//      it, because MeshPhysicalMaterial defines it as a prototype accessor, so
//      the first fix produced a node material with transmission 0: the same
//      invisibility for a new reason.
//
// Source-level, because materials.js imports the WebGPU renderer and a canvas.
// Weaker than driving the real code; stronger than the nothing that was here.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? '  -- ' + note : ''}`); }
};

const src = readFileSync('client/lib/materials.js', 'utf8');
const fn = /function upgradeTransmissive\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';

console.log('TRANSMISSION -- a correct file the renderer could not honour');
check('there is an upgrade for transmissive materials', fn.length > 0);
check('it targets MeshPhysicalNodeMaterial',
      /THREE\.MeshPhysicalNodeMaterial/.test(fn));
check('it only fires on transmission > 0 (node materials are dearer to compile)',
      /if \(!\(m\.transmission > 0\)\) return m;/.test(fn));
check('it leaves node materials and repeats alone (idempotent)',
      /m\.isNodeMaterial \|\| TRANSMISSIVE_UPGRADED\.has\(m\)/.test(fn));

// THE REGRESSION. `transmission` is a prototype accessor, so a copy loop over
// Object.keys() silently drops the one value the upgrade exists to carry.
check('it copies PROTOTYPE ACCESSORS, not just own keys',
      /getOwnPropertyDescriptors\(proto\)/.test(fn) &&
      /typeof d\.get === 'function' && typeof d\.set === 'function'/.test(fn),
      'Object.keys() cannot see `transmission`');
check('...and copies three\'s Color/Vector types by value, not by reference',
      /nm\[k\]\?\.isColor && v\?\.isColor/.test(fn) && /\.copy\(v\)/.test(fn));
check('it puts the material in the transparent pass',
      /nm\.transparent = true;/.test(fn));
check('a failed upgrade returns the ORIGINAL material rather than throwing',
      /catch \(e\) \{[\s\S]*?return m;/.test(fn));

// Wired in, and BEFORE prepareMaterial: the upgrade replaces the material
// object, and prepareMaterial early-returns on non-node materials anyway.
const prep = /export function prepareObject\([\s\S]*?\n\}/.exec(src)?.[0] ?? '';
check('prepareObject runs the upgrade', /upgradeTransmissive\(o, /.test(prep));
check('...and writes the replacement back onto the mesh',
      /o\.material\[i\] = up/.test(prep) && /o\.material = up/.test(prep));
check('...before prepareMaterial, which skips non-node materials',
      prep.indexOf('upgradeTransmissive') < prep.indexOf('prepareMaterial('));

// The export side must actually emit the extensions, and thickness is the
// one people put in the wrong place.
const gm = readFileSync('/Users/lariareynolds/Documents/mythos-models/rigtest/gltf_materials.py', 'utf8');
check('the exporter writes KHR_materials_transmission',
      /ext\["KHR_materials_transmission"\]/.test(gm));
check('...and KHR_materials_ior (a transmissive material with no ior is glass by luck)',
      /ext\["KHR_materials_ior"\]/.test(gm));
check('...and puts thickness in KHR_materials_volume, where it belongs',
      /ext\["KHR_materials_volume"\] = dict\(thicknessFactor/.test(gm));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
