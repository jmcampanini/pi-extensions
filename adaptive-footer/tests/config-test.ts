import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "adaptive-footer-config-"));
const importAgentDir = join(testRoot, "import");
mkdirSync(importAgentDir);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = importAgentDir;
const {
	DEFAULT_ISSUE_PATTERNS,
	agentConfigDir,
	config,
	configFilePath,
	loadConfig,
} = await import("../config.ts");

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

function throws(label: string, fn: () => void, contains: string): void {
	try {
		fn();
		fail++;
		console.log(`  FAIL ${label}: expected throw`);
	} catch (error) {
		if (String(error).includes(contains)) {
			pass++;
			console.log(`  ok  ${label}`);
		} else {
			fail++;
			console.log(`  FAIL ${label}: message missing ${JSON.stringify(contains)}: ${String(error)}`);
		}
	}
}

let nextDirectory = 0;
function dirWith(content: string | null): string {
	const directory = join(testRoot, String(nextDirectory++));
	mkdirSync(directory);
	if (content !== null) writeFileSync(join(directory, "adaptive-footer.json"), content);
	return directory;
}

function matchNumber(pattern: string, value: string): string | undefined {
	return new RegExp(pattern).exec(value)?.groups?.number;
}

eq("default agent config directory follows Pi", agentConfigDir({}), join(homedir(), ".pi", "agent"));
eq("configured agent directory is used verbatim", agentConfigDir({ PI_CODING_AGENT_DIR: "/configured/pi" }), "/configured/pi");
eq(
	"config file path is adaptive-footer.json under the agent directory",
	configFilePath({ PI_CODING_AGENT_DIR: "/configured/pi" }),
	join("/configured/pi", "adaptive-footer.json"),
);
eq("missing file loads ordered defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), {
	issuePatterns: DEFAULT_ISSUE_PATTERNS,
});
eq("config singleton loads the defaults at import", config, { issuePatterns: DEFAULT_ISSUE_PATTERNS });
ok(
	"each load gets a new issue pattern array",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }).issuePatterns !== DEFAULT_ISSUE_PATTERNS,
);

const defaultPattern = DEFAULT_ISSUE_PATTERNS[0];
eq("default infers an issue from a branch marker", matchNumber(defaultPattern, "feature/issue-456-footer-links"), "456");
eq("default infers an issue from an issues cwd basename", matchNumber(defaultPattern, "issues_27_footer"), "27");
eq("default accepts hash and slash marker separators", [
	matchNumber(defaultPattern, "issue#81"),
	matchNumber(defaultPattern, "issues/82"),
], ["81", "82"]);
eq("default does not infer an unmarked number", matchNumber(defaultPattern, "feature/task-456-footer-links"), undefined);
eq("default requires a positive issue number", matchNumber(defaultPattern, "feature/issue-0-footer-links"), undefined);

const replacements = ["ticket-(?<number>[1-9][0-9]*)", "bug/(?<number>[1-9][0-9]*)"];
eq(
	"provided patterns replace defaults while preserving order",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith(JSON.stringify({ issuePatterns: replacements })) }),
	{ issuePatterns: replacements },
);
eq(
	"an empty pattern array disables issue inference",
	loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":[]}') }),
	{ issuePatterns: [] },
);

throws(
	"unknown persisted keys are rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePattern":[]}') }),
	"unknown key(s) issuePattern",
);
throws(
	"invalid JSON is rejected",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{broken") }),
	"not valid JSON",
);
for (const [label, content] of [["null", "null"], ["array", "[]"], ["scalar", "42"]] as const) {
	throws(
		`${label} config root is rejected as a non-object`,
		() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(content) }),
		"must be a JSON object",
	);
}
throws(
	"issuePatterns must be an array",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":"issue-(?<number>[0-9]+)"}') }),
	"must be an array",
);
throws(
	"every issue pattern must be a string",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":[17]}') }),
	"issuePatterns[0] must be a regular expression string",
);
throws(
	"every issue pattern must compile as JavaScript regex",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["(?<number>"]}') }),
	"not a valid JavaScript regular expression",
);
throws(
	"every issue pattern must declare the number capture",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["issue-([0-9]+)"]}') }),
	"named capture group (?<number>...)",
);
throws(
	"escaped capture-like text is not treated as a number capture",
	() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["\\\\(\\\\?<number>"]}') }),
	"named capture group (?<number>...)",
);

if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
rmSync(testRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
