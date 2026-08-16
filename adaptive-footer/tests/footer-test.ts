import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import {
	aggregateSessionUsage,
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
	fitFooterLayout,
	fitRepositoryLayout,
	styleFooterSpans,
	styleRepositorySpans,
	type FooterComponent,
	type FittedRepositoryLayout,
} from "../layout.ts";

const classes = [
	{ windowMax: 300_000, thresholdPercent: 90 },
	{ windowMax: 500_000, thresholdPercent: 70 },
];
const enabled = { enabled: true, classes, default: { thresholdTokens: 400_000 } };
const disabled = { enabled: false, classes, default: { thresholdTokens: 400_000 } };

describe("compactTargetVariants", () => {
	it("compact target shows progress toward the resolved token point", () => {
		assert.deepStrictEqual(compactTargetVariants(enabled, 372_000, 140_000), {
			full: "compact @260k 54%",
			compact: "C54%",
		});
	});

	it("compact target shows progress when pi may compact first", () => {
		assert.deepStrictEqual(compactTargetVariants(enabled, 128_000, 100_000), {
			full: "compact @115k 87%",
			compact: "C87%",
		});
	});

	it("compact target uses the token default for large windows", () => {
		assert.deepStrictEqual(compactTargetVariants(enabled, 1_000_000, 200_000), {
			full: "compact @400k 50%",
			compact: "C50%",
		});
	});

	it("unknown progress preserves the resolved token point", () => {
		assert.deepStrictEqual(compactTargetVariants(enabled, 372_000), {
			full: "compact @260k",
			compact: "C@260k",
		});
	});

	it("disabled compact target is absent", () => {
		assert.strictEqual(compactTargetVariants(disabled, 372_000, 140_000), undefined);
	});

	it("zero-window compact target is absent", () => {
		assert.strictEqual(compactTargetVariants(enabled, 0, 140_000), undefined);
	});

	it("unknown-window compact target is absent", () => {
		assert.strictEqual(compactTargetVariants(enabled, undefined, 140_000), undefined);
	});

	it("paused compact target replaces progress with the paused marker", () => {
		assert.deepStrictEqual(compactTargetVariants(enabled, 372_000, 140_000, true), {
			full: "compact ⏸",
			compact: "C⏸",
		});
	});

	it("paused disabled compact target stays absent", () => {
		assert.strictEqual(compactTargetVariants(disabled, 372_000, 140_000, true), undefined);
	});
});

describe("selectContextColorBand", () => {
	it("enabled warning lower bound is inclusive", () => {
		assert.strictEqual(selectContextColorBand(60, enabled, 372_000), "warning");
	});

	it("enabled threshold is error", () => {
		assert.strictEqual(selectContextColorBand(70, enabled, 372_000), "error");
	});

	it("below the warning band is uncolored", () => {
		assert.strictEqual(selectContextColorBand(59.9, enabled, 372_000), undefined);
	});

	it("enabled unknown percent is uncolored", () => {
		assert.strictEqual(selectContextColorBand(undefined, enabled, 372_000), undefined);
	});

	it("configured error band is independent of pi's native point", () => {
		assert.strictEqual(selectContextColorBand(90, enabled, 128_000), "error");
	});

	it("configured warning band is independent of pi's native point", () => {
		assert.strictEqual(selectContextColorBand(80, enabled, 128_000), "warning");
	});

	it("configured band stays uncolored below the margin", () => {
		assert.strictEqual(selectContextColorBand(79.9, enabled, 128_000), undefined);
	});

	it("unknown window falls back to static bands", () => {
		assert.strictEqual(selectContextColorBand(80, enabled, 0), "warning");
	});

	it("disabled keeps exact 70 boundary uncolored", () => {
		assert.strictEqual(selectContextColorBand(70, disabled, 372_000), undefined);
	});

	it("disabled keeps greater-than-70 warning boundary", () => {
		assert.strictEqual(selectContextColorBand(70.1, disabled, 372_000), "warning");
	});

	it("disabled keeps greater-than-90 error boundary", () => {
		assert.strictEqual(selectContextColorBand(90.1, disabled, 372_000), "error");
	});

	it("paused falls back to the static bands", () => {
		assert.strictEqual(selectContextColorBand(70, enabled, 372_000, true), undefined);
	});

	it("paused keeps the static warning boundary", () => {
		assert.strictEqual(selectContextColorBand(70.1, enabled, 372_000, true), "warning");
	});
});

describe("tokenFlowVariants", () => {
	it("token flow has no shorter representation", () => {
		assert.deepStrictEqual(tokenFlowVariants(305_000, 31_000), {
			full: "↑305k ↓31k",
			compact: "↑305k ↓31k",
		});
	});

	it("empty token flow is absent", () => {
		assert.strictEqual(tokenFlowVariants(0, 0), undefined);
	});
});

