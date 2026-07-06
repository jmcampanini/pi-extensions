/**
 * models.ts — picking a usable model from an agent's candidate list.
 *
 * Walk an ordered list of model candidates and pick the FIRST usable one.
 * An entry is either:
 *   - "provider/model" — fully qualified; wins if pi knows it AND that
 *     provider has credentials configured on this machine, or
 *   - a bare model id like "gpt-5.5" — wins if EXACTLY ONE configured
 *     provider offers that exact id here (so the same agent file picks the
 *     right provider on each machine). Two configured providers offering the
 *     same id is ambiguous and fails that entry — we never guess, and we
 *     never fuzzy-match.
 *
 * Nothing matching is a hard, immediate error (fail fast so a broken agent
 * file gets fixed, instead of a child pane dying later with a confusing
 * provider error). Winners are returned in canonical "provider/model" form,
 * so the launch script always records exactly what ran.
 *
 * This module is dependency-free on purpose: it sees pi's model registry
 * through the minimal ModelLookup interface below, which keeps it unit-
 * testable with a plain fake object.
 */

/** Pi's thinking/effort levels (mirrors pi's ModelThinkingLevel). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Fail fast on a typo'd thinking level instead of letting the child pane error. */
export function assertValidThinkingLevel(level: string): void {
	if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
		throw new Error(`Invalid thinking level "${level}" — valid levels: ${THINKING_LEVELS.join(", ")}.`);
	}
}

interface KnownModel {
	provider: string;
	id: string;
}

/** The slice of pi's ModelRegistry this module needs. */
export interface ModelLookup {
	getAll(): KnownModel[];
	hasConfiguredAuth(model: KnownModel): boolean;
}

export function resolveUsableModel(candidates: string[], registry: ModelLookup): string {
	const reasons: string[] = [];

	for (const entry of candidates) {
		// The provider is everything before the FIRST slash (pi's own rule —
		// some model ids contain slashes, e.g. openrouter/deepseek/deepseek-chat).
		const slash = entry.indexOf("/");
		if (slash === 0 || slash === entry.length - 1) {
			reasons.push(`${entry} — malformed (use "provider/model" or a bare model id)`);
			continue;
		}

		// Bare model id: exact-id match among providers with credentials.
		if (slash === -1) {
			const id = entry.toLowerCase();
			const usable = registry
				.getAll()
				.filter((m) => m.id.toLowerCase() === id && registry.hasConfiguredAuth(m));
			if (usable.length === 1) {
				return `${usable[0].provider}/${usable[0].id}`;
			}
			if (usable.length > 1) {
				const providers = usable.map((m) => m.provider).join(", ");
				reasons.push(`${entry} — ambiguous: offered by ${providers}; qualify it as "provider/${entry}"`);
				continue;
			}
			const known = registry.getAll().filter((m) => m.id.toLowerCase() === id);
			reasons.push(
				known.length > 0
					? `${entry} — known (${known.map((m) => m.provider).join(", ")}) but none of those providers have credentials on this machine`
					: `${entry} — unknown model (not in pi's registry; see \`pi --list-models\`)`,
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
			reasons.push(`${entry} — unknown model (not in pi's registry; see \`pi --list-models\`)`);
			continue;
		}
		if (!registry.hasConfiguredAuth(model)) {
			reasons.push(`${entry} — provider "${model.provider}" has no credentials on this machine`);
			continue;
		}
		return `${model.provider}/${model.id}`;
	}

	throw new Error(
		`No usable model. Tried, in order:\n${reasons.map((r) => `  - ${r}`).join("\n")}\n` +
			`Entries are "provider/model" (or an unambiguous bare model id), known to pi, with credentials configured.`,
	);
}
