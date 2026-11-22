# Shaders on things

A thing can be drawn by code you write: its colour, its glow, how rough or metallic it is and how see-through, worked
out for every pixel, and the shape of its surface, worked out at every vertex, every frame. The code rides the thing as a component,
`antra/shader`, so it is in the world's log like everything else, and every browser that reads it draws the same thing.

`antra/shader` is a **draft** component (docs/contributing/COMPONENT-LADDER.md, rung 1): the authority stores it as you
write it and checks nothing, and a client draws it only if it carries the reader (the browser client does; other
renderers show the thing's own material). Its shape may still change.

```
act {verb: "set", args: {id: "<a thing>", component: "antra/shader", value: {code: "
  float n = fbm(positionWorld * 3.0 + vec3(0.0, time * 0.4, 0.0));
  color = mix(baseColor, vec3(0.1, 0.8, 1.0), smoothstep(-0.2, 0.6, n));
  emissive = vec3(0.1, 0.8, 1.0) * pow(saturate(n + 0.3), 3.0) * 2.0;
"}}}
act {verb: "delete", args: {id: "<a thing>", component: "antra/shader"}}      # its own material again
```

**Is this code in a component?** The house rule is that components hold parameters, never code, and it stands: what the
rule keeps out is code that RUNS, on the authority or in a reader. Nothing runs this text. Every reader checks it and
turns it into a material, the way a particle effect document becomes an emitter; to the authority and the fold it is a
string like any other. Code that does run (a script) still lives where the rule puts it, in an uploaded blob.

In a real request the code is one JSON string: write its line breaks as `\n`, or put it on one line (statements end
with `;`, so line breaks mean nothing). The examples here are laid out to be read.

**Check your code as you send it.** A `set` request stores whatever you send, and code that doesn't compile simply
isn't drawn. The inspector checks first and tells you the line: `edit {id, set: {"comp.antra/shader": {code: "…"}}}`
(on a thing that already has one: `edit {id, set: {"ashader.code": "…"}}`). A refusal reads like
`line 3, column 14: there is no function 'foo'`. In a browser the Shader card does the same as you type.

## The component

| | |
|---|---|
| `antra/shader` | `{code, params?}`: every material of the thing |
| `antra/shader:<slot>` | the same, for one material of its model. The slot is the material's name as `hesperus/material:<slot>` spells it (the Inspector's Material card lists them; a `mesh` thing has one, `surface`). A slot's own shader wins over the thing-wide one |

