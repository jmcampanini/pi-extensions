import { randomBytes } from "node:crypto";

export type ChildStatus = "running" | "completed" | "failed" | "cancelled";
export type ChildMode = "background" | "foreground";
export type ChildContext = "fresh" | "fork";

export interface ChildRecord {
	id: string;
	title: string;
	task: string;
	mode: ChildMode;
	context: ChildContext;
	cwd: string;
	model: string;
	effort: string;
	startedAt: number;
	finishedAt?: number;
	status: ChildStatus;
	/** Recent progress lines, newest last. */
	progress: string[];
	result?: string;
	error?: string;
	sessionFile?: string;
	worktree?: { path: string; branch: string };
	abort: () => void;
}

/** Owns every child started by this extension runtime and tells the UI when any of them changes. */
export class SubagentRegistry {
	private readonly children = new Map<string, ChildRecord>();
	private readonly listeners = new Set<() => void>();

	add(record: ChildRecord): void {
		this.children.set(record.id, record);
		this.notify();
	}

	update(id: string, patch: Partial<Omit<ChildRecord, "id" | "abort">>): ChildRecord | undefined {
		const current = this.children.get(id);
		if (!current) return undefined;

		const next = { ...current, ...patch };
		this.children.set(id, next);
		this.notify();
		return next;
	}

	addProgress(id: string, line: string, keep = 20): void {
		const current = this.children.get(id);
		if (!current) return;
		this.update(id, { progress: [...current.progress, line].slice(-keep) });
	}

	get(id: string): ChildRecord | undefined {
		return this.children.get(id);
	}

	list(): ChildRecord[] {
		return [...this.children.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	running(): ChildRecord[] {
		return this.list().filter((child) => child.status === "running");
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	abortAll(): void {
		for (const child of this.running()) child.abort();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

export function newChildId(): string {
	return randomBytes(3).toString("hex");
}
