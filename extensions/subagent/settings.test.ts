import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS, readSubagentSettings } from "./settings.ts";

describe("readSubagentSettings", () => {
	it("returns defaults when the section is missing or not an object", () => {
		expect(readSubagentSettings({})).toEqual(DEFAULT_SUBAGENT_SETTINGS);
		expect(readSubagentSettings({ subagent: "nope" })).toEqual(DEFAULT_SUBAGENT_SETTINGS);
	});

	it("takes valid overrides and keeps defaults for mistyped fields", () => {
		const settings = readSubagentSettings({ subagent: { worktreePath: "$CODE_DIR/.worktrees/pi/{repo}/{slug}", resultMaxChars: "big", resultMaxLines: 0 } });
		expect(settings).toEqual({ worktreePath: "$CODE_DIR/.worktrees/pi/{repo}/{slug}", worktreeBranch: "pi/{slug}", resultMaxChars: 50_000, resultMaxLines: 2_000 });
	});
});
