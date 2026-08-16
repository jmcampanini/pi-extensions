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
eq("branch inference wins over cwd basename",
	inferIssueNumber("feature/ticket-41", "/work/bug-92", replacementPatterns), 41);
eq("pattern order wins within the branch",
	inferIssueNumber("bug-92-ticket-41", "/work/none", replacementPatterns), 41);
eq("cwd basename is the fallback inference source",
	inferIssueNumber("feature/no-ticket", "/work/bug-92", replacementPatterns), 92);
eq("detached HEAD falls back to cwd basename",
	inferIssueNumber("detached", "/work/issue-456", DEFAULT_ISSUE_PATTERNS), 456);
eq("unmarked numbers are not inferred",
	inferIssueNumber("feature/456", "/work/task-92", DEFAULT_ISSUE_PATTERNS), undefined);

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
	eq(`PR ${label} state maps to its footer suffix`, context.pr?.state, expected);
}

const commandCalls: string[][] = [];
const complete = await discoverRepositoryContext(
	jsonRunner(
		{ number: 123, url: "https://github.enterprise/acme/payments/pull/123", state: "MERGED", isDraft: false },
		{ number: 456, url: "https://github.enterprise/acme/payments/issues/456", state: "CLOSED" },
		commandCalls,
	),
	{ cwd: "/work/issue-456", branch: "feature/issue-456", issuePatterns: DEFAULT_ISSUE_PATTERNS },
);
eq("verified issue preserves its canonical Enterprise URL", complete.issue,
	{ number: 456, url: "https://github.enterprise/acme/payments/issues/456", state: "c" });
eq("current-branch PR preserves its canonical Enterprise URL", complete.pr,
	{ number: 123, url: "https://github.enterprise/acme/payments/pull/123", state: "m" });
eq("PR discovery asks gh for draft-aware state", commandCalls[0],
	["pr", "view", "--json", "number,url,state,isDraft"]);
eq("issue verification asks gh for the inferred number", commandCalls[1],
	["issue", "view", "456", "--json", "number,url,state"]);

const mismatchedIssue = await discoverRepositoryContext(
	jsonRunner(undefined, {
		number: 999,
		url: "https://github.example/acme/payments/issues/999",
		state: "OPEN",
	}),
	{ cwd: "/work/issue-456", branch: null, issuePatterns: DEFAULT_ISSUE_PATTERNS },
);
eq("issue verification rejects a mismatched returned number", mismatchedIssue.issue, undefined);

const unsafeUrl = await discoverRepositoryContext(
	jsonRunner({ number: 123, url: "file:///etc/passwd", state: "OPEN", isDraft: false }, undefined),
	{ cwd: "/work/payments", branch: "feature/footer", issuePatterns: [] },
);
eq("non-http gh URLs cannot become terminal hyperlinks", unsafeUrl.pr, undefined);
const failedDiscovery = await discoverRepositoryContext(
	async () => {
		throw new Error("gh unavailable");
	},
	{ cwd: "/work/issue-456", branch: "feature/issue-456", issuePatterns: DEFAULT_ISSUE_PATTERNS },
);
eq("gh failures produce a clean local-only context", failedDiscovery, {});

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
eq("overlapping refresh requests share one in-flight discovery", discoveryCalls, 1);
pending.shift()?.({ pr: { number: 1, url: "https://example.test/pull/1", state: "o" } });
await new Promise<void>((resolve) => setImmediate(resolve));
eq("a queued refresh starts after the in-flight lookup", discoveryCalls, 2);
pending.shift()?.({ pr: { number: 2, url: "https://example.test/pull/2", state: "o" } });
await Promise.all([firstRefresh, secondRefresh]);
eq("stale discovery results never replace the latest context", refresher.get().pr?.number, 2);
eq("coalesced discovery renders only the latest result", changes, 1);
refresher.dispose();

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
eq("an unconditional refresh always discovers", flooredDiscoveries, 1);
clockMs = 29_999;
await flooredRefresher.refreshIfStale(30_000);
eq("a refresh inside the floor is skipped", flooredDiscoveries, 1);
clockMs = 30_000;
await flooredRefresher.refreshIfStale(30_000);
eq("a refresh at the floor rediscovers", flooredDiscoveries, 2);
clockMs = 30_001;
flooredRefresher.clear();
await flooredRefresher.refreshIfStale(30_000);
eq("a cleared context is always stale", flooredDiscoveries, 3);
flooredRefresher.dispose();

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const fixture = mkdtempSync(join(sandbox, "adaptive-footer-gh-"));
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
eq("subprocess-backed discovery renders issue, PR, then branch", endToEndLayout.right,
	"is#456 o • pr#123 d • feature/issue-456");
ok("subprocess-backed issue URL reaches OSC 8 output",
	endToEndLine.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\"));
ok("subprocess-backed PR URL reaches OSC 8 output",
	endToEndLine.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\"));
eq("subprocess-backed styled output retains its fitted width", visibleWidth(endToEndLine), 120);
rmSync(fixture, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
