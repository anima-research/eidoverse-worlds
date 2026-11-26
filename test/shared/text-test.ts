// shared/text.js directionOf: a paragraph's base direction is its first strong letter's (the bidi algorithm's P2–P3).
//
//   bun test/shared/text-test.ts
//
// Digits are not strong (Arabic-Indic U+0660–0669 and their separators are AN, extended U+06F0–06F9 are EN), so P2
// skips them: a line that starts with them takes its direction from the first letter after (G2-082). Nor are the
// neutrals, separators and marks inside the Arabic and Hebrew blocks (the Arabic comma is CS): only R and AL are.
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
// a strong letter is one the bidi table calls R or AL (or L): a neutral, a separator or a mark inside an Arabic or Hebrew
// block is skipped like a digit (#377 review 3, 8): the rows sit on each side of the edges of what is skipped
const dirs: [string, string, string][] = [
  ["\u060c", "ltr", "the Arabic comma (CS) is skipped"], ["\u066a", "ltr", "the Arabic percent sign (ET) is skipped"],
  ["\u066d", "rtl", "the Arabic five-pointed star (AL) is strong"], ["\u061b", "rtl", "the Arabic semicolon (AL) is strong"],
  ["\u061f", "rtl", "the Arabic question mark (AL) is strong"], ["\u064b", "ltr", "an Arabic vowel mark (NSM) is skipped"],
  ["\u05be", "rtl", "the Hebrew maqaf (R) is strong"], ["\ufd3e", "ltr", "the ornate parenthesis (ON) is skipped"],
  ["\u0600", "ltr", "the Arabic number sign (AN) is skipped"], ["\u200f", "rtl", "a right-to-left mark (R) is strong"],
];
for (const [c, want, why] of dirs) check(`${why}: "${c} apples" reads ${want}`, directionOf(`${c} apples`) === want, directionOf(`${c} apples`));
check("the review's case: \"١، apples\" (digit, comma, then Latin) reads left to right", directionOf("١، apples") === "ltr", directionOf("١، apples"));
check("a left-to-right mark before Arabic: left to right", directionOf("\u200e مرحبا") === "ltr");
check("a letter of any left-to-right script decides (Devanagari before Arabic)", directionOf("नमस्ते مرحبا") === "ltr", directionOf("नमस्ते مرحبا"));
check("a symbol is no letter: × before Arabic still reads right to left", directionOf("× مرحبا") === "rtl", directionOf("× مرحبا"));
const lines = layoutLines("١٢٣ apples\nمرحبا", 1000, (s: string) => s.length);
check("layoutLines carries each paragraph's own direction", lines.map((l) => l.dir).join(",") === "ltr,rtl", JSON.stringify(lines));

done();
