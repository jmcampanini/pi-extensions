import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
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
	cwdVariants,
	DISPLAY_ORDER,
	fitFooterLayout,
	fitRepositoryLayout,
	REDUCTION_ORDER,
	styleFooterSpans,
	styleRepositorySpans,
	type FooterComponent,
	type FittedRepositoryLayout,
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

const classes = [
	{ windowMax: 300_000, thresholdPercent: 90 },
	{ windowMax: 500_000, thresholdPercent: 70 },
];
const enabled = { enabled: true, classes, default: { thresholdTokens: 400_000 } };
const disabled = { enabled: false, classes, default: { thresholdTokens: 400_000 } };

eq("compact target shows progress toward the resolved token point", compactTargetVariants(enabled, 372_000, 140_000), {
	full: "compact @260k 54%",
	compact: "C54%",
});
eq("compact target shows progress when pi may compact first", compactTargetVariants(enabled, 128_000, 100_000), {
	full: "compact @115k 87%",
	compact: "C87%",
});
eq("compact target uses the token default for large windows", compactTargetVariants(enabled, 1_000_000, 200_000), {
	full: "compact @400k 50%",
	compact: "C50%",
});
eq("unknown progress preserves the resolved token point", compactTargetVariants(enabled, 372_000), {
	full: "compact @260k",
	compact: "C@260k",
});
eq("disabled compact target is absent", compactTargetVariants(disabled, 372_000, 140_000), undefined);
eq("unknown window compact target is absent", compactTargetVariants(enabled, 0, 140_000), undefined);
eq("paused compact target replaces progress with the paused marker", compactTargetVariants(enabled, 372_000, 140_000, true), {
	full: "compact ⏸",
	compact: "C⏸",
});
eq("paused disabled compact target stays absent", compactTargetVariants(disabled, 372_000, 140_000, true), undefined);

eq("enabled warning lower bound is inclusive", selectContextColorBand(60, enabled, 372_000), "warning");
eq("enabled threshold is error", selectContextColorBand(70, enabled, 372_000), "error");
eq("below the warning band is uncolored", selectContextColorBand(59.9, enabled, 372_000), undefined);
eq("enabled unknown percent is uncolored", selectContextColorBand(null, enabled, 372_000), undefined);
eq("configured error band is independent of pi's native point", selectContextColorBand(90, enabled, 128_000), "error");
eq("configured warning band is independent of pi's native point", selectContextColorBand(80, enabled, 128_000), "warning");
eq("configured band stays uncolored below the margin", selectContextColorBand(79.9, enabled, 128_000), undefined);
eq("unknown window falls back to static bands", selectContextColorBand(80, enabled, 0), "warning");
eq("disabled keeps exact 70 boundary uncolored", selectContextColorBand(70, disabled, 372_000), undefined);
eq("disabled keeps greater-than-70 warning boundary", selectContextColorBand(70.1, disabled, 372_000), "warning");
eq("disabled keeps greater-than-90 error boundary", selectContextColorBand(90.1, disabled, 372_000), "error");
eq("paused falls back to the static bands", selectContextColorBand(70, enabled, 372_000, true), undefined);
eq("paused keeps the static warning boundary", selectContextColorBand(70.1, enabled, 372_000, true), "warning");

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

eq("runtime compact form shortens fast and drops provider", runtimeIdentityVariants(
	"gpt-5.6-sol",
	"xhigh",
	"openai-codex",
	true,
), {
	full: "(openai-codex) gpt-5.6-sol • fast • xhigh",
	compact: "gpt-5.6-sol • f • xhigh",
});
eq("runtime without fast keeps the existing identity", runtimeIdentityVariants(
	"gpt-5.6-sol",
	"xhigh",
	undefined,
), {
	full: "gpt-5.6-sol • xhigh",
	compact: "gpt-5.6-sol • xhigh",
});
eq("runtime fast mode has no dangling thinking separator", runtimeIdentityVariants(
	"gpt-5.6-sol",
	undefined,
	undefined,
	true,
), {
	full: "gpt-5.6-sol • fast",
	compact: "gpt-5.6-sol • f",
});

