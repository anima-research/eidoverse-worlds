// chat mention insertion — the shipping doors (mentionPerson, a click on a name) put a space before `@name ` when the
// caret follows a word, and nothing extra otherwise (#313 review: the regex suite never ran these call sites).
//
//   bun test/client/chat-mention-insert-test.ts

import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { suite } from "../gate/suite.ts";
import { stubResolve } from "../harness/stub.ts";
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: "chat-stubs",
  setup(b) {
    stubResolve(b, /^(\.\.?\/)+base\.js$/, () => ({ path: here("../stubs/chat-base-stub.mjs") }));
    stubResolve(b, /^(\.\.?\/)+(ui\/)?(frames|windows)\.js$/, () => ({ path: here("../stubs/chat-frames-stub.mjs") }));
    stubResolve(b, /^(\.\.?\/)+net\.js$/, () => ({ path: here("../stubs/chat-history-stub.mjs") }));
  },
});
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

const { frameStub } = await import("../stubs/chat-frames-stub.mjs");
const chat = await import("../../client/lib/ui/chat.js");
chat.initChat({ send: () => {}, people: () => [{ id: "me", me: true }] });
const input = frameStub.body!.querySelector("#chatline") as HTMLTextAreaElement;
const logEl = frameStub.body!.querySelector("#chatlog") as HTMLElement;

const { check, done } = suite("chat-mention-insert");
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

done();
