export interface SubagentSettings {
	/** Template for the directory a worktree child runs in. See expandWorktreePath for placeholders. */
	worktreePath: string;
	/** Template for the worktree branch name; `{slug}` and `{repo}` are replaced. */
	worktreeBranch: string;
	/** Result text longer than this is cut before it reaches the parent. */
	resultMaxChars: number;
	/** Result text with more lines than this is cut before it reaches the parent. */
	resultMaxLines: number;
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
	worktreePath: "~/.pi/worktrees/{repo}/{slug}",
	worktreeBranch: "pi/{slug}",
	resultMaxChars: 50_000,
	resultMaxLines: 2_000,
};

/** Reads the `subagent` key of Pi's merged settings, keeping defaults for missing or mistyped fields. */
export function readSubagentSettings(settings: Record<string, unknown>): SubagentSettings {
	const raw = settings.subagent;
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SUBAGENT_SETTINGS };

	const section = raw as Record<string, unknown>;
	return {
		worktreePath: stringOr(section.worktreePath, DEFAULT_SUBAGENT_SETTINGS.worktreePath),
		worktreeBranch: stringOr(section.worktreeBranch, DEFAULT_SUBAGENT_SETTINGS.worktreeBranch),
		resultMaxChars: positiveIntegerOr(section.resultMaxChars, DEFAULT_SUBAGENT_SETTINGS.resultMaxChars),
		resultMaxLines: positiveIntegerOr(section.resultMaxLines, DEFAULT_SUBAGENT_SETTINGS.resultMaxLines),
	};
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
