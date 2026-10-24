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

## Box3D (MIT)

- **What:** the physics in eidosim was studied from Box3D's source and written fresh in JavaScript; no file was
  copied. Some parts follow Box3D's structure closely enough that this notice is carried to be safe: the soft-step
  stage order and its softness coefficients (`solver.h` `b3MakeSoft`), central (manifold) friction and twist
  friction (`contact_solver.c`), the contact-stiffness cap by substep rate (`physics_world.c`), speculative
  margins, the continuous-collision rules (`solver.c` time of impact against statics), the joint softness defaults
  (`joint.c`), and the implicit gyroscopic step.
- **Where:** `shared/eidosim.js` (its header credits Box3D, Catto's "Solver2D" (2024) and Ross Nordby's soft
  constraint coefficients).
- **Source:** https://github.com/erincatto/box3d, commit `5d83df83ab47172c2c745b44315e7538ead02397` (2026-10-07).
- **Licence:** MIT.

```
MIT License

Copyright (c) 2026 Erin Catto

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
