import { describe, expect, it } from "vitest";
import { childToolNames, parentFlags, resolveChildTrust } from "./environment.ts";

describe("parentFlags", () => {
	it("collects the parent's -e entries and --no-extensions, ignoring its other flags", () => {
		const flags = parentFlags(["--mode", "rpc", "-e", "./extensions/subagent", "--extension", "builtin:mcp", "-e", "/abs/ext.ts", "--no-extensions", "--api-key", "sk-test", "--model", "x"], "/code/app");
		expect(flags).toEqual({ extensions: ["/code/app/extensions/subagent", "builtin:mcp", "/abs/ext.ts"], noExtensions: true });
	});

	it("reports nothing for a parent started without those flags", () => {
		expect(parentFlags(["--mode", "rpc"], "/code/app")).toEqual({ extensions: [], noExtensions: false });
	});
});

describe("childToolNames", () => {
	it("keeps the parent's active tools except subagent", () => {
		expect(childToolNames(["read", "subagent", "bash", "codemode"])).toEqual(["read", "bash", "codemode"]);
	});
});

describe("resolveChildTrust", () => {
	const base = { parentCwd: "/code/app", parentTrusted: true, storedDecision: () => null, requiresTrust: () => true };

	it("inherits the parent's trust inside the parent's project", () => {
		expect(resolveChildTrust({ ...base, childCwd: "/code/app/src" })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/code/app", parentTrusted: false })).toBe(false);
		expect(resolveChildTrust({ ...base, childCwd: "/code/app-other" })).toBe(false);
	});

	it("follows the stored decision elsewhere, and trusts only when nothing there needs trust", () => {
		expect(resolveChildTrust({ ...base, childCwd: "/other", storedDecision: () => true })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/other", storedDecision: () => false, requiresTrust: () => false })).toBe(false);
		expect(resolveChildTrust({ ...base, childCwd: "/other", requiresTrust: () => false })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/other" })).toBe(false);
	});
});
