#!/usr/bin/env python3
"""Assert every file in the relay-spike delta belongs to a PR group.

We have lost work from staging by splitting from memory. This makes the
coverage claim MECHANICAL: it re-derives the file list from git every run,
so a file added tomorrow shows up as UNASSIGNED instead of vanishing.

    python3 notes/pr-split-coverage.py            # audit the whole delta
    python3 notes/pr-split-coverage.py --straddle # also list cross-group commits

Exit 1 if anything is unassigned. 🔴 Measure against upstream/main, NEVER
origin/main — `origin` in this tree is a LOCAL path and reads ~241 commits
ahead, which is meaningless for PRs.
"""
import subprocess, sys

# 🔴 MERGE-BASE, NOT THE MOVING TIP (fixed 2026-08-16). This read
# `upstream/main` directly, so the moment upstream merged anything (#126,
# headless Bullet bodies), THEIR nine new files appeared in my delta and the
# script reported them as MY unassigned work — "🔴 THIS WORK WOULD BE LOST"
# about files I had never opened. A three-dot delta answers the question the
# script is actually asking: what did I change since I diverged?
HEAD = "relay-spike"
BASE = subprocess.run(["git", "merge-base", "upstream/main", HEAD],
                      capture_output=True, text=True).stdout.strip() or "upstream/main"

