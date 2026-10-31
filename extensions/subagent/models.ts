/** The fields of a Pi model that matching needs; structural so tests need no Pi import. */
export interface ModelRef {
	provider: string;
	id: string;
	name: string;
}

export type ModelMatch<M extends ModelRef> =
	| { status: "resolved"; model: M }
	| { status: "ambiguous"; candidates: M[] }
	| { status: "not-found"; available: M[] };

/**
 * Resolves a user-facing model reference: `provider/id`, an exact id, or a case-insensitive
 * substring of an id or display name. Scoped models (the session's enabledModels) are searched
 * before every available model, so a short name like "luna" prefers what the user already chose.
 */
export function matchModel<M extends ModelRef>(reference: string, scoped: readonly M[], available: readonly M[]): ModelMatch<M> {
	const text = reference.trim();
	const lower = text.toLowerCase();

	const exact = available.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
	if (exact) return { status: "resolved", model: exact };

	for (const pool of [scoped, available]) {
		const byId = pool.filter((m) => m.id.toLowerCase() === lower);
		if (byId.length === 1) return { status: "resolved", model: byId[0]! };
		if (byId.length > 1) return { status: "ambiguous", candidates: byId };
	}

	for (const pool of [scoped, available]) {
		const partial = pool.filter((m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower));
		if (partial.length === 1) return { status: "resolved", model: partial[0]! };
		if (partial.length > 1) return { status: "ambiguous", candidates: partial };
	}

	return { status: "not-found", available: [...available] };
}

export function describeModel(model: ModelRef): string {
	return `${model.provider}/${model.id}`;
}

export function formatModelMatchError<M extends ModelRef>(reference: string, match: Exclude<ModelMatch<M>, { status: "resolved" }>): string {
	if (match.status === "ambiguous") {
		const list = match.candidates.map(describeModel).join(", ");
		return `Model "${reference}" matches several models: ${list}. Use provider/id or a longer substring.`;
	}
	const list = match.available.map(describeModel).join(", ");
	return `No available model matches "${reference}". Available: ${list || "(none with credentials)"}.`;
}
