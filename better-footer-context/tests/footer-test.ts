import {
	compactTargetSuffix,
	selectContextColorBand,
} from "../index.ts";

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

const enabled = { enabled: true, thresholdPercent: 70 };

eq("enabled suffix includes the configured target", compactTargetSuffix(enabled), " · compact @70%");
eq("enabled below warning range is uncolored", selectContextColorBand(59.9, enabled), undefined);
eq("enabled warning lower bound is inclusive", selectContextColorBand(60, enabled), "warning");
eq("enabled value below threshold is warning", selectContextColorBand(69.9, enabled), "warning");
eq("enabled threshold is error", selectContextColorBand(70, enabled), "error");
eq("enabled value above threshold is error", selectContextColorBand(71, enabled), "error");
eq("enabled unknown percent is uncolored", selectContextColorBand(null, enabled), undefined);

const relativeThreshold = { enabled: true, thresholdPercent: 85 };

eq("suffix follows a changed threshold", compactTargetSuffix(relativeThreshold), " · compact @85%");
eq("warning range follows a changed threshold", selectContextColorBand(75, relativeThreshold), "warning");
eq("error range follows a changed threshold", selectContextColorBand(85, relativeThreshold), "error");

const disabled = { enabled: false, thresholdPercent: 85 };

eq("disabled omits the target suffix", compactTargetSuffix(disabled), "");
eq("disabled ignores the configured threshold", selectContextColorBand(85, disabled), "warning");
eq("disabled keeps exact 70 boundary uncolored", selectContextColorBand(70, disabled), undefined);
eq("disabled keeps greater-than-70 warning boundary", selectContextColorBand(70.1, disabled), "warning");
eq("disabled keeps exact 90 boundary warning", selectContextColorBand(90, disabled), "warning");
eq("disabled keeps greater-than-90 error boundary", selectContextColorBand(90.1, disabled), "error");
eq("disabled unknown percent is uncolored", selectContextColorBand(undefined, disabled), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
