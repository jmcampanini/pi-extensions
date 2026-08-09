type ExecOptions = {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
};

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

export type PullRequestState = "o" | "d" | "c" | "m";
export type IssueState = "o" | "c";

export interface PullRequestContext {
	number: number;
	url: string;
	state: PullRequestState;
}

export interface IssueContext {
	number: number;
	url: string;
	state: IssueState;
}

export interface RepositoryContext {
	issue?: IssueContext;
	pr?: PullRequestContext;
}

export interface RepositoryContextInput {
	cwd: string;
	branch: string | null | undefined;
	issuePatterns: readonly string[];
}

export type RepositoryContextDiscovery = (
	input: RepositoryContextInput,
	signal?: AbortSignal,
) => Promise<RepositoryContext>;

interface GitHubPullRequest {
	number?: unknown;
	url?: unknown;
	state?: unknown;
	isDraft?: unknown;
}

interface GitHubIssue {
	number?: unknown;
	url?: unknown;
	state?: unknown;
}

const GH_TIMEOUT_MS = 5_000;

function cwdBasename(cwd: string): string {
	return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function matchIssueNumber(text: string, patterns: readonly string[]): number | undefined {
	for (const pattern of patterns) {
		const match = new RegExp(pattern).exec(text);
		const captured = match?.groups?.number;
		if (captured === undefined) continue;
		const number = Number(captured);
		if (Number.isSafeInteger(number) && number > 0) return number;
	}
	return undefined;
}

export function inferIssueNumber(
	branch: string | null | undefined,
	cwd: string,
	patterns: readonly string[],
): number | undefined {
	if (branch && branch !== "detached") {
		const branchNumber = matchIssueNumber(branch, patterns);
		if (branchNumber !== undefined) return branchNumber;
	}
	return matchIssueNumber(cwdBasename(cwd), patterns);
}

function canonicalHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parsePullRequest(raw: GitHubPullRequest): PullRequestContext | undefined {
	const number = positiveInteger(raw.number);
	const url = canonicalHttpUrl(raw.url);
	if (number === undefined || url === undefined) return undefined;

	let state: PullRequestState | undefined;
	if (raw.state === "OPEN") state = raw.isDraft === true ? "d" : "o";
	if (raw.state === "CLOSED") state = "c";
	if (raw.state === "MERGED") state = "m";
	return state ? { number, url, state } : undefined;
}

function parseIssue(raw: GitHubIssue, expectedNumber: number): IssueContext | undefined {
	const number = positiveInteger(raw.number);
	const url = canonicalHttpUrl(raw.url);
	if (number !== expectedNumber || url === undefined) return undefined;
	if (raw.state === "OPEN") return { number, url, state: "o" };
	if (raw.state === "CLOSED") return { number, url, state: "c" };
	return undefined;
}

async function runGhJson(
	run: CommandRunner,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	try {
		const result = await run("gh", args, { cwd, timeout: GH_TIMEOUT_MS, signal });
		if (result.code !== 0) return undefined;
		return JSON.parse(result.stdout) as unknown;
	} catch {
		return undefined;
	}
}

export async function discoverRepositoryContext(
	run: CommandRunner,
	input: RepositoryContextInput,
	signal?: AbortSignal,
): Promise<RepositoryContext> {
	const issueNumber = inferIssueNumber(input.branch, input.cwd, input.issuePatterns);
	const prPromise = input.branch && input.branch !== "detached"
		? runGhJson(run, ["pr", "view", "--json", "number,url,state,isDraft"], input.cwd, signal)
		: Promise.resolve(undefined);
	const issuePromise = issueNumber === undefined
		? Promise.resolve(undefined)
		: runGhJson(
			run,
			["issue", "view", String(issueNumber), "--json", "number,url,state"],
			input.cwd,
			signal,
		);
	const [rawPr, rawIssue] = await Promise.all([prPromise, issuePromise]);
	const context: RepositoryContext = {};

	if (typeof rawPr === "object" && rawPr !== null && !Array.isArray(rawPr)) {
		const pr = parsePullRequest(rawPr as GitHubPullRequest);
		if (pr) context.pr = pr;
	}
	if (issueNumber !== undefined && typeof rawIssue === "object" && rawIssue !== null && !Array.isArray(rawIssue)) {
		const issue = parseIssue(rawIssue as GitHubIssue, issueNumber);
		if (issue) context.issue = issue;
	}
	return context;
}

export interface RepositoryContextRefresher {
	get(): RepositoryContext;
	refresh(): Promise<void>;
	clear(): void;
	dispose(): void;
}

export function createRepositoryContextRefresher(
	getInput: () => RepositoryContextInput,
	discover: RepositoryContextDiscovery,
	onChange: () => void,
): RepositoryContextRefresher {
	let current: RepositoryContext = {};
	let pending = false;
	let disposed = false;
	let active: Promise<void> | undefined;
	let controller: AbortController | undefined;

	async function drain(): Promise<void> {
		while (pending && !disposed) {
			pending = false;
			controller = new AbortController();
			let next: RepositoryContext;
			try {
				next = await discover(getInput(), controller.signal);
			} catch {
				next = {};
			}
			controller = undefined;
			if (!pending && !disposed) {
				current = next;
				onChange();
			}
		}
	}

	return {
		get: () => current,
		refresh(): Promise<void> {
			if (disposed) return Promise.resolve();
			pending = true;
			if (!active) {
				const started = drain().finally(() => {
					if (active === started) active = undefined;
				});
				active = started;
			}
			return active;
		},
		clear(): void {
			if (disposed) return;
			current = {};
			onChange();
		},
		dispose(): void {
			disposed = true;
			pending = false;
			controller?.abort();
			controller = undefined;
			current = {};
		},
	};
}
