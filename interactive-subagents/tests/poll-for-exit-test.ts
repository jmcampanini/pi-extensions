// Direct integration tests for the exit poller. A private tmux server runs
// real retained panes so sidecars, dead statuses, signal death, and vanished
// panes cross the same boundary they do in production.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, condition: boolean) {
	if (condition) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	console.log("  SKIP tmux is not installed");
	console.log("\n0 passed, 0 failed (skipped)");
	process.exit(0);
}

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "poll-for-exit-test-"));
const configDir = join(root, "config");
mkdirSync(configDir);
writeFileSync(join(configDir, "subagents.json"), '{"layout":"off"}\n');

const socketName = `pi-subagents-poll-test-${process.pid}`;
const savedEnv = {
	PATH: process.env.PATH,
	TMUX: process.env.TMUX,
	TMUX_PANE: process.env.TMUX_PANE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function isolatedTmux(args: string[]): string {
	return execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8" });
}

function attachedTmux(args: string[]): string {
	return execFileSync("tmux", args, { encoding: "utf8" });
}

async function waitForFormat(paneId: string, format: string, want: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (attachedTmux(["display-message", "-p", "-t", paneId, format]).trim() === want) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pane ${paneId} never reported ${format}=${want}`);
}

function restore(name: keyof typeof savedEnv): void {
	const value = savedEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

try {
	process.env.PATH = savedEnv.PATH ?? "";
	process.env.PI_CODING_AGENT_DIR = configDir;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;

	const parentPane = isolatedTmux([
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"poll-for-exit",
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"bash",
		"-c",
		"while :; do sleep 60; done",
	]).trim();
	const socketPath = isolatedTmux(["display-message", "-p", "-t", parentPane, "#{socket_path}"]).trim();
	process.env.TMUX = `${socketPath},0,0`;
	process.env.TMUX_PANE = parentPane;

	const { config } = await import("../config.ts");
	const { closePane, createPane, pollForExit, stageLaunchScript } = await import("../tmux.ts");
	config.layout = "off";

	function launch(label: string, command: string): { paneId: string; sessionFile: string } {
		const scriptPath = join(root, `${label}.sh`);
		const sessionFile = join(root, `${label}.jsonl`);
		stageLaunchScript(command, scriptPath);
		return { paneId: createPane(label, scriptPath), sessionFile };
	}

	async function poll(
		paneId: string,
		sessionFile: string,
		controller: AbortController,
		onTick?: () => void,
	) {
		const timeout = setTimeout(() => controller.abort(), 3000);
		try {
			return await pollForExit({ paneId, sessionFile, signal: controller.signal, onTick, tickMs: 25 });
		} finally {
			clearTimeout(timeout);
		}
	}

	{
		const child = launch("exit-code", "exit 23");
		const controller = new AbortController();
		const result = await poll(child.paneId, child.sessionFile, controller);
		if (result.reason === "killed") {
			eq("crash without a tmux status still fails", result.exitCode, 1);
			ok("status-less crash is explained", result.errorMessage.includes("died without reporting an exit status"));
		} else {
			eq("crash exit code is preserved when tmux reports it", result, { reason: "exited", exitCode: 23 });
		}
		closePane(child.paneId);
	}

	{
		const child = launch("signal-death", "exec sleep 60");
		await waitForFormat(child.paneId, "#{pane_current_command}", "sleep");
		const panePid = Number.parseInt(attachedTmux(["display-message", "-p", "-t", child.paneId, "#{pane_pid}"]).trim(), 10);
		process.kill(panePid, "SIGKILL");
		const controller = new AbortController();
		let ticks = 0;
		const result = await poll(child.paneId, child.sessionFile, controller, () => { ticks += 1; });
		eq("signal death has a distinct reason", result.reason, "killed");
		ok("empty dead status is confirmed on a later tick", ticks >= 1);
		eq("signal death uses failure exit code", result.exitCode, 1);
		ok(
			"signal death explains the missing status",
			result.reason === "killed" && result.errorMessage.includes("died without reporting an exit status"),
		);
		closePane(child.paneId);
	}

	{
		const child = launch("dead-sidecar", "exit 0");
		writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "precise child error" }));
		await waitForFormat(child.paneId, "#{pane_dead}", "1");
		const controller = new AbortController();
		const result = await poll(child.paneId, child.sessionFile, controller);
		eq("sidecar beats a dead pane", result, { reason: "error", exitCode: 1, errorMessage: "precise child error" });
		ok("consumed sidecar is deleted", !existsSync(`${child.sessionFile}.exit`));
		closePane(child.paneId);
	}

	{
		const child = launch("gone-late-sidecar", "exec sleep 60");
		const controller = new AbortController();
		let ticks = 0;
		const result = await poll(child.paneId, child.sessionFile, controller, () => {
			ticks += 1;
			if (ticks === 1) closePane(child.paneId);
			if (ticks === 3) writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "done" }));
		});
		eq("late sidecar wins during pane-gone grace", result, { reason: "done", exitCode: 0 });
		ok("pane-gone grace waited for the late sidecar", ticks >= 3);
		ok("late sidecar is deleted", !existsSync(`${child.sessionFile}.exit`));
	}

	{
		const child = launch("gone-silent", "exec sleep 60");
		closePane(child.paneId);
		const controller = new AbortController();
		let ticks = 0;
		const result = await poll(child.paneId, child.sessionFile, controller, () => { ticks += 1; });
		eq("silent vanished pane fails after grace", result.reason, "pane-closed");
		eq("pane-gone grace performs four sleeps before the fifth verdict", ticks, 4);
	}

	{
		const child = launch("abort", "exec sleep 60");
		const controller = new AbortController();
		let ticks = 0;
		const result = await poll(child.paneId, child.sessionFile, controller, () => {
			ticks += 1;
			controller.abort();
		});
		eq("aborted poll reports aborted", result, { reason: "aborted", exitCode: 0 });
		eq("abort happens mid-poll", ticks, 1);
		closePane(child.paneId);
	}
} catch (error) {
	fail++;
	console.log(`  FAIL pollForExit integration setup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
	try { isolatedTmux(["kill-server"]); } catch {}
	restore("PATH");
	restore("TMUX");
	restore("TMUX_PANE");
	restore("PI_CODING_AGENT_DIR");
	rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