- `code`: the program, as text (below). At most 20,000 characters.
- `params`: values for the code's uniforms, by name: a number, or a list of numbers for a vector
  (`{"speed": 2, "tint": [1, 0.4, 0.1]}`). A uniform `params` doesn't name reads the thing's own registered `params`
  component (so a script's `world.param(id, "speed", 3)` moves a shader), and 0 if neither has it. Changing a value
  never recompiles anything.
- What absence means: no `antra/shader`, or one whose code doesn't compile, is the thing's own material.

A thing with both `hesperus/material` and a shader: the override's colour, roughness and so on are what the shader
reads as `baseColor`, `baseRoughness`…

## The language

It reads like GLSL, and it is small on purpose. The code is never run as code: the client reads it into a graph of
pure expressions and builds the renderer's own shader from that, so a world's shader can't run anything in a visitor's
page, and the same code draws on WebGPU and WebGL 2.

```glsl
uniform float speed;                         // set from params
const float PI = 3.14159;

float wave(vec3 p, float t) {                // functions return a value
  return sin(p.y * 10.0 + t) * 0.5 + 0.5;
}

float w = wave(position, time * speed);
position += normal * w * 0.08;               // move the surface
color = mix(vec3(0.05), vec3(1.0, 0.4, 0.1), w);
if (w > 0.95) { emissive = vec3(2.0); }
```

- **Types**: `float`, `int`, `bool`, `vec2`, `vec3`, `vec4`. A whole number is an `int` and becomes a `float` where one
  is wanted (`float a = 1;`), and a single number beside or assigned to a vector is spread across it (`color = 0.5;`).
  Vectors of different sizes never mix.
- **Vectors**: `vec3(1.0)`, `vec3(a, b, c)`, `vec3(uv, c)`, `vec3(vertexColor)`; swizzles `.xyz`, `.rg`, `.x`, also on the left
  (`c.rg = c.gr;`).
- **Operators**: `+ - * / %` (`%` on floats is `mod`), `< > <= >= == !=` on single numbers, `&& || !`, `?:`, and
  `= += -= *= /= ++ --`.
- **Statements**: declarations (`float x = …;`, `const`), assignments, `if` / `else`, `for`, `{ … }` blocks, and in
  functions `return`. `discard;` drops the pixel. `//` and `/* */` comments.
- **Loops**: `for (int i = 0; i < 8; i++) { … }` only. The bounds are numbers written out (the loop is unrolled when
  the code is read), at most 256 turns a loop, and nothing the condition or step reads may be assigned in the body;
  `break` and `continue` work.
- **Functions**: `float name(vec3 p, float t) { …; return …; }`. They are inlined where called, so one can't call
  itself. A function sees its parameters, the inputs, the uniforms and top-level `const`s.
- **Not here**: `while`, `void`, structs, arrays, matrices, textures (`baseColor` already holds the material's own
  texture), comparing whole vectors.

A shader is at most 4,096 operations once its loops are unrolled and its functions inlined, and reading it may take
at most 100,000 steps (a statement run, a value read): loops inside loops and functions that call functions multiply,
and every viewer's browser reads the code before it can draw. Brackets, blocks and signs nest at most 200 deep. Each
refusal says which bound was met.

**Constants are worked out when the code is read.** `sqrt(16.0) / 8.0` is stored as 0.5 and costs nothing to draw. An
expression of written-out numbers that has no answer is refused there, with its line, because a graphics card would
otherwise refuse the whole shader: `sqrt` or `log` of what they can't take, `asin` or `acos` past ±1, `pow` of a negative
number, a division by zero, `normalize` of zeros, `smoothstep` with its two edges written out equal or crossed, `clamp`
with its low above its high. Numbers stay within ±1e30, whole numbers within ±2,147,483,647.

### What you assign (outputs)

Assign any of these; the ones you leave alone stay the material's own. Each starts as the thing's own value, so
`roughness *= 0.5;` and `position += …;` mean what they say.

| | | |
|---|---|---|
| `color` | vec3 | its base colour (linear RGB) |
| `emissive` | vec3 | the light it gives off, lit or not |
| `roughness` | float | 0 mirror-smooth … 1 matte |
| `metalness` | float | 0 plastic, wood, paint … 1 bare metal |
| `opacity` | float | 1 solid … 0 invisible; assigning it makes the material see-through |
| `position` | vec3 | the vertex, in its mesh's own frame (metres): assign it to move the surface |
| `normal` | vec3 | the shading normal, in its mesh's own frame, never all zeros (after moving `position`, light still falls as on the old shape unless you set this) |

`position` is worked out at each vertex, everything else at each pixel. So `position` can't use what is only known per
pixel (`baseColor` and the other `base…` values, `dFdx`, `dFdy`, `fwidth`), neither in what it is assigned nor in a
condition it sits under, and in the lines that set colour, `position` already is the moved point. A model with few
vertices moves coarsely: there is nothing between them to move.

**A mesh's own frame.** `position` and `normal` are in the frame of the mesh being drawn. For a `mesh` thing, and for a
model that is one mesh at its origin, that is the thing's own frame. A model made of several parts has a frame for each
part (its node's place, turn and scale inside the model), so `position.y` is height within the part, and a shader on
such a model is usually better written with `positionWorld`.

### What you read (inputs)

| | | |
|---|---|---|
| `position` | vec3 | the point on the surface, in its mesh's own frame (metres) |
| `positionWorld` | vec3 | the same point in world metres (a pattern in it stays put while the thing moves through it) |
| `normal` | vec3 | the surface normal, in its mesh's own frame |
| `normalWorld` | vec3 | the normal in the world's frame (`normalWorld.y` is how much it faces up) |
| `normalView` | vec3 | the normal in the eye's frame |
| `viewDir` | vec3 | the unit vector from the surface to the eye, in the eye's frame |
| `uv` | vec2 | the model's texture coordinate |
| `time` | float | seconds on the world's clock: the same for every viewer, and it wraps to 0 every hour |
| `instance` | float | which copy this is, 0, 1, 2… on a thing drawn many times (docs/guide/INSTANCES.md); 0 otherwise |
| `vertexColor` | vec4 | the model's vertex colour (white where it has none) |
| `baseColor` | vec3 | the material's own colour, its texture included |
| `baseEmissive` | vec3 | the material's own glow |
| `baseRoughness` | float | the material's own roughness |
| `baseMetalness` | float | the material's own metalness |
| `baseOpacity` | float | the material's own opacity |

### What you call (functions)

Where a function takes "a value", it takes a float or a vector and answers in kind, part by part.

- **Angles and powers**: `sin(x)` `cos(x)` `tan(x)` `asin(x)` `acos(x)` `atan(x)` `atan(y, x)` `radians(x)` `degrees(x)`
  `pow(x, y)` `exp(x)` `exp2(x)` `log(x)` `log2(x)` `sqrt(x)` `inversesqrt(x)`
- **Shaping**: `abs(x)` `sign(x)` `floor(x)` `ceil(x)` `round(x)` `trunc(x)` `fract(x)` `mod(x, y)` `min(x, y)` `max(x, y)`
  `clamp(x, lo, hi)` `saturate(x)` (clamp to 0…1) `mix(a, b, t)` `step(edge, x)` `smoothstep(lo, hi, x)`
- **Vectors**: `length(v)` `distance(a, b)` `dot(a, b)` `cross(a, b)` `normalize(v)` `reflect(v, n)` `refract(v, n, ratio)`
  `rotate(v2, angle)` (a vec2 turned by radians)
- **Noise** (the point is a float, vec2 or vec3): `noise(p)` smooth, about −1…1; `noise3(p)` three of them, a vec3;
  `fbm(p)` or `fbm(p, octaves, lacunarity, gain)` several octaves of it (octaves 1–8, a number written out; 4, 2 and
  0.5 when left out); `worley(p)` the distance to the nearest cell point, 0…~1; `hash(x)` a repeatable 0…1 number
  with no smoothness (of a float or any vector)
- **Colour**: `hsv(h, s, v)` or `hsv(vec3)` to RGB (hue 0…1 round the wheel); `luminance(rgb)`
- **The rim**: `fresnel()` or `fresnel(power)`: 0 facing the eye, 1 edge-on, sharpened by the power (5 when left out)
- **Per-pixel slopes** (colour code only): `dFdx(x)` `dFdy(x)` `fwidth(x)`

## Recipes

```glsl
// a pulse travelling up, a different phase for each instanced copy
float band = sin(position.y * 6.0 - time * 2.0 + instance * 0.9) * 0.5 + 0.5;
emissive = hsv(fract(instance / 14.0), 0.9, 1.0) * pow(band, 4.0) * 2.0;
```
```glsl
// a glowing rim
emissive = vec3(0.2, 0.6, 1.0) * fresnel(2.0) * 1.5;
```
```glsl
// dissolve: holes that grow and close
if (worley(position.xy * 6.0) > 0.55 + 0.3 * sin(time)) discard;
```
```glsl
// water-like ripples, with the light following them
float h = sin(position.x * 4.0 + time) * cos(position.z * 4.0 + time * 0.7) * 0.05;
position.y += h;
normal = normalize(vec3(-cos(position.x * 4.0 + time) * 0.2, 1.0, sin(position.z * 4.0 + time * 0.7) * 0.14));
roughness = 0.05;
```

## What a shader is not

It changes how a thing is drawn and nothing else. A surface moved by `position` still collides, is walked on and is
picked where the model really is; a thing made invisible is still there. It gives no light to other things (add a
`light`), and text-tier readers are told only that the thing carries the component: write its `description` for them.

A shader runs on every viewer's graphics card, every frame, for every pixel the thing covers. Noise is the costly part:
`fbm` with 8 octaves inside a long loop on a wall that fills the screen is slow on a phone or a headset. The first
time a browser meets a new shader it compiles it, which can cost that viewer a hitch of a frame or two.
