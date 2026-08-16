import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_ISSUE_PATTERNS } from "../config.ts";
import { cwdVariants, fitRepositoryLayout, styleRepositorySpans } from "../layout.ts";
import {
	createRepositoryContextRefresher,
	discoverRepositoryContext,
	inferIssueNumber,
	type CommandRunner,
	type RepositoryContext,
	type RepositoryContextDiscovery,
} from "../repository-context.ts";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const fixture = mkdtempSync(join(sandbox, "adaptive-footer-gh-"));

after(() => {
	rmSync(fixture, { recursive: true, force: true });
});

function jsonRunner(
	pr: unknown,
	issue: unknown,
	calls: string[][] = [],
): CommandRunner {
	return async (_command, args) => {
		calls.push(args);
		return {
			stdout: JSON.stringify(args[0] === "pr" ? pr : issue),
			stderr: "",
			code: 0,
			killed: false,
		};
	};
}

const replacementPatterns = [
	String.raw`ticket-(?<number>[1-9][0-9]*)`,
	String.raw`bug-(?<number>[1-9][0-9]*)`,
];

describe("inferIssueNumber", () => {
	it("branch inference wins over cwd basename", () => {
		assert.strictEqual(inferIssueNumber("feature/ticket-41", "/work/bug-92", replacementPatterns), 41);
	});

	it("pattern order wins within the branch", () => {
		assert.strictEqual(inferIssueNumber("bug-92-ticket-41", "/work/none", replacementPatterns), 41);
	});

	it("cwd basename is the fallback inference source", () => {
		assert.strictEqual(inferIssueNumber("feature/no-ticket", "/work/bug-92", replacementPatterns), 92);
	});

	it("detached HEAD falls back to cwd basename", () => {
		assert.strictEqual(inferIssueNumber("detached", "/work/issue-456", DEFAULT_ISSUE_PATTERNS), 456);
	});

	it("unmarked numbers are not inferred", () => {
		assert.strictEqual(inferIssueNumber("feature/456", "/work/task-92", DEFAULT_ISSUE_PATTERNS), undefined);
	});
});

describe("discoverRepositoryContext", () => {
	function completeDiscovery(calls: string[][] = []): Promise<RepositoryContext> {
		return discoverRepositoryContext(
			jsonRunner(
				{ number: 123, url: "https://github.enterprise/acme/payments/pull/123", state: "MERGED", isDraft: false },
				{ number: 456, url: "https://github.enterprise/acme/payments/issues/456", state: "CLOSED" },
				calls,
			),
			{ cwd: "/work/issue-456", branch: "feature/issue-456", issuePatterns: DEFAULT_ISSUE_PATTERNS },
		);
	}

	it("PR states map to their footer suffixes", async () => {
		for (const [label, state, isDraft, expected] of [
			["open", "OPEN", false, "o"],
			["draft", "OPEN", true, "d"],
			["closed", "CLOSED", false, "c"],
			["merged", "MERGED", false, "m"],
		] as const) {
			const context = await discoverRepositoryContext(
				jsonRunner(
					{ number: 123, url: "https://github.example/acme/payments/pull/123", state, isDraft },
					undefined,
				),
				{ cwd: "/work/payments", branch: "feature/footer", issuePatterns: [] },
			);
			assert.strictEqual(context.pr?.state, expected, `PR ${label} state maps to its footer suffix`);
		}
	});

	it("verified issue preserves its canonical Enterprise URL", async () => {
		const complete = await completeDiscovery();
		assert.deepStrictEqual(complete.issue,
			{ number: 456, url: "https://github.enterprise/acme/payments/issues/456", state: "c" });
	});

	it("current-branch PR preserves its canonical Enterprise URL", async () => {
		const complete = await completeDiscovery();
		assert.deepStrictEqual(complete.pr,
			{ number: 123, url: "https://github.enterprise/acme/payments/pull/123", state: "m" });
	});

	it("PR discovery asks gh for draft-aware state", async () => {
		const commandCalls: string[][] = [];
		await completeDiscovery(commandCalls);
		assert.deepStrictEqual(commandCalls[0], ["pr", "view", "--json", "number,url,state,isDraft"]);
	});

	it("issue verification asks gh for the inferred number", async () => {
		const commandCalls: string[][] = [];
		await completeDiscovery(commandCalls);
		assert.deepStrictEqual(commandCalls[1], ["issue", "view", "456", "--json", "number,url,state"]);
	});

	it("issue verification rejects a mismatched returned number", async () => {
		const mismatchedIssue = await discoverRepositoryContext(
			jsonRunner(undefined, {
				number: 999,
				url: "https://github.example/acme/payments/issues/999",
				state: "OPEN",
			}),
			{ cwd: "/work/issue-456", branch: null, issuePatterns: DEFAULT_ISSUE_PATTERNS },
		);
		assert.strictEqual(mismatchedIssue.issue, undefined);
	});

	it("non-http gh URLs cannot become terminal hyperlinks", async () => {
		const unsafeUrl = await discoverRepositoryContext(
			jsonRunner({ number: 123, url: "file:///etc/passwd", state: "OPEN", isDraft: false }, undefined),
			{ cwd: "/work/payments", branch: "feature/footer", issuePatterns: [] },
		);
		assert.strictEqual(unsafeUrl.pr, undefined);
	});

	it("gh failures produce a clean local-only context", async () => {
		const failedDiscovery = await discoverRepositoryContext(
			async () => {
				throw new Error("gh unavailable");
			},
			{ cwd: "/work/issue-456", branch: "feature/issue-456", issuePatterns: DEFAULT_ISSUE_PATTERNS },
		);
		assert.deepStrictEqual(failedDiscovery, {});
	});

	it("subprocess-backed discovery renders linked issue, PR, and branch at the fitted width", async () => {
		const fakeGh = join(fixture, "gh");
		writeFileSync(fakeGh, `#!/usr/bin/env node
const [kind] = process.argv.slice(2);
if (kind === "pr") process.stdout.write(JSON.stringify({number:123,url:"https://git.acme.test/acme/payments/pull/123",state:"OPEN",isDraft:true}));
else process.stdout.write(JSON.stringify({number:456,url:"https://git.acme.test/acme/payments/issues/456",state:"OPEN"}));
`);
		chmodSync(fakeGh, 0o755);
		const processRunner: CommandRunner = (_command, args, options) => new Promise((resolve, reject) => {
			execFile(fakeGh, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout, stderr) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({ stdout, stderr, code: 0, killed: false });
			});
		});
		const processContext = await discoverRepositoryContext(
			processRunner,
			{ cwd: fixture, branch: "feature/issue-456", issuePatterns: DEFAULT_ISSUE_PATTERNS },
		);
		const endToEndLayout = fitRepositoryLayout({
			cwd: cwdVariants("/Users/dev/Code/acme/payments/main", "/Users/dev"),
			session: "footer links",
			branch: "feature/issue-456",
			context: processContext,
		}, 120);
		const endToEndLine = styleRepositorySpans(
			endToEndLayout.spans,
			(text) => text,
			(text, url) => hyperlink(`\x1b[4m${text}\x1b[24m`, url),
		);
		assert.strictEqual(endToEndLayout.right, "is#456 o • pr#123 d • feature/issue-456",
			"subprocess-backed discovery renders issue, PR, then branch");
		assert.ok(endToEndLine.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\"),
			"subprocess-backed issue URL reaches OSC 8 output");
		assert.ok(endToEndLine.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\"),
			"subprocess-backed PR URL reaches OSC 8 output");
		assert.strictEqual(visibleWidth(endToEndLine), 120,
			"subprocess-backed styled output retains its fitted width");
	});
});

