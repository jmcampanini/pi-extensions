import { sanitizeDisplayText } from "../display-text.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}:\n    got  ${g}\n    want ${w}`); }
}

eq("strips CSI styling and cursor controls", sanitizeDisplayText("before\x1b[31mred\x1b[0m\x1b[2Jafter"), "beforeredafter");
eq("strips OSC 52 with BEL", sanitizeDisplayText("before\x1b]52;c;Zm9v\x07after"), "beforeafter");
eq("strips OSC 52 with ST", sanitizeDisplayText("before\x1b]52;c;Zm9v\x1b\\after"), "beforeafter");
eq("strips C1 CSI", sanitizeDisplayText("before\x9b2Jafter"), "beforeafter");
eq("removes C1 OSC delimiters", sanitizeDisplayText("before\x9d52;c;Zm9v\x9cafter"), "before52;c;Zm9vafter");
eq("removes C1 DCS delimiters", sanitizeDisplayText("before\x90payload\x9cafter"), "beforepayloadafter");
eq("removes unsafe C0 controls", sanitizeDisplayText("a\0b\bc\fd"), "abcd");
eq("removes DEL and standalone C1 controls", sanitizeDisplayText("a\x7fb\x85c"), "abc");
eq("keeps tabs and logical line breaks", sanitizeDisplayText("a\tb\nc\rd"), "a\tb\nc\rd");
eq("keeps ordinary Unicode text", sanitizeDisplayText("界e\u0301 🙂"), "界e\u0301 🙂");
eq("removes interlinear annotation controls", sanitizeDisplayText("a\ufff9b\ufffac\ufffbd"), "abcd");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
