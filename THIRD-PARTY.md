# Third-party code in this repository

This project is licensed under the AGPL-3.0 (`LICENSE`). Some files carry code
lifted from other projects under their own, compatible licences; each such
file keeps the original copyright and licence notice in its header, and is
listed here.

## Godot Engine (MIT)

- **What:** the CPU particle simulation of `CPUParticles3D`
  (`scene/3d/cpu_particles_3d.cpp`: `_particles_process`, `_update_internal`,
  `idhash`, `rand_from_seed`, the emission shapes, the velocity spread, the
  hue rotation), and the module vocabulary of `ParticleProcessMaterial`
  (`scene/resources/particle_process_material.cpp`), ported to JavaScript.
- **Where:** `shared/particlesim.js` (the port; its header lists every change
  from Godot's behaviour), `shared/particle_effects.js` (the effect document's
  modules follow Godot's parameter names and defaults).
- **Source:** https://github.com/godotengine/godot, tag `4.7.2-stable`
  (commit `ed1daf0bf001b61586d9930840f2f1394092c079`), fetched 2026-10-07.
- **Licence:** MIT.

```
Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md).
Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