describe("createRepositoryContextRefresher", () => {
	it("coalesces overlapping refreshes and drops stale results", async () => {
		let branch = "first";
		let discoveryCalls = 0;
		const pending: Array<(context: RepositoryContext) => void> = [];
		const deferredDiscovery: RepositoryContextDiscovery = () => {
			discoveryCalls++;
			return new Promise((resolve) => pending.push(resolve));
		};
		let changes = 0;
		const refresher = createRepositoryContextRefresher(
			() => ({ cwd: "/work/payments", branch, issuePatterns: [] }),
			deferredDiscovery,
			() => changes++,
		);
		const firstRefresh = refresher.refresh();
		branch = "second";
		const secondRefresh = refresher.refresh();
		assert.strictEqual(discoveryCalls, 1, "overlapping refresh requests share one in-flight discovery");
		pending.shift()?.({ pr: { number: 1, url: "https://example.test/pull/1", state: "o" } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(discoveryCalls, 2, "a queued refresh starts after the in-flight lookup");
		pending.shift()?.({ pr: { number: 2, url: "https://example.test/pull/2", state: "o" } });
		await Promise.all([firstRefresh, secondRefresh]);
		assert.strictEqual(refresher.get().pr?.number, 2,
			"stale discovery results never replace the latest context");
		assert.strictEqual(changes, 1, "coalesced discovery renders only the latest result");
		refresher.dispose();
	});

	it("refreshIfStale rediscovers only at or past the staleness floor", async () => {
		let clockMs = 0;
		let flooredDiscoveries = 0;
		const flooredRefresher = createRepositoryContextRefresher(
			() => ({ cwd: "/work/payments", branch: "main", issuePatterns: [] }),
			async () => {
				flooredDiscoveries++;
				return {};
			},
			() => {},
			() => clockMs,
		);
		await flooredRefresher.refresh();
		assert.strictEqual(flooredDiscoveries, 1, "an unconditional refresh always discovers");
		clockMs = 29_999;
		await flooredRefresher.refreshIfStale(30_000);
		assert.strictEqual(flooredDiscoveries, 1, "a refresh inside the floor is skipped");
		clockMs = 30_000;
		await flooredRefresher.refreshIfStale(30_000);
		assert.strictEqual(flooredDiscoveries, 2, "a refresh at the floor rediscovers");
		clockMs = 30_001;
		flooredRefresher.clear();
		await flooredRefresher.refreshIfStale(30_000);
		assert.strictEqual(flooredDiscoveries, 3, "a cleared context is always stale");
		flooredRefresher.dispose();
	});
});
