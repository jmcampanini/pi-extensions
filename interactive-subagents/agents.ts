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
import { homedir } from "node:os";
import { join } from "node:path";
import { assertValidAgentIdentifier, isValidAgentIdentifier } from "./agent-identifier.ts";
import { agentConfigDir } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { harnessProfile, validHarnessValues } from "./harnesses.ts";
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
	/** Compact routing text for the parent model (bounded in the injected
	 * catalogue; see formatAgentCatalogue). */
	description?: string;
	/** Optional expanded explanation for humans and explicit model discovery
	 * (subagent_list, /subagent-available). Never injected into the catalogue;
	 * those surfaces fall back to the full description when absent. */
	details?: string;
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
	/** "forked" (inherit parent conversation) or "fresh" (clean context). */
	context?: "fresh" | "forked";
	/** true = autonomous (exits when its turn completes). Default true. */
	autoExit?: boolean;
	/** true = spawn this agent in a fresh git worktree by default. */
	worktree?: boolean;
	/** Which tool runs the child. Absent or "pi" = a pi child (all existing
	 * behavior); an external name ("claude-code") = that tool's profile in
	 * harnesses.ts drives the launch. Only set when the value is valid. */
	harness?: string;
	/** Extra command-line flags appended VERBATIM to the launch command -
	 * where tool-specific flag knowledge lives, kept out of the core. Applies
	 * to pi children too, for uniform semantics. */
	harnessPassThrough?: string;
	/**
	 * Problems found in the frontmatter itself (e.g. an unknown `context:` or
	 * `worktree:` value). Kept on the definition (not just the inventory) so
	 * spawning can fail loud instead of silently running with a default the
	 * file didn't ask for.
	 */
	problems: string[];
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

	const rawContext = frontmatterValue(frontmatter, "context");
	const rawAutoExit = frontmatterValue(frontmatter, "auto-exit");
	const rawWorktree = frontmatterValue(frontmatter, "worktree");
	const rawModels = frontmatterValue(frontmatter, "models");
	const rawHarness = frontmatterValue(frontmatter, "harness");

	const problems: string[] = [];
	// Unknown values are problems, not silent defaults — a typo in `context:`
	// quietly spawning a fresh child would hide a forked-context intent.
	if (rawContext !== undefined && rawContext !== "fresh" && rawContext !== "forked") {
		problems.push(`invalid context "${rawContext}" — use "fresh" or "forked"`);
	}
	// Same loudness for worktree: `worktree: yes` silently spawning WITHOUT
	// isolation would be exactly the parallel-edit hazard the flag prevents.
	if (rawWorktree !== undefined && rawWorktree !== "true" && rawWorktree !== "false") {
		problems.push(`invalid worktree "${rawWorktree}" — use "true" or "false"`);
	}
	// Harness names come from the profile registry; a typo silently spawning
	// a pi child instead of the intended external tool would be the exact
	// wrong-tool hazard the key exists to prevent.
	const harnessValid = rawHarness === undefined || rawHarness === "pi" || harnessProfile(rawHarness) !== undefined;
	if (!harnessValid) {
		problems.push(`invalid harness "${rawHarness}" - valid values: ${validHarnessValues().join(", ")}`);
	}
	// A forked context copies a pi conversation into the child; an external
	// tool cannot open one, so the combination can never work.
	if (harnessValid && rawHarness !== undefined && rawHarness !== "pi" && rawContext === "forked") {
		problems.push(
			`context "forked" is not supported with harness "${rawHarness}" - a pi conversation cannot be transplanted into a different tool`,
		);
	}

	return {
		name,
		source,
		filePath,
		description: frontmatterValue(frontmatter, "description"),
		details: frontmatterValue(frontmatter, "details"),
		models: rawModels
			? rawModels.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")
			: undefined,
		thinking: frontmatterValue(frontmatter, "thinking"),
		tools: frontmatterValue(frontmatter, "tools"),
		context: rawContext === "forked" || rawContext === "fresh" ? rawContext : undefined,
		autoExit: rawAutoExit === "true" ? true : rawAutoExit === "false" ? false : undefined,
		worktree: rawWorktree === "true" ? true : rawWorktree === "false" ? false : undefined,
		harness: harnessValid ? rawHarness : undefined,
		harnessPassThrough: frontmatterValue(frontmatter, "harness-pass-through"),
		problems,
		body,
	};
}

