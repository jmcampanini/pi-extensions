import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AutoCompactConfig } from "../auto-compact-config.ts";
import { formatTokens, resolveThresholdTokens } from "../auto-compact-threshold.ts";

const defaults: AutoCompactConfig = {
	enabled: true,
	classes: [
		{ windowMax: 300_000, thresholdPercent: 90 },
		{ windowMax: 500_000, thresholdPercent: 70 },
	],
	default: { thresholdTokens: 400_000 },
};

const tokenClass: AutoCompactConfig = {
	enabled: true,
	classes: [{ windowMax: 500_000, thresholdTokens: 250_000 }],
	default: { thresholdPercent: 50 },
};

const defaultOnly: AutoCompactConfig = { enabled: true, classes: [], default: { thresholdPercent: 50 } };

describe("resolveThresholdTokens", () => {
	it("percent class resolves against the window", () => {
		assert.strictEqual(resolveThresholdTokens(defaults, 272_000), 244_800);
	});

	it("windowMax boundary is inclusive", () => {
		assert.strictEqual(resolveThresholdTokens(defaults, 300_000), 270_000);
	});

	it("the next class picks up just past a boundary", () => {
		assert.strictEqual(resolveThresholdTokens(defaults, 300_001), 210_001);
	});

	it("the default applies past the last class", () => {
		assert.strictEqual(resolveThresholdTokens(defaults, 1_000_000), 400_000);
	});

	it("token class is window-independent", () => {
		assert.strictEqual(resolveThresholdTokens(tokenClass, 372_000), 250_000);
	});

	it("percent default resolves against the window", () => {
		assert.strictEqual(resolveThresholdTokens(tokenClass, 1_000_000), 500_000);
	});

	it("empty classes fall through to the default", () => {
		assert.strictEqual(resolveThresholdTokens(defaultOnly, 200_000), 100_000);
	});
});

describe("formatTokens", () => {
	it("small counts print verbatim", () => {
		assert.strictEqual(formatTokens(999), "999");
	});

	it("thousands keep one decimal", () => {
		assert.strictEqual(formatTokens(1_500), "1.5k");
	});

	it("large thousands round", () => {
		assert.strictEqual(formatTokens(111_616), "112k");
	});

	it("hundreds of thousands round", () => {
		assert.strictEqual(formatTokens(400_000), "400k");
	});

	it("millions keep one decimal", () => {
		assert.strictEqual(formatTokens(1_000_000), "1.0M");
	});

	it("tens of millions round", () => {
		assert.strictEqual(formatTokens(12_000_000), "12M");
	});
});
