# Gamepad controls

Click inside the world, press a controller button, then release buttons and
center the sticks. The browser must report `mapping: "standard"`; unmapped
devices are ignored. The first available standard controller keeps control
until it disconnects.

| Action | Xbox / PlayStation | Keyboard / mouse |
| --- | --- | --- |
| Move | Left stick | WASD / arrows |
| Look | Right stick | Drag / mouselook |
| Jump | A / Cross | Space |
| Use nearby object | X / Square | E / click the prompt |
| Cancel posture, photo mode, or pointer lock | B / Circle | Escape |
| Run | Left stick click | Shift |

Movement is analog and camera-relative. Both sticks have a 0.18 radial dead
zone with the remaining range rescaled to full travel. Right-stick look uses
2.4 radians/second horizontally and 1.9 vertically, independent of frame rate.
Use and cancel fire on press edges. Prompts follow the active input device.
Walking gets up from a ragdoll or dismounts a seat, at the same 0.08 threshold
the walk controller uses, so a stick resting outside the dead zone does not tip
you off a swing. Getting up is an edge, not a level: after a knock-down or a
grab the input must pass through neutral before it counts, so being shoved
while holding a key leaves you on the ground until you press again.
Keyboard flight and photo-camera translation retain their existing controls.

Blur, hidden pages, disconnection, and leaving the page clear input. Chat,
editable controls, and modal focus suppress gameplay. After returning or
reconnecting, release buttons and center sticks before playing again.

The controller legend flashes once, the first time a pad takes over in a
session, not on every switch back from the mouse.

## Contextual objects

An ordinary `interaction` component selects a primary use action:

```text
comp {id: "bell", type: "interaction", data: {action: "ring", label: "Ring bell"}}
```

An entity with exactly one `reactions` action also offers that action without
an extra component. The nearest visible, unobstructed object within three
metres offers a prompt. Activation rechecks range and visibility and sends the
existing `use {id, action}` verb. Server rights, reactions, and bound behaviors
still own effects; components contain data only. No new verb is introduced.

## Browser requirements and verification

Use HTTPS or trustworthy loopback HTTP for local testing. A focused page may
not see an already-connected device until a physical button is pressed.
Cross-origin iframes need `gamepad` delegation in their `allow` attribute;
any ancestor Permissions Policy must permit it too. Missing or denied Gamepad
API access leaves keyboard and touch operational.

- [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API)
- [Gamepad Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/gamepad)

Run `bun tools/input-test.ts`, `bun tools/input-dom-test.ts`,
`bun tools/interaction-test.ts`, `bun tools/limp-input-test.ts`, and
`bun tools/collider-test.ts` as separate processes. They cover normalization,
edge triggering, discovery/reconnection neutral guards, focus suppression,
disconnect clearing, denied API fallback, contextual use routing, the prompt
never taking the keyboard, the movement threshold and neutral latch that guard
knock-downs and seats, and excluding the target's own collider while respecting
other obstacles.

Physical Windows/Edge acceptance on 2026-09-07 exposed an
`Xbox 360 Controller (XInput STANDARD GAMEPAD)`. The operator verified movement,
look, jump, use, chat suppression, and stopping on unplug on the source
implementation, including an iframe session. This upstream adaptation retains
the same input modules and mapping; its generic use action is tested separately.
An Edge smoke test of this upstream adaptation drove the real controller and
avatar with simulated standard-pad input: movement, camera rotation, jump,
disconnect clearing, and exactly one server-logged `use` across 120 held polls
passed, with no page JavaScript errors.
