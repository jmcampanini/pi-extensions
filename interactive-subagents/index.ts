/**
 * interactive-subagents — spawn sub-agents as real pi sessions in tmux panes.
 *
 * The parent model calls the `subagent` tool, which RETURNS IMMEDIATELY.
 * The child runs as a full `pi` process in its own tmux pane (watch it, or
 * take it over by typing). A background watcher polls for the child's exit
 * and steers the result back into the parent conversation, waking the model.
 *
 * How the pieces talk:
 *
 *   parent pane                      filesystem                child pane
 *   ───────────                      ──────────                ──────────
 *   subagent tool ──── writes ────▶  task file, launch script
 *                 ──── tmux ─────────────────────────────────▶ pi --session … -e implant.ts
 *   watcher (1s)  ◀─── reads ─────  <session>.jsonl.exit  ◀──  implant (done/ping/error)
 *                 ◀─── reads ─────  <session>.jsonl       ◀──  pi (the transcript)
 *   pi.sendMessage(steer) → parent model wakes with the result
 *
 * Where to find things — one file per job:
 *
 *   protocol.ts          the parent↔child contract (env vars, .exit sidecar, sentinel)
 *   config.ts            layered settings (defaults < subagents.json < env), fail-fast
 *   models.ts            picking a usable model from an agent's candidates
 *   agents.ts            agent definition files + the inventory built from them
 *   session.ts           reading/seeding pi session .jsonl files (fork, summaries)
 *   tmux.ts              panes: create/type/read/close + the exit poller
 *   launch.ts            building a child's launch command + the .meta sidecar
 *   state.ts             shared runtime state (running children, ledger, /reload)
 *   widget.ts            pure renderer for the running-children widget
 *   running-widget.ts    the widget's stateful controller (timer, ctx.ui)
 *   watcher.ts           per-child supervision + the steered result messages
 *   result-message.ts    compact/expanded renderer for delivered results
 *   delivery.ts          message_end listener that clears "delivering" widget rows
 *   implant.ts           loaded INSIDE each child: done/ping tools, auto-exit
 *   tool-*.ts            one file per model-facing tool (subagent, resume, list)
 *   command-*.ts         one file per human command (available, running)
 *
 * This file only WIRES those pieces into pi: lifecycle events plus one
 * registration call per tool/command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resetOverview, registerSubagentsAvailableCommand } from "./command-available.ts";
import { registerSubagentsRunningCommand } from "./command-running.ts";
import { registerDeliveryListener } from "./delivery.ts";
import { registerSubagentResultRenderer } from "./result-message.ts";
import { stopWidgetTimer } from "./running-widget.ts";
import { completeReloadHandoff, prepareForReload, resetForShutdown, setLatestCtx } from "./state.ts";
import { registerSubagentsListTool } from "./tool-list.ts";
import { registerSubagentResumeTool } from "./tool-resume.ts";
import { registerSubagentTool } from "./tool-subagent.ts";
import { closePane } from "./tmux.ts";
import { adoptRunningChildren } from "./watcher.ts";

// ── am I running inside a subagent? ──────────────────────────────────────
// This extension is installed globally, so it also loads inside every child
// we spawn. Children must NOT get the spawn tools (that would allow runaway
// recursive orchestration), so we detect child-mode via the env var the
// parent set (see protocol.ts) and register nothing. Depth is hard-capped
// at 1.
const IS_SUBAGENT_CHILD = Boolean(process.env.PI_SUBAGENT_SESSION);

export default function (pi: ExtensionAPI) {
	// Track the live context for widget updates, and clean everything up when
	// the session ends or is replaced (/new, /resume, quit, reload).
	pi.on("session_start", (event, ctx) => {
		setLatestCtx(ctx);
		if (event.reason === "reload") {
			adoptRunningChildren(pi);
			completeReloadHandoff();
		}
	});

	pi.on("session_shutdown", (event) => {
		stopWidgetTimer();
		resetOverview();
		if (event.reason === "reload") {
			prepareForReload((children) => {
				for (const child of children) closePane(child.paneId);
			});
			return;
		}
		for (const child of resetForShutdown()) closePane(child.paneId);
	});

	// Inside a child: register nothing. The implant (loaded via -e) provides
	// the child-side tools; withholding the spawn tools here is what enforces
	// the no-recursion rule.
	if (IS_SUBAGENT_CHILD) return;

	// Parent mode only: watch our own result/ping messages land in the parent
	// transcript so "delivering" widget rows can be cleared (see delivery.ts).
	// Registered before the spawn tools: on an idle parent the landing event
	// fires within microtasks of the watcher's send, so the listener must
	// exist before any child can possibly exit.
	registerDeliveryListener(pi);
	registerSubagentResultRenderer(pi);

	registerSubagentTool(pi);
	registerSubagentsAvailableCommand(pi);
	registerSubagentsRunningCommand(pi);
	registerSubagentsListTool(pi);
	registerSubagentResumeTool(pi);
}
