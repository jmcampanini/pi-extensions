import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";

/** What a child inherits from the way the parent process was started. */
export interface ParentFlags {
	/** The parent's `-e` entries: file paths made absolute, `builtin:<name>` and other sources kept as given. */
	extensions: string[];
	noExtensions: boolean;
}

const SOURCE_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Children discover extensions for their own directory, which would otherwise ignore what the
 * parent process was started with. Relative paths are resolved against the parent's cwd because
 * the child's loader would resolve them against the child's.
 */
export function parentFlags(argv: readonly string[], parentCwd: string): ParentFlags {
	const args = parseArgs([...argv]);
	const extensions = (args.extensions ?? []).map((entry) => (SOURCE_PREFIX.test(entry) || entry.startsWith("~") || isAbsolute(entry) ? entry : resolve(parentCwd, entry)));
	return { extensions, noExtensions: args.noExtensions ?? false };
}

/**
 * T3 Code sets this to the path of the bridge extension it injects into the Pi processes that run
 * its threads, and passes the same path with --extension.
 */
const T3_BRIDGE_ENV = "T3_PI_MCP_EXTENSION_PATH";

/**
 * Whether T3 Code launched this process to run one of its threads. T3 records only the turns it
 * starts, so a background report, which starts its own turn, never reaches the thread; under T3,
 * delegation belongs to its delegate_task tool. The variable alone is not enough: a Pi started from
 * a T3 thread's bash tool inherits it without being run by T3.
 */
export function launchedByT3Code(env: NodeJS.ProcessEnv, flags: ParentFlags): boolean {
	const bridge = env[T3_BRIDGE_ENV];
	if (!bridge) return false;

	return flags.extensions.some((entry) => resolve(entry) === resolve(bridge));
}

/** A child declares exactly the parent's active tools, minus this extension's own tool. */
export function childToolNames(parentActiveTools: readonly string[]): string[] {
	return parentActiveTools.filter((name) => name !== "subagent");
}

export interface ChildTrustInput {
	/** The directory the child was asked to work in, before any worktree is created from it. */
	childCwd: string;
	parentCwd: string;
	parentTrusted: boolean;
	/** Pi's persisted decision for a directory or its nearest trusted ancestor. */
	storedDecision: (cwd: string) => boolean | null;
	/** Whether the directory has project-local resources that only run when trusted. */
	requiresTrust: (cwd: string) => boolean;
}

/**
 * A child inside the parent's project inherits the parent's trust. Anywhere else follows the
 * user's stored decision, and is trusted only when nothing there needs it. A worktree takes the
 * trust of the directory it was created from.
 */
export function resolveChildTrust(input: ChildTrustInput): boolean {
	if (isWithin(input.childCwd, input.parentCwd)) return input.parentTrusted;

	const stored = input.storedDecision(input.childCwd);
	if (stored !== null) return stored;
	return !input.requiresTrust(input.childCwd);
}

function isWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}
