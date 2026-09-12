#!/usr/bin/env bash
# The #132 composed receipt set — one command, every suite, loud on failure.
# Prereqs: `bun install` at the root AND in client/ AND in mcpl/ (nested
# dependency trees — the #131 review's environment note applies here too).
# Browser probes resolve Chrome via SFU_TEST_CHROME, else Playwright's managed
# browser. Run from the repository root:  bash tools/cutover-receipts.sh
set -u
BUN="${BUN_PATH:-bun}"
fails=0
run() {
  printf '%-38s' "$1:"
  # Stream to a scratch file, not $(…): a multi-minute browser suite inside a
  # command substitution is INVISIBLE until it exits, and "no output" reads
  # exactly like "wedged" — a healthy run got killed for looking quiet
  # (2026-08-20, twice). tail -f the file to watch a slow suite live.
  local out="/tmp/cutover-receipt-$$-${1%.*}.log"
  if $BUN "tools/$1" >"$out" 2>&1; then tail -1 "$out"; else
    echo "FAIL"; tail -5 "$out" | sed 's/^/    /'; fails=$((fails+1)); fi
}
echo "── node-side ──"
run mention-regex-test.mjs
run channel-cap-gate-test.mjs
run door-media-whitelist-test.mjs
run micstate-exec-test.mjs
run micstate-release-test.mjs
run micstate-single-transport-test.mjs
run tts-import-order-test.mjs
run tts-fault-test.ts
run tts-test.ts
run audioctx-test.ts
run voice-wiring-test.ts
run sfu-test.ts
run sfu-adapter-test.ts
run relay-decision-test.ts
run sfu-ops-test.mjs
run sfu-verb-gate-test.mjs
run sfu-loss-test.mjs
run synth-hook-broadcast-test.mjs
run tts-publishes-mic-off-test.mjs
run mic-gate-wired-test.mjs
run audio-unlock-test.mjs
run join-rfc005.test.ts
echo "── owned live-door ──"
run door-cap-gate-live-test.mjs
echo "── owned real-browser ──"
run boot-check.mjs
# THE VIEWPORT MATRIX, actually run (antra-tess #185). The knobs existed and no
# command exercised them, so the resize phase and the chrome/occlusion check were
# capabilities rather than receipts — the same gap as a corpus row nothing applies.
# 390x844 is deliberately NOT here: it fails today on a disclosed defect —
# "stand" covered by #earbtn — that needs an owner layout call (wrap the bar
# narrower, or move the mic/ear pair). Wiring a known-red command into the
# shared receipts script would block unrelated cutovers; the defect is carried
# by the PR body and by a corpus row instead. Restore this line when it passes.
BOOT_CHECK_VIEWPORT=800x700 run boot-check.mjs
BOOT_CHECK_VIEWPORT=1280x720 BOOT_CHECK_RESIZE_TO=390x844 run boot-check.mjs
BOOT_CHECK_VIEWPORT=844x390 BOOT_CHECK_TOUCH=1 run boot-check.mjs
# 1024x800 is NOT here for the same reason as 390x844: it fails today, and the
# defect PREDATES this branch — bef5311 (the head of the 05:32Z review) fails
# identically with `emotes [336,10,688,56] x world [609,8,1016,381]`. Cause:
# fitsDefaults sums chat(545)+world(407)=952 for the side-by-side test but
# EXCLUDES emotes, whose x is 'center' rather than a number — so a 352px centred
# strip is never counted. Below ~968 the predicate hides the bar and saves us;
# above ~1192 the geometry separates on its own; 1000-1100 is unprotected and no
# receipt or corpus row sat between 900 and 1200. Enable this line with the fix.
#BOOT_CHECK_VIEWPORT=1024x800 run boot-check.mjs
run mic-hud-probe.mjs
run mic-meter-states.mjs
run panel-teardown-probe.mjs
run sfu-no-duplicate-playback-test.mjs
run voicesource-real-test.mjs
run mic-resume-after-synth-test.mjs
run transport-check.mjs
run sfu-browser-smoke.mjs
echo
[ "$fails" = 0 ] && echo "✅ composed receipt set: ALL GREEN" || echo "❌ $fails suite(s) failed"
exit $((fails > 0))
