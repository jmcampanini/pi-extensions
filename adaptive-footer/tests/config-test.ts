import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
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

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testRoot, { recursive: true, force: true });
});

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

describe("config", () => {
	it("default agent config directory follows Pi", () => {
		assert.strictEqual(agentConfigDir({}), join(homedir(), ".pi", "agent"));
	});

	it("configured agent directory is used verbatim", () => {
		assert.strictEqual(agentConfigDir({ PI_CODING_AGENT_DIR: "/configured/pi" }), "/configured/pi");
	});

	it("config file path is adaptive-footer.json under the agent directory", () => {
		assert.strictEqual(
			configFilePath({ PI_CODING_AGENT_DIR: "/configured/pi" }),
			join("/configured/pi", "adaptive-footer.json"),
		);
	});

	it("missing file loads ordered defaults", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), {
			issuePatterns: DEFAULT_ISSUE_PATTERNS,
		});
	});

	it("config singleton loads the defaults at import", () => {
		assert.deepStrictEqual(config, { issuePatterns: DEFAULT_ISSUE_PATTERNS });
	});

	it("each load gets a new issue pattern array", () => {
		assert.ok(loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }).issuePatterns !== DEFAULT_ISSUE_PATTERNS);
	});

	it("default infers an issue from a branch marker", () => {
		assert.strictEqual(matchNumber(DEFAULT_ISSUE_PATTERNS[0], "feature/issue-456-footer-links"), "456");
	});

	it("default infers an issue from an issues cwd basename", () => {
		assert.strictEqual(matchNumber(DEFAULT_ISSUE_PATTERNS[0], "issues_27_footer"), "27");
	});

	it("default accepts hash and slash marker separators", () => {
		assert.deepStrictEqual([
			matchNumber(DEFAULT_ISSUE_PATTERNS[0], "issue#81"),
			matchNumber(DEFAULT_ISSUE_PATTERNS[0], "issues/82"),
		], ["81", "82"]);
	});

	it("default does not infer an unmarked number", () => {
		assert.strictEqual(matchNumber(DEFAULT_ISSUE_PATTERNS[0], "feature/task-456-footer-links"), undefined);
	});

	it("default requires a positive issue number", () => {
		assert.strictEqual(matchNumber(DEFAULT_ISSUE_PATTERNS[0], "feature/issue-0-footer-links"), undefined);
	});

	it("provided patterns replace defaults while preserving order", () => {
		const replacements = ["ticket-(?<number>[1-9][0-9]*)", "bug/(?<number>[1-9][0-9]*)"];
		assert.deepStrictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith(JSON.stringify({ issuePatterns: replacements })) }),
			{ issuePatterns: replacements },
		);
	});

	it("an empty pattern array disables issue inference", () => {
		assert.deepStrictEqual(
			loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":[]}') }),
			{ issuePatterns: [] },
		);
	});

	it("unknown persisted keys are rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePattern":[]}') }),
			/unknown key\(s\) issuePattern/,
		);
	});

	it("invalid JSON is rejected", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{broken") }),
			/not valid JSON/,
		);
	});

	it("non-object config roots are rejected", () => {
		for (const [label, content] of [["null", "null"], ["array", "[]"], ["scalar", "42"]] as const) {
			assert.throws(
				() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(content) }),
				/must be a JSON object/,
				`${label} config root is rejected as a non-object`,
			);
		}
	});

	it("issuePatterns must be an array", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":"issue-(?<number>[0-9]+)"}') }),
			/must be an array/,
		);
	});

	it("every issue pattern must be a string", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":[17]}') }),
			/issuePatterns\[0\] must be a regular expression string/,
		);
	});

	it("every issue pattern must compile as JavaScript regex", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["(?<number>"]}') }),
			/not a valid JavaScript regular expression/,
		);
	});

	it("every issue pattern must declare the number capture", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["issue-([0-9]+)"]}') }),
			/named capture group \(\?<number>\.\.\.\)/,
		);
	});

	it("escaped capture-like text is not treated as a number capture", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"issuePatterns":["\\\\(\\\\?<number>"]}') }),
			/named capture group \(\?<number>\.\.\.\)/,
		);
	});
});
