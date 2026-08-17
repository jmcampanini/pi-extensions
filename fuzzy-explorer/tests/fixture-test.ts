import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { extractBlocks } from "../extract.ts";
import { searchBlocks } from "../search.ts";
import { buildFixtureSession } from "./fixture-session.ts";

const fixtureDirectory = resolve(".sandbox/fuzzy-explorer-fixture-test");
mkdirSync(fixtureDirectory, { recursive: true });
const sentinelPath = resolve(fixtureDirectory, "caller-owned.txt");
writeFileSync(sentinelPath, "keep me", "utf8");
const fixture = buildFixtureSession(fixtureDirectory);

describe("fixture session", () => {
	const session = SessionManager.open(fixture.sessionFile);
	const branch = session.getBranch();
	const blocks = extractBlocks(branch, (id) => session.getLabel(id));
	const indexed = blocks.map((block) => `${block.fields}\n${block.body}`).join("\n");

	it("fixture generation preserves unrelated caller-owned files", () => {
		assert.strictEqual(readFileSync(sentinelPath, "utf8"), "keep me");
	});

	it("fixture full-output survivor exists", () => {
		assert.ok(existsSync(fixture.fullOutputPath));
	});

	it("fixture missing full-output path is absent", () => {
		assert.ok(!existsSync(fixture.missingFullOutputPath));
	});

	it("active branch excludes both abandoned entry ids", () => {
		assert.deepStrictEqual(
			fixture.abandonedEntryIds.filter((id) => branch.some((entry) => entry.id === id)),
			[],
		);
	});

	it("every v1 block kind is represented", () => {
		assert.ok(["user", "assistant", "tool", "bash", "custom", "summary"]
			.every((kind) => blocks.some((block) => block.kind === kind)));
	});

	it("fixture includes merged and orphan tool rows", () => {
		assert.ok(blocks.some((block) => block.toolCallId === "call-read" && block.body.includes("STORED_RESULT_ONLY_NEEDLE"))
			&& blocks.some((block) => block.toolCallId === "orphan-call"));
	});

	it("one fixture query combines fuzzy invocation fields with result-only body text", () => {
		assert.deepStrictEqual(
			searchBlocks(blocks, "sconf STORED_RESULT_ONLY_NEEDLE").map((result) => result.block.toolCallId),
			["call-read"],
		);
	});

	it("label is searchable metadata", () => {
		assert.ok(indexed.includes("configuration checkpoint"));
	});

	it("hidden content and image bytes are absent", () => {
		assert.ok(!["ABANDONED_SECRET_NEVER_INDEX", "HIDDEN_THINKING_NEVER_INDEX", "HIDDEN_CUSTOM_NEVER_INDEX", "BASE64_IMAGE_NEVER_INDEX"]
			.some((needle) => indexed.includes(needle)));
	});

	it("search data never reads the surviving full-output file", () => {
		assert.ok(!indexed.includes("deliberately not searchable"));
	});
});
