/**
 * agents.ts — agent definition files, and everything derived from them.
 *
 * An agent definition is `<name>.md` in a subagents dir: a small frontmatter
 * block plus a body that becomes the child's appended system prompt. The
 * FILENAME is the agent name — there is no `name:` key. Definitions load
 * from two places, most specific wins:
 *
 *   1. project — `<cwd>/.pi/subagents/`      (a repo's own agents)
 *   2. global  — `$PI_CODING_AGENT_DIR/subagents/`, default ~/.pi/agent/subagents/
 *
 * A project file SHADOWS a global one with the same name, so a repo can
 * specialize `worker.md` or `scout.md` for its own conventions.
 *
 * This module is a pure leaf: it reads files and pi's model registry (through
 * the minimal ModelLookup interface) and renders plain strings — no pi
 * imports at runtime, so it unit-tests under plain node.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentConfigDir } from "./config.ts";
import { assertValidThinkingLevel, resolveUsableModel, type ModelLookup } from "./models.ts";

// ── where definitions live ───────────────────────────────────────────────

/** The global agent-definitions dir. */
export function agentDefsDir(): string {
	return join(agentConfigDir(), "subagents");
}

/** The project-local agent-definitions dir for a working directory. */
export function projectDefsDir(cwd: string): string {
	return join(cwd, ".pi", "subagents");
}

// ── the definition itself ────────────────────────────────────────────────

export interface AgentDefinition {
	name: string;
	/** Which layer this definition came from (project shadows global). */
	source: "project" | "global";
	/** The definition file itself. */
	filePath: string;
	description?: string;
	/**
	 * Ordered model candidates, each fully qualified as "provider/model"
	 * (e.g. "openai-codex/gpt-5.5"). At spawn time the FIRST entry that is
	 * both known to pi and whose provider has credentials on this machine
	 * wins — that's what makes one agent file portable across computers
	 * with different provider setups.
	 */
	models?: string[];
	/** Thinking/effort level, passed to the child via `pi --thinking` (works
	 * with or without a models list). */
	thinking?: string;
	/** Comma-separated tool allowlist for `pi --tools`. */
	tools?: string;
	/** "fork" (inherit parent conversation) or "fresh" (clean context). */
	mode?: "fork" | "fresh";
	/** true = autonomous (exits when its turn completes). Default true. */
	autoExit?: boolean;
	/** Everything after the frontmatter: the agent's system-prompt text. */
	body: string;
}

/** Pull one `key: value` line out of a frontmatter block. */
function frontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : undefined;
}

function parseAgentMarkdown(
	name: string,
	markdown: string,
	source: "project" | "global",
	filePath: string,
): AgentDefinition {
	// Normalize Windows line endings first — otherwise the fence regex below
	// silently fails to match and the whole frontmatter is treated as body.
	markdown = markdown.replace(/\r\n/g, "\n");
	// Frontmatter = the block between the leading `---` fences (optional).
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
	const frontmatter = match ? match[1] : "";
	const body = (match ? markdown.slice(match[0].length) : markdown).trim();

	const rawMode = frontmatterValue(frontmatter, "mode");
	const rawAutoExit = frontmatterValue(frontmatter, "auto-exit");
	const rawModels = frontmatterValue(frontmatter, "models");

	return {
		name,
		source,
		filePath,
		description: frontmatterValue(frontmatter, "description"),
		models: rawModels
			? rawModels.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
			: undefined,
		thinking: frontmatterValue(frontmatter, "thinking"),
		tools: frontmatterValue(frontmatter, "tools"),
		mode: rawMode === "fork" || rawMode === "fresh" ? rawMode : undefined,
		autoExit: rawAutoExit === "true" ? true : rawAutoExit === "false" ? false : undefined,
		body,
	};
}

export function loadAgentDefinition(name: string, cwd: string): AgentDefinition | null {
	// Project first, then global — most specific wins, so a repo can
	// specialize scout/worker for its own conventions.
	const projectPath = join(projectDefsDir(cwd), `${name}.md`);
	if (existsSync(projectPath)) {
		return parseAgentMarkdown(name, readFileSync(projectPath, "utf8"), "project", projectPath);
	}
	const globalPath = join(agentDefsDir(), `${name}.md`);
	if (!existsSync(globalPath)) return null;
	return parseAgentMarkdown(name, readFileSync(globalPath, "utf8"), "global", globalPath);
}

