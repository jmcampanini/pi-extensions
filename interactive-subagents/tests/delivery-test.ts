// Unit tests for delivery.ts - the message_end listener that clears
// "delivering" widget rows when this extension's own result/ping message
// lands in the parent transcript. The matcher is load-bearing in BOTH
// directions: too loose (subagent_stalled / subagent_recovered share the
// details.id shape) clears rows whose real result is still queued; too
// strict, or a throw on a hostile shape, strands rows forever. delivery.ts
// takes pi's ExtensionAPI as `import type` only, so a stub object with a
// handler registry and a manual emit() drives it under plain node.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliveredChildId, registerDeliveryListener } from "../delivery.ts";
import { delivering, resetForShutdown } from "../state.ts";

// registerDeliveryListener only ever calls pi.on(type, handler), so a
// Map-backed registry with a manual emit is a faithful stand-in (same
// pattern as recorder-test.ts).

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi(): { on: (type: string, handler: Handler) => void; emit: (type: string, event: unknown, ctx: unknown) => void } {
	const handlers = new Map<string, Handler[]>();
	return {
		on(type: string, handler: Handler): void {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		emit(type: string, event: unknown, ctx: unknown): void {
			for (const handler of handlers.get(type) ?? []) handler(event, ctx);
		},
	};
}

function seed(id: string): void {
	delivering.set(id, {
		id,
		name: `child-${id}`,
		agent: "worker",
		startedAt: 1,
		elapsedSeconds: 42,
		forked: false,
		interactive: false,
		worktree: false,
		stopped: false,
	});
}
function message(id: unknown, customType: string = "subagent_result"): unknown {
	return { role: "custom", customType, content: "prose", display: true, details: { id }, timestamp: 1 };
}

describe("deliveredChildId", () => {
	it("matcher accepts subagent_result with a string id", () => {
		assert.strictEqual(deliveredChildId(message("abc12345")), "abc12345");
	});

	it("matcher accepts subagent_ping with a string id", () => {
		assert.strictEqual(deliveredChildId(message("abc12345", "subagent_ping")), "abc12345");
	});

	// The load-bearing rejections: stalled/recovered carry the same details.id
	// shape but are sent for STILL-RUNNING children - matching them would clear
	// a row whose real result is still queued.
	it("matcher rejects subagent_stalled (load-bearing)", () => {
		assert.strictEqual(deliveredChildId(message("abc12345", "subagent_stalled")), undefined);
	});

	it("matcher rejects subagent_recovered (load-bearing)", () => {
		assert.strictEqual(deliveredChildId(message("abc12345", "subagent_recovered")), undefined);
	});

	// Hostile / mismatched shapes: every one returns undefined without throwing.
	it("matcher rejects a non-custom role", () => {
		assert.strictEqual(deliveredChildId({ role: "assistant", customType: "subagent_result", details: { id: "abc12345" } }), undefined);
	});

	it("matcher rejects a missing role", () => {
		assert.strictEqual(deliveredChildId({ customType: "subagent_result", details: { id: "abc12345" } }), undefined);
	});

	it("matcher rejects missing details", () => {
		assert.strictEqual(deliveredChildId({ role: "custom", customType: "subagent_result" }), undefined);
	});

	it("matcher rejects null details", () => {
		assert.strictEqual(deliveredChildId({ role: "custom", customType: "subagent_result", details: null }), undefined);
	});

	it("matcher rejects a non-string id", () => {
		assert.strictEqual(deliveredChildId(message(42)), undefined);
	});

	it("matcher rejects empty details", () => {
		assert.strictEqual(deliveredChildId({ role: "custom", customType: "subagent_result", details: {} }), undefined);
	});

	it("matcher rejects a null message", () => {
		assert.strictEqual(deliveredChildId(null), undefined);
	});

	it("matcher rejects a primitive message", () => {
		assert.strictEqual(deliveredChildId("subagent_result"), undefined);
	});

	it("matcher rejects an undefined message", () => {
		assert.strictEqual(deliveredChildId(undefined), undefined);
	});
});

describe("registerDeliveryListener", () => {
	// updateRunningWidget runs inside the handler and must no-op harmlessly:
	// getLatestCtx() is null under plain node - nothing may throw.
	it("clears delivering rows only when this extension's own message lands", () => {
		const pi = fakePi();
		registerDeliveryListener(pi as unknown as ExtensionAPI);

		seed("aaaa1111");
		seed("bbbb2222");
		pi.emit("message_end", { type: "message_end", message: message("aaaa1111") }, undefined);
		assert.deepStrictEqual([...delivering.keys()], ["bbbb2222"], "a landed result clears exactly its own row");
		pi.emit("message_end", { type: "message_end", message: message("bbbb2222", "subagent_ping") }, undefined);
		assert.strictEqual(delivering.size, 0, "a landed ping clears its row too");

		seed("cccc3333");
		pi.emit("message_end", { type: "message_end", message: message("cccc3333", "subagent_stalled") }, undefined);
		assert.strictEqual(delivering.has("cccc3333"), true, "a stalled steer never clears a delivering row");
		pi.emit("message_end", { type: "message_end", message: message("zzzz9999") }, undefined);
		assert.strictEqual(delivering.size, 1, "an unknown id is a no-op (pre-reload results are normal)");
		pi.emit("message_end", { type: "message_end", message: null }, undefined);
		pi.emit("message_end", { type: "message_end" }, undefined);
		assert.strictEqual(delivering.size, 1, "hostile events neither throw nor clear anything");

		pi.emit("message_end", { type: "message_end", message: message("cccc3333") }, undefined);
		assert.strictEqual(delivering.has("cccc3333"), false, "the matching result clears the seeded row");
		pi.emit("message_end", { type: "message_end", message: message("cccc3333") }, undefined);
		assert.strictEqual(delivering.size, 0, "redelivery is an idempotent no-op");
	});
});

describe("resetForShutdown", () => {
	// Stale rows must not leak into the next session; the fresh AbortController
	// resetForShutdown arms is harmless under node.
	it("resetForShutdown clears the delivering map", () => {
		seed("dddd4444");
		resetForShutdown();
		assert.strictEqual(delivering.size, 0);
	});
});
