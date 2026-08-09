import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepositoryContextDiscovery } from "../repository-context.ts";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "adaptive-footer-extension-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = testRoot;
process.env.HOME = "/Users/dev";
const { registerAdaptiveFooter } = await import("../index.ts");

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

interface FakeContext {
	hasUI: boolean;
	ui: {
		setFooter(factory: FooterFactory): void;
	};
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
		getEntries(): never[];
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
type EventHandler = (event: unknown, context: FakeContext) => unknown;

const handlers = new Map<string, EventHandler>();
let footerFactory: FooterFactory | undefined;
const fakePi = {
	on(event: string, handler: EventHandler): void {
		handlers.set(event, handler);
	},
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
registerAdaptiveFooter(fakePi, { issuePatterns: [], discover });

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
		getEntries: () => [],
	},
	model: undefined,
	modelRegistry: {
		isUsingOAuth: () => false,
	},
	getContextUsage: () => ({ percent: 51, tokens: 140_000, contextWindow: 272_000 }),
};
await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
if (!footerFactory) throw new Error("session_start did not install the footer");

let branch = "feature/issue-456";
let branchChanged: (() => void) | undefined;
let unsubscribed = 0;
let renders = 0;
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
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
	},
);
await new Promise<void>((resolve) => setImmediate(resolve));

function plain(line: string): string {
	return line
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

const initialLine = component.render(120)[0] ?? "";
ok("startup discovery requests a footer rerender", renders > 0);
eq("startup discovery runs once", discoveryCalls, 1);
eq("extension render keeps the approved left ordering", plain(initialLine).trimStart().split(/ {2,}/)[0],
	"~/Code/acme/payments/main • footer links");
ok("extension render keeps issue, PR, and branch ordering",
	plain(initialLine).endsWith("is#456 o • pr#123 d • feature/issue-456"));
ok("extension render emits clickable issue and PR URLs",
	initialLine.includes("\x1b]8;;https://git.acme.test/acme/payments/issues/456\x1b\\")
		&& initialLine.includes("\x1b]8;;https://git.acme.test/acme/payments/pull/123\x1b\\"));
ok("issue and PR links share the underlined accent treatment",
	initialLine.includes("\x1b[36m\x1b[4mis#456 o")
		&& initialLine.includes("\x1b[36m\x1b[4mpr#123 d"));

branch = "feature/issue-789";
branchChanged?.();
const invalidatedLine = plain(component.render(120)[0] ?? "");
ok("branch change clears stale remote links synchronously",
	!invalidatedLine.includes("is#456") && !invalidatedLine.includes("pr#123"));
ok("branch text updates while remote discovery is pending", invalidatedLine.endsWith(branch));
await new Promise<void>((resolve) => setImmediate(resolve));
const refreshedLine = plain(component.render(120)[0] ?? "");
ok("branch refresh installs links for the new branch", refreshedLine.includes("is#789 o"));
eq("branch change performs one additional discovery", discoveryCalls, 2);

await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
await new Promise<void>((resolve) => setImmediate(resolve));
eq("settled agent runs refresh repository context", discoveryCalls, 3);

const wiredOverflowWidth = Array.from({ length: 121 }, (_, width) => width)
	.find((width) => visibleWidth(component.render(width)[0] ?? "") > width);
eq("wired footer line never overflows from width 0 through 120", wiredOverflowWidth, undefined);
component.dispose();
eq("footer disposal removes the branch subscription", unsubscribed, 1);
await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
eq("session shutdown does not dispose an already disposed footer twice", unsubscribed, 1);

if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
if (originalHome === undefined) delete process.env.HOME;
else process.env.HOME = originalHome;
rmSync(testRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
