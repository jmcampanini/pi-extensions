import { describe, expect, it } from "vitest";
import { childToolNames, parentExtensionFlags, resolveChildTrust } from "./environment.ts";

describe("parentExtensionFlags", () => {
	it("collects the parent's -e entries and --no-extensions, ignoring its other flags", () => {
		const flags = parentExtensionFlags(["--mode", "rpc", "-e", "./extensions/subagent", "--extension", "builtin:mcp", "--no-extensions", "--model", "x", "--thinking", "low"]);
		expect(flags).toEqual({ paths: ["./extensions/subagent", "builtin:mcp"], noExtensions: true });
	});

	it("reports nothing for a parent started without extension flags", () => {
		expect(parentExtensionFlags(["--mode", "rpc"])).toEqual({ paths: [], noExtensions: false });
	});
});

describe("childToolNames", () => {
	it("keeps the parent's active tools except subagent", () => {
		expect(childToolNames(["read", "subagent", "bash", "codemode"])).toEqual(["read", "bash", "codemode"]);
	});
});

describe("resolveChildTrust", () => {
	const base = { parentCwd: "/code/app", parentTrusted: true, createdWorktree: false, storedDecision: () => null, requiresTrust: () => true };

	it("inherits the parent's trust inside the parent's project or in a worktree made from it", () => {
		expect(resolveChildTrust({ ...base, childCwd: "/code/app/src" })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/code/app", parentTrusted: false })).toBe(false);
		expect(resolveChildTrust({ ...base, childCwd: "/wt/app/x", createdWorktree: true })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/code/app-other" })).toBe(false);
	});

	it("follows the stored decision elsewhere, and trusts only when nothing there needs trust", () => {
		expect(resolveChildTrust({ ...base, childCwd: "/other", storedDecision: () => true })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/other", storedDecision: () => false, requiresTrust: () => false })).toBe(false);
		expect(resolveChildTrust({ ...base, childCwd: "/other", requiresTrust: () => false })).toBe(true);
		expect(resolveChildTrust({ ...base, childCwd: "/other" })).toBe(false);
	});
});
