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
 * This module reads files and pi's model registry through the minimal
 * ModelLookup interface; its only UI dependency is pi-tui's text metrics.
 */

import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertValidAgentIdentifier, isValidAgentIdentifier } from "./agent-identifier.ts";
import { agentConfigDir } from "./config.ts";
import { sanitizeDisplayText } from "./display-text.ts";
import { harnessProfile, isExternalHarness, validHarnessValues } from "./harnesses.ts";
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
	 * (subagent_available, /subagent-available). Never injected into the catalogue;
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
	/** "forked" (inherit parent conversation) or "new" (clean context). */
	context?: "new" | "forked";
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
	// quietly spawning a new child would hide a forked-context intent.
	if (rawContext !== undefined && rawContext !== "new" && rawContext !== "forked") {
		problems.push(`invalid context "${rawContext}" — use "new" or "forked"`);
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
	if (harnessValid && rawHarness !== undefined && isExternalHarness(rawHarness) && rawContext === "forked") {
		problems.push(
			'context "forked" requires the pi harness - external sub-agents are new-only (a pi conversation cannot be transplanted into a different tool)',
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
		context: rawContext === "forked" || rawContext === "new" ? rawContext : undefined,
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
// problems that would break a spawn. The model-facing subagent_available tool
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
	context: "new" | "forked";
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

/** The discovery vocabulary for an agent's context capability. */
export function contextMode(agent: Pick<AgentInfo, "harness" | "context">): "new" | "forked" | "new-only" {
	return isExternalHarness(agent.harness) ? "new-only" : agent.context;
}

/** A thrown Error's message, trimmed. Line breaks are KEPT — each view
 * decides for itself: the overview widget indents them, the terse
 * subagent_available tool flattens them. */
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
		const profile = isExternalHarness(harness) ? harnessProfile(harness) : undefined;

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
			context: def.context ?? "new",
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
// to an agent without a subagent_available round trip (catalogue.ts owns when it
// is computed and injected). Descriptions are HARD-BOUNDED here: an agent
// file cannot grow every parent request, no matter what its author writes.
// The full text stays reachable through subagent_available and the overview.

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
 * routing facts only - everything else is subagent_available territory. A broken
 * agent shows no description at all: advertising its purpose would invite
 * calls that can only fail, while the name + pointer still explains where
 * the details live.
 */
export function formatAgentCatalogue(inventory: AgentInfo[]): string | undefined {
	if (inventory.length === 0) return undefined;
	const lines = inventory.map((agent) => {
		if (agent.problems.length > 0) {
			return `- ${agent.name} (not spawnable - see subagent_available)`;
		}
		const markers: string[] = [];
		if (agent.name === "worker") markers.push("default");
		const mode = contextMode(agent);
		if (mode === "new-only") {
			markers.push(`external: ${agent.harness}`);
			markers.push(mode);
		}
		if (!agent.autoExit) markers.push("interactive");
		const tag = markers.length > 0 ? `${agent.name} (${markers.join(", ")})` : agent.name;
		return `- ${tag}: ${boundedDescription(agent.description)}`;
	});
	return (
		"Available sub-agents (values for the `agent` parameter of subagent_spawn):\n" +
		`${lines.join("\n")}\n\n` +
		"Descriptions above are abbreviated. Call subagent_available for expanded descriptions and configuration details."
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
	/** Primary description text when the overview renders inside a tool body. */
	output?: (text: string) => string;
	/** Problem blocks and the "✗ no usable model" slot. */
	error?: (text: string) => string;
	/** Non-default run behavior ("forked", "interactive"). */
	warning?: (text: string) => string;
	/** The top rule (theme's muted border color). */
	border?: (text: string) => string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
}

function sanitizedInline(text: string): string {
	return sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
}

/** ANSI-free text wrapping measured in terminal columns. */
function wrapText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	return new Text(sanitizeDisplayText(text), 0, 0).render(safeWidth).map((line) => line.trimEnd());
}

/** Wrap one line, keeping its leading indent; continuations tuck 2 deeper. */
function wrapIndented(line: string, width: number): string[] {
	const sanitized = sanitizeDisplayText(line);
	const leadText = sanitized.match(/^ */)?.[0] ?? "";
	const lead = visibleWidth(leadText);
	const parts = wrapText(sanitized.trim(), Math.max(1, width - lead - 2));
	return parts.map((part, i) => " ".repeat(i === 0 ? lead : lead + 2) + part);
}

/** Absolute paths read shorter with the home dir as ~. */
function tildify(path: string): string {
	const home = homedir();
	return sanitizedInline(path.startsWith(home) ? `~${path.slice(home.length)}` : path);
}

/**
 * The scannable headline of a description: everything before the first
 * " — " or first sentence end, whichever comes first. Definitions follow a
 * "headline — spawn-time guidance" shape, and the guidance is for the model
 * choosing an agent; the human overview only needs the headline (the
 * subagent_available tool keeps the full text). The headline is never truncated,
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

export interface AgentOverviewOptions {
	header?: boolean;
	footer?: string | false;
	fullDescriptionFallback?: boolean;
}

/** The detailed inventory rendering shared by /subagent-available and the
 * expanded subagent_available tool card. */
export function formatAgentOverviewLines(
	inventory: AgentInfo[],
	width: number,
	dirs: { global: string; project: string },
	style: OverviewStyle = {},
	options: AgentOverviewOptions = {},
): string[] {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return [];
	const identity = (text: string) => text;
	const dim = style.dim ?? identity;
	const muted = style.muted ?? identity;
	const accent = style.accent ?? identity;
	const output = style.output ?? identity;
	const error = style.error ?? identity;
	const warning = style.warning ?? identity;
	const border = style.border ?? identity;
	const bold = style.bold ?? identity;
	const italic = style.italic ?? identity;
	const agents = inventory.map((agent) => ({
		...agent,
		name: sanitizedInline(agent.name),
		description: agent.description === undefined ? undefined : sanitizeDisplayText(agent.description),
		details: agent.details === undefined ? undefined : sanitizeDisplayText(agent.details),
		resolvedModel: agent.resolvedModel === undefined ? undefined : sanitizedInline(agent.resolvedModel),
		thinking: agent.thinking === undefined ? undefined : sanitizedInline(agent.thinking),
		tools: agent.tools === undefined ? undefined : sanitizedInline(agent.tools),
		harness: sanitizedInline(agent.harness),
		harnessPassThrough: agent.harnessPassThrough === undefined
			? undefined
			: sanitizedInline(agent.harnessPassThrough),
		problems: agent.problems.map(sanitizeDisplayText),
	}));

	if (agents.length === 0) {
		return [
			"Sub-agents · none found",
			` global:  ${tildify(dirs.global)}`,
			` project: ${tildify(dirs.project)}`,
			...wrapText(
				"Create <name>.md files there (frontmatter: description, details, models, thinking, tools, context, auto-exit, worktree, harness, harness-pass-through; body = system prompt).",
				Math.max(1, safeWidth - 1),
			).map((wrapped) => ` ${wrapped}`),
		].map((line) => truncateToWidth(line, safeWidth, ""));
	}

	// Tag column: "[scout]" padded so every card's body starts at the same
	// column (the same tag-column idea as the running widget).
	const tags = agents.map((agent) => `[${agent.name}]`);
	const tagWidth = Math.max(...tags.map(visibleWidth));
	const indent = 1 + tagWidth + 2;
	const pad = " ".repeat(indent);
	const body = Math.max(1, safeWidth - indent);

	const head = `── Sub-agents · ${agents.length} `;
	const lines: string[] = options.header === false
		? []
		: [
			border("── ") +
				bold("Sub-agents") +
				muted(` · ${agents.length} `) +
				border("─".repeat(Math.max(0, safeWidth - visibleWidth(head)))),
		];

	for (let i = 0; i < agents.length; i++) {
		const agent = agents[i];
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
		const isDefault = inventory[i].name === "worker";
		const right = agent.source + (isDefault ? " · default" : "");
		// The dots absorb the leftover width (min 3); a too-long model slot
		// gives way with an ellipsis — or vanishes entirely on an absurdly
		// narrow pane — so the source column stays anchored.
		const maxSlot = Math.max(0, safeWidth - indent - visibleWidth(right) - 2 - 3);
		const slotText = truncateToWidth(slot.text, maxSlot, maxSlot > 0 ? "…" : "");
		const dots = Math.max(3, safeWidth - indent - visibleWidth(slotText) - visibleWidth(right) - 2);
		lines.push(
			" " +
				dim("[") +
				accent(agent.name) +
				dim("]") +
				" ".repeat(Math.max(0, indent - 1 - visibleWidth(tags[i]))) +
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

		// Description text is sanitized before styling and measured in terminal
		// columns. The command uses its headline; explicit tool discovery can
		// request the full description when no separate details text exists.
		if (agent.description) {
			const description = options.fullDescriptionFallback && !agent.details
				? agent.description
				: descriptionHeadline(agent.description);
			for (const wrapped of wrapText(description, body)) {
				lines.push(pad + output(wrapped));
			}
		}

		// Details: the expanded human explanation, in full but visually
		// tertiary so the cards still scan by headline.
		if (agent.details) {
			for (const wrapped of wrapText(agent.details, body)) {
				lines.push(pad + dim(wrapped));
			}
		}

		// Meta row: only what deviates from a plain default agent — a fully
		// default one gets no row at all. Run-behavior deviations render loud.
		const parts: { text: string; paint: (text: string) => string }[] = [];
		const mode = contextMode(agent);
		// A non-pi harness changes what program runs the child entirely - the
		// loudest deviation there is, so it leads the row.
		if (mode === "new-only") {
			parts.push({ text: agent.harness, paint: warning });
			parts.push({ text: mode, paint: warning });
		}
		if (agent.thinking) parts.push({ text: `thinking ${agent.thinking}`, paint: muted });
		if (agent.tools) parts.push({ text: `tools: ${agent.tools}`, paint: muted });
		if (agent.harnessPassThrough) parts.push({ text: `pass-through: ${agent.harnessPassThrough}`, paint: muted });
		if (mode === "forked") parts.push({ text: mode, paint: warning });
		if (!agent.autoExit) parts.push({ text: "interactive", paint: warning });
		// Worktree isolation changes where the child runs — a run-behavior
		// deviation, so it renders loud like forked/interactive.
		if (agent.worktree) parts.push({ text: "worktree", paint: warning });
		let row = "";
		let rowWidth = 0;
		const flushRow = () => {
			if (rowWidth > 0) lines.push(pad + row);
			row = "";
			rowWidth = 0;
		};
		for (const part of parts) {
			const partWidth = visibleWidth(part.text);
			// A part that alone exceeds the body (a big tools allowlist) wraps
			// onto its own rows instead of overflowing the line.
			if (partWidth > body) {
				flushRow();
				for (const wrapped of wrapText(part.text, body)) lines.push(pad + part.paint(wrapped));
				continue;
			}
			if (rowWidth > 0 && rowWidth + 3 + partWidth > body) flushRow();
			row += (rowWidth > 0 ? dim(" · ") : "") + part.paint(part.text);
			rowWidth += (rowWidth > 0 ? 3 : 0) + partWidth;
		}
		flushRow();
	}

	const footer = options.footer === undefined
		? "run /subagent-available again or send a message to dismiss"
		: options.footer;
	if (footer !== false) {
		lines.push("");
		for (const wrapped of wrapText(footer, Math.max(1, safeWidth - 1))) {
			lines.push(dim(` ${wrapped}`));
		}
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}
