// Unit tests for agents.ts — definition parsing, project-shadows-global
// loading, and the inventory (including how model problems are reported).
import {
	collectAgentInventory,
	formatAgentOverviewLines,
	listAgentDefinitions,
	loadAgentDefinition,
} from "../agents.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, cond: boolean) {
	if (cond) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

// A throwaway global config root and a throwaway project cwd.
const globalRoot = mkdtempSync(join(tmpdir(), "subagents-global-"));
const cwd = mkdtempSync(join(tmpdir(), "subagents-project-"));
process.env.PI_CODING_AGENT_DIR = globalRoot;
const globalDefs = join(globalRoot, "subagents");
const projectDefs = join(cwd, ".pi", "subagents");
mkdirSync(globalDefs, { recursive: true });
mkdirSync(projectDefs, { recursive: true });

// ── parsing ──────────────────────────────────────────────────────────────

writeFileSync(
	join(globalDefs, "scout.md"),
	"---\ndescription: Fast recon\nmodels: openai-codex/gpt-5.5, gpt-5.4-mini\nthinking: low\ntools: read, bash\nmode: fork\nauto-exit: false\n---\n\nYou are a scout.\n",
);
const scout = loadAgentDefinition("scout", cwd)!;
eq("filename is the name", scout.name, "scout");
eq("source is global", scout.source, "global");
eq("description", scout.description, "Fast recon");
eq("models split + trimmed", scout.models, ["openai-codex/gpt-5.5", "gpt-5.4-mini"]);
eq("thinking", scout.thinking, "low");
eq("tools kept as one string", scout.tools, "read, bash");
eq("mode", scout.mode, "fork");
eq("auto-exit false", scout.autoExit, false);
eq("body is the system prompt", scout.body, "You are a scout.");

writeFileSync(join(globalDefs, "crlf.md"), "---\r\ndescription: windows line endings\r\n---\r\nBody here.\r\n");
eq("CRLF frontmatter still parses", loadAgentDefinition("crlf", cwd)!.description, "windows line endings");

writeFileSync(join(globalDefs, "bare.md"), "Just a prompt, no frontmatter.\n");
const bare = loadAgentDefinition("bare", cwd)!;
eq("no fences = all body", bare.body, "Just a prompt, no frontmatter.");
eq("no fences = no description", bare.description, undefined);

eq("unknown agent = null", loadAgentDefinition("ghost", cwd), null);

// ── shadowing ────────────────────────────────────────────────────────────

writeFileSync(join(globalDefs, "worker.md"), "---\ndescription: global worker\n---\nGlobal body.\n");
writeFileSync(join(projectDefs, "worker.md"), "---\ndescription: project worker\n---\nProject body.\n");
const worker = loadAgentDefinition("worker", cwd)!;
eq("project shadows global", worker.description, "project worker");
eq("shadowed source is project", worker.source, "project");
ok("filePath points into .pi/subagents", worker.filePath.startsWith(projectDefs));

const names = listAgentDefinitions(cwd).map((def) => def.name);
eq("list is the sorted union (no duplicate worker)", names, ["bare", "crlf", "scout", "worker"]);

// ── inventory ────────────────────────────────────────────────────────────

// A fake registry: one configured provider offering one model.
const registry = {
	getAll: () => [
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "anthropic", id: "claude-x" },
	],
	hasConfiguredAuth: (m: { provider: string }) => m.provider === "openai-codex",
};

const inventory = collectAgentInventory(registry, cwd);
const scoutInfo = inventory.find((a) => a.name === "scout")!;
eq("first usable model wins", scoutInfo.resolvedModel, "openai-codex/gpt-5.5");
eq("valid agent has no problems", scoutInfo.problems, []);
const workerInfo = inventory.find((a) => a.name === "worker")!;
eq("defaults applied: mode fresh, auto-exit true", [workerInfo.mode, workerInfo.autoExit], ["fresh", true]);

// An agent whose models are all unusable: the problem must carry the real
// per-entry reasons (flattened to one line), not a generic string.
writeFileSync(join(globalDefs, "broken.md"), "---\nmodels: anthropic/claude-x\nthinking: ultra\n---\nB.\n");
const broken = collectAgentInventory(registry, cwd).find((a) => a.name === "broken")!;
eq("problem count", broken.problems.length, 2);
ok("model problem names the provider reason", broken.problems[0].includes('provider "anthropic" has no credentials'));
ok("model problem is one line", !broken.problems[0].includes("\n"));
ok("thinking problem names the bad level", broken.problems[1].includes('Invalid thinking level "ultra"'));

// ── worktree frontmatter (tri-state, mirrors auto-exit) ──────────────────

writeFileSync(join(globalDefs, "isolated.md"), "---\nworktree: true\n---\nI.\n");
eq("worktree true", loadAgentDefinition("isolated", cwd)!.worktree, true);
writeFileSync(join(globalDefs, "shared.md"), "---\nworktree: false\n---\nS.\n");
eq("worktree false", loadAgentDefinition("shared", cwd)!.worktree, false);
eq("worktree absent = undefined", scout.worktree, undefined);

// Inventory turns the tri-state into a concrete boolean (absent → false),
// and the overview only tags agents that opted in.
const withWorktree = collectAgentInventory(registry, cwd);
eq("inventory: worktree true carried through", withWorktree.find((a) => a.name === "isolated")!.worktree, true);
eq("inventory: absent defaults to false", withWorktree.find((a) => a.name === "worker")!.worktree, false);
const worktreeLines = formatAgentOverviewLines(withWorktree, { global: globalDefs, project: projectDefs });
eq("overview tags exactly the one worktree agent", worktreeLines.filter((l) => l.includes("· worktree")).length, 1);

// ── overview rendering ───────────────────────────────────────────────────

const emptyLines = formatAgentOverviewLines([], { global: "/g/subagents", project: "/p/.pi/subagents" });
ok("empty state names both dirs", emptyLines[0].includes("/g/subagents") && emptyLines[0].includes("/p/.pi/subagents"));

const lines = formatAgentOverviewLines(inventory, { global: globalDefs, project: projectDefs });
ok("worker marked (default)", lines.some((l) => l.includes("worker (default)")));
ok("overview shows the file path", lines.some((l) => l.trim() === worker.filePath));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
