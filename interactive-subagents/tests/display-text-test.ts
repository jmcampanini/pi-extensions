import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplayText } from "../display-text.ts";

describe("sanitizeDisplayText", () => {
	it("strips CSI styling and cursor controls", () => {
		assert.strictEqual(sanitizeDisplayText("before\x1b[31mred\x1b[0m\x1b[2Jafter"), "beforeredafter");
	});

	it("strips OSC 52 with BEL", () => {
		assert.strictEqual(sanitizeDisplayText("before\x1b]52;c;Zm9v\x07after"), "beforeafter");
	});

	it("strips OSC 52 with ST", () => {
		assert.strictEqual(sanitizeDisplayText("before\x1b]52;c;Zm9v\x1b\\after"), "beforeafter");
	});

	it("strips C1 CSI", () => {
		assert.strictEqual(sanitizeDisplayText("before\x9b2Jafter"), "beforeafter");
	});

	it("removes C1 OSC delimiters", () => {
		assert.strictEqual(sanitizeDisplayText("before\x9d52;c;Zm9v\x9cafter"), "before52;c;Zm9vafter");
	});

	it("removes C1 DCS delimiters", () => {
		assert.strictEqual(sanitizeDisplayText("before\x90payload\x9cafter"), "beforepayloadafter");
	});

	it("removes unsafe C0 controls", () => {
		assert.strictEqual(sanitizeDisplayText("a\0b\bc\fd"), "abcd");
	});

	it("removes DEL and standalone C1 controls", () => {
		assert.strictEqual(sanitizeDisplayText("a\x7fb\x85c"), "abc");
	});

	it("keeps tabs and logical line breaks", () => {
		assert.strictEqual(sanitizeDisplayText("a\tb\nc\rd"), "a\tb\nc\rd");
	});

	it("keeps ordinary Unicode text", () => {
		assert.strictEqual(sanitizeDisplayText("界e\u0301 🙂"), "界e\u0301 🙂");
	});

	it("removes interlinear annotation controls", () => {
		assert.strictEqual(sanitizeDisplayText("a\ufff9b\ufffac\ufffbd"), "abcd");
	});
});
