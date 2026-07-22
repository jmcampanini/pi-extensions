import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ELAPSED_TIME_STATUS_KEY = "elapsed-time";

export interface ElapsedTimeClock {
	now(): number;
	setInterval(callback: () => void, milliseconds: number): unknown;
	clearInterval(handle: unknown): void;
}

const systemClock: ElapsedTimeClock = {
	now: () => performance.now(),
	setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Number.isFinite(milliseconds)
		? Math.max(0, Math.floor(milliseconds / 1000))
		: 0;
	const pad = (value: number) => String(value).padStart(2, "0");
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function registerElapsedTime(pi: ExtensionAPI, clock: ElapsedTimeClock = systemClock): void {
	let startedAt: number | undefined;
	let refreshTimer: unknown;
	let activeContext: ExtensionContext | undefined;

	function elapsed(): string {
		return formatElapsed(clock.now() - (startedAt ?? clock.now()));
	}

	function showRunning(ctx: ExtensionContext): void {
		ctx.ui.setStatus(ELAPSED_TIME_STATUS_KEY, `◷ ${elapsed()}`);
	}

	function stopTimer(): void {
		if (refreshTimer === undefined) return;
		clock.clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		activeContext = ctx;
		if (startedAt !== undefined) return;

		startedAt = clock.now();
		showRunning(ctx);
		refreshTimer = clock.setInterval(() => {
			if (activeContext && startedAt !== undefined) showRunning(activeContext);
		}, 1000);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (startedAt === undefined) return;

		stopTimer();
		if (ctx.hasUI) ctx.ui.setStatus(ELAPSED_TIME_STATUS_KEY, `✓ ${elapsed()}`);
		startedAt = undefined;
		activeContext = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		startedAt = undefined;
		activeContext = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(ELAPSED_TIME_STATUS_KEY, undefined);
	});
}

export default function elapsedTime(pi: ExtensionAPI): void {
	registerElapsedTime(pi);
}
