// Integration test for the real tmux pane boundary. It uses an isolated
// server and a stand-in `pi` on that server's PATH, so no user session or
// interactive shell initialization participates in the launch.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

function tmuxAvailable(): boolean {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

if (!tmuxAvailable()) {
	describe("tmux pane boundary", () => {
		it("dead-pane launches are observable and closable in every layout", { skip: "tmux is not installed" }, () => {});
	});
} else {
	const sandbox = join(process.cwd(), ".sandbox");
	mkdirSync(sandbox, { recursive: true });
	const root = mkdtempSync(join(sandbox, "tmux test-"));
	const binDir = join(root, "bin");
	const configDir = join(root, "config");
	const defaultShellMarker = join(binDir, "default-shell-invoked");
	const fakeDefaultShell = join(binDir, "hostile-shell");
	mkdirSync(binDir);
	mkdirSync(configDir);
	writeFileSync(
		join(binDir, "pi"),
		"#!/bin/bash\nprintf 'stand-in pi crashed immediately\\n'\nexit 23\n",
		{ mode: 0o755 },
	);
	writeFileSync(
		fakeDefaultShell,
		"#!/bin/bash\nprintf invoked >\"${0%/*}/default-shell-invoked\"\nexit 97\n",
		{ mode: 0o755 },
	);
	writeFileSync(join(configDir, "subagents.json"), '{"layout":"off"}\n');

	const socketName = `pi-subagents-test-${process.pid}`;
	const sessionName = "pane-launch";
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

	function paneExists(paneId: string): boolean {
		return attachedTmux(["list-panes", "-a", "-F", "#{pane_id}"])
			.split("\n")
			.some((line) => line.trim() === paneId);
	}

	async function waitForDeadPane(paneId: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (attachedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead}"]).trim() === "1") return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`pane ${paneId} did not become dead`);
	}

	function restore(name: keyof typeof savedEnv): void {
		const value = savedEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	after(() => {
		try { isolatedTmux(["kill-server"]); } catch {}
		restore("PATH");
		restore("TMUX");
		restore("TMUX_PANE");
		restore("PI_CODING_AGENT_DIR");
		rmSync(root, { recursive: true, force: true });
	});

	process.env.PATH = `${binDir}${delimiter}${savedEnv.PATH ?? ""}`;
	process.env.PI_CODING_AGENT_DIR = configDir;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;

	const parentPane = isolatedTmux([
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		sessionName,
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"bash",
		"-c",
		"while :; do sleep 60; done",
	]).trim();
	const socketPath = isolatedTmux(["display-message", "-p", "-t", parentPane, "#{socket_path}"]).trim();
	isolatedTmux(["set-option", "-g", "default-shell", fakeDefaultShell]);
	process.env.TMUX = `${socketPath},0,0`;
	process.env.TMUX_PANE = parentPane;

	const { config } = await import("../config.ts");
	const { closePane, createPane, stageLaunchScript } = await import("../tmux.ts");

	async function launch(layout: "off" | "main" | "window", label: string): Promise<string> {
		config.layout = layout;
		const scriptPath = join(root, `${label}.sh`);
		stageLaunchScript("pi", scriptPath);
		const paneId = createPane(label, scriptPath);
		await waitForDeadPane(paneId);

		assert.strictEqual(
			attachedTmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim(),
			"on",
			`${label}: remain-on-exit is on`,
		);
		const deadState = attachedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead},#{pane_dead_status}"]).trim();
		assert.ok(
			deadState === "1,23" || deadState === "1,",
			`${label}: tmux reports the crash with or without an available status`,
		);
		return paneId;
	}

	describe("tmux pane boundary", () => {
		it("dead-pane launches are observable and closable in every layout", async () => {
			const offPane = await launch("off", "off-layout");
			closePane(offPane);
			assert.ok(!paneExists(offPane), "off-layout: kill-pane removes the dead pane");

			const mainPane = await launch("main", "main-layout");
			closePane(mainPane);
			assert.ok(!paneExists(mainPane), "main-layout: kill-pane removes the dead pane");

			const firstWindowPane = await launch("window", "window-layout-first");
			const secondWindowPane = await launch("window", "window-layout-split");
			closePane(secondWindowPane);
			assert.ok(!paneExists(secondWindowPane), "window-layout-split: kill-pane removes the dead pane");
			closePane(firstWindowPane);
			assert.ok(!paneExists(firstWindowPane), "window-layout-first: kill-pane removes the dead pane");
			assert.ok(!existsSync(defaultShellMarker), "the hostile default shell was never invoked");
		});
	});
}
