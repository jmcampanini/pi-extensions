// Direct integration tests for the exit poller. A private tmux server runs
// real retained panes so sidecars, dead statuses, signal death, and vanished
// panes cross the same boundary they do in production.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const socketName = `pi-subagents-poll-test-${process.pid}`;
const savedEnv = {
	PATH: process.env.PATH,
	TMUX: process.env.TMUX,
	TMUX_PANE: process.env.TMUX_PANE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let root = "";
let tmuxServerMayExist = false;
let cleaned = false;

function restore(name: keyof typeof savedEnv): void {
	const value = savedEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function isolatedTmux(args: string[]): string {
	return execFileSync("tmux", ["-L", socketName, ...args], { encoding: "utf8" });
}

function cleanup(): void {
	if (cleaned) return;
	cleaned = true;
	if (tmuxServerMayExist) {
		try { isolatedTmux(["kill-server"]); } catch {}
	}
	restore("PATH");
	restore("TMUX");
	restore("TMUX_PANE");
	restore("PI_CODING_AGENT_DIR");
	if (root) rmSync(root, { recursive: true, force: true });
}

after(cleanup);

let tmuxAvailable = true;
try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	tmuxAvailable = false;
}

if (!tmuxAvailable) {
	it("pollForExit integration", { skip: "tmux is not installed" }, () => {});
} else {
	const { attachedTmux, closePane, createPane, pollForExit, stageLaunchScript } = await (async () => {
		try {
			const sandbox = join(process.cwd(), ".sandbox");
			mkdirSync(sandbox, { recursive: true });
			root = mkdtempSync(join(sandbox, "poll-for-exit-test-"));
			const configDir = join(root, "config");
			mkdirSync(configDir);
			writeFileSync(join(configDir, "subagents.json"), '{"layout":"off"}\n');

			process.env.PATH = savedEnv.PATH ?? "";
			process.env.PI_CODING_AGENT_DIR = configDir;
			delete process.env.TMUX;
			delete process.env.TMUX_PANE;

			tmuxServerMayExist = true;
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
			const tmux = await import("../tmux.ts");
			config.layout = "off";
			return {
				attachedTmux: (args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }),
				closePane: tmux.closePane,
				createPane: tmux.createPane,
				pollForExit: tmux.pollForExit,
				stageLaunchScript: tmux.stageLaunchScript,
			};
		} catch (error) {
			cleanup();
			throw error;
		}
	})();

	async function waitForFormat(paneId: string, format: string, want: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (attachedTmux(["display-message", "-p", "-t", paneId, format]).trim() === want) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`pane ${paneId} never reported ${format}=${want}`);
	}

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

	describe("pollForExit", () => {
		it("a crash preserves the reported exit code or explains the missing status", async () => {
			const child = launch("exit-code", "exit 23");
			const controller = new AbortController();
			const result = await poll(child.paneId, child.sessionFile, controller);
			if (result.reason === "killed") {
				assert.strictEqual(result.exitCode, 1, "crash without a tmux status still fails");
				assert.ok(
					result.errorMessage.includes("died without reporting an exit status"),
					"status-less crash is explained",
				);
			} else {
				assert.deepStrictEqual(result, { reason: "exited", exitCode: 23 },
					"crash exit code is preserved when tmux reports it");
			}
			closePane(child.paneId);
		});

		it("signal death is reported as killed with the missing status explained", async () => {
			const child = launch("signal-death", "exec sleep 60");
			await waitForFormat(child.paneId, "#{pane_current_command}", "sleep");
			const panePid = Number.parseInt(attachedTmux(["display-message", "-p", "-t", child.paneId, "#{pane_pid}"]).trim(), 10);
			process.kill(panePid, "SIGKILL");
			const controller = new AbortController();
			let ticks = 0;
			const result = await poll(child.paneId, child.sessionFile, controller, () => { ticks += 1; });
			assert.strictEqual(result.reason, "killed", "signal death has a distinct reason");
			assert.ok(ticks >= 1, "empty dead status is confirmed on a later tick");
			assert.strictEqual(result.exitCode, 1, "signal death uses failure exit code");
			assert.ok(
				result.reason === "killed" && result.errorMessage.includes("died without reporting an exit status"),
				"signal death explains the missing status",
			);
			closePane(child.paneId);
		});

		it("an exit sidecar beats a dead pane and is consumed", async () => {
			const child = launch("dead-sidecar", "exit 0");
			writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: "precise child error" }));
			await waitForFormat(child.paneId, "#{pane_dead}", "1");
			const controller = new AbortController();
			const result = await poll(child.paneId, child.sessionFile, controller);
			assert.deepStrictEqual(result, { reason: "error", exitCode: 1, errorMessage: "precise child error" },
				"sidecar beats a dead pane");
			assert.ok(!existsSync(`${child.sessionFile}.exit`), "consumed sidecar is deleted");
			closePane(child.paneId);
		});

		it("a late sidecar wins during pane-gone grace", async () => {
			const child = launch("gone-late-sidecar", "exec sleep 60");
			const controller = new AbortController();
			let ticks = 0;
			const result = await poll(child.paneId, child.sessionFile, controller, () => {
				ticks += 1;
				if (ticks === 1) closePane(child.paneId);
				if (ticks === 3) writeFileSync(`${child.sessionFile}.exit`, JSON.stringify({ type: "done" }));
			});
			assert.deepStrictEqual(result, { reason: "done", exitCode: 0 }, "late sidecar wins during pane-gone grace");
			assert.ok(ticks >= 3, "pane-gone grace waited for the late sidecar");
			assert.ok(!existsSync(`${child.sessionFile}.exit`), "late sidecar is deleted");
		});

		it("a silent vanished pane fails after grace", async () => {
			const child = launch("gone-silent", "exec sleep 60");
			closePane(child.paneId);
			const controller = new AbortController();
			let ticks = 0;
			const result = await poll(child.paneId, child.sessionFile, controller, () => { ticks += 1; });
			assert.strictEqual(result.reason, "pane-closed", "silent vanished pane fails after grace");
			assert.strictEqual(ticks, 4, "pane-gone grace performs four sleeps before the fifth verdict");
		});

		it("an aborted poll reports aborted mid-poll", async () => {
			const child = launch("abort", "exec sleep 60");
			const controller = new AbortController();
			let ticks = 0;
			const result = await poll(child.paneId, child.sessionFile, controller, () => {
				ticks += 1;
				controller.abort();
			});
			assert.deepStrictEqual(result, { reason: "aborted", exitCode: 0 }, "aborted poll reports aborted");
			assert.strictEqual(ticks, 1, "abort happens mid-poll");
			closePane(child.paneId);
		});
	});
}
