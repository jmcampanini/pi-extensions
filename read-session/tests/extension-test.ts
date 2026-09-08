import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";
import { entries } from "./fixture.ts";

const sandbox = join(process.cwd(), ".sandbox");
await mkdir(sandbox, { recursive: true });
const directory = await mkdtemp(join(sandbox, "read-session-test-"));
after(() => rm(directory, { recursive: true, force: true }));

describe("read-session command", () => {
	it("writes one page before opening it and replaces the same session's prior snapshot", async () => {
		let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		const notices: string[] = [];
		const opened: { command: string; paths: string[]; contents: string[] }[] = [];
		let branch = entries;
		register({
			registerCommand(_name: string, options: { handler: typeof handler }) {
				handler = options.handler;
			},
			async exec(command: string, paths: string[]) {
				opened.push({
					command,
					paths,
					contents: await Promise.all(paths.map((path) => readFile(path, "utf8"))),
				});
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: directory,
			sessionManager: {
				getBranch: () => branch,
				getSessionId: () => "fixture-session",
				getSessionName: () => "Preview",
			},
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionCommandContext;

		await handler!("", ctx);
		branch = [
			...entries,
			{
				type: "message",
				id: "new-prompt",
				parentId: entries.at(-1)!.id,
				timestamp: "2026-09-07T12:01:00.000Z",
				message: { role: "user", content: "One more question.", timestamp: 1 },
			},
		];
		await handler!("", ctx);

		assert.equal(opened.length, 2);
		assert.equal(opened[0]!.command, "open");
		assert.equal(opened[0]!.paths.length, 1);
		assert.deepEqual(opened[0]!.paths, opened[1]!.paths);
		assert.ok(opened[0]!.contents.every((html) => (html.match(/id="message-\d+-source"/g) ?? []).length === 6));
		assert.ok(opened[1]!.contents.every((html) => (html.match(/id="message-\d+-source"/g) ?? []).length === 7));
		const sessions = await readdir(join(directory, ".sandbox", "read-session"));
		assert.deepEqual(await readdir(join(directory, ".sandbox", "read-session", sessions[0]!)), ["index.html"]);
		assert.ok(notices.every((message) => message.startsWith("Opened the session reader")));
	});

	it("opens failure notices even when the session has no text messages", async () => {
		const entry = entries[1]!;
		assert.ok(entry.type === "message" && entry.message.role === "assistant");
		let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		let html = "";
		register({
			registerCommand(_name: string, options: { handler: typeof handler }) {
				handler = options.handler;
			},
			async exec(_command: string, paths: string[]) {
				html = await readFile(paths[0]!, "utf8");
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		} as unknown as ExtensionAPI);

		await handler!("", {
			cwd: directory,
			sessionManager: {
				getBranch: () => [
					{
						...entry,
						message: {
							...entry.message,
							content: [],
							stopReason: "error",
							errorMessage: "Provider unavailable",
						},
					},
				],
				getSessionId: () => "empty-failed-turn",
				getSessionName: () => "Preview",
			},
			ui: { notify() {} },
		} as unknown as ExtensionCommandContext);

		assert.match(html, /<summary>Agent response failed<\/summary>\s*<pre>Provider unavailable<\/pre>/);
		assert.doesNotMatch(html, /id="message-\d+-source"/);
	});

	it("keeps the generated file available when the OS opener fails", async () => {
		let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		let paths: string[] = [];
		const notices: string[] = [];
		register({
			registerCommand(_name: string, options: { handler: typeof handler }) {
				handler = options.handler;
			},
			async exec(_command: string, files: string[]) {
				paths = files;
				return { code: 1, stderr: "No browser", stdout: "", killed: false };
			},
		} as unknown as ExtensionAPI);

		await handler!("", {
			cwd: directory,
			sessionManager: {
				getBranch: () => entries,
				getSessionId: () => "opener-failure",
				getSessionName: () => "Preview",
			},
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionCommandContext);

		assert.equal(paths.length, 1);
		assert.equal(((await readFile(paths[0]!, "utf8")).match(/id="message-\d+-source"/g) ?? []).length, 6);
		assert.match(notices[0]!, /Generated .*index\.html.*open failed: No browser/);
	});
});
