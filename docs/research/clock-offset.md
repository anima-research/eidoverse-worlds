# The server-to-local clock offset (shared/clockoffset.js)

The one rule for a browser (client/lib/player/remotes.js), a lite page (client/lib/ui/participants_lite.js) and an agent
(mcpl/agent.ts). In a browser it is the fallback: once a round trip lands (net.js asks every 10 s, a spectator too),
serverclock.js uses the round trips instead, so the recovery and quiet-world behaviour below is a browser's only until then.

## Why the largest sample

A sample is a message's `t`, the world's authority clock when the server sent it (server/world.ts authorityNow: wall time that never goes backwards), less the local time the message was handled.
That is the true offset less the message's delay, never more: a message handled late, behind a busy page or a slow
link, reads the server's clock as earlier than it is. So the largest sample is the best estimate, and a late one moves
it by no more than the leak.

## The leak

The estimate may come down by LEAK_MS_PER_S for each second since the previous sample, and by no more than
LEAK_MAX_MS at once, so a slow drift between the two clocks is followed, while a run of late samples moves it by almost
nothing. Between samples it holds, so a world with no messages doesn't wander, and the cap keeps a late sample after a
long quiet spell (a page coming back from a background tab, say) from pulling it down by its whole delay. Its cost: a
drift built up over such a spell is followed by at most 100 ms at the first sample after it, and the rest of the way at
2 ms a second as samples resume, as any drift is. 2 ms/s is a reading, not a measurement: twice the 1 ms/s two clocks
drift apart when each slews at 500 ppm, ntpd's limit.

A step back of the server's clock (rare under NTP, which slews small offsets) holds `t` still until the wall catches up (server/livehost.ts now()), so the samples fall as local time runs on; that, or a reconnect to a server whose clock
is behind the last one's, is followed at the same rate while samples come at least every 50 s: about 8 minutes for a
1 s step and an hour for 7 s, and at 100 ms a sample when they come less often.

## When samples arrive

The server sends a world frames only while some client there streams its body's pose, as an agent does every tick and
a browser with a body does from its frame loop, moving or not, while its tab is shown. A world with nobody streaming
(spectators only, or bodies whose tabs are hidden) gets none, so there the estimate holds until a frame, or this
client's next join's clock message, brings a sample. That is the cost of not trusting late samples.