GROUPS = {
    "A.SFU-core": [
        "server/sfu.ts", "server/sfuadapter.ts", "server/sfuguard.ts",
        "server/relayadapter.ts", "server/relaydecision.ts",
        "tools/sfu-test.ts", "tools/sfu-adapter-test.ts", "tools/sfu-load.ts",
        "tools/relay-decision-test.ts", "tools/relay-e2e-test.ts",
        "tools/mini-sfu-test.mjs", "tools/probe-consent.ts",
        "tools/probe-live.ts", "tools/probe-ws.ts",
        "notes/SFU-SPEC.md", "notes/SFU-HANDOFF.md",
    ],
    "B.SFU-wiring": [
        "server/server.ts", "client/lib/voicesfu.js", "client/lib/voicesfubridge.js",
        "client/lib/voicerelay.js", "client/main.js", "client/lib/voice.js",
        "client/lib/voicemouths.js", "tools/sfu-browser-smoke.mjs",
        "tools/relay-browser-smoke.mjs", "tools/sfu-two-publishers.mjs",
        "tools/sfu-reconnect-mic.mjs", "tools/sfu-mic-race.mjs",
        "tools/transport-check.mjs", "tools/msid-probe.ts", "tools/tunnel-up.sh",
        # 2026-08-16, from the first real cross-network test (R's phone):
        "client/lib/audiounlock.js",        # autoplay unlock — both transports
        "tools/audio-unlock-test.mjs",
        "tools/ice-stall-report-test.mjs",  # ICE stall reporter
        "tools/sfu-ice-cred-probe.mjs",     # STUN arrives with the credential
        # the synth lane: TTS publishes with the mic off (2026-08-16 pm)
        "client/lib/voicesource.js",
        "tools/tts-publishes-mic-off-test.mjs",
        "tools/synth-hook-broadcast-test.mjs",
        "tools/mic-resume-after-synth-test.mjs",
        # the cutover: one transport, and the ops gaps closed (2026-08-16 pm)
        "server/transport.ts",            # voiceTransport + durable incarnation
        "server/sfusupervisor.ts",        # A2 voice-service state
        "client/lib/micstate.js",         # the transport-neutral mic half
        "tools/sfu-ops-test.mjs",
        "tools/sfu-verb-gate-test.mjs",
        "tools/mic-gate-wired-test.mjs",
        "tools/micstate-exec-test.mjs",
        "tools/sfu-loss-test.mjs",
        "tools/sfu-no-duplicate-playback-test.mjs",
        "mcpl/mention.ts",                 # door: shared, escaped mention pattern
        "tools/door-media-whitelist-test.mjs",
        "tools/mention-regex-test.mjs",
        "tools/voicesource-real-test.mjs",
        "tools/voice-lifecycle-test.ts",  # DELETED with the mesh it tested
        "tools/audioctx-test.ts",         # repointed at micstate
        "tools/tts-test.ts",              # repointed at micstate
        "tools/audiopanel-css-probe.html",
    ],
    "C.door": ["mcpl/agent.ts", "mcpl/net-server.ts"],
    "D.mic-HUD": [
        "client/lib/mictoggle.js", "client/lib/micgate.js", "client/lib/stt.js",
        "tools/hud-mic-truth.mjs", "tools/mic-button-probe.mjs",
        "tools/mic-glyph-probe.mjs", "tools/mic-meter-states.mjs",
        "tools/reachable.mjs",
    ],
    "E.panel": ["client/lib/audiopanel.js", "client/lib/ttslist.js",
                "tools/panel-teardown-probe.mjs",
                # the teardown class-fix and its receipts (2026-08-16)
                "tools/panel-identity-test.mjs", "tools/host-class-test.mjs",
                "tools/voicelist-inplace-test.mjs", "tools/voicelist-empty-test.mjs",
                "tools/ttsrow-select-test.mjs"],
    "F.tts": ["client/lib/tts.js", "client/lib/tts-chunk.js",
              "client/lib/ttsrow.js", "client/lib/engine-piper.js",
              "tools/tts-blocking-probe.mjs",
              # the afternoon's TTS panel work
              "client/lib/voiceconsent.js",          # volume prefs + defaults
              "tools/self-tts-gain-test.mjs",
              "tools/sidetone-gain-live-test.mjs",
              "tools/tts-import-order-test.mjs",
              "tools/tts-mic-precedence-test.mjs"],
    # /audio diagnostics + the STT findings. Its own group because it is a
    # DEBUGGING surface, not a feature: a reviewer should be able to take or
    # leave it independently of the audio work it was built to investigate.
    "J.diagnostics": ["client/lib/chat.js", "client/lib/commands/registry.js",
                      "tools/audio-report-test.mjs"],
    # Written this session; they document decisions rather than change behaviour.
    "K.notes": ["notes/DECISION-android-captions.md", "notes/PR-SPLIT-AUDIT.md",
                "notes/pr-split-coverage.py", "tools/tts-threading-bench.mjs",
                "notes/NEXT-barge-in.md", "notes/NEXT-remove-mesh.md",
                "notes/PR-0-isolation.md", "notes/PR-1-sfu.md",
                "notes/PR-2-mesh-removal.md", "notes/PR-3-panel-tts.md",
                "notes/REVIEW-agent-tts-path.md"],
    "G.headers": ["server/routes.ts", "client/lib/conjure.js"],   # + tools/tts-threading-bench.mjs measures it (K)
    "H.join": ["client/lib/net.js", "tools/join-check.mjs",
               "tools/join-negative-control.mjs", "tools/join-probe.mjs",
               "tools/voice-wiring-test.ts"],
    "I.deps": ["bun.lock", "client/bun.lock", "package.json",
               "client/package.json", "client/index.html"],
}


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def main():
    files = [f for f in sh(f"git diff --name-only {BASE}..{HEAD}").split() if f]
    if not files:
        print(f"no diff between {BASE} and {HEAD} — is upstream fetched?")
        return 1

    f2g = {f: g for g, fs in GROUPS.items() for f in fs}
    missing = [f for f in files if f not in f2g]
    # A group entry that no longer appears in the diff is ALSO drift worth
    # seeing: it usually means a file was renamed and its new name is now
    # unassigned (i.e. about to be lost).
    stale = [f for f in f2g if f not in files]

    for g in GROUPS:
        n = sum(1 for f in files if f2g.get(f) == g)
        print(f"  {g:14s} {n:3d} files")
    print(f"\n  coverage: {len(files) - len(missing)}/{len(files)}")

    if stale:
        print(f"\n  ⚠️  {len(stale)} mapped file(s) not in the diff (renamed? merged?):")
        for f in stale:
            print("     ", f)

    if missing:
        print(f"\n🔴 UNASSIGNED — THIS WORK WOULD BE LOST ({len(missing)}):")
        for f in missing:
            print("   ", f)
        return 1
    print("\n✅ every file in the delta belongs to a PR group")

    if "--straddle" in sys.argv:
        commits = sh(f"git log --format=%h {BASE}..{HEAD}").split()
        n = 0
        print("\ncommits spanning >1 group (cannot cherry-pick by commit):")
        for c in commits:
            gs = {f2g.get(f, "??") for f in sh(f"git show --name-only --format= {c}").split() if f}
            if len(gs) > 1:
                n += 1
                subj = sh(f"git log -1 --format=%s {c}").strip()[:50]
                print(f"  {c} {'+'.join(sorted(gs)):30s} {subj}")
        print(f"\n  {n}/{len(commits)} straddle — split by FILE/HUNK, never by commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
