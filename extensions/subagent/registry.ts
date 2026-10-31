import { randomBytes } from "node:crypto";
import type { ChildSummary } from "./child.ts";

export interface ChildRecord extends ChildSummary {
	task: string;
	startedAt: number;
	finishedAt?: number | undefined;
	/** Recent progress lines, newest last. */
	progress: string[];
	result?: string | undefined;
	abort: () => void;
}

/** The persisted and displayed view of a record, without the task text, result, and abort handle. */
export function summarize(record: ChildRecord): ChildSummary {
	return {
		id: record.id,
		title: record.title,
		mode: record.mode,
		context: record.context,
		status: record.status,
		model: record.model,
		effort: record.effort,
		cwd: record.cwd,
		worktree: record.worktree,
		sessionFile: record.sessionFile,
		error: record.error,
	};
}

/** Owns every child started by this extension runtime and tells the UI when the running set changes. */
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

	/** Progress does not change the running set, so listeners are not told. */
	addProgress(id: string, line: string, keep = 20): void {
		const current = this.children.get(id);
		if (!current) return;
		this.children.set(id, { ...current, progress: [...current.progress, line].slice(-keep) });
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
