// Integration test for the real tmux pane boundary. It uses an isolated
// server and a stand-in `pi` on that server's PATH, so no user session or
// interactive shell initialization participates in the launch.
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

async function waitForDeadPane(paneId: string, exitCode: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const state = attachedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead},#{pane_dead_status}"]).trim();
		if (state === `1,${exitCode}`) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const details = attachedTmux([
		"display-message",
		"-p",
		"-t",
		paneId,
		"dead=#{pane_dead} status=#{pane_dead_status} signal=#{pane_dead_signal} current=#{pane_current_command} start=#{pane_start_command}",
	]).trim();
	throw new Error(`pane ${paneId} did not retain exit code ${exitCode}: ${details}`);
}

function restore(name: keyof typeof savedEnv): void {
	const value = savedEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

try {
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
		await waitForDeadPane(paneId, 23);

		eq(`${label}: remain-on-exit is on`, attachedTmux(["show-options", "-p", "-v", "-t", paneId, "remain-on-exit"]).trim(), "on");
		eq(
			`${label}: tmux preserves the fast crash exit code`,
			attachedTmux(["display-message", "-p", "-t", paneId, "#{pane_dead},#{pane_dead_status}"]).trim(),
			"1,23",
		);
		return paneId;
	}

	const offPane = await launch("off", "off-layout");
	closePane(offPane);
	ok("off-layout: kill-pane removes the dead pane", !paneExists(offPane));

	const mainPane = await launch("main", "main-layout");
	closePane(mainPane);
	ok("main-layout: kill-pane removes the dead pane", !paneExists(mainPane));

	const firstWindowPane = await launch("window", "window-layout-first");
	const secondWindowPane = await launch("window", "window-layout-split");
	closePane(secondWindowPane);
	ok("window-layout-split: kill-pane removes the dead pane", !paneExists(secondWindowPane));
	closePane(firstWindowPane);
	ok("window-layout-first: kill-pane removes the dead pane", !paneExists(firstWindowPane));
	ok("the hostile default shell was never invoked", !existsSync(defaultShellMarker));
} catch (error) {
	fail++;
	console.log(`  FAIL tmux integration setup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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
