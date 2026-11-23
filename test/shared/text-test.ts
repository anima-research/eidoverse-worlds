// shared/text.js directionOf: a paragraph's base direction is its first strong letter's (the bidi algorithm's P2–P3).
//
//   bun test/shared/text-test.ts
//
// Digits are not strong (Arabic-Indic U+0660–0669 and their separators are AN, extended U+06F0–06F9 are EN), so P2
// skips them: a line that starts with them takes its direction from the first letter after (G2-082).
import { directionOf, layoutLines } from "../../shared/text.js";
import { suite } from "../gate/suite.ts";

const { check, done } = suite("text-test");

check("Arabic reads right to left", directionOf("مرحبا بالعالم") === "rtl");
check("Hebrew reads right to left", directionOf("שלום עולם") === "rtl");
check("Latin reads left to right", directionOf("hello") === "ltr");
check("no strong letter at all: left to right", directionOf("123 ٣٤٥ ۶۷") === "ltr", directionOf("123 ٣٤٥ ۶۷"));
check("Arabic-Indic digits are skipped: the Latin after them decides", directionOf("١٢٣ apples") === "ltr", directionOf("١٢٣ apples"));
check("extended Arabic-Indic digits are skipped too", directionOf("۱۲۳ apples") === "ltr", directionOf("۱۲۳ apples"));
check("the Arabic decimal and thousands separators are skipped", directionOf("١٬٠٠٠٫٥ kg") === "ltr", directionOf("١٬٠٠٠٫٥ kg"));
check("Arabic after Arabic-Indic digits still reads right to left", directionOf("٣ تفاحات") === "rtl");
check("European digits before Arabic: right to left", directionOf("3 تفاحات") === "rtl");
const lines = layoutLines("١٢٣ apples\nمرحبا", 1000, (s: string) => s.length);
check("layoutLines carries each paragraph's own direction", lines.map((l) => l.dir).join(",") === "ltr,rtl", JSON.stringify(lines));

done();