eq("owned statuses are removed from the generic line", partitionFooterStatuses(new Map([
	["z-status", "  zeta\nvalue  "],
	["elapsed-time", "  ◷ 00:42  "],
	["fast-openai", "fast"],
	["auto-compact", "auto-compact paused"],
	["a-status", "alpha\tvalue"],
])), {
	elapsedTime: "◷ 00:42",
	fastMode: true,
	autoCompactPaused: true,
	statusLine: "alpha value zeta value",
});
eq("elapsed alone does not create a third line or fast mode", partitionFooterStatuses(new Map([
	["elapsed-time", "✓ 00:42"],
])), {
	elapsedTime: "✓ 00:42",
	fastMode: false,
	autoCompactPaused: false,
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

const repositoryInput = {
	cwd: cwdVariants("/Users/dev/Code/acme/payments/main", "/Users/dev"),
	session: "footer links",
	branch: "feature/issue-456",
	context: {
		issue: { number: 456, url: "https://git.acme.test/acme/payments/issues/456", state: "c" as const },
		pr: { number: 123, url: "https://git.acme.test/acme/payments/pull/123", state: "m" as const },
	},
};

function repositoryRequiredWidth(layout: FittedRepositoryLayout): number {
	return visibleWidth(layout.left) + visibleWidth(layout.right) + (layout.left && layout.right ? 2 : 0);
}

const repositoryFull = fitRepositoryLayout(repositoryInput, 200);
eq("repository context puts cwd before session", repositoryFull.left,
	"~/Code/acme/payments/main • footer links");
eq("repository context puts issue and PR before branch", repositoryFull.right,
	"is#456 c • pr#123 m • feature/issue-456");
eq("wide repository context uses full forms", repositoryFull.stage, "full");

const repositoryStages = [
	"cwd-compact",
	"session-hidden",
	"issue-compact",
	"pr-compact",
	"issue-hidden",
	"pr-hidden",
] as const;
let previousRepositoryLayout = repositoryFull;
let issueCompactLayout: FittedRepositoryLayout | undefined;
for (const stage of repositoryStages) {
	const layout = fitRepositoryLayout(repositoryInput, repositoryRequiredWidth(previousRepositoryLayout) - 1);
	eq(`repository reduction advances to ${stage}`, layout.stage, stage);
	if (stage === "issue-compact") issueCompactLayout = layout;
	previousRepositoryLayout = layout;
}
eq("compact issue label is lowercase and omits state", issueCompactLayout?.right,
	"i456 • pr#123 m • feature/issue-456");

const repositoryOverflowWidth = Array.from({ length: 201 }, (_, width) => width)
	.find((width) => visibleWidth(fitRepositoryLayout(repositoryInput, width).line) > width);
eq("repository layout never overflows from width 0 through 200", repositoryOverflowWidth, undefined);
const branchOnly = fitRepositoryLayout(repositoryInput, 5);
eq("branch survives when only one local chunk can remain", branchOnly.stage, "branch-only");
eq("branch-only extreme uses the branch prefix", branchOnly.right, "feat…");

const styledRepository = styleRepositorySpans(
	repositoryFull.spans,
	(text) => `\x1b[2m${text}\x1b[22m`,
	(text, url) => hyperlink(`\x1b[4;36m${text}\x1b[24;39m`, url),
);
eq("repository styling preserves fitted terminal width", visibleWidth(styledRepository), 200);
ok("issue token carries its canonical OSC 8 URL",
	styledRepository.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\\x1b[4;36mis#456 c"));
ok("PR token carries its canonical OSC 8 URL",
	styledRepository.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\\x1b[4;36mpr#123 m"));

eq("home shortening requires a path boundary", cwdVariants("/Users/developer/project", "/Users/dev").full,
	"/Users/developer/project");
eq("compact cwd keeps the final two path components", cwdVariants("/a/b/c/d", undefined).compact, "…/c/d");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
