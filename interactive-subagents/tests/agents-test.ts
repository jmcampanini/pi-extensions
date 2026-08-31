// Unit tests for agents.ts - definition parsing, project-shadows-global
// loading, and the inventory (including how model problems are reported) -
// plus catalogue.ts's system-prompt injection of the catalogue and the
// waiting contract.
//
// File writes and inventory collects stay at module scope in their original
// order: later sections add agent files that would change the inventory
// counts earlier sections assert on, so each collect snapshots the directory
// state at its point in the sequence.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerCatalogue, updateCatalogue, WAITING_CONTRACT } from "../catalogue.ts";
import {
	CATALOGUE_DESCRIPTION_MAX_CHARS,
	collectAgentInventory,
	contextMode,
	descriptionHeadline,
	formatAgentCatalogue,
	formatAgentOverviewLines,
	listAgentDefinitions,
	loadAgentDefinition,
	type AgentInfo,
} from "../agents.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestEventHarness } from "../../shared/test-event-harness.ts";
import { USABLE_MODELS_MAX_LISTED } from "../models.ts";

// A throwaway global config root and a throwaway project cwd.
const globalRoot = mkdtempSync(join(tmpdir(), "subagents-global-"));
const cwd = mkdtempSync(join(tmpdir(), "subagents-project-"));
process.env.PI_CODING_AGENT_DIR = globalRoot;
const globalDefs = join(globalRoot, "subagents");
const projectDefs = join(cwd, ".pi", "subagents");
mkdirSync(globalDefs, { recursive: true });
mkdirSync(projectDefs, { recursive: true });

writeFileSync(
	join(globalDefs, "scout.md"),
	"---\ndescription: Fast recon\nmodels: openai-codex/gpt-5.5, gpt-5.4-mini\nthinking: low\ntools: read, bash\ncontext: forked\nauto-exit: false\n---\n\nYou are a scout.\n",
);
const scout = loadAgentDefinition("scout", cwd)!;
writeFileSync(join(globalDefs, "badcontext.md"), "---\ncontext: shared\n---\nBad context value.\n");
const badcontext = loadAgentDefinition("badcontext", cwd)!;
writeFileSync(join(globalDefs, "crlf.md"), "---\r\ndescription: windows line endings\r\n---\r\nBody here.\r\n");
writeFileSync(join(globalDefs, "bare.md"), "Just a prompt, no frontmatter.\n");
const bare = loadAgentDefinition("bare", cwd)!;
writeFileSync(join(globalDefs, "not an agent.md"), "Ignored.\n");
writeFileSync(join(globalDefs, "abcdefghijklmnopqrstu.md"), "Ignored.\n");

describe("definition parsing", () => {
	it("filename is the name", () => {
		assert.strictEqual(scout.name, "scout");
	});

	it("source is global", () => {
		assert.strictEqual(scout.source, "global");
	});

	it("description", () => {
		assert.strictEqual(scout.description, "Fast recon");
	});

	it("models split + trimmed", () => {
		assert.deepStrictEqual(scout.models, ["openai-codex/gpt-5.5", "gpt-5.4-mini"]);
	});

	it("thinking", () => {
		assert.strictEqual(scout.thinking, "low");
	});

	it("tools kept as one string", () => {
		assert.strictEqual(scout.tools, "read, bash");
	});

	it("context", () => {
		assert.strictEqual(scout.context, "forked");
	});

	it("auto-exit false", () => {
		assert.strictEqual(scout.autoExit, false);
	});

	it("valid frontmatter has no problems", () => {
		assert.deepStrictEqual(scout.problems, []);
	});

	it("body is the system prompt", () => {
		assert.strictEqual(scout.body, "You are a scout.");
	});

	it("invalid context value does not set context", () => {
		assert.strictEqual(badcontext.context, undefined);
	});

	it("invalid context problem suggests the valid values", () => {
		assert.strictEqual(badcontext.problems[0], 'invalid context "shared" - use "new" or "forked"');
	});

	it("CRLF frontmatter still parses", () => {
		assert.strictEqual(loadAgentDefinition("crlf", cwd)!.description, "windows line endings");
	});

	it("no fences = all body", () => {
		assert.strictEqual(bare.body, "Just a prompt, no frontmatter.");
	});

	it("no fences = no description", () => {
		assert.strictEqual(bare.description, undefined);
	});

	it("unknown agent = null", () => {
		assert.strictEqual(loadAgentDefinition("ghost", cwd), null);
	});

	it("explicit whitespace identifier is rejected", () => {
		assert.throws(
			() => loadAgentDefinition("code reviewer", cwd),
			/whitespace/,
		);
	});

	it("explicit overlong identifier is rejected", () => {
		assert.throws(
			() => loadAgentDefinition("abcdefghijklmnopqrstu", cwd),
			/20 display columns/,
		);
	});
});

