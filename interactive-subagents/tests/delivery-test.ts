// Unit tests for delivery.ts - the message_end listener that clears
// "delivering" widget rows when this extension's own result/ping message
// lands in the parent transcript. The matcher is load-bearing in BOTH
// directions: too loose (subagent_stalled / subagent_recovered share the
// details.id shape) clears rows whose real result is still queued; too
// strict, or a throw on a hostile shape, strands rows forever. delivery.ts
// takes pi's ExtensionAPI as `import type` only, so a stub object with a
// handler registry and a manual emit() drives it under plain node.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deliveredChildId, registerDeliveryListener } from "../delivery.ts";
import { delivering, resetForShutdown } from "../state.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}

// ── the fake pi emitter ──────────────────────────────────────────────────
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

// ── helpers: a seeded delivering entry and a well-formed landed message ──

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

// ── the matcher truth table (pure, no pi) ────────────────────────────────

eq("matcher accepts subagent_result with a string id", deliveredChildId(message("abc12345")), "abc12345");
eq("matcher accepts subagent_ping with a string id", deliveredChildId(message("abc12345", "subagent_ping")), "abc12345");

// The load-bearing rejections: stalled/recovered carry the same details.id
// shape but are sent for STILL-RUNNING children - matching them would clear
// a row whose real result is still queued.
eq("matcher rejects subagent_stalled (load-bearing)", deliveredChildId(message("abc12345", "subagent_stalled")), undefined);
eq("matcher rejects subagent_recovered (load-bearing)", deliveredChildId(message("abc12345", "subagent_recovered")), undefined);

// Hostile / mismatched shapes: every one returns undefined without throwing.
eq("matcher rejects a non-custom role",
	deliveredChildId({ role: "assistant", customType: "subagent_result", details: { id: "abc12345" } }), undefined);
eq("matcher rejects a missing role",
	deliveredChildId({ customType: "subagent_result", details: { id: "abc12345" } }), undefined);
eq("matcher rejects missing details",
	deliveredChildId({ role: "custom", customType: "subagent_result" }), undefined);
eq("matcher rejects null details",
	deliveredChildId({ role: "custom", customType: "subagent_result", details: null }), undefined);
eq("matcher rejects a non-string id", deliveredChildId(message(42)), undefined);
eq("matcher rejects empty details",
	deliveredChildId({ role: "custom", customType: "subagent_result", details: {} }), undefined);
eq("matcher rejects a null message", deliveredChildId(null), undefined);
eq("matcher rejects a primitive message", deliveredChildId("subagent_result"), undefined);
eq("matcher rejects an undefined message", deliveredChildId(undefined), undefined);

// ── the listener round trip ──────────────────────────────────────────────
// updateRunningWidget runs inside the handler and must no-op harmlessly:
// getLatestCtx() is null under plain node - nothing may throw.

const pi = fakePi();
registerDeliveryListener(pi as unknown as ExtensionAPI);

seed("aaaa1111");
seed("bbbb2222");
pi.emit("message_end", { type: "message_end", message: message("aaaa1111") }, undefined);
eq("a landed result clears exactly its own row", [...delivering.keys()], ["bbbb2222"]);
pi.emit("message_end", { type: "message_end", message: message("bbbb2222", "subagent_ping") }, undefined);
eq("a landed ping clears its row too", delivering.size, 0);

seed("cccc3333");
pi.emit("message_end", { type: "message_end", message: message("cccc3333", "subagent_stalled") }, undefined);
eq("a stalled steer never clears a delivering row", delivering.has("cccc3333"), true);
pi.emit("message_end", { type: "message_end", message: message("zzzz9999") }, undefined);
eq("an unknown id is a no-op (pre-reload results are normal)", delivering.size, 1);
pi.emit("message_end", { type: "message_end", message: null }, undefined);
pi.emit("message_end", { type: "message_end" }, undefined);
eq("hostile events neither throw nor clear anything", delivering.size, 1);

pi.emit("message_end", { type: "message_end", message: message("cccc3333") }, undefined);
eq("the matching result clears the seeded row", delivering.has("cccc3333"), false);
pi.emit("message_end", { type: "message_end", message: message("cccc3333") }, undefined);
eq("redelivery is an idempotent no-op", delivering.size, 0);

// ── session teardown ─────────────────────────────────────────────────────
// Stale rows must not leak into the next session; the fresh AbortController
// resetForShutdown arms is harmless under node.

seed("dddd4444");
resetForShutdown();
eq("resetForShutdown clears the delivering map", delivering.size, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