export function loadAgentDefinition(name: string, cwd: string): AgentDefinition | null {
	assertValidAgentIdentifier(name);
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
			.map((file) => file.slice(0, -3))
			.filter(isValidAgentIdentifier);
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
// problems that would break a spawn. The model-facing subagent_list tool
// and the human-facing /subagent-available command are both views over this —
// they differ only in how much of it they show.

export interface AgentInfo {
	name: string;
	/** Which layer it came from — "project" (.pi/subagents) or "global". */
	source: "project" | "global";
	description?: string;
	/** Expanded explanation for the detailed surfaces; absent = they fall
	 * back to the full description. */
	details?: string;
	/** The definition file this agent came from. */
	filePath: string;
	/** The frontmatter model candidates, verbatim. Empty = no models listed
	 * (the child simply inherits the parent's model). */
	requestedModels: string[];
	/** The model that wins on this machine (canonical provider/model), if the agent lists any. */
	resolvedModel?: string;
	thinking?: string;
	tools?: string;
	context: "fresh" | "forked";
	autoExit: boolean;
	/** true = this agent runs in a fresh git worktree by default. */
	worktree: boolean;
	/** Which tool runs the child; "pi" unless the frontmatter says otherwise. */
	harness: string;
	/** Extra command-line flags appended verbatim to the launch command. */
	harnessPassThrough?: string;
	/** Anything that would break or degrade spawning this agent. Empty = valid. */
	problems: string[];
}

/** A thrown Error's message, trimmed. Line breaks are KEPT — each view
 * decides for itself: the overview widget indents them, the terse
 * subagent_list tool flattens them. */
function problemText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim();
}

export function collectAgentInventory(registry: ModelLookup, cwd: string): AgentInfo[] {
	return listAgentDefinitions(cwd).map((def) => {
		const problems: string[] = [...def.problems];
		let resolvedModel: string | undefined;
		const harness = def.harness ?? "pi";
		// External model names are the tool's own: pi's registry never applies,
		// the FIRST entry is what runs, verbatim. Same for thinking: the
		// profile's effort mapping is the validity check, not pi's levels.
		const profile = harness === "pi" ? undefined : harnessProfile(harness);

		if (def.models && def.models.length > 0) {
			if (profile) {
				resolvedModel = def.models[0];
			} else {
				try {
					resolvedModel = resolveUsableModel(def.models, registry);
				} catch (error) {
					problems.push(problemText(error));
				}
			}
		}
		if (def.thinking) {
			try {
				if (profile) profile.mapEffort(def.thinking);
				else assertValidThinkingLevel(def.thinking);
			} catch (error) {
				problems.push(problemText(error));
			}
		}

		return {
			name: def.name,
			source: def.source,
			description: def.description,
			details: def.details,
			filePath: def.filePath,
			requestedModels: def.models ?? [],
			resolvedModel,
			thinking: def.thinking,
			tools: def.tools,
			context: def.context ?? "fresh",
			autoExit: def.autoExit ?? true,
			worktree: def.worktree ?? false,
			harness,
			harnessPassThrough: def.harnessPassThrough,
			problems,
		};
	});
}

// ── the model-facing catalogue (injected into the system prompt) ─────────
// A compact routing list - one line per agent - so the parent can match work
// to an agent without a subagent_list round trip (catalogue.ts owns when it
// is computed and injected). Descriptions are HARD-BOUNDED here: an agent
// file cannot grow every parent request, no matter what its author writes.
// The full text stays reachable through subagent_list and the overview.

/** Per-agent cap on catalogue description text, in visible characters. */
export const CATALOGUE_DESCRIPTION_MAX_CHARS = 200;

