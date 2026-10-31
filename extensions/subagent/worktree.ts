export interface WorktreeValues {
	/** Repository directory name, for example `pi-extensions`. */
	repo: string;
	/** Absolute path of the repository root. */
	repoPath: string;
	/** Host of the `origin` remote, empty when there is none. */
	host: string;
	/** Owner path of the `origin` remote, nested groups keep their slashes; empty when there is none. */
	owner: string;
	slug: string;
	branch: string;
}

const PLACEHOLDER = /\{(repo|repoPath|host|owner|slug|branch)\}/g;
const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Renders the worktree path template. `~` at the start becomes the home directory and `$VAR` or
 * `${VAR}` expand from the environment. An unset variable or a relative result is an error, so a
 * misconfigured template never lands a worktree somewhere unexpected.
 */
export function expandWorktreePath(template: string, values: WorktreeValues, env: Record<string, string | undefined>, home: string): string {
	let path = template.replace(PLACEHOLDER, (_, key: keyof WorktreeValues) => values[key]);
	path = path.replace(ENV_VAR, (_, braced: string | undefined, bare: string | undefined) => {
		const name = braced ?? bare ?? "";
		const value = env[name];
		if (value === undefined || value.length === 0) throw new Error(`worktreePath references $${name}, which is not set`);
		return value;
	});
	if (path === "~" || path.startsWith("~/")) path = home + path.slice(1);
	if (!path.startsWith("/")) throw new Error(`worktreePath must resolve to an absolute path, got "${path}"`);

	return path.replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Lowercase, hyphen-separated, at most `max` characters, never empty. */
export function slugify(text: string, max = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug.length > 0 ? slug : "task";
}

/** Host and owner from a git remote URL in ssh, scp-like, or https form; undefined when unparseable. */
export function parseRemoteUrl(url: string): { host: string; owner: string; repo: string } | undefined {
	const trimmed = url.trim();
	const scpLike = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed);
	const withScheme = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
	const match = scpLike ?? withScheme;
	if (!match) return undefined;

	const host = match[1]!;
	const segments = match[2]!.replace(/\.git$/, "").split("/").filter((s) => s.length > 0);
	if (segments.length < 2) return undefined;
	return { host, owner: segments.slice(0, -1).join("/"), repo: segments[segments.length - 1]! };
}

export interface ExecLike {
	(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface CreateWorktreeInput {
	exec: ExecLike;
	cwd: string;
	slug: string;
	from: string;
	template: string;
	env: Record<string, string | undefined>;
	home: string;
	exists: (path: string) => boolean;
}

export interface CreatedWorktree {
	path: string;
	branch: string;
	repoPath: string;
}

// Pi runs a turn's tool calls in parallel, so two launches can pick the same name unless creation
// is serialized. Collisions with other processes surface as git's own error.
let creating: Promise<unknown> = Promise.resolve();

/** Creates a branch and worktree with plain git, picking a unique slug when the first choice is taken. */
export function createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
	const result = creating.then(() => createWorktreeNow(input));
	creating = result.catch(() => undefined);
	return result;
}

async function createWorktreeNow(input: CreateWorktreeInput): Promise<CreatedWorktree> {
	const repoPath = await gitStdout(input.exec, input.cwd, ["rev-parse", "--show-toplevel"], "not inside a git repository");
	const remote = await input.exec("git", ["remote", "get-url", "origin"], { cwd: repoPath });
	const parsed = remote.code === 0 ? parseRemoteUrl(remote.stdout) : undefined;
	const repo = repoPath.split("/").filter((s) => s.length > 0).pop() ?? "repo";

	for (let attempt = 0; attempt < 20; attempt++) {
		const slug = attempt === 0 ? input.slug : `${input.slug}-${attempt + 1}`;
		const branch = `pi/${slug}`;
		const path = expandWorktreePath(input.template, { repo, repoPath, host: parsed?.host ?? "", owner: parsed?.owner ?? "", slug, branch }, input.env, input.home);
		const branchExists = (await input.exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })).code === 0;
		if (branchExists || input.exists(path)) continue;

		const added = await input.exec("git", ["worktree", "add", "-b", branch, path, input.from], { cwd: repoPath, timeout: 120_000 });
		if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
		return { path, branch, repoPath };
	}

	throw new Error(`could not find a free worktree name for "${input.slug}" after 20 attempts`);
}

async function gitStdout(exec: ExecLike, cwd: string, args: string[], failure: string): Promise<string> {
	const result = await exec("git", args, { cwd });
	if (result.code !== 0) throw new Error(`${failure} (${cwd}): ${result.stderr.trim()}`);
	return result.stdout.trim();
}
