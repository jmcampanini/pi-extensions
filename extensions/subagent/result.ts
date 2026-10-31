export interface TruncateLimits {
	maxChars: number;
	maxLines: number;
}

export interface Truncated {
	text: string;
	truncated: boolean;
}

/** Cuts text to the configured size, keeping the beginning, and reports whether anything was removed. */
export function truncateResult(text: string, limits: TruncateLimits): Truncated {
	const lines = text.split("\n");
	let kept = lines.length > limits.maxLines ? lines.slice(0, limits.maxLines).join("\n") : text;
	if (kept.length > limits.maxChars) kept = kept.slice(0, limits.maxChars);

	return { text: kept, truncated: kept.length < text.length };
}

export interface CompletionSummary {
	id: string;
	title: string;
	status: "completed" | "failed" | "cancelled";
	model: string;
	cwd: string;
	durationMs: number;
	result: string;
	truncated: boolean;
	error?: string;
	sessionFile?: string;
	worktree?: { path: string; branch: string };
}

/** The user message the parent receives when a background subagent finishes. */
export function formatCompletionMessage(summary: CompletionSummary): string {
	const lines = [`Subagent "${summary.title}" ${summary.status} (id ${summary.id}, ${summary.model}, ${formatDuration(summary.durationMs)}).`];
	lines.push(`Worked in ${summary.cwd}.`);
	if (summary.worktree) lines.push(`Worktree ${summary.worktree.path} on branch ${summary.worktree.branch}; it was left in place.`);
	if (summary.sessionFile) lines.push(`Child session: ${summary.sessionFile}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	lines.push("");
	lines.push(summary.result.length > 0 ? summary.result : "(the subagent produced no final text)");
	if (summary.truncated) {
		lines.push("");
		lines.push(`[Result truncated. The full transcript is in the child session file${summary.sessionFile ? `: ${summary.sessionFile}` : ""}.]`);
	}
	return lines.join("\n");
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** A short label for lists and the footer, derived from the task when the model gave no title. */
export function deriveTitle(task: string, title?: string): string {
	const source = (title ?? task).trim().split("\n")[0] ?? "";
	return source.length > 60 ? `${source.slice(0, 57).trimEnd()}...` : source || "subagent";
}