writeFileSync(join(globalDefs, "worker.md"), "---\ndescription: global worker\n---\nGlobal body.\n");
writeFileSync(join(projectDefs, "worker.md"), "---\ndescription: project worker\n---\nProject body.\n");
const worker = loadAgentDefinition("worker", cwd)!;
const names = listAgentDefinitions(cwd).map((def) => def.name);

describe("shadowing", () => {
	it("project shadows global", () => {
		assert.strictEqual(worker.description, "project worker");
	});

	it("shadowed source is project", () => {
		assert.strictEqual(worker.source, "project");
	});

	it("filePath points into .pi/subagents", () => {
		assert.ok(worker.filePath.startsWith(projectDefs));
	});

	it("list is the sorted valid union (no duplicate worker)", () => {
		assert.deepStrictEqual(names, ["badcontext", "bare", "crlf", "scout", "worker"]);
	});
});

// A fake registry: one configured provider offering one model.
const registry = {
	getAll: () => [
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "anthropic", id: "claude-x" },
	],
	hasConfiguredAuth: (m: { provider: string }) => m.provider === "openai-codex",
};
const usableIds = ["openai-codex/gpt-5.5"];

const inventory = collectAgentInventory(registry, cwd, usableIds);
const scoutInfo = inventory.find((a) => a.name === "scout")!;
const workerInfo = inventory.find((a) => a.name === "worker")!;

// An agent whose models are all unusable: the problem must carry the real
// per-entry reasons, keeping the message's own line breaks (each view
// decides how to flatten or indent them).
writeFileSync(join(globalDefs, "broken.md"), "---\nmodels: anthropic/claude-x\nthinking: ultra\n---\nB.\n");
const broken = collectAgentInventory(registry, cwd, usableIds).find((a) => a.name === "broken")!;

describe("inventory", () => {
	it("first usable model wins", () => {
		assert.strictEqual(scoutInfo.resolvedModel, "openai-codex/gpt-5.5");
	});

	it("requested models kept verbatim", () => {
		assert.deepStrictEqual(scoutInfo.requestedModels, ["openai-codex/gpt-5.5", "gpt-5.4-mini"]);
	});

	it("valid agent has no problems", () => {
		assert.deepStrictEqual(scoutInfo.problems, []);
	});

	it("defaults applied: context new, auto-exit true", () => {
		assert.deepStrictEqual([workerInfo.context, workerInfo.autoExit], ["new", true]);
	});

	it("no models listed = empty requestedModels", () => {
		assert.deepStrictEqual(workerInfo.requestedModels, []);
	});

	it("frontmatter problems flow into the inventory", () => {
		const badcontextInfo = inventory.find((a) => a.name === "badcontext")!;
		assert.strictEqual(badcontextInfo.problems.length, 1);
	});

	it("an all-unusable model list reports the real per-entry reasons", () => {
		assert.strictEqual(broken.problems.length, 2, "problem count");
		assert.ok(broken.problems[0].includes('provider "anthropic" has no credentials'),
			"model problem names the provider reason");
		assert.ok(broken.problems[0].includes("\n  - "), "model problem keeps its line breaks");
		assert.ok(broken.problems[1].includes('Invalid thinking level "ultra"'),
			"thinking problem names the bad level");
	});
});

