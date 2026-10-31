import type { ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ChildRecord, SubagentRegistry } from "./registry.ts";
import { formatDuration } from "./result.ts";

/** Details every `subagent` tool result carries, for rendering only. */
export interface SubagentToolDetails {
	id: string;
	title: string;
	mode: ChildRecord["mode"];
	context: ChildRecord["context"];
	status: ChildRecord["status"];
	model: string;
	effort: string;
	cwd: string;
	worktree?: { path: string; branch: string };
	sessionFile?: string;
	durationMs?: number;
	error?: string;
	progress?: string[];
}

/**
 * All terminal UI for the extension: the footer count, the /subagents command, and the tool
 * renderers. Everything here reacts to the registry; nothing in the core depends on this module.
 */
export function installSubagentUi(pi: ExtensionAPI, registry: SubagentRegistry): void {
	let uiCtx: ExtensionContext | undefined;

	const renderStatus = () => {
		if (!uiCtx?.hasUI) return;
		const running = registry.running();
		if (running.length === 0) {
			uiCtx.ui.setStatus("subagent", undefined);
			return;
		}
		const theme = uiCtx.ui.theme;
		const names = running.map((child) => child.title).join(", ");
		uiCtx.ui.setStatus("subagent", theme.fg("accent", "◐ ") + theme.fg("dim", `${running.length} subagent${running.length === 1 ? "" : "s"}: ${names}`));
	};

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		renderStatus();
	});
	pi.on("session_shutdown", () => {
		// The context is stale from here on; children still settling must not render into it.
		uiCtx = undefined;
	});
	registry.subscribe(renderStatus);

	pi.registerCommand("subagents", {
		description: "List subagents started in this session; pick a running one to cancel it",
		handler: async (_args, ctx) => {
			const children = registry.list();
			if (children.length === 0) {
				ctx.ui.notify("No subagents have been started in this session.", "info");
				return;
			}

			const labels = children.map(describeChild);
			const picked = await ctx.ui.select("Subagents", labels);
			const child = picked ? children[labels.indexOf(picked)] : undefined;
			if (!child) return;
			if (child.status !== "running") {
				ctx.ui.notify(`${child.title}: ${child.status}${child.sessionFile ? ` (session ${child.sessionFile})` : ""}`, "info");
				return;
			}

			const confirmed = await ctx.ui.confirm("Cancel subagent", `Cancel "${child.title}" (${child.model})?`);
			if (confirmed) child.abort();
		},
	});
}

function describeChild(child: ChildRecord): string {
	const elapsed = formatDuration((child.finishedAt ?? Date.now()) - child.startedAt);
	return `${statusGlyph(child.status)} ${child.title} · ${child.model} · ${child.mode} · ${elapsed}`;
}

function statusGlyph(status: ChildRecord["status"]): string {
	switch (status) {
		case "running":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
	}
}

export const subagentToolRenderers: ToolRenderers = {
	renderCall(args, theme) {
		const params = args as { task?: string; title?: string; mode?: string; model?: string; isolation?: string; context?: string };
		const title = params.title ?? firstLine(params.task ?? "");
		const tags = [params.mode ?? "background", params.context ?? "fresh", params.isolation === "worktree" ? "worktree" : undefined, params.model].filter(Boolean).join(" · ");
		return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", title) + "  " + theme.fg("dim", tags), 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme) {
		const details = result.details as SubagentToolDetails | undefined;
		const text = result.content.find((block): block is { type: "text"; text: string } => block.type === "text")?.text ?? "";
		if (!details) return new Text(text, 0, 0);

		const container = new Container();
		const elapsed = details.durationMs !== undefined ? ` · ${formatDuration(details.durationMs)}` : "";
		const where = details.worktree ? `${details.worktree.path} (${details.worktree.branch})` : details.cwd;
		container.addChild(new Text(theme.fg(statusColor(details.status, isPartial), `${statusGlyph(details.status)} ${details.status}`) + theme.fg("dim", ` · ${details.model} · ${details.effort}${elapsed} · ${where}`), 0, 0));
		if (details.error) container.addChild(new Text(theme.fg("error", details.error), 0, 0));

		if (isPartial && details.progress && details.progress.length > 0) {
			const lines = expanded ? details.progress : details.progress.slice(-3);
			for (const line of lines) container.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
			return container;
		}
		if (details.mode === "background" && details.status === "running") {
			container.addChild(new Text(theme.fg("dim", "  running in the background; the result arrives as a user message"), 0, 0));
			return container;
		}

		const body = expanded ? text : clipLines(text, 6);
		container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		return container;
	},
};

function statusColor(status: ChildRecord["status"], isPartial: boolean): "accent" | "success" | "error" | "warning" {
	if (isPartial || status === "running") return "accent";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return "warning";
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function clipLines(text: string, max: number): string {
	const lines = text.split("\n");
	return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…` : text;
}
