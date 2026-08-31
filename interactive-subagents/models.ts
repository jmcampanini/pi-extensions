/**
 * models.ts - picking a usable model from an agent's candidate list, and
 * listing the models a spawn may name at all.
 *
 * Walk an ordered list of model candidates and pick the FIRST usable one.
 * An entry is either:
 *   - "provider/model" - fully qualified; wins if pi knows it AND that
 *     provider has credentials configured on this machine, or
 *   - a bare model id like "gpt-5.5" - wins if EXACTLY ONE configured
 *     provider offers that exact id here (so the same agent file picks the
 *     right provider on each machine). Two configured providers offering the
 *     same id is ambiguous and fails that entry - we never guess, and we
 *     never fuzzy-match.
 *
 * Nothing matching is a hard, immediate error (fail fast so a broken agent
 * file gets fixed, instead of a child pane dying later with a confusing
 * provider error). The error ends with the usable ids, so a nickname guess
 * like "terra" corrects itself in one step instead of a `pi --list-models`
 * detour. Winners are returned in canonical "provider/model" form, so the
 * launch script always records exactly what ran.
 *
 * This module is dependency-free on purpose: it sees pi's model registry
 * through the minimal ModelLookup interface below, which keeps it unit-
 * testable with a plain fake object.
 */

/** Pi's thinking/effort levels (mirrors pi's ModelThinkingLevel). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Fail fast on a typo'd thinking level instead of letting the child pane error. */
export function assertValidThinkingLevel(level: string): void {
	if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
		throw new Error(`Invalid thinking level "${level}" - valid levels: ${THINKING_LEVELS.join(", ")}.`);
	}
}

export interface KnownModel {
	provider: string;
	id: string;
}

/** The slice of pi's ModelRegistry this module needs. */
export interface ModelLookup {
	getAll(): KnownModel[];
	hasConfiguredAuth(model: KnownModel): boolean;
}

/** Where the usable-model list comes from; pi's ExtensionContext satisfies it. */
export interface UsableModelSource {
	/** The session's scoped models (`enabledModels` / `--models`); empty = unscoped. */
	scopedModels: readonly { model: KnownModel }[];
	modelRegistry: { getAvailable(): KnownModel[] };
	/** The parent's active model, if one is selected. */
	model: KnownModel | undefined;
}

export interface UsableModels {
	/** Canonical "provider/model" ids a spawn may name, in catalogue order. */
	ids: string[];
	/** The parent's active model in canonical form; absent when none is selected. */
	current?: string;
}

/** Rows shown before a "+N more" trailer wherever the list is bounded. */
export const USABLE_MODELS_MAX_LISTED = 20;

/**
 * The models a spawn may name on this machine: the session's scoped models
 * when the user scoped any (mirroring pi's own model picker), else every
 * model whose provider has credentials.
 */
export function listUsableModels(source: UsableModelSource): UsableModels {
	const models = source.scopedModels.length > 0
		? source.scopedModels.map((scoped) => scoped.model)
		: source.modelRegistry.getAvailable();

	const ids = models.map(canonicalId);
	return source.model ? { ids, current: canonicalId(source.model) } : { ids };
}

/** A bounded, comma-separated rendering of usable ids for prose and errors. */
export function summarizeUsableModels(ids: readonly string[], max = USABLE_MODELS_MAX_LISTED): string {
	const hidden = ids.length - max;
	if (hidden <= 0) return ids.join(", ");
	return `${ids.slice(0, max).join(", ")}, +${hidden} more (call subagent_available for the full list)`;
}

function canonicalId(model: KnownModel): string {
	return `${model.provider}/${model.id}`;
}

export function resolveUsableModel(
	candidates: string[],
	registry: ModelLookup,
	usableModelIds: readonly string[],
): string {
	const reasons: string[] = [];

	for (const entry of candidates) {
		// The provider is everything before the FIRST slash (pi's own rule -
		// some model ids contain slashes, e.g. openrouter/deepseek/deepseek-chat).
		const slash = entry.indexOf("/");
		if (slash === 0 || slash === entry.length - 1) {
			reasons.push(`${entry} - malformed (use "provider/model" or a bare model id)`);
			continue;
		}

		// Bare model id: exact-id match among providers with credentials.
		if (slash === -1) {
			const id = entry.toLowerCase();
			const usable = registry
				.getAll()
				.filter((m) => m.id.toLowerCase() === id && registry.hasConfiguredAuth(m));
			if (usable.length === 1) {
				return canonicalId(usable[0]);
			}
			if (usable.length > 1) {
				const providers = usable.map((m) => m.provider).join(", ");
				reasons.push(`${entry} - ambiguous: offered by ${providers}; qualify it as "provider/${entry}"`);
				continue;
			}
			const known = registry.getAll().filter((m) => m.id.toLowerCase() === id);
			reasons.push(
				known.length > 0
					? `${entry} - known (${known.map((m) => m.provider).join(", ")}) but none of those providers have credentials on this machine`
					: `${entry} - unknown model (not in pi's registry)`,
			);
			continue;
		}

		// Fully qualified: case-insensitive exact match on provider + id.
		const provider = entry.slice(0, slash).toLowerCase();
		const id = entry.slice(slash + 1).toLowerCase();
		const model = registry
			.getAll()
			.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
		if (!model) {
			reasons.push(`${entry} - unknown model (not in pi's registry)`);
			continue;
		}
		if (!registry.hasConfiguredAuth(model)) {
			reasons.push(`${entry} - provider "${model.provider}" has no credentials on this machine`);
			continue;
		}
		return canonicalId(model);
	}

	// Per-entry reasons say what was wrong; the usable list says what to use.
	const usable = usableModelIds.length > 0
		? `\nUsable models (exact ids): ${summarizeUsableModels(usableModelIds)}`
		: "";
	throw new Error(`No usable model. Tried, in order:\n${reasons.map((r) => `  - ${r}`).join("\n")}${usable}`);
}