describe("descriptionHeadline", () => {
	it("headline cuts at the sentence end", () => {
		assert.strictEqual(descriptionHeadline("Finds code. Say how thorough."), "Finds code.");
	});

	it("dashes are not boundaries", () => {
		assert.strictEqual(
			descriptionHeadline("Fast recon - finds code. More text."),
			"Fast recon - finds code.",
		);
	});

	it("plain description stays whole", () => {
		assert.strictEqual(descriptionHeadline("Just a plain description"), "Just a plain description");
	});

	it("e.g. is not a sentence end", () => {
		assert.strictEqual(
			descriptionHeadline("Runs quick checks (e.g. lint) on the diff - pass a file path."),
			"Runs quick checks (e.g. lint) on the diff - pass a file path.",
		);
	});

	it("vs. is not a sentence end", () => {
		assert.strictEqual(
			descriptionHeadline("Compares impl vs. spec - cite line numbers."),
			"Compares impl vs. spec - cite line numbers.",
		);
	});
});

// Hostile shapes for the overview: a long agent name (eats the tag column), a
// long tools allowlist (single meta part wider than the body). The width
// contract is HARD - pi-tui treats an overlong rendered line as fatal - so
// every width must fit, down to absurd ones.
writeFileSync(
	join(globalDefs, "toolsy.md"),
	"---\ndescription: Big allowlist.\ntools: read, bash, edit, write, grep, glob, webfetch, websearch, task, notebook, todo\n---\nT.\n",
);
writeFileSync(
	join(globalDefs, "integration-test-orchestrator.md"),
	"---\ndescription: Runs the suite and reports findings back to the caller.\n---\nI.\n",
);
const hostile = collectAgentInventory(registry, cwd, usableIds);
const brokenInventory = collectAgentInventory(registry, cwd, usableIds);

