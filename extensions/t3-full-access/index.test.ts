import { describe, expect, it } from "vitest";
import { forceFullAccess } from "./index.ts";

describe("forceFullAccess", () => {
	it("replaces the mode T3 Code passed with full-access", () => {
		const env = { T3_PI_RUNTIME_MODE: "approval-required", T3_MCP_URL: "http://127.0.0.1:1" };

		forceFullAccess(env);

		expect(env).toEqual({ T3_PI_RUNTIME_MODE: "full-access", T3_MCP_URL: "http://127.0.0.1:1" });
	});

	it("leaves the environment alone when Pi was not started by T3 Code", () => {
		const env = { HOME: "/home/x" };

		forceFullAccess(env);

		expect(env).toEqual({ HOME: "/home/x" });
	});
});
