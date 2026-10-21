# Consent table — a record of one design (retired from code 10-20, #260 recut A)

Kept so the thinking isn't lost. Not a direction: nobody knows yet which of these a world will need (house markup, #260 22:05Z). What shipped instead is one switch per body — see spec/NORMATIVE.md.

### Body consent (who may do what to your body)

Consent is presence: never logged, never a grant, never a property of what kind of participant a body is.

| Choice | Value | Status · source |
|---|---|---|
| Classes | `near`, `follow`, `touch`, `intimate`, `pose`, `shove`, `displace`, `voice` | trial · author (10-13 v1), renamed 10-17 |
| Enforced today | `touch`, `intimate`, `pose`, `shove`, `displace`. `near`, `follow`, `voice` are shown, not enforced | trial · lead (what the reference can enforce) |
| Tiers | `everyone`, `friends` (mutual: each named the other) | decided · author (10-13: no circles) |
| Cells | `allow` · `ask` · `deny` | decided · author (10-17) |
| Per-person extras | allow or deny one identity, for one class or all; beats the tiers. Either stands **until you revoke it**; an allow may instead name `for` (any length) | decided · author (10-13 v1; until-revoked 10-20) |
| Pause | closes your whole table at once; you or a delegate may pause, only you resume | trial · lead |
| Default | the `normal` preset, for every body | decided · author |
| Presets | `normal`, `open`, `friends-only`, `performer` (opt-in). Table below | trial · lead (values) |
| Silence | a body with no table gets `normal`; an ask unanswered in **20 s** is no | trial · lead (20 s) |
| After a no | the same asker, you, and that class: no new ask for **10 min**, doubling with each no (10, 20, 40…) | trial · lead |
| A yes to an ask | covers one touch, held at most **10 min**; letting go, either leaving, or your cell moving off allow ends it sooner | trial · lead |
| Repeated refusals | 5 refusals of one class from 3 different people within 5 min: a 10-min world-wide cool-down for that class, written to the moderator log as an automatic act. Never a ban | trial · lead (research 10-13) |
| Intimate points | `chest_front`, `waist_l`, `waist_r`, `hip_l`, `hip_r`; every other contact point is `touch` | trial · lead |
| Delegates | a list apart from friends; may close your table (pause, deny), never open it; only you add or remove one | decided · author (10-17 split) |
| Unfriend | ends the mutual tier at once, on both bodies | trial · lead |
| A refusal's words | one uniform no: `"<name> isn't taking <class> right now"`; never says why (a reason leaks a per-person deny) | trial · lead (research 10-13) |
| Who has the final word | the authority refuses before delivery; the target's own client may still refuse | decided · author |
| World overrides of personal consent | none | **open** · research recommends never for intimate |

**Presets** (everyone tier; the friends tier is the same for all four presets):

| class | normal | open | friends-only | performer | friends (all) |
|---|---|---|---|---|---|
| near | ask | allow | deny | allow | allow |
| follow | ask | ask | deny | ask | allow |
| touch | ask | allow | deny | allow | allow |
| intimate | deny | deny | deny | deny | ask |
| pose | deny | ask | deny | allow | ask |
| shove | deny | ask | deny | allow | allow |
| displace | deny | ask | deny | ask | ask |
| voice | ask | allow | deny | allow | allow |