describe("overview rendering", () => {
	const dirs = { global: globalDefs, project: projectDefs };
	const WIDTH = 78;

	// `inventory` predates broken.md: badcontext, bare, crlf, scout, worker.
	const lines = formatAgentOverviewLines(inventory, WIDTH, dirs);
	const flat = lines.join("\n");

	it("empty state names both dirs and fits the width", () => {
		const emptyFlat = formatAgentOverviewLines([], WIDTH, { global: "/g/subagents", project: "/p/.pi/subagents" }).join("\n");
		assert.ok(emptyFlat.includes("/g/subagents") && emptyFlat.includes("/p/.pi/subagents"),
			"empty state names both dirs");
		assert.ok(formatAgentOverviewLines([], 40, dirs).every((l) => visibleWidth(l) <= 40),
			"empty state fits the width");
		assert.ok(formatAgentOverviewLines([], WIDTH, dirs, {}, { models: { ids: ["provider/model"] } }).includes(" provider/model"));
	});

	it("top rule carries the count", () => {
		assert.ok(lines[0].startsWith("── Sub-agents · 5 ─") && visibleWidth(lines[0]) === WIDTH);
	});

	it("names render as tags", () => {
		assert.ok(flat.includes("[scout]") && flat.includes("[worker]"));
	});

	it("resolved model on the header row", () => {
		assert.ok(lines.some((l) => l.includes("[scout]") && l.includes("openai-codex/gpt-5.5")));
	});

	it("no models listed reads as inherits", () => {
		assert.ok(lines.some((l) => l.includes("[worker]") && l.includes("inherits model")));
	});

	it("source right-anchored, worker marked default", () => {
		assert.ok(lines.some((l) => l.includes("[worker]") && l.endsWith("project · default")));
	});

	it("file paths are gone", () => {
		assert.ok(!flat.includes(worker.filePath) && !flat.includes(globalDefs));
	});

	it("default run behavior is folded away", () => {
		// The fold is checked on a worker-only render: the full flat legitimately
		// contains "new"/"forked" inside the invalid-context problem text.
		const workerCard = formatAgentOverviewLines([workerInfo], WIDTH, dirs).join("\n");
		assert.ok(!workerCard.includes("new") && !workerCard.includes("auto-exit"));
	});

	it("deviations surface on the meta row", () => {
		assert.ok(lines.some((l) => l.includes("thinking low") && l.includes("tools: read, bash") && l.includes("forked · interactive")));
	});

	it("frontmatter problems render as ⚠ blocks", () => {
		assert.ok(lines.some((l) => l.trim().startsWith("⚠ invalid context")));
	});

	it("every line fits the width", () => {
		assert.ok(lines.every((l) => visibleWidth(l) <= WIDTH));
	});

	it("dismiss hint present", () => {
		assert.ok(flat.includes("/subagent-available again"));
	});

	it("narrow terminals give way instead of overflowing", () => {
		// everything (incl. the model slot and dismiss hint) must still give way
		const narrowLines = formatAgentOverviewLines(inventory, 50, dirs);
		assert.ok(narrowLines.every((l) => visibleWidth(l) <= 50), "narrow width still fits");
		assert.ok(narrowLines.some((l) => l.includes("…")), "narrow model slot ellipsizes");
	});

	it("hostile inventory fits every width", () => {
		for (const w of [100, 78, 50, 34, 21]) {
			assert.ok(formatAgentOverviewLines(hostile, w, dirs).every((l) => visibleWidth(l) <= w),
				`hostile inventory fits width ${w}`);
		}
	});

	it("long tools list wraps instead of truncating", () => {
		const hostileFlat = formatAgentOverviewLines(hostile, 78, dirs).join("\n");
		assert.ok(hostileFlat.includes("notebook, todo"));
	});

	it("the models section lists ids, marks the current one, and fits the width", () => {
		const models = { ids: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"], current: "openai-codex/gpt-5.6-terra" };

		const modelLines = formatAgentOverviewLines(inventory, WIDTH, dirs, {}, { models });
		const modelFlat = modelLines.join("\n");

		assert.ok(modelFlat.includes("── Models · 2 ─"));
		assert.ok(modelLines.some((l) => l === " openai-codex/gpt-5.6-sol"));
		assert.ok(modelLines.some((l) => l === " openai-codex/gpt-5.6-terra · current"));
		assert.ok(modelFlat.indexOf("[worker]") < modelFlat.indexOf("── Models"), "models follow the agent cards");
		assert.ok(modelFlat.indexOf("── Models") < modelFlat.indexOf("dismiss"), "the dismiss hint stays last");
		assert.ok(modelLines.every((l) => visibleWidth(l) <= WIDTH));
	});

	it("an overlong models section is bounded and narrow widths give way", () => {
		const ids = Array.from({ length: USABLE_MODELS_MAX_LISTED + 4 }, (_, i) => `provider/model-number-${i}`);

		const boundedLines = formatAgentOverviewLines(inventory, WIDTH, dirs, {}, { models: { ids, current: ids.at(-1) } });

		assert.ok(boundedLines.some((l) => l === ` current: ${ids.at(-1)}`));
		assert.ok(boundedLines.some((l) => l === " +4 more"));
		for (const w of [1, 8, 20, 40]) {
			assert.ok(formatAgentOverviewLines(inventory, w, dirs, {}, { models: { ids } }).every((l) => visibleWidth(l) <= w),
				`models section fits width ${w}`);
		}
	});

	it("a broken agent gets a red header slot and structured ⚠ blocks", () => {
		const brokenLines = formatAgentOverviewLines(brokenInventory, WIDTH, dirs);
		assert.ok(brokenLines.some((l) => l.includes("[broken]") && l.includes("✗ no usable model")),
			"broken agent flagged in its header");
		assert.ok(brokenLines.some((l) => l.trim().startsWith("⚠ No usable model.")),
			"problem headline starts the block");
		assert.ok(brokenLines.some((l) => l.trim().startsWith("- anthropic/claude-x")),
			"problem bullets keep their shape");
		assert.ok(brokenLines.some((l) => l.includes("⚠ Invalid thinking level")),
			"second problem gets its own block");
		assert.ok(brokenLines.some((l) => l.includes("Usable models") && l.includes("openai-codex/gpt-5.5")),
			"the problem block names the ids to use instead");
		assert.ok(brokenLines.every((l) => visibleWidth(l) <= WIDTH),
			"broken view still fits the width");
	});
});

// Worktree frontmatter (tri-state, mirrors auto-exit). Placed after the
// overview-rendering collects: writing these agent files earlier would change
// the inventory counts those tests assert on.
writeFileSync(join(globalDefs, "isolated.md"), "---\nworktree: true\n---\nI.\n");
writeFileSync(join(globalDefs, "shared.md"), "---\nworktree: false\n---\nS.\n");
writeFileSync(join(globalDefs, "sloppy.md"), "---\nworktree: yes\n---\nY.\n");
const sloppy = loadAgentDefinition("sloppy", cwd)!;
const withWorktree = collectAgentInventory(registry, cwd, usableIds);

describe("worktree frontmatter", () => {
	const dirs = { global: globalDefs, project: projectDefs };

	it("worktree true", () => {
		assert.strictEqual(loadAgentDefinition("isolated", cwd)!.worktree, true);
	});

	it("worktree false", () => {
		assert.strictEqual(loadAgentDefinition("shared", cwd)!.worktree, false);
	});

	it("worktree absent = undefined", () => {
		assert.strictEqual(scout.worktree, undefined);
	});

	it("any other value is a problem, not a silent default", () => {
		// e.g. YAML's `yes` - spawning without isolation is exactly the hazard
		// the flag prevents.
		assert.strictEqual(sloppy.worktree, undefined, "worktree invalid value = undefined");
		assert.strictEqual(sloppy.problems.length, 1, "worktree invalid value reported as problem");
		assert.ok(sloppy.problems[0].includes('invalid worktree "yes"'), "worktree problem names the bad value");
	});

	it("inventory: worktree true carried through", () => {
		assert.strictEqual(withWorktree.find((a) => a.name === "isolated")!.worktree, true);
	});

	it("inventory: absent defaults to false", () => {
		assert.strictEqual(withWorktree.find((a) => a.name === "worker")!.worktree, false);
	});

	it("overview tags exactly the one worktree agent", () => {
		// The overview's meta row tags only agents that opted in - for an agent
		// whose only deviation is the worktree, the row is exactly "worktree".
		const worktreeLines = formatAgentOverviewLines(withWorktree, 78, dirs);
		assert.strictEqual(worktreeLines.filter((l) => l.trim() === "worktree").length, 1);
	});
});

// External harnesses (harness / harness-pass-through frontmatter). Placed
// after the count-sensitive collects, like the sections above.
writeFileSync(
	join(globalDefs, "ext.md"),
	"---\ndescription: Claude Code worker.\nharness: claude-code\nmodels: claude-haiku-4-5, claude-sonnet-5\nthinking: minimal\ntools: Read,Bash\nharness-pass-through: --permission-mode acceptEdits\n---\nBe careful.\n",
);
const ext = loadAgentDefinition("ext", cwd)!;
writeFileSync(join(globalDefs, "explicitpi.md"), "---\nharness: pi\n---\nP.\n");
writeFileSync(join(globalDefs, "badharness.md"), "---\nharness: codex\n---\nB.\n");
const badharness = loadAgentDefinition("badharness", cwd)!;
writeFileSync(join(globalDefs, "extforked.md"), "---\nharness: claude-code\ncontext: forked\n---\nF.\n");
const extforked = loadAgentDefinition("extforked", cwd)!;
writeFileSync(join(globalDefs, "shadowed-harness.md"), "---\nharness: claude-code\n---\nG.\n");
writeFileSync(join(projectDefs, "shadowed-harness.md"), "---\ndescription: plain pi\n---\nP.\n");
const extInventory = collectAgentInventory(registry, cwd, usableIds);
const extInfo = extInventory.find((a) => a.name === "ext")!;
writeFileSync(join(globalDefs, "extoff.md"), "---\nharness: claude-code\nthinking: off\n---\nO.\n");
const extoff = collectAgentInventory(registry, cwd, usableIds).find((a) => a.name === "extoff")!;

describe("external harnesses", () => {
	it("harness parses", () => {
		assert.strictEqual(ext.harness, "claude-code");
	});

	it("pass-through kept verbatim", () => {
		assert.strictEqual(ext.harnessPassThrough, "--permission-mode acceptEdits");
	});

	it("valid external frontmatter has no problems", () => {
		assert.deepStrictEqual(ext.problems, []);
	});

	it("explicit harness pi parses", () => {
		assert.strictEqual(loadAgentDefinition("explicitpi", cwd)!.harness, "pi");
	});

	it("harness absent = undefined on the definition", () => {
		assert.strictEqual(scout.harness, undefined);
	});

	it("unknown harness names are problems, not silent pi children", () => {
		// spawning the wrong tool is exactly the hazard the key exists to prevent
		assert.strictEqual(badharness.harness, undefined, "unknown harness does not set harness");
		assert.ok(badharness.problems[0].includes('invalid harness "codex"') && badharness.problems[0].includes("pi, claude-code"),
			"unknown harness problem lists the valid values");
	});

	it("forked context cannot ride into a different tool", () => {
		assert.strictEqual(extforked.problems.length, 1, "forked + external harness is one problem");
		assert.strictEqual(
			extforked.problems[0],
			'context "forked" requires the pi harness - external sub-agents are new-only (a pi conversation cannot be transplanted into a different tool)',
			"forked + external problem explains why");
	});

	it("project shadows global harness", () => {
		assert.strictEqual(loadAgentDefinition("shadowed-harness", cwd)!.harness, undefined);
	});

	// Inventory: external agents skip pi's registry entirely - the FIRST models
	// entry is what runs, verbatim, and thinking validates through the profile's
	// effort mapping instead of pi's levels.
	it("external model is the first entry verbatim", () => {
		assert.strictEqual(extInfo.resolvedModel, "claude-haiku-4-5");
	});

	it("external harness carried into the inventory", () => {
		assert.strictEqual(extInfo.harness, "claude-code");
	});

	it("external pass-through carried into the inventory", () => {
		assert.strictEqual(extInfo.harnessPassThrough, "--permission-mode acceptEdits");
	});

	it("external agent with mappable thinking has no problems", () => {
		assert.deepStrictEqual(extInfo.problems, []);
	});

	it("pi agents default to harness pi in the inventory", () => {
		assert.strictEqual(extInventory.find((a) => a.name === "worker")!.harness, "pi");
	});

	it("unmappable external thinking is a problem from the profile", () => {
		assert.strictEqual(extoff.problems.length, 1, "unmappable external thinking is a problem");
		assert.ok(extoff.problems[0].includes("no claude-code effort mapping"),
			"unmappable thinking problem comes from the profile");
	});

	it("overview renders the harness loudly and the pass-through muted", () => {
		const extLines = formatAgentOverviewLines([extInfo], 78, { global: globalDefs, project: projectDefs });
		const extFlat = extLines.join("\n");
		assert.ok(extFlat.includes("claude-code"), "overview meta row names the harness");
		assert.ok(extFlat.includes("claude-code · new-only"), "overview marks external agents new-only");
		assert.ok(extFlat.includes("pass-through: --permission-mode acceptEdits"), "overview shows the pass-through");
		assert.ok(extLines.every((l) => visibleWidth(l) <= 78), "external overview still fits the width");
	});
});

// Description vs details. Placed after the count-sensitive collects, like the
// sections above.
writeFileSync(
	join(globalDefs, "detailed.md"),
	"---\ndescription: Compact routing line.\ndetails: A much longer explanation for humans and explicit discovery.\n---\nD.\n",
);
const detailed = loadAgentDefinition("detailed", cwd)!;
const detailedInfo = collectAgentInventory(registry, cwd, usableIds).find((a) => a.name === "detailed")!;

describe("description vs details", () => {
	it("details parses", () => {
		assert.strictEqual(detailed.details, "A much longer explanation for humans and explicit discovery.");
	});

	it("details absent = undefined", () => {
		assert.strictEqual(scout.details, undefined);
	});

	it("details carried into the inventory", () => {
		assert.strictEqual(detailedInfo.details, "A much longer explanation for humans and explicit discovery.");
	});

	it("overview shows the details under the description headline, in full", () => {
		const detailLines = formatAgentOverviewLines([detailedInfo], 78, { global: globalDefs, project: projectDefs });
		const detailFlat = detailLines.join("\n");
		assert.ok(detailFlat.includes("Compact routing line."), "overview keeps the description headline");
		assert.ok(detailFlat.includes("A much longer explanation"), "overview shows the details");
		assert.ok(detailLines.every((l) => visibleWidth(l) <= 78), "details overview still fits the width");
	});
});

// The model-facing catalogue is pure over AgentInfo[], so these build
// inventories directly - no files, no interference with the counts above.
function info(overrides: Partial<AgentInfo> & { name: string }): AgentInfo {
	return {
		source: "global",
		filePath: `/g/subagents/${overrides.name}.md`,
		requestedModels: [],
		context: "new",
		autoExit: true,
		worktree: false,
		harness: "pi",
		problems: [],
		...overrides,
	};
}

/** The agent half of the catalogue, with no models: the model rows have their own tests below. */
const catalogueOf = (agents: AgentInfo[]) => formatAgentCatalogue(agents, []);

describe("the model-facing catalogue", () => {
	it("pi new context mode", () => {
		assert.strictEqual(contextMode(info({ name: "pi-new" })), "new");
	});

	it("pi forked context mode", () => {
		assert.strictEqual(contextMode(info({ name: "pi-forked", context: "forked" })), "forked");
	});

	it("external context mode", () => {
		assert.strictEqual(contextMode(info({ name: "external", harness: "claude-code" })), "new-only");
	});

	it("empty inventory = no catalogue", () => {
		assert.strictEqual(catalogueOf([]), undefined);
	});

	const catalogue = catalogueOf([
		info({ name: "broken", description: "Secretly fine.", problems: ["invalid context"] }),
		info({ name: "cc-worker", description: "Bounded edit tasks.", harness: "claude-code" }),
		info({ name: "pair", description: "Live pairing session.", autoExit: false }),
		info({ name: "scout", description: "Fast recon.", details: "Only for humans." }),
		info({ name: "undescribed" }),
		info({ name: "worker", description: "General-purpose implementation." }),
	])!;

	it("catalogue names the agent parameter", () => {
		assert.ok(catalogue.includes("`agent` parameter of subagent_spawn"));
	});

	it("plain agent renders name: description", () => {
		assert.ok(catalogue.includes("- scout: Fast recon."));
	});

	it("worker is marked default", () => {
		assert.ok(catalogue.includes("- worker (default): General-purpose implementation."));
	});

	it("external harness is marked new-only", () => {
		assert.ok(catalogue.includes("- cc-worker (external: claude-code, new-only): Bounded edit tasks."));
	});

	it("interactive agent is marked", () => {
		assert.ok(catalogue.includes("- pair (interactive): Live pairing session."));
	});

	it("broken agent points at subagent_available", () => {
		assert.ok(catalogue.includes("- broken (not spawnable - see subagent_available)"));
	});

	it("broken agent's description is suppressed", () => {
		assert.ok(!catalogue.includes("Secretly fine."));
	});

	it("missing description reads as such", () => {
		assert.ok(catalogue.includes("- undescribed: (no description)"));
	});

	it("details never enter the catalogue", () => {
		assert.ok(!catalogue.includes("Only for humans."));
	});

	it("catalogue explains how to expand abbreviated descriptions", () => {
		assert.ok(catalogue.includes(
			"Descriptions above are abbreviated. Call subagent_available for expanded descriptions and configuration details.",
		));
	});

	it("markers combine into one paren group", () => {
		const combined = catalogueOf([info({ name: "worker", description: "W.", autoExit: false })])!;
		assert.ok(combined.includes("- worker (default, interactive): W."), "combined markers share one group");
		assert.ok(!combined.includes("external:") && !combined.includes("new-only"),
			"pi catalogue agents have no external capability markers");
	});

	it("overlong descriptions are cut to the cap with an ellipsis", () => {
		const long = "x".repeat(CATALOGUE_DESCRIPTION_MAX_CHARS + 100);
		const bounded = catalogueOf([info({ name: "chatty", description: long })])!;
		const chattyLine = bounded.split("\n").find((l) => l.startsWith("- chatty"))!;
		assert.strictEqual(chattyLine.length, "- chatty: ".length + CATALOGUE_DESCRIPTION_MAX_CHARS,
			"overlong description is capped");
		assert.ok(chattyLine.endsWith("…"), "truncation ends in an ellipsis");
	});

	it("description at the cap is untouched", () => {
		const exact = "y".repeat(CATALOGUE_DESCRIPTION_MAX_CHARS);
		assert.ok(catalogueOf([info({ name: "exact", description: exact })])!.includes(`- exact: ${exact}`));
	});

	it("hostile description flattens to one line", () => {
		// Newlines and tabs flatten to one clean line (the frontmatter parser is
		// single-line, but the bound must hold for ANY input).
		const hostileCatalogue = catalogueOf([
			info({ name: "sneaky", description: "line one\nline\ttwo end" }),
		])!;
		assert.ok(hostileCatalogue.includes("- sneaky: line one line two end"));
	});

	it("control characters are stripped, not just flattened", () => {
		// ANSI sequences, bells, and bare ESC bytes - the whitespace collapse
		// alone would let them ride into the parent's system prompt.
		const controlCatalogue = catalogueOf([
			info({ name: "sneakier", description: "x\u0007y \u001b[31mz \u001bw" }),
		])!;
		assert.ok(controlCatalogue.includes("- sneakier: xy z w"), "ANSI, bell, and bare ESC are stripped");
		assert.ok(!controlCatalogue.includes("\u001b") && !controlCatalogue.includes("\u0007"),
			"no escape byte survives into the catalogue");
	});

	it("the overview sanitizes hostile text and measures in terminal columns", () => {
		const hostileOverview = formatAgentOverviewLines(
			[
				info({
					name: "sneaky",
					description: `bad\u001b${"A".repeat(120)}`,
					details: `worse\u001b${"B".repeat(120)}`,
				}),
			],
			50,
			{ global: globalDefs, project: projectDefs },
		);
		assert.ok(hostileOverview.every((l) => visibleWidth(l) <= 50), "hostile overview text fits the width");
		assert.ok(!hostileOverview.join("\n").includes("\u001b"), "no escape byte survives into the overview");
	});

	const withModels = formatAgentCatalogue([info({ name: "worker", description: "W." })], ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.6-sol"])!;

	it("usable models follow the agents as exact ids for the model parameter", () => {
		assert.ok(withModels.includes("`model` parameter of subagent_spawn"));
		assert.ok(withModels.includes("- openai-codex/gpt-5.6-terra\n- openai-codex/gpt-5.6-sol"));
		assert.ok(withModels.indexOf("- worker (default): W.") < withModels.indexOf("- openai-codex/gpt-5.6-terra"));
	});

	it("no usable models means no models section", () => {
		assert.ok(!catalogueOf([info({ name: "worker", description: "W." })])!.includes("Usable models"));
	});

	it("models alone never create a catalogue", () => {
		assert.strictEqual(formatAgentCatalogue([], ["openai-codex/gpt-5.6-sol"]), undefined);
	});

	it("a long model list is bounded with a pointer", () => {
		const ids = Array.from({ length: USABLE_MODELS_MAX_LISTED + 2 }, (_, i) => `p/m${i}`);

		const bounded = formatAgentCatalogue([info({ name: "worker", description: "W." })], ids)!;

		assert.ok(bounded.includes(`- p/m${USABLE_MODELS_MAX_LISTED - 1}\n- +2 more (call subagent_available for the full list)`));
		assert.ok(!bounded.includes(`- p/m${USABLE_MODELS_MAX_LISTED}\n`));
	});

	it("model ids are flattened and stripped like descriptions", () => {
		const hostile = formatAgentCatalogue([info({ name: "worker", description: "W." })], ["p/m\u001b[31m\nx"])!;

		assert.ok(hostile.includes("- p/m x") && !hostile.includes("\u001b"));
	});

	it("the system-prompt injection rides only when spawning is possible", () => {
		const events = createTestEventHarness<
			{ systemPrompt: string },
			undefined,
			{ systemPrompt: string } | undefined
		>();
		let activeTools = ["subagent_spawn"];
		registerCatalogue({
			on: events.on,
			getActiveTools: () => activeTools,
		} as unknown as Parameters<typeof registerCatalogue>[0]);
		const beforeAgentStart = (systemPrompt: string) =>
			events.emitResults("before_agent_start", { systemPrompt }, undefined)[0];
		updateCatalogue([info({ name: "worker", description: "W." })], []);
		const injected = beforeAgentStart("BASE");
		assert.ok(Boolean(injected?.systemPrompt.startsWith("BASE\n\n") &&
			injected.systemPrompt.includes("- worker (default): W.") &&
			injected.systemPrompt.endsWith(WAITING_CONTRACT)),
			"catalogue and waiting contract are appended to the system prompt");
		assert.ok(WAITING_CONTRACT.includes("Ending your turn is how you wait") &&
			WAITING_CONTRACT.includes("tell the user in one line what you are waiting on and end your turn"),
			"waiting contract prescribes the action instead of prohibiting");
		activeTools = [];
		assert.strictEqual(beforeAgentStart("BASE"), undefined,
			"nothing is injected while subagent_spawn is inactive");
		activeTools = ["subagent_spawn"];
		updateCatalogue([], []);
		assert.strictEqual(beforeAgentStart("BASE"), undefined,
			"nothing is injected while no agents exist");
	});
});