/** All *.md names in a dir (missing dir = empty). */
function agentNamesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -3));
	} catch {
		return [];
	}
}

export function listAgentDefinitions(cwd: string): AgentDefinition[] {
	// Union of global + project names; loadAgentDefinition applies the same
	// shadowing rule, so both views can never disagree.
	const names = new Set(agentNamesIn(agentDefsDir()));
	for (const name of agentNamesIn(projectDefsDir(cwd))) names.add(name);
	return [...names]
		.sort()
		.map((name) => loadAgentDefinition(name, cwd))
		.filter((def): def is AgentDefinition => def !== null);
}

// ── the agent inventory: one loader, many presenters ─────────────────────
// Everything a consumer could want to know about each agent, loaded once:
// identity, source file, what would actually run on THIS machine, and any
// problems that would break a spawn. The model-facing subagents_list tool
// and the human-facing /subagents-available command are both views over this —
// they differ only in how much of it they show.

export interface AgentInfo {
	name: string;
	/** Which layer it came from — "project" (.pi/subagents) or "global". */
	source: "project" | "global";
	description?: string;
	/** The definition file this agent came from. */
	filePath: string;
	/** The model that wins on this machine (canonical provider/model), if the agent lists any. */
	resolvedModel?: string;
	thinking?: string;
	tools?: string;
	mode: "fork" | "fresh";
	autoExit: boolean;
	/** Anything that would break or degrade spawning this agent. Empty = valid. */
	problems: string[];
}

/** A thrown Error's message, flattened to one line for widget/list display. */
function problemText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s*\n\s*/g, " ");
}

export function collectAgentInventory(registry: ModelLookup, cwd: string): AgentInfo[] {
	return listAgentDefinitions(cwd).map((def) => {
		const problems: string[] = [];
		let resolvedModel: string | undefined;

		if (def.models && def.models.length > 0) {
			try {
				resolvedModel = resolveUsableModel(def.models, registry);
			} catch (error) {
				problems.push(problemText(error));
			}
		}
		if (def.thinking) {
			try {
				assertValidThinkingLevel(def.thinking);
			} catch (error) {
				problems.push(problemText(error));
			}
		}

		return {
			name: def.name,
			source: def.source,
			description: def.description,
			filePath: def.filePath,
			resolvedModel,
			thinking: def.thinking,
			tools: def.tools,
			mode: def.mode ?? "fresh",
			autoExit: def.autoExit ?? true,
			problems,
		};
	});
}

/** The human-facing rendering of the inventory (used by /subagents-available). */
export function formatAgentOverviewLines(
	inventory: AgentInfo[],
	dirs: { global: string; project: string },
): string[] {
	if (inventory.length === 0) {
		return [
			`Sub-agents · none found in ${dirs.global} or ${dirs.project}`,
			"  Create <name>.md files there (frontmatter: description, models, thinking, tools, mode, auto-exit; body = system prompt).",
		];
	}
	const lines: string[] = [`Sub-agents · ${inventory.length}`];
	for (const agent of inventory) {
		const thinking = agent.thinking ? ` · thinking ${agent.thinking}` : "";
		lines.push("");
		const isDefault = agent.name === "worker" ? " (default)" : "";
		lines.push(`  ${agent.name}${isDefault} — ${agent.resolvedModel ?? "default model"}${thinking}`);
		for (const problem of agent.problems) {
			lines.push(`    ⚠ ${problem}`);
		}
		if (agent.description) lines.push(`    ${agent.description}`);
		lines.push(`    tools: ${agent.tools ?? "(all)"} · ${agent.mode} · ${agent.autoExit ? "auto-exit" : "interactive"}`);
		lines.push(`    ${agent.filePath}`);
	}
	lines.push("");
	lines.push("  (run /subagents-available again or send a message to dismiss)");
	return lines;
}