/** One line, control characters stripped, hard-capped with an ellipsis.
 * Operates on code points so the cut can never split a surrogate pair. The
 * source description is never modified - only this rendering is bounded. */
function boundedDescription(description: string | undefined): string {
	if (description === undefined) return "(no description)";
	const flat = sanitizeDisplayText(description).replace(/\s+/g, " ").trim();
	if (flat === "") return "(no description)";
	const chars = Array.from(flat);
	if (chars.length <= CATALOGUE_DESCRIPTION_MAX_CHARS) return flat;
	return `${chars.slice(0, CATALOGUE_DESCRIPTION_MAX_CHARS - 1).join("")}…`;
}

/**
 * The injectable catalogue block, or undefined when there are no agents (an
 * empty "Available sub-agents:" header would only invite doomed spawns).
 * Markers appear only on agents that deviate from a plain spawnable default:
 * routing facts only - everything else is subagent_list territory. A broken
 * agent shows no description at all: advertising its purpose would invite
 * calls that can only fail, while the name + pointer still explains where
 * the details live.
 */
export function formatAgentCatalogue(inventory: AgentInfo[]): string | undefined {
	if (inventory.length === 0) return undefined;
	const lines = inventory.map((agent) => {
		if (agent.problems.length > 0) {
			return `- ${agent.name} (not spawnable - see subagent_list)`;
		}
		const markers: string[] = [];
		if (agent.name === "worker") markers.push("default");
		if (agent.harness !== "pi") markers.push(`harness ${agent.harness}`);
		if (!agent.autoExit) markers.push("interactive");
		const tag = markers.length > 0 ? `${agent.name} (${markers.join(", ")})` : agent.name;
		return `- ${tag}: ${boundedDescription(agent.description)}`;
	});
	return (
		"Available sub-agents (values for the `agent` parameter of subagent_spawn):\n" +
		`${lines.join("\n")}\n\n` +
		"Descriptions above are abbreviated. Call subagent_list for expanded descriptions and configuration details."
	);
}

// ── the human-facing overview (used by /subagent-available) ──────────────
// One card per agent under a top rule: a bracketed name tag, the model that
// would run, dim dot leaders out to a right-anchored source column, then the
// description HEADLINE and only the non-default parts of the config. File
// paths are deliberately absent — the name IS the filename, so the source
// column already locates the file. Layout is computed on plain strings and
// the styling hooks are applied last, so ANSI codes never enter the width
// math (same pattern as widget.ts).

/** Optional styling hooks; identity (no styling) when omitted. */
export interface OverviewStyle {
	/** Faded chrome: dot leaders, separators, the dismiss hint. */
	dim?: (text: string) => string;
	/** Secondary facts: the count, source column, thinking/tools. */
	muted?: (text: string) => string;
	/** Agent names and the "default" marker. */
	accent?: (text: string) => string;
	/** Problem blocks and the "✗ no usable model" slot. */
	error?: (text: string) => string;
	/** Non-default run behavior ("forked", "interactive"). */
	warning?: (text: string) => string;
	/** The top rule (theme's muted border color). */
	border?: (text: string) => string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
}

/** Greedy word wrap. A single overlong word overflows on its own line. */
function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (line === "") line = word;
		else if (line.length + 1 + word.length <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line !== "") lines.push(line);
	return lines;
}

/** Wrap one line, keeping its leading indent; continuations tuck 2 deeper. */
function wrapIndented(line: string, width: number): string[] {
	const lead = line.length - line.trimStart().length;
	const parts = wrapText(line.trim(), Math.max(1, width - lead - 2));
	return parts.map((part, i) => " ".repeat(i === 0 ? lead : lead + 2) + part);
}

/** Absolute paths read shorter with the home dir as ~. */
function tildify(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Last-resort truncation by VISIBLE characters (ANSI sequences pass through
 * for free). The width contract is HARD: pi-tui treats a rendered line wider
 * than the terminal as fatal and kills the whole session, so every line the
 * overview returns goes through this — the layout math above it only has to
 * be right for realistic inputs, not pathological ones.
 */
function clampVisible(line: string, width: number): string {
	let visible = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\u001b") {
			const end = line.indexOf("m", i);
			if (end === -1) break;
			i = end + 1;
			continue;
		}
		if (visible === width) {
			const cut = line.slice(0, i);
			// Close any open styling so the truncation can't bleed color.
			return cut.includes("\u001b") ? `${cut}\u001b[0m` : cut;
		}
		visible++;
		i++;
	}
	return line;
}