describe("cacheVariants", () => {
	it("cache full adds hit rate and compact keeps read/write", () => {
		assert.deepStrictEqual(cacheVariants(5_400_000, 120_000, 99), {
			full: "R5.4M W120k CH99%",
			compact: "R5.4M W120k",
		});
	});

	it("cache omits zero writes", () => {
		assert.deepStrictEqual(cacheVariants(5_400_000, 0, 99), {
			full: "R5.4M CH99%",
			compact: "R5.4M",
		});
	});

	it("empty cache is absent", () => {
		assert.strictEqual(cacheVariants(0, 0, undefined), undefined);
	});
});

describe("costVariants", () => {
	it("subscription cost compacts to billing mode", () => {
		assert.deepStrictEqual(costVariants(5.179, true), {
			full: "$5.179 (sub)",
			compact: "(sub)",
		});
	});

	it("zero subscription cost still shows subscription mode", () => {
		assert.deepStrictEqual(costVariants(0, true), {
			full: "$0.000 (sub)",
			compact: "(sub)",
		});
	});

	it("metered cost compacts precision", () => {
		assert.deepStrictEqual(costVariants(5.179, false), {
			full: "$5.179",
			compact: "$5.18",
		});
	});

	it("empty metered cost is absent", () => {
		assert.strictEqual(costVariants(0, false), undefined);
	});
});

describe("contextVariants", () => {
	it("context compact form drops percentage", () => {
		assert.deepStrictEqual(contextVariants(51, 140_000, 272_000), {
			full: "51% 140k/272k",
			compact: "140k/272k",
		});
	});

	it("unknown context remains explicit", () => {
		assert.deepStrictEqual(contextVariants(undefined, undefined, 272_000), {
			full: "? ?/272k",
			compact: "?/272k",
		});
	});

	it("unknown window remains explicit", () => {
		assert.deepStrictEqual(contextVariants(51, 140_000, undefined), {
			full: "51% 140k/?",
			compact: "140k/?",
		});
	});

	it("zero window is treated as unknown", () => {
		assert.deepStrictEqual(contextVariants(undefined, undefined, 0), {
			full: "? ?/?",
			compact: "?/?",
		});
	});
});

describe("runtimeIdentityVariants", () => {
	it("runtime compact form shortens fast and drops provider", () => {
		assert.deepStrictEqual(runtimeIdentityVariants("gpt-5.6-sol", "xhigh", "openai-codex", true), {
			full: "(openai-codex) gpt-5.6-sol • fast • xhigh",
			compact: "gpt-5.6-sol • f • xhigh",
		});
	});

	it("runtime without fast keeps the existing identity", () => {
		assert.deepStrictEqual(runtimeIdentityVariants("gpt-5.6-sol", "xhigh", undefined), {
			full: "gpt-5.6-sol • xhigh",
			compact: "gpt-5.6-sol • xhigh",
		});
	});

	it("runtime fast mode has no dangling thinking separator", () => {
		assert.deepStrictEqual(runtimeIdentityVariants("gpt-5.6-sol", undefined, undefined, true), {
			full: "gpt-5.6-sol • fast",
			compact: "gpt-5.6-sol • f",
		});
	});
});

describe("partitionFooterStatuses", () => {
	it("owned statuses are removed from the generic line", () => {
		assert.deepStrictEqual(partitionFooterStatuses(new Map([
			["z-status", "  zeta\nvalue  "],
			["elapsed-time", "  ◷ 00:42  "],
			["fast-openai", "on"],
			["auto-compact", "auto-compact paused"],
			["a-status", "alpha\tvalue"],
		])), {
			elapsedTime: "◷ 00:42",
			fastMode: true,
			autoCompactPaused: true,
			statusLine: "alpha value zeta value",
		});
	});

	it("elapsed alone does not create a third line or fast mode", () => {
		assert.deepStrictEqual(partitionFooterStatuses(new Map([
			["elapsed-time", "✓ 00:42"],
		])), {
			elapsedTime: "✓ 00:42",
			fastMode: false,
			autoCompactPaused: false,
			statusLine: undefined,
		});
	});

	it("published fast-openai off stays owned without lighting fast mode", () => {
		assert.deepStrictEqual(partitionFooterStatuses(new Map([
			["fast-openai", "off"],
		])), {
			elapsedTime: undefined,
			fastMode: false,
			autoCompactPaused: false,
			statusLine: undefined,
		});
	});
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

describe("aggregateSessionUsage", () => {
	it("session usage counts assistant, tool-result, compaction, and branch-summary usage", () => {
		const usageEntries = [
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", usage: usage(100, 50, 400, 25, 0.5) } },
			{ type: "message", message: { role: "toolResult", usage: usage(10, 5, 0, 0, 0.25) } },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "compaction", usage: usage(1000, 200, 0, 0, 0.125) },
			{ type: "branch_summary", usage: usage(500, 100, 0, 0, 0.0625) },
			{ type: "model_change" },
			{ type: "message", message: { role: "assistant", usage: usage(30, 20, 90, 0, 0.5) } },
		] as unknown as Parameters<typeof aggregateSessionUsage>[0];
		assert.deepStrictEqual(aggregateSessionUsage(usageEntries), {
			input: 1640,
			output: 375,
			cacheRead: 490,
			cacheWrite: 25,
			cost: 1.4375,
			latestCacheHitRate: 75,
		});
	});

	it("empty session usage is all zeros", () => {
		assert.deepStrictEqual(aggregateSessionUsage([]), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: undefined,
		});
	});
});

