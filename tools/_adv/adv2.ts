/**
 * C — sfuguard semantics. Does throwing inside an uncaughtException handler
 * do what the author thinks? Run each case in a CHILD process so we can read
 * the real exit code and stderr.
 */
const CASE = process.argv[2];

if (CASE === "child-benign") {
  const { installSfuTransportGuard, transportErrorsSwallowed } = await import("../../server/sfuguard.ts");
  installSfuTransportGuard();
  setTimeout(() => {
    const e: any = new Error("connect ECONNREFUSED 127.0.0.1:5000"); e.code = "ECONNREFUSED";
    throw e;
  }, 10);
  setTimeout(() => { console.log("SURVIVED swallowed=" + transportErrorsSwallowed()); process.exit(0); }, 200);
}

else if (CASE === "child-real") {
  // A REAL bug. Author's intent: "crash loudly", same as unguarded.
  const { installSfuTransportGuard } = await import("../../server/sfuguard.ts");
  installSfuTransportGuard();
  setTimeout(() => { throw new Error("REAL BUG: undefined is not a function"); }, 10);
  setTimeout(() => { console.log("STILL ALIVE AFTER REAL BUG"); process.exit(0); }, 300);
}

else if (CASE === "child-unguarded") {
  // Control: what an unguarded process does with the same real bug.
  setTimeout(() => { throw new Error("REAL BUG: undefined is not a function"); }, 10);
  setTimeout(() => { console.log("STILL ALIVE AFTER REAL BUG"); process.exit(0); }, 300);
}

else if (CASE === "child-benign-rejection") {
  const { installSfuTransportGuard, transportErrorsSwallowed } = await import("../../server/sfuguard.ts");
  installSfuTransportGuard();
  setTimeout(() => { Promise.reject(new Error("send EHOSTUNREACH")); }, 10);
  setTimeout(() => { console.log("SURVIVED swallowed=" + transportErrorsSwallowed()); process.exit(0); }, 200);
}

else if (CASE === "child-real-rejection") {
  const { installSfuTransportGuard } = await import("../../server/sfuguard.ts");
  installSfuTransportGuard();
  setTimeout(() => { Promise.reject(new Error("REAL BUG in a promise")); }, 10);
  setTimeout(() => { console.log("STILL ALIVE AFTER REAL REJECTION"); process.exit(0); }, 300);
}

else if (CASE === "child-message-false-positive") {
  // Does the BENIGN regex swallow a real application bug whose message merely
  // MENTIONS one of the errno strings? e.g. an error surfaced while handling one.
  const { installSfuTransportGuard, transportErrorsSwallowed } = await import("../../server/sfuguard.ts");
  installSfuTransportGuard();
  setTimeout(() => {
    throw new TypeError("Cannot read properties of undefined (reading 'ECONNRESET')");
  }, 10);
  setTimeout(() => { console.log("SWALLOWED-A-REAL-BUG swallowed=" + transportErrorsSwallowed()); process.exit(0); }, 200);
}

else {
  // ── driver ──
  const { spawn } = await import("node:child_process");
  const run = (c: string) => new Promise<{ code: number | null; out: string; err: string }>((res) => {
    const p = spawn(process.execPath, ["tools/_adv/adv2.ts", c], { cwd: process.cwd() });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out, err }));
  });

  const cases = ["child-benign", "child-benign-rejection", "child-real", "child-unguarded", "child-real-rejection", "child-message-false-positive"];
  for (const c of cases) {
    const r = await run(c);
    const firstErrLine = r.err.split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ");
    console.log(`\n[${c}]`);
    console.log(`  exit=${r.code}  stdout=${JSON.stringify(r.out.trim())}`);
    console.log(`  stderr(head)= ${firstErrLine.slice(0, 240)}`);
  }
}
