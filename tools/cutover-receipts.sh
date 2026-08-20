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
  if out=$($BUN "tools/$1" 2>&1); then echo "${out##*$'\n'}"; else
    echo "FAIL"; echo "$out" | tail -5 | sed 's/^/    /'; fails=$((fails+1)); fi
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
