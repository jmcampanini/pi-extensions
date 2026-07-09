// Unit tests for agents.ts — definition parsing, project-shadows-global
// loading, and the inventory (including how model problems are reported).
import {
	collectAgentInventory,
	descriptionHeadline,
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
	"---\ndescription: Fast recon\nmodels: openai-codex/gpt-5.5, gpt-5.4-mini\nthinking: low\ntools: read, bash\ncontext: forked\nauto-exit: false\n---\n\nYou are a scout.\n",
);
const scout = loadAgentDefinition("scout", cwd)!;
eq("filename is the name", scout.name, "scout");
eq("source is global", scout.source, "global");
eq("description", scout.description, "Fast recon");
eq("models split + trimmed", scout.models, ["openai-codex/gpt-5.5", "gpt-5.4-mini"]);
eq("thinking", scout.thinking, "low");
eq("tools kept as one string", scout.tools, "read, bash");
eq("context", scout.context, "forked");
eq("auto-exit false", scout.autoExit, false);
eq("valid frontmatter has no problems", scout.problems, []);
eq("body is the system prompt", scout.body, "You are a scout.");

writeFileSync(join(globalDefs, "badcontext.md"), "---\ncontext: shared\n---\nBad context value.\n");
const badcontext = loadAgentDefinition("badcontext", cwd)!;
eq("invalid context value does not set context", badcontext.context, undefined);
ok("invalid context problem suggests the valid values", badcontext.problems[0].includes('"forked"'));

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
eq("list is the sorted union (no duplicate worker)", names, ["badcontext", "bare", "crlf", "scout", "worker"]);

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
eq("requested models kept verbatim", scoutInfo.requestedModels, ["openai-codex/gpt-5.5", "gpt-5.4-mini"]);
eq("valid agent has no problems", scoutInfo.problems, []);
const workerInfo = inventory.find((a) => a.name === "worker")!;
eq("defaults applied: context fresh, auto-exit true", [workerInfo.context, workerInfo.autoExit], ["fresh", true]);
eq("no models listed = empty requestedModels", workerInfo.requestedModels, []);
const badcontextInfo = inventory.find((a) => a.name === "badcontext")!;
eq("frontmatter problems flow into the inventory", badcontextInfo.problems.length, 1);

// An agent whose models are all unusable: the problem must carry the real
// per-entry reasons, keeping the message's own line breaks (each view
// decides how to flatten or indent them).
writeFileSync(join(globalDefs, "broken.md"), "---\nmodels: anthropic/claude-x\nthinking: ultra\n---\nB.\n");
const broken = collectAgentInventory(registry, cwd).find((a) => a.name === "broken")!;
eq("problem count", broken.problems.length, 2);
ok("model problem names the provider reason", broken.problems[0].includes('provider "anthropic" has no credentials'));
ok("model problem keeps its line breaks", broken.problems[0].includes("\n  - "));
ok("thinking problem names the bad level", broken.problems[1].includes('Invalid thinking level "ultra"'));

// ── description headline ─────────────────────────────────────────────────

eq("headline cuts at the em-dash", descriptionHeadline("Fast recon — finds code. More text."), "Fast recon");
eq("headline cuts at the sentence end", descriptionHeadline("Finds code. Say how thorough."), "Finds code.");
eq(
	"earliest boundary wins",
	descriptionHeadline("Finds code. Then — something else."),
	"Finds code.",
);
eq("plain description stays whole", descriptionHeadline("Just a plain description"), "Just a plain description");
eq(
	"e.g. is not a sentence end",
	descriptionHeadline("Runs quick checks (e.g. lint) on the diff — pass a file path."),
	"Runs quick checks (e.g. lint) on the diff",
);
eq(
	"vs. is not a sentence end",
	descriptionHeadline("Compares impl vs. spec — cite line numbers."),
	"Compares impl vs. spec",
);

// ── overview rendering ───────────────────────────────────────────────────

const dirs = { global: globalDefs, project: projectDefs };
const WIDTH = 78;

const emptyLines = formatAgentOverviewLines([], WIDTH, { global: "/g/subagents", project: "/p/.pi/subagents" });
const emptyFlat = emptyLines.join("\n");
ok("empty state names both dirs", emptyFlat.includes("/g/subagents") && emptyFlat.includes("/p/.pi/subagents"));
ok("empty state fits the width", formatAgentOverviewLines([], 40, dirs).every((l) => l.length <= 40));

