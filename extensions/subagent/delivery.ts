export interface PromptGate {
	isIdle(): boolean;
	signal: AbortSignal | undefined;
}

/**
 * Whether the parent session would accept a prompt right now. Pi rejects prompts while a manual
 * compaction runs and offers extensions no compaction flag, but it aborts any run before compacting,
 * so "not idle and no live agent signal" is that state (plus branch summaries, which cannot start a
 * run either). A live, unaborted signal means a turn is streaming and the message queues as a steer.
 */
export function canAcceptPrompt(ctx: PromptGate): boolean {
	return ctx.isIdle() || (ctx.signal !== undefined && !ctx.signal.aborted);
}

export interface OutboxDeps {
	canAccept(): boolean;
	/** Sends one message containing every pending report. */
	send(text: string): void;
	/** Keeps a report for the next turn when the parent would not accept it before the deadline. */
	park(text: string): void;
	notifyStuck(count: number): void;
	pollMs?: number;
	deadlineMs?: number;
	now?: () => number;
}

export interface Outbox {
	push(report: string): void;
	/** Sends what is pending if the parent accepts prompts; otherwise checks again shortly. */
	flush(): void;
	close(): void;
}

/** Collects background reports and delivers them together as soon as the parent can take them. */
export function createOutbox(deps: OutboxDeps): Outbox {
	const pollMs = deps.pollMs ?? 50;
	const deadlineMs = deps.deadlineMs ?? 5 * 60_000;
	const now = deps.now ?? Date.now;
	const pending: Array<{ text: string; since: number }> = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (closed || pending.length === 0) return;

		if (deps.canAccept()) {
			deps.send(pending.splice(0).map((report) => report.text).join("\n\n"));
			return;
		}
		if (now() - pending[0]!.since >= deadlineMs) {
			const stuck = pending.splice(0);
			deps.notifyStuck(stuck.length);
			for (const report of stuck) deps.park(report.text);
			return;
		}
		timer = setTimeout(flush, pollMs);
	};

	return {
		push(report) {
			if (closed) return;
			pending.push({ text: report, since: now() });
			flush();
		},
		flush,
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}
