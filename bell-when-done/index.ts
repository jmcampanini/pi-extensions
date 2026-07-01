import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!process.env.TMUX) return;

		// tmux receives BEL from pane output and records it as a window bell alert.
		process.stdout.write("\x07");
	});
}
