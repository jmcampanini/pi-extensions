import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface BellIO {
	env: Record<string, string | undefined>;
	write(text: string): void;
}

const systemIO: BellIO = {
	env: process.env,
	write: (text) => {
		process.stdout.write(text);
	},
};

export function registerBellWhenDone(pi: ExtensionAPI, io: BellIO = systemIO): void {
	// Subagent children inherit global extensions; register nothing so only
	// the parent session bells.
	if (io.env.PI_SUBAGENT_SESSION) return;

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Terminals surface BEL as an attention cue: tmux records a window bell
		// alert, others raise urgency hints or dock bounces.
		io.write("\x07");
	});
}

export default function bellWhenDone(pi: ExtensionAPI): void {
	registerBellWhenDone(pi);
}
