// tools/protocol/oneshot-sim.ts — tests only (oneshot-check): a --preload (BUN_OPTIONS) that makes a world.ts child misbehave
// around its frame (server/oneshot.ts frameAtExit), as ONESHOT_SIM says. Any other process, or no ONESHOT_SIM: nothing.
//   hang         after its complete frame, never finishes exiting (Bun 1.3.14 on Windows, simulated; bounded at 90 s so a
//                failing run leaves nothing behind for long)
//   timer        a timer of its own open at exit;  listener  a listening socket of its own open at exit
//   partial      stdout's frame never written (stderr's is);  partial-hang  …and then the hang
//   nonce        both frames carry another nonce;  exitlie  both frames say exit 77, which it doesn't exit with;  noframe  no frame at all
//   descendant   a grandchild left running, holding no handle of the child's (its parent bun has already exited; on Windows
//                started detached, outside Bun's kill-on-close job, as the only kind that outlives its bun there)
//   descendant-hang  …and then the hang
import fs from "node:fs";

const sim = process.env.ONESHOT_SIM ?? "";
if (sim && /world\.ts$/.test(process.argv[1] ?? "")) {
  const write = fs.writeSync, isFrame = (s: unknown) => typeof s === "string" && /\[oneshot [0-9a-f]+\] answered/.test(s);
  const hang = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90_000);
  (fs as any).writeSync = (fd: number, s: any, ...rest: any[]) => {
    if (!isFrame(s)) return write(fd, s, ...rest);
    if (sim === "noframe") return 0;
    if (fd === 1 && sim.startsWith("partial")) return 0;
    if (sim === "nonce") s = s.replace(/\[oneshot [0-9a-f]+\]/, "[oneshot 0123456789abcdef]");
    if (sim === "exitlie") s = s.replace(/\(exit -?\d+\)/, "(exit 77)");
    const n = write(fd, s, ...rest);
    if (fd === 2 && sim.endsWith("hang")) hang();
    return n;
  };
  if (sim === "timer") process.on("exit", () => { setInterval(() => {}, 1000); });
  if (sim === "listener") process.on("exit", () => { Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); });
  if (sim.startsWith("descendant")) {
    const pidFile = process.env.ONESHOT_SIM_PIDFILE ?? "";
    // Windows: detached, or Bun's own kill-on-close job ends it with the bun that started it; POSIX: not, so it stays in the group
    Bun.spawnSync([process.execPath, "-e", `const g = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"], detached: ${process.platform === "win32"} });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.exit(0);`], { stdio: ["ignore", "ignore", "ignore"] });
  }
}
