export type ChildStatus = "running" | "completed" | "failed" | "cancelled";
export type ChildMode = "background" | "foreground";
export type ChildContext = "fresh" | "fork";

export interface Worktree {
	path: string;
	branch: string;
}

/**
 * What every surface says about one child: the registry, the tool result details written to the
 * parent's session file, the footer, `/subagents`, and the completion message.
 */
export interface ChildSummary {
	id: string;
	title: string;
	mode: ChildMode;
	context: ChildContext;
	status: ChildStatus;
	model: string;
	effort: string;
	cwd: string;
	worktree?: Worktree | undefined;
	sessionFile?: string | undefined;
	error?: string | undefined;
}
