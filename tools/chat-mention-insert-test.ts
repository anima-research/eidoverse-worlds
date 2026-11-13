// chat mention insertion — the shipping doors (mentionPerson, a click on a name) put a space before `@name ` when the
// caret follows a word, and nothing extra otherwise (#313 review: the regex suite never ran these call sites).
//
//   bun tools/chat-mention-insert-test.ts

import { plugin } from "bun";
import { fileURLToPath } from "node:url";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "chat-stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here("./chat-core-stub.mjs") }));
    b.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here("./chat-base-stub.mjs") }));
    b.onResolve({ filter: /^\.\/(frames|windows)\.js$/ }, () => ({ path: here("./chat-frames-stub.mjs") }));
    b.onResolve({ filter: /^\.\/net\.js$/ }, () => ({ path: here("./chat-history-stub.mjs") }));
  },
});
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { frameStub } = await import("./chat-frames-stub.mjs");
const chat = await import("../client/lib/chat.js");
chat.initChat({ send: () => {}, whisper: () => {}, people: () => [{ id: "me", me: true }] });
const input = frameStub.body!.querySelector("#chatline") as HTMLTextAreaElement;
const logEl = frameStub.body!.querySelector("#chatlog") as HTMLElement;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const typed = (v: string) => { input.value = v; input.setSelectionRange(v.length, v.length); };

check("precondition: chat.js drew its input and log", !!input && !!logEl);

typed("hello");
chat.mentionPerson("cairn");
check("MI1 mentionPerson after a word: `hello` → `hello @cairn `", input.value === "hello @cairn ", JSON.stringify(input.value));

typed("");
chat.mentionPerson("cairn");
check("MI2 mentionPerson into an empty line: no separator", input.value === "@cairn ", JSON.stringify(input.value));

typed("hi ");
chat.mentionPerson("cairn");
check("MI3 mentionPerson after a space: no second space", input.value === "hi @cairn ", JSON.stringify(input.value));

chat.logChat("cairn", "over here", "");
const who = [...logEl.querySelectorAll(".who")].find((w) => w.textContent === "cairn") as HTMLElement | undefined;
typed("hello");
who?.click();
check("MI4 clicking a name after a word: `hello` → `hello @cairn `", !!who && input.value === "hello @cairn ", JSON.stringify({ found: !!who, value: input.value }));

console.log(`\n[chat-mention-insert] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
