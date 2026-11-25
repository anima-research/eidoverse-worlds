// The server's disposable children (the optimizer, a build check's worker, the avatar importer, one-shots): on Linux each
// raises its own oom_score_adj to 1000 before exec, so when the unit's cgroup (MemoryMax=, OOMPolicy=continue) runs out,
// the kernel kills the child, not the server. Raising one's own score needs no privilege; a failed write is silent, and
// the child runs anyway. /bin/sh by absolute path: PATH may hold no shell. The pid is the child's (exec), so kills and
// process groups behave as without the wrapper.

/** `cmd`, run so the kernel picks it first when memory runs out (Linux; elsewhere `cmd` as it is). */
export function disposable(cmd: string[]): string[] {
  return process.platform === "linux" ? ["/bin/sh", "-c", 'echo 1000 2>/dev/null >/proc/self/oom_score_adj; exec "$@"', "sh", ...cmd] : cmd;
}
