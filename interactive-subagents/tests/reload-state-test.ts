import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as initial from "../state.ts";
import type { RunningSubagent } from "../state.ts";

let pass = 0;
let fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	if (got === want) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${String(got)}, want ${String(want)}`);
	}
}

initial.running.clear();
initial.ledger.clear();

const child = {
	id: "reload01",
	name: "reload fixture",
	paneId: "%42",
	sessionFile: "/fixture/session.jsonl",
	startTime: 1234,
	skipEntries: 0,
	autoExit: false,
	abort: new AbortController(),
	expectsRun: false,
} as RunningSubagent;

const firstGeneration = initial.moduleGeneration();
const firstSignal = initial.moduleSignal();
initial.running.set(child.id, child);
initial.ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
initial.prepareForReload(() => {});

eq("reload aborts the old generation", firstSignal.aborted, true);
eq("reload preserves the running child", initial.running.get(child.id), child);
eq("reload preserves the short-id ledger", initial.ledger.get(child.id)?.sessionFile, child.sessionFile);

const replacement = await import(new URL(`../state.ts?reload-test=${Date.now()}`, import.meta.url).href) as typeof initial;
eq("replacement import advances the generation", replacement.moduleGeneration() > firstGeneration, true);
eq("replacement import shares the running map", replacement.running, initial.running);
eq("replacement import shares the ledger", replacement.ledger, initial.ledger);
replacement.completeReloadHandoff();

const context = { hasUI: true } as ExtensionContext;
replacement.setLatestCtx(context);
eq("replacement context is published through stable state", initial.getLatestCtx(), context);

const replacementSignal = replacement.moduleSignal();
const replacementGeneration = replacement.moduleGeneration();
const stopped = replacement.resetForShutdown();
eq("destructive shutdown returns the child for pane cleanup", stopped[0], child);
eq("destructive shutdown aborts the replacement generation", replacementSignal.aborted, true);
eq("destructive shutdown clears running children", replacement.running.size, 0);
eq("destructive shutdown preserves same-process short-id resume", replacement.ledger.get(child.id)?.sessionFile, child.sessionFile);
eq("destructive shutdown clears the UI context", replacement.getLatestCtx(), null);
eq("cached factory rebind gets a fresh generation", replacement.moduleGeneration() > replacementGeneration, true);
eq("cached factory rebind gets a live signal", replacement.moduleSignal().aborted, false);

replacement.running.set(child.id, child);
replacement.ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
let expiredChildren: RunningSubagent[] = [];
replacement.prepareForReload((children) => { expiredChildren = children; }, 0);
await new Promise((resolve) => setTimeout(resolve, 5));
eq("failed reload reaper returns the preserved child", expiredChildren[0], child);
eq("failed reload reaper clears running children", replacement.running.size, 0);
eq("failed reload reaper preserves same-process short-id resume", replacement.ledger.get(child.id)?.sessionFile, child.sessionFile);
eq("failed reload reaper leaves the unadopted runtime stopped", replacement.moduleSignal().aborted, true);
const expiredGeneration = replacement.moduleGeneration();
replacement.completeReloadHandoff();
eq("late successful adoption advances the stopped generation", replacement.moduleGeneration() > expiredGeneration, true);
eq("late successful adoption rearms a live signal", replacement.moduleSignal().aborted, false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
