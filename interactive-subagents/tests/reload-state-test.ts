import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDeliveryListener } from "../delivery.ts";
import * as runningWidget from "../running-widget.ts";
import * as initial from "../state.ts";
import type { DeliveryRecord, RunningSubagent } from "../state.ts";

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
const widgetWrites: Array<{ key: string; content: unknown }> = [];
const firstContext = {
	hasUI: true,
	ui: {
		setWidget(key: string, content: unknown): void {
			widgetWrites.push({ key, content });
		},
	},
} as unknown as ExtensionContext;
initial.setLatestCtx(firstContext);
runningWidget.activateRunningWidgetGeneration(firstGeneration);
const releaseOldWidgetSuspension = runningWidget.suspendRunningWidget(firstContext);
eq("open picker clears the old generation widget", widgetWrites[0]?.content, undefined);
initial.prepareForReload(() => {});

eq("reload aborts the old generation", firstSignal.aborted, true);
eq("reload preserves the running child", initial.running.get(child.id), child);
eq("reload preserves the short-id ledger", initial.ledger.get(child.id)?.sessionFile, child.sessionFile);

const replacement = await import(new URL(`../state.ts?reload-test=${Date.now()}`, import.meta.url).href) as typeof initial;
eq("replacement import advances the generation", replacement.moduleGeneration() > firstGeneration, true);
eq("replacement import shares the running map", replacement.running, initial.running);
eq("replacement import shares the ledger", replacement.ledger, initial.ledger);
replacement.completeReloadHandoff();

const context = {
	hasUI: true,
	ui: {
		setWidget(key: string, content: unknown): void {
			widgetWrites.push({ key, content });
		},
	},
} as unknown as ExtensionContext;
replacement.setLatestCtx(context);
eq("replacement context is published through stable state", initial.getLatestCtx(), context);
runningWidget.activateRunningWidgetGeneration(replacement.moduleGeneration());
runningWidget.updateRunningWidget();
eq("replacement generation discards the stale picker suspension", typeof widgetWrites.at(-1)?.content, "function");
const replacementWidgetWrites = widgetWrites.length;
releaseOldWidgetSuspension();
eq("late old-generation picker release cannot repaint the replacement", widgetWrites.length, replacementWidgetWrites);

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

// Deterministic lifecycle E2E: an exited child and its accepted queued send
// cross two reload generations, then exactly one landed result clears the row.
let cleanupRuns = 0;
const sharedCleanup = Promise.resolve().then(() => {
	cleanupRuns++;
	return { status: "kept" as const, code: "mode-never" as const, reason: "test" };
});
const delivery = {
	id: child.id,
	name: child.name,
	agent: "worker",
	elapsedSeconds: 42,
	forked: false,
	worktree: false,
	child,
	exit: { reason: "exited", exitCode: 0 },
	worktreeCleanup: sharedCleanup,
	sendAccepted: true,
} as unknown as DeliveryRecord;
replacement.setDeliveryRecord(delivery);
replacement.prepareForReload(() => {});
const second = await import(new URL(`../state.ts?reload-test-2=${Date.now()}`, import.meta.url).href) as typeof initial;
eq("first delivery reload keeps the sole enriched record", second.deliveryRecord(child.id), delivery);
eq("delivery reload backfills launch time", second.deliveryRecord(child.id)?.startedAt, child.startTime);
eq("delivery reload backfills the interactive marker", second.deliveryRecord(child.id)?.interactive, true);
second.completeReloadHandoff();
second.prepareForReload(() => {});
const third = await import(new URL(`../state.ts?reload-test-3=${Date.now()}`, import.meta.url).href) as typeof initial;
eq("second delivery reload keeps the same accepted-send record", third.deliveryRecord(child.id), delivery);
eq("two reloads retain one cleanup promise", third.deliveryRecord(child.id)?.worktreeCleanup, sharedCleanup);
await third.deliveryRecord(child.id)?.worktreeCleanup;
eq("the retained cleanup executes once", cleanupRuns, 1);
third.completeReloadHandoff();

let landedHandlers = 0;
let handler: ((event: unknown) => void) | undefined;
registerDeliveryListener({
	on(_type: string, callback: (event: unknown) => void): void {
		landedHandlers++;
		handler = callback;
	},
} as unknown as ExtensionAPI);
eq("one active delivery listener is registered", landedHandlers, 1);
handler?.({ message: { role: "custom", customType: "subagent_result", details: { id: child.id } } });
eq("one landed result clears the delivery row after two reloads", third.deliveryRecord(child.id), undefined);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
