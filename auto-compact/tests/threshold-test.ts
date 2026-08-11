import type { AutoCompactConfig } from "../config.ts";
import {
	effectiveCompactionTokens,
	formatTokens,
	isNativeFirst,
	nativeCompactionTokens,
	resolveThresholdTokens,
} from "../threshold.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

const defaults: AutoCompactConfig = {
	enabled: true,
	classes: [
		{ windowMax: 300_000, thresholdPercent: 90 },
		{ windowMax: 500_000, thresholdPercent: 70 },
	],
	default: { thresholdTokens: 400_000 },
};

eq("percent class resolves against the window", resolveThresholdTokens(defaults, 272_000), 244_800);
eq("windowMax boundary is inclusive", resolveThresholdTokens(defaults, 300_000), 270_000);
eq("the next class picks up just past a boundary", resolveThresholdTokens(defaults, 300_001), 210_001);
eq("the default applies past the last class", resolveThresholdTokens(defaults, 1_000_000), 400_000);

const tokenClass: AutoCompactConfig = {
	enabled: true,
	classes: [{ windowMax: 500_000, thresholdTokens: 250_000 }],
	default: { thresholdPercent: 50 },
};
eq("token class is window-independent", resolveThresholdTokens(tokenClass, 372_000), 250_000);
eq("percent default resolves against the window", resolveThresholdTokens(tokenClass, 1_000_000), 500_000);

const defaultOnly: AutoCompactConfig = { enabled: true, classes: [], default: { thresholdPercent: 50 } };
eq("empty classes fall through to the default", resolveThresholdTokens(defaultOnly, 200_000), 100_000);

eq("native compaction point subtracts pi's reserve", nativeCompactionTokens(200_000), 183_616);
eq("effective point is capped by the native point", effectiveCompactionTokens(defaults, 128_000), 111_616);
eq("effective point is the class threshold when reachable", effectiveCompactionTokens(defaults, 372_000), 260_400);
eq("a 90% class on a 128k window is native-first", isNativeFirst(defaults, 128_000), true);
eq("a 90% class on a 200k window beats native", isNativeFirst(defaults, 200_000), false);

eq("small counts print verbatim", formatTokens(999), "999");
eq("thousands keep one decimal", formatTokens(1_500), "1.5k");
eq("large thousands round", formatTokens(111_616), "112k");
eq("hundreds of thousands round", formatTokens(400_000), "400k");
eq("millions keep one decimal", formatTokens(1_000_000), "1.0M");
eq("tens of millions round", formatTokens(12_000_000), "12M");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
