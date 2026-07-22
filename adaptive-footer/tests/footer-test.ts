import { visibleWidth } from "@earendil-works/pi-tui";
import {
	cacheVariants,
	compactTargetVariants,
	contextVariants,
	costVariants,
	partitionFooterStatuses,
	runtimeIdentityVariants,
	selectContextColorBand,
	tokenFlowVariants,
} from "../index.ts";
import {
	DISPLAY_ORDER,
	fitFooterLayout,
	REDUCTION_ORDER,
	styleFooterSpans,
	type FooterComponent,
} from "../layout.ts";

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

function ok(label: string, condition: boolean): void {
	if (condition) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}`);
	}
}

const enabled = { enabled: true, thresholdPercent: 70 };
const disabled = { enabled: false, thresholdPercent: 85 };

eq("compact target variants", compactTargetVariants(enabled), {
	full: "compact @70%",
	compact: "C@70%",
});
eq("disabled compact target is absent", compactTargetVariants(disabled), undefined);
eq("enabled warning lower bound is inclusive", selectContextColorBand(60, enabled), "warning");
eq("enabled threshold is error", selectContextColorBand(70, enabled), "error");
eq("enabled unknown percent is uncolored", selectContextColorBand(null, enabled), undefined);
eq("disabled keeps exact 70 boundary uncolored", selectContextColorBand(70, disabled), undefined);
eq("disabled keeps greater-than-70 warning boundary", selectContextColorBand(70.1, disabled), "warning");
eq("disabled keeps greater-than-90 error boundary", selectContextColorBand(90.1, disabled), "error");

eq("token flow has no shorter representation", tokenFlowVariants(305_000, 31_000), {
	full: "↑305k ↓31k",
	compact: "↑305k ↓31k",
});
eq("empty token flow is absent", tokenFlowVariants(0, 0), undefined);

eq("cache full adds hit rate and compact keeps read/write", cacheVariants(5_400_000, 120_000, 99), {
	full: "R5.4M W120k CH99%",
	compact: "R5.4M W120k",
});
eq("cache omits zero writes", cacheVariants(5_400_000, 0, 99), {
	full: "R5.4M CH99%",
	compact: "R5.4M",
});
eq("empty cache is absent", cacheVariants(0, 0, undefined), undefined);

eq("subscription cost compacts to billing mode", costVariants(5.179, true), {
	full: "$5.179 (sub)",
	compact: "(sub)",
});
eq("zero subscription cost still shows subscription mode", costVariants(0, true), {
	full: "$0.000 (sub)",
	compact: "(sub)",
});
eq("metered cost compacts precision", costVariants(5.179, false), {
	full: "$5.179",
	compact: "$5.18",
});
eq("empty metered cost is absent", costVariants(0, false), undefined);

eq("context compact form drops percentage", contextVariants(51, 140_000, 272_000), {
	full: "51% 140k/272k",
	compact: "140k/272k",
});
eq("unknown context remains explicit", contextVariants(null, null, 272_000), {
	full: "? ?/272k",
	compact: "?/272k",
});

eq("runtime compact form drops provider", runtimeIdentityVariants("gpt-5.6-sol", "xhigh", "openai-codex"), {
	full: "(openai-codex) gpt-5.6-sol • xhigh",
	compact: "gpt-5.6-sol • xhigh",
});
eq("runtime without provider has equal variants", runtimeIdentityVariants("gpt-5.6-sol", "xhigh", undefined), {
	full: "gpt-5.6-sol • xhigh",
	compact: "gpt-5.6-sol • xhigh",
});

eq("elapsed is removed from generic statuses", partitionFooterStatuses(new Map([
	["z-status", "  zeta\nvalue  "],
	["elapsed-time", "  ◷ 00:42  "],
	["a-status", "alpha\tvalue"],
])), {
	elapsedTime: "◷ 00:42",
	statusLine: "alpha value zeta value",
});
eq("elapsed alone does not create a third line", partitionFooterStatuses(new Map([
	["elapsed-time", "✓ 00:42"],
])), {
	elapsedTime: "✓ 00:42",
	statusLine: undefined,
});

eq("display order is independent from priority", DISPLAY_ORDER, [
	"token-flow",
	"cache",
	"cost",
	"context",
	"compact-target",
	"elapsed",
	"runtime-identity",
]);
eq("reduction priority is lowest to highest", REDUCTION_ORDER, [
	"cost",
	"compact-target",
	"elapsed",
	"token-flow",
	"cache",
	"context",
	"runtime-identity",
]);

const components: FooterComponent[] = [
	{ id: "token-flow", alignment: "left", full: "n", compact: "n" },
	{ id: "cache", alignment: "left", full: "cache-full", compact: "k" },
	{ id: "cost", alignment: "left", full: "cost-full", compact: "c" },
	{ id: "context", alignment: "left", full: "context-full", compact: "x" },
	{ id: "compact-target", alignment: "left", full: "target-full", compact: "t" },
	{ id: "elapsed", alignment: "right", full: "e", compact: "e" },
	{ id: "runtime-identity", alignment: "right", full: "runtime-full", compact: "r" },
];

const wide = fitFooterLayout(components, 100);
eq("wide layout preserves visual order on the left", wide.left,
	"n • cache-full • cost-full • context-full • target-full");
eq("elapsed is immediately left of runtime identity", wide.right, "e • runtime-full");
eq("wide layout keeps every component full", Object.values(wide.states), [
	"full", "full", "full", "full", "full", "full", "full",
]);
eq("runtime identity is right aligned", wide.line.endsWith("e • runtime-full"), true);
eq("fitted two-sided line occupies the available width", visibleWidth(wide.line), 100);
const styledWide = styleFooterSpans(
	wide.spans,
	(text) => `\x1b[90m${text}\x1b[39m`,
	(id, text) => id === "context"
		? `\x1b[31m${text}\x1b[39m`
		: `\x1b[90m${text}\x1b[39m`,
);
ok("separator after colored context reapplies dim styling",
	styledWide.includes("\x1b[31mcontext-full\x1b[39m\x1b[90m • \x1b[39m"));
ok("right-side content remains explicitly dim after colored context",
	styledWide.includes("\x1b[90me\x1b[39m\x1b[90m • \x1b[39m\x1b[90mruntime-full\x1b[39m"));
eq("styling spans preserves terminal width", visibleWidth(styledWide), 100);

const exactFullWidth = visibleWidth(wide.left) + 2 + visibleWidth(wide.right);
const costCompacted = fitFooterLayout(components, exactFullWidth - 1);
eq("first overflow compacts lowest-priority cost", costCompacted.states.cost, "compact");
eq("first overflow leaves the next priority full", costCompacted.states["compact-target"], "full");

const afterCostWidth = visibleWidth(costCompacted.left) + 2 + visibleWidth(costCompacted.right);
const targetCompacted = fitFooterLayout(components, afterCostWidth - 1);
eq("next overflow compacts the target", targetCompacted.states["compact-target"], "compact");
eq("elapsed remains full after target compaction", targetCompacted.states.elapsed, "full");

const afterTargetWidth = visibleWidth(targetCompacted.left) + 2 + visibleWidth(targetCompacted.right);
const cacheCompacted = fitFooterLayout(components, afterTargetWidth - 1);
eq("no-op elapsed and token reductions continue to cache", cacheCompacted.states.cache, "compact");
eq("elapsed still transitions through compact state", cacheCompacted.states.elapsed, "compact");
eq("token flow still transitions through compact state", cacheCompacted.states["token-flow"], "compact");

const allCompactWidth = visibleWidth("n • k • c • x • t") + 2 + visibleWidth("e • r");
const costHidden = fitFooterLayout(components, allCompactWidth - 1);
eq("second sweep hides cost first", costHidden.states.cost, "hidden");
eq("hiding a middle component rejoins its neighbors", costHidden.left, "n • k • x • t");
eq("higher-priority compact components remain visible", costHidden.right, "e • r");

for (let width = 0; width <= 120; width++) {
	ok(`layout width ${width} never overflows`, visibleWidth(fitFooterLayout(components, width).line) <= width);
}

eq("extreme width can hide every component", fitFooterLayout(components, 0).line, "");
eq("a wider rerender restores full variants", fitFooterLayout(components, 100).states.cost, "full");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
