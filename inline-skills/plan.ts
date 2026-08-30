export type SubmitPlan =
	| { kind: "pass" }
	| { kind: "hoist"; name: string; text: string }
	| { kind: "conflict"; names: string[] };

// Pi validates skill names as lowercase [a-z0-9-], so $PATH-style environment
// variables can never match. The leading boundary keeps "$name" (quoted) and
// $$name inert; the trailing set lets a mention end a clause: "$name, then…".
const MENTION_PATTERN = /(?:^|\s)\$([a-z0-9-]+)(?=$|\s|[.,;:!?)}\]])/g;

/**
 * Decide what to do with a submitted message. Exactly one mention of an
 * installed skill hoists pi's native command onto the front (the sigil stays
 * in the sentence); two or more fail closed rather than guess which one wins,
 * since native /skill: expansion can only apply a single skill per message.
 */
export function planSubmit(text: string, knownSkillNames: ReadonlySet<string>): SubmitPlan {
	// A leading "/" is an explicit command, skill, or template invocation -
	// pi's own expanders own it, and hoisting would double-prefix.
	if (text.startsWith("/")) return { kind: "pass" };

	const mentions: string[] = [];
	for (const match of text.matchAll(MENTION_PATTERN)) {
		const name = match[1];
		if (knownSkillNames.has(name)) mentions.push(name);
	}

	const first = mentions[0];
	if (first === undefined) return { kind: "pass" };
	if (mentions.length > 1) return { kind: "conflict", names: mentions };
	return { kind: "hoist", name: first, text: `/skill:${first} ${text}` };
}