/**
 * The scannable headline of a description: everything before the first
 * " — " or first sentence end, whichever comes first. Definitions follow a
 * "headline — spawn-time guidance" shape, and the guidance is for the model
 * choosing an agent; the human overview only needs the headline (the
 * subagent_list tool keeps the full text). The headline is never truncated,
 * only wrapped.
 */
export function descriptionHeadline(description: string): string {
	const boundaries: number[] = [];
	const dash = description.indexOf(" — ");
	if (dash >= 0) boundaries.push(dash);
	// A sentence end is punctuation before a CAPITALIZED next word — a bare
	// "period + space" would false-match abbreviations like "e.g." or "vs.".
	const sentence = description.match(/[.!?](?=\s+[A-Z])/);
	if (sentence?.index !== undefined) boundaries.push(sentence.index + 1);
	if (boundaries.length === 0) return description;
	return description.slice(0, Math.min(...boundaries)).trim();
}

/** The human-facing rendering of the inventory (used by /subagent-available). */
export function formatAgentOverviewLines(
	inventory: AgentInfo[],
	width: number,
	dirs: { global: string; project: string },
	style: OverviewStyle = {},
): string[] {
	const identity = (text: string) => text;
	const dim = style.dim ?? identity;
	const muted = style.muted ?? identity;
	const accent = style.accent ?? identity;
	const error = style.error ?? identity;
	const warning = style.warning ?? identity;
	const border = style.border ?? identity;
	const bold = style.bold ?? identity;
	const italic = style.italic ?? identity;

	if (inventory.length === 0) {
		return [
			"Sub-agents · none found",
			` global:  ${tildify(dirs.global)}`,
			` project: ${tildify(dirs.project)}`,
			...wrapText(
				"Create <name>.md files there (frontmatter: description, details, models, thinking, tools, context, auto-exit, worktree, harness, harness-pass-through; body = system prompt).",
				Math.max(1, width - 1),
			).map((wrapped) => ` ${wrapped}`),
		].map((line) => clampVisible(line, width));
	}

	// Tag column: "[scout]" padded so every card's body starts at the same
	// column (the same tag-column idea as the running widget).
	const tags = inventory.map((agent) => `[${agent.name}]`);
	const tagWidth = Math.max(...tags.map((tag) => tag.length));
	const indent = 1 + tagWidth + 2;
	const pad = " ".repeat(indent);
	const body = Math.max(1, width - indent);

	const head = `── Sub-agents · ${inventory.length} `;
	const lines: string[] = [
		border("── ") +
			bold("Sub-agents") +
			muted(` · ${inventory.length} `) +
			border("─".repeat(Math.max(0, width - head.length))),
	];

	for (let i = 0; i < inventory.length; i++) {
		const agent = inventory[i];
		if (i > 0) lines.push("");

		// Header row: [name]  model ······· source (· default). The model slot
		// answers the #1 question — what would this agent run on. When
		// resolution failed it says so in red; when no models are listed the
		// child inherits the parent's model, which reads quieter on purpose.
		const slot = agent.resolvedModel
			? { text: agent.resolvedModel, paint: bold }
			: agent.requestedModels.length > 0
				? { text: "✗ no usable model", paint: (text: string) => bold(error(text)) }
				: { text: "inherits parent model", paint: (text: string) => italic(muted(text)) };
		const isDefault = agent.name === "worker";
		const right = agent.source + (isDefault ? " · default" : "");
		// The dots absorb the leftover width (min 3); a too-long model slot
		// gives way with an ellipsis — or vanishes entirely on an absurdly
		// narrow pane — so the source column stays anchored.
		let slotText = slot.text;
		const maxSlot = width - indent - right.length - 2 - 3;
		if (slotText.length > maxSlot) {
			slotText = maxSlot >= 2 ? `${slotText.slice(0, maxSlot - 1)}…` : maxSlot === 1 ? "…" : "";
		}
		const dots = Math.max(3, width - indent - slotText.length - right.length - 2);
		lines.push(
			" " +
				dim("[") +
				accent(agent.name) +
				dim("]") +
				" ".repeat(indent - 1 - tags[i].length) +
				slot.paint(slotText) +
				" " +
				dim(".".repeat(dots)) +
				" " +
				muted(agent.source) +
				(isDefault ? dim(" · ") + accent("default") : ""),
		);

		// Problems: loud and structured, pinned right under the header. The
		// message's own line breaks are kept (so "Tried, in order:" bullets
		// stay bullets); wrapped continuations tuck 2 columns deeper.
		for (const problem of agent.problems) {
			const problemLines = problem.split("\n");
			problemLines[0] = `⚠ ${problemLines[0]}`;
			problemLines.forEach((problemLine, lineIndex) => {
				for (const wrapped of wrapIndented(problemLine, body)) {
					lines.push(pad + (lineIndex === 0 ? bold(error(wrapped)) : error(wrapped)));
				}
			});
		}

		// Description and details render sanitized: clampVisible treats a raw
		// ESC as ANSI it cannot measure, so an unsanitized frontmatter value
		// could yield an overwide line - which the width contract makes fatal.
		// Description: the headline only, wrapped in full (never truncated).
		if (agent.description) {
			for (const wrapped of wrapText(descriptionHeadline(sanitizeDisplayText(agent.description)), body)) {
				lines.push(pad + wrapped);
			}
		}

		// Details: the expanded human explanation, in full but visually
		// tertiary so the cards still scan by headline.
		if (agent.details) {
			for (const wrapped of wrapText(sanitizeDisplayText(agent.details), body)) {
				lines.push(pad + dim(wrapped));
			}
		}

		// Meta row: only what deviates from a plain default agent — a fully
		// default one gets no row at all. Run-behavior deviations render loud.
		const parts: { text: string; paint: (text: string) => string }[] = [];
		// A non-pi harness changes what program runs the child entirely - the
		// loudest deviation there is, so it leads the row.
		if (agent.harness !== "pi") parts.push({ text: agent.harness, paint: warning });
		if (agent.thinking) parts.push({ text: `thinking ${agent.thinking}`, paint: muted });
		if (agent.tools) parts.push({ text: `tools: ${agent.tools}`, paint: muted });
		if (agent.harnessPassThrough) parts.push({ text: `pass-through: ${agent.harnessPassThrough}`, paint: muted });
		if (agent.context === "forked") parts.push({ text: "forked", paint: warning });
		if (!agent.autoExit) parts.push({ text: "interactive", paint: warning });
		// Worktree isolation changes where the child runs — a run-behavior
		// deviation, so it renders loud like forked/interactive.
		if (agent.worktree) parts.push({ text: "worktree", paint: warning });
		let row = "";
		let rowLength = 0;
		const flushRow = () => {
			if (rowLength > 0) lines.push(pad + row);
			row = "";
			rowLength = 0;
		};
		for (const part of parts) {
			// A part that alone exceeds the body (a big tools allowlist) wraps
			// onto its own rows instead of overflowing the line.
			if (part.text.length > body) {
				flushRow();
				for (const wrapped of wrapText(part.text, body)) lines.push(pad + part.paint(wrapped));
				continue;
			}
			if (rowLength > 0 && rowLength + 3 + part.text.length > body) flushRow();
			row += (rowLength > 0 ? dim(" · ") : "") + part.paint(part.text);
			rowLength += (rowLength > 0 ? 3 : 0) + part.text.length;
		}
		flushRow();
	}

	lines.push("");
	for (const wrapped of wrapText("run /subagent-available again or send a message to dismiss", Math.max(1, width - 1))) {
		lines.push(dim(` ${wrapped}`));
	}
	return lines.map((line) => clampVisible(line, width));
}