const components: FooterComponent[] = [
	{ id: "token-flow", alignment: "left", full: "n", compact: "n" },
	{ id: "cache", alignment: "left", full: "cache-full", compact: "k" },
	{ id: "cost", alignment: "left", full: "cost-full", compact: "c" },
	{ id: "context", alignment: "left", full: "context-full", compact: "x" },
	{ id: "compact-target", alignment: "left", full: "target-full", compact: "t" },
	{ id: "elapsed", alignment: "right", full: "e", compact: "e" },
	{ id: "runtime-identity", alignment: "right", full: "runtime-full", compact: "r" },
];

describe("fitFooterLayout", () => {
	const wide = fitFooterLayout(components, 100);
	const exactFullWidth = visibleWidth(wide.left) + 2 + visibleWidth(wide.right);
	const costCompacted = fitFooterLayout(components, exactFullWidth - 1);
	const afterCostWidth = visibleWidth(costCompacted.left) + 2 + visibleWidth(costCompacted.right);
	const targetCompacted = fitFooterLayout(components, afterCostWidth - 1);
	const afterTargetWidth = visibleWidth(targetCompacted.left) + 2 + visibleWidth(targetCompacted.right);
	const cacheCompacted = fitFooterLayout(components, afterTargetWidth - 1);
	const allCompactWidth = visibleWidth("n • k • c • x • t") + 2 + visibleWidth("e • r");
	const costHidden = fitFooterLayout(components, allCompactWidth - 1);

	it("wide layout preserves visual order on the left", () => {
		assert.strictEqual(wide.left, "n • cache-full • cost-full • context-full • target-full");
	});

	it("elapsed is immediately left of runtime identity", () => {
		assert.strictEqual(wide.right, "e • runtime-full");
	});

	it("wide layout keeps every component full", () => {
		assert.deepStrictEqual(Object.values(wide.states), [
			"full", "full", "full", "full", "full", "full", "full",
		]);
	});

	it("runtime identity is right aligned", () => {
		assert.strictEqual(wide.line.endsWith("e • runtime-full"), true);
	});

	it("fitted two-sided line occupies the available width", () => {
		assert.strictEqual(visibleWidth(wide.line), 100);
	});

	it("first overflow compacts lowest-priority cost", () => {
		assert.strictEqual(costCompacted.states.cost, "compact");
	});

	it("first overflow leaves the next priority full", () => {
		assert.strictEqual(costCompacted.states["compact-target"], "full");
	});

	it("next overflow compacts the target", () => {
		assert.strictEqual(targetCompacted.states["compact-target"], "compact");
	});

	it("elapsed remains full after target compaction", () => {
		assert.strictEqual(targetCompacted.states.elapsed, "full");
	});

	it("no-op elapsed and token reductions continue to cache", () => {
		assert.strictEqual(cacheCompacted.states.cache, "compact");
	});

	it("elapsed still transitions through compact state", () => {
		assert.strictEqual(cacheCompacted.states.elapsed, "compact");
	});

	it("token flow still transitions through compact state", () => {
		assert.strictEqual(cacheCompacted.states["token-flow"], "compact");
	});

	it("second sweep hides cost first", () => {
		assert.strictEqual(costHidden.states.cost, "hidden");
	});

	it("hiding a middle component rejoins its neighbors", () => {
		assert.strictEqual(costHidden.left, "n • k • x • t");
	});

	it("higher-priority compact components remain visible", () => {
		assert.strictEqual(costHidden.right, "e • r");
	});

	it("layout never overflows from width 0 through 120", () => {
		for (let width = 0; width <= 120; width++) {
			assert.ok(
				visibleWidth(fitFooterLayout(components, width).line) <= width,
				`layout width ${width} never overflows`,
			);
		}
	});

	it("extreme width can hide every component", () => {
		assert.strictEqual(fitFooterLayout(components, 0).line, "");
	});

	it("a wider rerender restores full variants", () => {
		assert.strictEqual(fitFooterLayout(components, 100).states.cost, "full");
	});
});

