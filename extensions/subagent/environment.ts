import { parseArgs } from "@earendil-works/pi-coding-agent";

export interface ParentExtensionFlags {
	/** Extension paths and `builtin:<name>` entries the parent was started with via `-e`. */
	paths: string[];
	noExtensions: boolean;
}

/**
 * The parent's `-e` and `--no-extensions` flags. Children discover extensions for their own
 * directory, which would otherwise ignore what the parent process was started with.
 */
export function parentExtensionFlags(argv: readonly string[]): ParentExtensionFlags {
	const args = parseArgs([...argv]);
	return { paths: args.extensions ?? [], noExtensions: args.noExtensions ?? false };
}

/** A child declares exactly the parent's active tools, minus this extension's own tool. */
export function childToolNames(parentActiveTools: readonly string[]): string[] {
	return parentActiveTools.filter((name) => name !== "subagent");
}

export interface ChildTrustInput {
	childCwd: string;
	parentCwd: string;
	parentTrusted: boolean;
	/** The child's cwd is a worktree this call created from the parent's repository. */
	createdWorktree: boolean;
	/** Pi's persisted decision for a directory or its nearest trusted ancestor. */
	storedDecision: (cwd: string) => boolean | null;
	/** Whether the directory has project-local resources that only run when trusted. */
	requiresTrust: (cwd: string) => boolean;
}

/**
 * A child inside the parent's project, or in a worktree made from it, inherits the parent's trust.
 * Anywhere else follows the user's stored decision, and is trusted only when nothing there needs it.
 */
export function resolveChildTrust(input: ChildTrustInput): boolean {
	if (input.createdWorktree || isWithin(input.childCwd, input.parentCwd)) return input.parentTrusted;

	const stored = input.storedDecision(input.childCwd);
	if (stored !== null) return stored;
	return !input.requiresTrust(input.childCwd);
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}
