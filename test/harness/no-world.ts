// test/harness/no-world.ts: the url for a test's WorldAgent that joins no world: the test's own server (port 0), no world and no library on it.
// The agent's default, 127.0.0.1:8940, is whatever runs there (or a closed port, which can hang ~2 min); hygiene's agent-url refuses it.
let server: ReturnType<typeof Bun.serve> | null = null;
let asked = 0;
export function noWorldUrl(): string {
  if (!server) { server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { asked++; return new Response("", { status: 404 }); } }); server.unref(); }
  return `ws://127.0.0.1:${server.port}/ws`;
}
/** How many requests (a rig read, a join) reached it. */
export const noWorldAsked = () => asked;
