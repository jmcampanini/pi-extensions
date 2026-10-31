import type { ChildSummary, Worktree } from "./child.ts";

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

export interface CompletionSummary extends ChildSummary {
	durationMs: number;
	result: string;
	truncated: boolean;
}

/** The opening words of every completion message; the tool description tells the model to expect them. */
export function completionPrefix(title: string): string {
	return `Subagent "${title}"`;
}

/** The user message the parent receives when a background subagent finishes. */
export function formatCompletionMessage(summary: CompletionSummary): string {
	const lines = [`${completionPrefix(summary.title)} ${summary.status} (id ${summary.id}, ${summary.model}, ${formatDuration(summary.durationMs)}).`, `Worked in ${summary.cwd}.`];
	if (summary.sessionFile) lines.push(`Child session: ${summary.sessionFile}`);
	if (summary.error) lines.push(`Error: ${summary.error}`);
	lines.push("", ...reportBody(summary));
	return lines.join("\n");
}

/** The tool result text of a foreground subagent. */
export function formatForegroundReport(summary: CompletionSummary): string {
	const lines = summary.error ? [`Subagent ${summary.status}: ${summary.error}`] : [];
	lines.push(...reportBody(summary));
	return lines.join("\n");
}

function reportBody(summary: CompletionSummary): string[] {
	const lines = [summary.result.length > 0 ? summary.result : "(the subagent produced no final text)"];
	if (summary.truncated) lines.push("", `[Result truncated. The full transcript is in the child session file${summary.sessionFile ? `: ${summary.sessionFile}` : ""}.]`);
	if (summary.worktree) lines.push("", worktreeNote(summary.worktree));
	return lines;
}

function worktreeNote(worktree: Worktree): string {
	return `Worktree ${worktree.path} on branch ${worktree.branch} was left in place.`;
}

/** The tool result text returned as soon as a background subagent is running. */
export function backgroundStartedText(summary: ChildSummary): string {
	const where = summary.worktree ? `worktree ${summary.worktree.path} on branch ${summary.worktree.branch}` : summary.cwd;
	return `Started subagent "${summary.title}" (id ${summary.id}) in the background with ${summary.model} at effort ${summary.effort}, working in ${where}. Its report will arrive as a user message beginning ${completionPrefix(summary.title)}. Do not wait or poll for it.`;
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
