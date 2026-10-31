import { describe, expect, it } from "vitest";
import { createWorktree, expandWorktreePath, parseRemoteUrl, slugify } from "./worktree.ts";

const values = { repo: "pi-extensions", repoPath: "/code/pi-extensions", host: "github.com", owner: "jmcampanini", slug: "add-tests", branch: "pi/add-tests" };

describe("expandWorktreePath", () => {
	it("expands placeholders, environment variables, and a leading tilde", () => {
		expect(expandWorktreePath("~/.pi/worktrees/{repo}/{slug}", values, {}, "/Users/me")).toBe("/Users/me/.pi/worktrees/pi-extensions/add-tests");
		expect(expandWorktreePath("$CODE_DIR/.worktrees/pi/{host}/{owner}/{repo}/{branch}", values, { CODE_DIR: "/Users/me/Code" }, "/Users/me")).toBe(
			"/Users/me/Code/.worktrees/pi/github.com/jmcampanini/pi-extensions/pi/add-tests",
		);
		expect(expandWorktreePath("${ROOT}/{slug}", values, { ROOT: "/tmp/wt" }, "/Users/me")).toBe("/tmp/wt/add-tests");
	});

	it("rejects an unset variable instead of producing a relative path", () => {
		expect(() => expandWorktreePath("$CODE_DIR/{slug}", values, {}, "/Users/me")).toThrow(/CODE_DIR/);
		expect(() => expandWorktreePath("relative/{slug}", values, {}, "/Users/me")).toThrow(/absolute/);
	});
});

describe("slugify", () => {
	it("lowercases, hyphenates, trims, and caps the length", () => {
		expect(slugify("Add tests for the Fork builder!")).toBe("add-tests-for-the-fork-builder");
		expect(slugify("a".repeat(60), 10)).toBe("aaaaaaaaaa");
		expect(slugify("???")).toBe("task");
	});
});

describe("parseRemoteUrl", () => {
	it("reads host and owner from scp-like, ssh, and https remotes", () => {
		expect(parseRemoteUrl("git@github.com:jmcampanini/pi-extensions.git")).toEqual({ host: "github.com", owner: "jmcampanini", repo: "pi-extensions" });
		expect(parseRemoteUrl("ssh://git@gitlab.com:2222/group/sub/app.git")).toEqual({ host: "gitlab.com", owner: "group/sub", repo: "app" });
		expect(parseRemoteUrl("https://github.com/acme/app")).toEqual({ host: "github.com", owner: "acme", repo: "app" });
		expect(parseRemoteUrl("/local/path")).toBeUndefined();
	});
});

describe("createWorktree", () => {
	it("skips taken branches and paths, then adds the worktree from the requested ref", async () => {
		const calls: string[][] = [];
		const exec = async (_command: string, args: string[]) => {
			calls.push(args);
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/code/app\n", stderr: "", code: 0 };
			if (args[0] === "remote") return { stdout: "git@github.com:acme/app.git\n", stderr: "", code: 0 };
			if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: "", stderr: "", code: args[3] === "refs/heads/pi/fix" ? 0 : 1 };
			if (args[0] === "worktree") return { stdout: "", stderr: "", code: 0 };
			throw new Error(`unexpected git ${args.join(" ")}`);
		};

		const created = await createWorktree({ exec, cwd: "/code/app/src", slug: "fix", from: "origin/main", template: "/wt/{owner}/{repo}/{slug}", env: {}, home: "/home", exists: (path) => path === "/wt/acme/app/fix-2" });

		expect(created).toEqual({ path: "/wt/acme/app/fix-3", branch: "pi/fix-3", repoPath: "/code/app" });
		expect(calls.at(-1)).toEqual(["worktree", "add", "-b", "pi/fix-3", "/wt/acme/app/fix-3", "origin/main"]);
	});

	it("surfaces git's error when the worktree cannot be added", async () => {
		const exec = async (_command: string, args: string[]) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: "/code/app\n", stderr: "", code: 0 };
			if (args[0] === "remote") return { stdout: "", stderr: "no origin", code: 2 };
			if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 1 };
			return { stdout: "", stderr: "fatal: invalid reference: nope", code: 128 };
		};

		await expect(createWorktree({ exec, cwd: "/code/app", slug: "x", from: "nope", template: "/wt/{slug}", env: {}, home: "/home", exists: () => false })).rejects.toThrow(/invalid reference: nope/);
	});
});