// `inventory` predates broken.md: badcontext, bare, crlf, scout, worker.
const lines = formatAgentOverviewLines(inventory, WIDTH, dirs);
const flat = lines.join("\n");
ok("top rule carries the count", lines[0].startsWith("── Sub-agents · 5 ─") && lines[0].length === WIDTH);
ok("names render as tags", flat.includes("[scout]") && flat.includes("[worker]"));
ok("resolved model on the header row", lines.some((l) => l.includes("[scout]") && l.includes("openai-codex/gpt-5.5")));
ok("no models listed reads as inherits", lines.some((l) => l.includes("[worker]") && l.includes("inherits parent model")));
ok(
	"source right-anchored, worker marked default",
	lines.some((l) => l.includes("[worker]") && l.endsWith("project · default")),
);
ok("file paths are gone", !flat.includes(worker.filePath) && !flat.includes(globalDefs));
// The fold is checked on a worker-only render: the full flat legitimately
// contains "fresh"/"forked" inside the invalid-context problem text.
const workerCard = formatAgentOverviewLines([workerInfo], WIDTH, dirs).join("\n");
ok("default run behavior is folded away", !workerCard.includes("fresh") && !workerCard.includes("auto-exit"));
ok(
	"deviations surface on the meta row",
	lines.some((l) => l.includes("thinking low") && l.includes("tools: read, bash") && l.includes("forked · interactive")),
);
ok("frontmatter problems render as ⚠ blocks", lines.some((l) => l.trim().startsWith("⚠ invalid context")));
ok("every line fits the width", lines.every((l) => l.length <= WIDTH));
ok("dismiss hint present", flat.includes("/subagents-available again"));

// Narrow terminals: everything (incl. the model slot and dismiss hint) must
// still give way instead of overflowing.
const narrowLines = formatAgentOverviewLines(inventory, 50, dirs);
ok("narrow width still fits", narrowLines.every((l) => l.length <= 50));
ok("narrow model slot ellipsizes", narrowLines.some((l) => l.includes("…")));

// Hostile shapes: a long agent name (eats the tag column), a long tools
// allowlist (single meta part wider than the body). The width contract is
// HARD — pi-tui treats an overlong rendered line as fatal — so every width
// must fit, down to absurd ones.
writeFileSync(
	join(globalDefs, "toolsy.md"),
	"---\ndescription: Big allowlist.\ntools: read, bash, edit, write, grep, glob, webfetch, websearch, task, notebook, todo\n---\nT.\n",
);
writeFileSync(
	join(globalDefs, "integration-test-orchestrator.md"),
	"---\ndescription: Runs the suite and reports findings back to the caller.\n---\nI.\n",
);
const hostile = collectAgentInventory(registry, cwd);
for (const w of [100, 78, 50, 34, 21]) {
	ok(`hostile inventory fits width ${w}`, formatAgentOverviewLines(hostile, w, dirs).every((l) => l.length <= w));
}
const hostileFlat = formatAgentOverviewLines(hostile, 78, dirs).join("\n");
ok("long tools list wraps instead of truncating", hostileFlat.includes("notebook, todo"));

// A broken agent: red slot in the header, structured ⚠ block under it.
const brokenLines = formatAgentOverviewLines(collectAgentInventory(registry, cwd), WIDTH, dirs);
ok("broken agent flagged in its header", brokenLines.some((l) => l.includes("[broken]") && l.includes("✗ no usable model")));
ok("problem headline starts the block", brokenLines.some((l) => l.trim().startsWith("⚠ No usable model.")));
ok("problem bullets keep their shape", brokenLines.some((l) => l.trim().startsWith("- anthropic/claude-x")));
ok("second problem gets its own block", brokenLines.some((l) => l.includes("⚠ Invalid thinking level")));
ok("broken view still fits the width", brokenLines.every((l) => l.length <= WIDTH));

// ── worktree frontmatter (tri-state, mirrors auto-exit) ──────────────────
// Placed after the overview-rendering tests: writing these agent files
// earlier would change the inventory counts those tests assert on.

writeFileSync(join(globalDefs, "isolated.md"), "---\nworktree: true\n---\nI.\n");
eq("worktree true", loadAgentDefinition("isolated", cwd)!.worktree, true);
writeFileSync(join(globalDefs, "shared.md"), "---\nworktree: false\n---\nS.\n");
eq("worktree false", loadAgentDefinition("shared", cwd)!.worktree, false);
eq("worktree absent = undefined", scout.worktree, undefined);

// Any other value (e.g. YAML's `yes`) is a PROBLEM, not a silent default —
// spawning without isolation is exactly the hazard the flag prevents.
writeFileSync(join(globalDefs, "sloppy.md"), "---\nworktree: yes\n---\nY.\n");
const sloppy = loadAgentDefinition("sloppy", cwd)!;
eq("worktree invalid value = undefined", sloppy.worktree, undefined);
eq("worktree invalid value reported as problem", sloppy.problems.length, 1);
ok("worktree problem names the bad value", sloppy.problems[0].includes('invalid worktree "yes"'));

// Inventory turns the tri-state into a concrete boolean (absent → false),
// and the overview's meta row tags only agents that opted in — for an agent
// whose only deviation is the worktree, the row is exactly "worktree".
const withWorktree = collectAgentInventory(registry, cwd);
eq("inventory: worktree true carried through", withWorktree.find((a) => a.name === "isolated")!.worktree, true);
eq("inventory: absent defaults to false", withWorktree.find((a) => a.name === "worker")!.worktree, false);
const worktreeLines = formatAgentOverviewLines(withWorktree, WIDTH, dirs);
eq("overview tags exactly the one worktree agent", worktreeLines.filter((l) => l.trim() === "worktree").length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
