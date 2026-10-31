import type { ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ChildStatus } from "./child.ts";
import type { ChildRecord, SubagentRegistry } from "./registry.ts";
import { deriveTitle, formatDuration } from "./result.ts";
import { DEFAULT_CONTEXT, DEFAULT_MODE, type SubagentParams, type SubagentToolDetails } from "./run.ts";

/**
 * All terminal UI for the extension: the footer count, the /subagents command, and the tool
 * renderers. Everything here reacts to the registry; nothing in the core depends on this module.
 */
export function installSubagentUi(pi: ExtensionAPI, registry: SubagentRegistry, currentCtx: () => ExtensionContext | undefined): void {
	const renderStatus = () => {
		const ctx = currentCtx();
		if (!ctx?.hasUI) return;
		const running = registry.running();
		if (running.length === 0) {
			ctx.ui.setStatus("subagent", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const names = running.map((child) => child.title).join(", ");
		ctx.ui.setStatus("subagent", theme.fg("accent", "◐ ") + theme.fg("dim", `${running.length} subagent${running.length === 1 ? "" : "s"}: ${names}`));
	};

	pi.on("session_start", () => renderStatus());
	registry.subscribe(renderStatus);

	pi.registerCommand("subagents", {
		description: "List subagents started in this session; cancel a running one or read a finished one's report",
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

			if (child.status === "running") {
				const confirmed = await ctx.ui.confirm("Cancel subagent", `Cancel "${child.title}" (${child.model})?`);
				if (confirmed) child.abort();
				return;
			}
			const report = [child.error ? `Error: ${child.error}` : "", child.result ?? "(no report)", child.sessionFile ? `\nSession file: ${child.sessionFile}` : ""].filter((line) => line.length > 0).join("\n");
			await ctx.ui.editor(`Subagent "${child.title}" ${child.status} (read-only copy; close to return)`, report);
		},
	});
}

function describeChild(child: ChildRecord): string {
	const elapsed = formatDuration((child.finishedAt ?? Date.now()) - child.startedAt);
	const latest = child.status === "running" && child.progress.length > 0 ? ` · ${child.progress[child.progress.length - 1]}` : "";
	return `${statusGlyph(child.status)} ${child.title} [${child.id}] · ${child.model} · ${child.mode} · ${elapsed}${latest}`;
}

function statusGlyph(status: ChildStatus): string {
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
		const params = args as Partial<SubagentParams>;
		const title = deriveTitle(params.task ?? "", params.title);
		const tags = [params.mode ?? DEFAULT_MODE, params.context ?? DEFAULT_CONTEXT, params.isolation === "worktree" ? "worktree" : undefined, params.model].filter(Boolean).join(" · ");
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

function statusColor(status: ChildStatus, isPartial: boolean): "accent" | "success" | "error" | "warning" {
	if (isPartial || status === "running") return "accent";
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	return "warning";
}

function clipLines(text: string, max: number): string {
	const lines = text.split("\n");
	return lines.length > max ? `${lines.slice(0, max).join("\n")}\n…` : text;
}
