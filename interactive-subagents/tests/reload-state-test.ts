import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDeliveryListener } from "../delivery.ts";
import * as runningWidget from "../running-widget.ts";
import * as initial from "../state.ts";
import type { DeliveryRecord, RunningSubagent } from "../state.ts";

describe("state reload", () => {
	it("reload generations hand off children, deliveries, and widgets without loss or duplication", async () => {
		initial.running.clear();
		initial.ledger.clear();

		const firstRunIndex = initial.currentRunIndex();
		const acceptedRunIndex = initial.incrementRunIndex();
		assert.strictEqual(acceptedRunIndex, firstRunIndex + 1, "run counter increments monotonically");

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
		(child as RunningSubagent & { stoppedByUser?: boolean }).stoppedByUser = true;
		initial.running.set(child.id, child);
		initial.ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
		const widgetWrites: Array<{ key: string; content: unknown }> = [];
		function createWidgetContext(): ExtensionContext {
			return {
				hasUI: true,
				ui: {
					setWidget(key: string, content: unknown): void {
						widgetWrites.push({ key, content });
					},
				},
			} as unknown as ExtensionContext;
		}
		const firstContext = createWidgetContext();
		initial.setLatestCtx(firstContext);
		runningWidget.activateRunningWidgetGeneration(firstGeneration);
		const releaseOldWidgetSuspension = runningWidget.suspendRunningWidget(firstContext);
		assert.strictEqual(widgetWrites[0]?.content, undefined, "open picker clears the old generation widget");
		initial.prepareForReload(() => {});

		assert.strictEqual(firstSignal.aborted, true, "reload aborts the old generation");
		assert.strictEqual(initial.running.get(child.id), child, "reload preserves the running child");
		assert.strictEqual(initial.ledger.get(child.id)?.sessionFile, child.sessionFile,
			"reload preserves the short-id ledger");

		const replacement = await import(new URL(`../state.ts?reload-test=${Date.now()}`, import.meta.url).href) as typeof initial;
		assert.strictEqual(replacement.moduleGeneration() > firstGeneration, true,
			"replacement import advances the generation");
		assert.strictEqual(replacement.running, initial.running, "replacement import shares the running map");
		assert.strictEqual(replacement.ledger, initial.ledger, "replacement import shares the ledger");
		assert.strictEqual(replacement.running.get(child.id)?.stopRequester, "user",
			"replacement upgrades a legacy user stop requester");
		assert.strictEqual("stoppedByUser" in (replacement.running.get(child.id) as RunningSubagent), false,
			"replacement removes the legacy user stop field");
		assert.strictEqual(replacement.currentRunIndex(), acceptedRunIndex,
			"replacement import preserves the run counter");
		replacement.completeReloadHandoff();

		const context = createWidgetContext();
		replacement.setLatestCtx(context);
		assert.strictEqual(initial.getLatestCtx(), context, "replacement context is published through stable state");
		runningWidget.activateRunningWidgetGeneration(replacement.moduleGeneration());
		runningWidget.updateRunningWidget();
		assert.strictEqual(typeof widgetWrites.at(-1)?.content, "function",
			"replacement generation discards the stale picker suspension");
		const replacementWidgetWrites = widgetWrites.length;
		releaseOldWidgetSuspension();
		assert.strictEqual(widgetWrites.length, replacementWidgetWrites,
			"late old-generation picker release cannot repaint the replacement");

		const replacementSignal = replacement.moduleSignal();
		const replacementGeneration = replacement.moduleGeneration();
		const stopped = replacement.resetForShutdown();
		assert.strictEqual(stopped[0], child, "destructive shutdown returns the child for pane cleanup");
		assert.strictEqual(replacementSignal.aborted, true, "destructive shutdown aborts the replacement generation");
		assert.strictEqual(replacement.running.size, 0, "destructive shutdown clears running children");
		assert.strictEqual(replacement.ledger.get(child.id)?.sessionFile, child.sessionFile,
			"destructive shutdown preserves same-process short-id resume");
		assert.strictEqual(replacement.getLatestCtx(), null, "destructive shutdown clears the UI context");
		assert.strictEqual(replacement.moduleGeneration() > replacementGeneration, true,
			"cached factory rebind gets a fresh generation");
		assert.strictEqual(replacement.moduleSignal().aborted, false, "cached factory rebind gets a live signal");

		replacement.running.set(child.id, child);
		replacement.ledger.set(child.id, { sessionFile: child.sessionFile, name: child.name });
		let expiredChildren: RunningSubagent[] = [];
		replacement.prepareForReload((children) => { expiredChildren = children; }, 0);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(expiredChildren[0], child, "failed reload reaper returns the preserved child");
		assert.strictEqual(replacement.running.size, 0, "failed reload reaper clears running children");
		assert.strictEqual(replacement.ledger.get(child.id)?.sessionFile, child.sessionFile,
			"failed reload reaper preserves same-process short-id resume");
		assert.strictEqual(replacement.moduleSignal().aborted, true,
			"failed reload reaper leaves the unadopted runtime stopped");
		const expiredGeneration = replacement.moduleGeneration();
		replacement.completeReloadHandoff();
		assert.strictEqual(replacement.moduleGeneration() > expiredGeneration, true,
			"late successful adoption advances the stopped generation");
		assert.strictEqual(replacement.moduleSignal().aborted, false, "late successful adoption rearms a live signal");

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
			exit: { reason: "aborted" },
			worktreeCleanup: sharedCleanup,
			sendAccepted: true,
		} as unknown as DeliveryRecord;
		replacement.setDeliveryRecord(delivery);
		replacement.prepareForReload(() => {});
		const second = await import(new URL(`../state.ts?reload-test-2=${Date.now()}`, import.meta.url).href) as typeof initial;
		assert.strictEqual(second.deliveryRecord(child.id), delivery,
			"first delivery reload keeps the sole enriched record");
		assert.strictEqual(second.deliveryRecord(child.id)?.startedAt, child.startTime,
			"delivery reload backfills launch time");
		assert.strictEqual(second.deliveryRecord(child.id)?.interactive, true,
			"delivery reload backfills the interactive marker");
		assert.strictEqual(second.deliveryRecord(child.id)?.stopped, true,
			"delivery reload backfills the stopped projection");
		assert.strictEqual(second.deliveryRecord(child.id)?.sendAcceptedRunIndex, acceptedRunIndex,
			"delivery reload backfills a legacy accepted-send run stamp");
		second.completeReloadHandoff();
		second.prepareForReload(() => {});
		const third = await import(new URL(`../state.ts?reload-test-3=${Date.now()}`, import.meta.url).href) as typeof initial;
		assert.strictEqual(third.deliveryRecord(child.id), delivery,
			"second delivery reload keeps the same accepted-send record");
		assert.strictEqual(third.deliveryRecord(child.id)?.sendAcceptedRunIndex, acceptedRunIndex,
			"delivery reload preserves the accepted-send run stamp");
		assert.strictEqual(third.deliveryRecord(child.id)?.worktreeCleanup, sharedCleanup,
			"two reloads retain one cleanup promise");
		await third.deliveryRecord(child.id)?.worktreeCleanup;
		assert.strictEqual(cleanupRuns, 1, "the retained cleanup executes once");
		third.completeReloadHandoff();

		let landedHandlers = 0;
		let handler: ((event: unknown) => void) | undefined;
		registerDeliveryListener({
			on(type: string, callback: (event: unknown) => void): void {
				if (type !== "message_end") return;
				landedHandlers++;
				handler = callback;
			},
		} as unknown as ExtensionAPI);
		assert.strictEqual(landedHandlers, 1, "one active message_end delivery listener is registered");
		handler?.({ message: { role: "custom", customType: "subagent_result", details: { id: child.id } } });
		assert.strictEqual(third.deliveryRecord(child.id), undefined,
			"one landed result clears the delivery row after two reloads");
	});
});
