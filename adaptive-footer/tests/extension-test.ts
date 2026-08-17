import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepositoryContextDiscovery } from "../repository-context.ts";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "adaptive-footer-extension-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = testRoot;
process.env.HOME = "/Users/dev";
const { registerAdaptiveFooter } = await import("../index.ts");

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(testRoot, { recursive: true, force: true });
});

interface FakeContext {
	hasUI: boolean;
	ui: {
		setFooter(factory: FooterFactory): void;
	};
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): unknown[];
	};
	model: undefined;
	modelRegistry: {
		isUsingOAuth(): boolean;
	};
	getContextUsage(): {
		percent: number;
		tokens: number;
		contextWindow: number;
	};
}

interface FakeTui {
	requestRender(): void;
}

interface FakeTheme {
	fg(color: string, text: string): string;
	underline(text: string): string;
}

interface FakeFooterData {
	getGitBranch(): string;
	onBranchChange(callback: () => void): () => void;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
}

interface FooterComponent {
	dispose(): void;
	invalidate(): void;
	render(width: number): string[];
}

type FooterFactory = (tui: FakeTui, theme: FakeTheme, footerData: FakeFooterData) => FooterComponent;
function plain(line: string): string {
	return line
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("registerAdaptiveFooter", () => {
	it("wires discovery, rendering, refresh, and disposal through the pi footer", async () => {
		const events = createTestEventHarness<unknown, FakeContext, unknown>();
		let footerFactory: FooterFactory | undefined;
		const fakePi = {
			on: events.on,
			getThinkingLevel(): string {
				return "xhigh";
			},
		} as unknown as ExtensionAPI;

		let discoveryCalls = 0;
		const discover: RepositoryContextDiscovery = async ({ branch }) => {
			discoveryCalls++;
			const issueNumber = branch?.includes("789") ? 789 : 456;
			return {
				issue: {
					number: issueNumber,
					url: `https://git.acme.test/acme/payments/issues/${issueNumber}`,
					state: "o",
				},
				pr: {
					number: 123,
					url: "https://git.acme.test/acme/payments/pull/123",
					state: "d",
				},
			};
		};
		let nowMs = 0;
		registerAdaptiveFooter(fakePi, { issuePatterns: [], discover, now: () => nowMs });

		const context: FakeContext = {
			hasUI: true,
			ui: {
				setFooter(factory) {
					footerFactory = factory;
				},
			},
			sessionManager: {
				getCwd: () => "/Users/dev/Code/acme/payments/main",
				getSessionName: () => "footer links",
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 305_000, output: 31_000, cacheRead: 0, cacheWrite: 0, cost: { total: 5.179 } },
						},
					},
				],
			},
			model: undefined,
			modelRegistry: {
				isUsingOAuth: () => false,
			},
			getContextUsage: () => ({ percent: 51, tokens: 140_000, contextWindow: 272_000 }),
		};
		await events.emitAsync("session_start", { type: "session_start", reason: "startup" }, context);
		assert.ok(footerFactory, "session_start did not install the footer");

		let branch = "feature/issue-456";
		let branchChanged: (() => void) | undefined;
		let unsubscribed = 0;
		let renders = 0;
		let extensionStatuses = new Map([["fast-openai", "on"]]);
		const component = footerFactory(
			{ requestRender: () => renders++ },
			{
				fg: (color, text) => color === "accent"
					? `\x1b[36m${text}\x1b[39m`
					: `\x1b[2m${text}\x1b[22m`,
				underline: (text) => `\x1b[4m${text}\x1b[24m`,
			},
			{
				getGitBranch: () => branch,
				onBranchChange(callback) {
					branchChanged = callback;
					return () => unsubscribed++;
				},
				getExtensionStatuses: () => extensionStatuses,
				getAvailableProviderCount: () => 1,
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const initialRender = component.render(120);
		const initialLine = initialRender[0] ?? "";
		const initialStats = plain(initialRender[1] ?? "").trimStart().split(/ {2,}/)[0];
		assert.ok(renders > 0, "startup discovery requests a footer rerender");
		assert.strictEqual(discoveryCalls, 1, "startup discovery runs once");
		assert.strictEqual(plain(initialLine).trimStart().split(/ {2,}/)[0],
			"~/Code/acme/payments/main • footer links",
			"extension render keeps the approved left ordering");
		assert.ok(plain(initialLine).endsWith("is#456 o • pr#123 d • feature/issue-456"),
			"extension render keeps issue, PR, and branch ordering");
		assert.ok(initialLine.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\")
			&& initialLine.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\"),
			"extension render emits clickable issue and PR URLs");
		assert.ok(initialLine.includes("\x1b[36m\x1b[4mis#456 o")
			&& initialLine.includes("\x1b[36m\x1b[4mpr#123 d"),
			"issue and PR links share the underlined accent treatment");
		assert.strictEqual(initialStats,
			"↑305k ↓31k • $5.179 • 51% 140k/272k • compact @245k 57%",
			"extension wires usage totals and context into the stats line");
		assert.ok(plain(initialRender[1] ?? "").endsWith("no-model • fast"),
			"extension places enabled fast mode after the model");
		const responsiveStats = Array.from({ length: 121 }, (_, width) =>
			plain(component.render(width)[1] ?? ""));
		assert.ok(responsiveStats.some((line) => line.includes("C57%")),
			"responsive footer uses compact progress form");
		assert.ok(responsiveStats.some((line) => line.endsWith("no-model • f")),
			"responsive footer shortens fast mode");

		extensionStatuses = new Map([["fast-openai", "on"], ["auto-compact", "auto-compact paused"]]);
		assert.strictEqual(plain(component.render(120)[1] ?? "").trimStart().split(/ {2,}/)[0],
			"↑305k ↓31k • $5.179 • 51% 140k/272k • compact ⏸",
			"published auto-compact pause replaces compact-target progress");
		extensionStatuses = new Map([["fast-openai", "on"]]);

		branch = "feature/issue-789";
		branchChanged?.();
		const invalidatedLine = plain(component.render(120)[0] ?? "");
		assert.ok(!invalidatedLine.includes("is#456") && !invalidatedLine.includes("pr#123"),
			"branch change clears stale remote links synchronously");
		assert.ok(invalidatedLine.endsWith(branch), "branch text updates while remote discovery is pending");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const refreshedLine = plain(component.render(120)[0] ?? "");
		assert.ok(refreshedLine.includes("is#789 o"), "branch refresh installs links for the new branch");
		assert.strictEqual(discoveryCalls, 2, "branch change performs one additional discovery");

		await events.emitAsync("agent_settled", { type: "agent_settled" }, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(discoveryCalls, 2, "settling within the refresh floor skips gh discovery");
		nowMs = 31_000;
		await events.emitAsync("agent_settled", { type: "agent_settled" }, context);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(discoveryCalls, 3, "settling after the refresh floor rediscovers repository context");

		const wiredOverflowWidth = Array.from({ length: 121 }, (_, width) => width)
			.find((width) => visibleWidth(component.render(width)[0] ?? "") > width);
		assert.strictEqual(wiredOverflowWidth, undefined,
			"wired footer line never overflows from width 0 through 120");
		component.dispose();
		assert.strictEqual(unsubscribed, 1, "footer disposal removes the branch subscription");
		await events.emitAsync("session_shutdown", { type: "session_shutdown" }, context);
		assert.strictEqual(unsubscribed, 1,
			"session shutdown does not dispose an already disposed footer twice");
	});
});