describe("styleFooterSpans", () => {
	const wide = fitFooterLayout(components, 100);
	const styledWide = styleFooterSpans(
		wide.spans,
		(text) => `\x1b[90m${text}\x1b[39m`,
		(id, text) => id === "context"
			? `\x1b[31m${text}\x1b[39m`
			: `\x1b[90m${text}\x1b[39m`,
	);

	it("separator after colored context reapplies dim styling", () => {
		assert.ok(styledWide.includes("\x1b[31mcontext-full\x1b[39m\x1b[90m • \x1b[39m"));
	});

	it("right-side content remains explicitly dim after colored context", () => {
		assert.ok(styledWide.includes("\x1b[90me\x1b[39m\x1b[90m • \x1b[39m\x1b[90mruntime-full\x1b[39m"));
	});

	it("styling spans preserves terminal width", () => {
		assert.strictEqual(visibleWidth(styledWide), 100);
	});
});

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

describe("fitRepositoryLayout", () => {
	const repositoryFull = fitRepositoryLayout(repositoryInput, 200);
	const repositoryStages = [
		"cwd-compact",
		"session-hidden",
		"issue-compact",
		"pr-compact",
		"issue-hidden",
		"pr-hidden",
	] as const;
	const layoutsByStage = new Map<string, FittedRepositoryLayout>();
	let previousRepositoryLayout = repositoryFull;
	for (const stage of repositoryStages) {
		previousRepositoryLayout = fitRepositoryLayout(
			repositoryInput,
			repositoryRequiredWidth(previousRepositoryLayout) - 1,
		);
		layoutsByStage.set(stage, previousRepositoryLayout);
	}
	const branchOnly = fitRepositoryLayout(repositoryInput, 5);

	it("repository context puts cwd before session", () => {
		assert.strictEqual(repositoryFull.left, "~/Code/acme/payments/main • footer links");
	});

	it("repository context puts issue and PR before branch", () => {
		assert.strictEqual(repositoryFull.right, "is#456 c • pr#123 m • feature/issue-456");
	});

	it("wide repository context uses full forms", () => {
		assert.strictEqual(repositoryFull.stage, "full");
	});

	it("each width reduction advances one stage", () => {
		for (const stage of repositoryStages) {
			assert.strictEqual(layoutsByStage.get(stage)?.stage, stage, `repository reduction advances to ${stage}`);
		}
	});

	it("compact issue label is lowercase and omits state", () => {
		assert.strictEqual(layoutsByStage.get("issue-compact")?.right, "i456 • pr#123 m • feature/issue-456");
	});

	it("repository layout never overflows from width 0 through 200", () => {
		const repositoryOverflowWidth = Array.from({ length: 201 }, (_, width) => width)
			.find((width) => visibleWidth(fitRepositoryLayout(repositoryInput, width).line) > width);
		assert.strictEqual(repositoryOverflowWidth, undefined);
	});

	it("branch survives when only one local chunk can remain", () => {
		assert.strictEqual(branchOnly.stage, "branch-only");
	});

	it("branch-only extreme uses the branch prefix", () => {
		assert.strictEqual(branchOnly.right, "feat…");
	});
});

describe("styleRepositorySpans", () => {
	const repositoryFull = fitRepositoryLayout(repositoryInput, 200);
	const styledRepository = styleRepositorySpans(
		repositoryFull.spans,
		(text) => `\x1b[2m${text}\x1b[22m`,
		(text, url) => hyperlink(`\x1b[4;36m${text}\x1b[24;39m`, url),
	);

	it("repository styling preserves fitted terminal width", () => {
		assert.strictEqual(visibleWidth(styledRepository), 200);
	});

	it("issue token carries its canonical OSC 8 URL", () => {
		assert.ok(styledRepository.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\\x1b[4;36mis#456 c"));
	});

	it("PR token carries its canonical OSC 8 URL", () => {
		assert.ok(styledRepository.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\\x1b[4;36mpr#123 m"));
	});
});

describe("cwdVariants", () => {
	it("home shortening requires a path boundary", () => {
		assert.strictEqual(cwdVariants("/Users/developer/project", "/Users/dev").full, "/Users/developer/project");
	});

	it("compact cwd keeps the final two path components", () => {
		assert.strictEqual(cwdVariants("/a/b/c/d", undefined).compact, "…/c/d");
	});
});
