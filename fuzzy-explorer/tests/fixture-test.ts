import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { extractBlocks } from "../extract.ts";
import { searchBlocks } from "../search.ts";
import { buildFixtureSession } from "./fixture-session.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${g}, want ${w}`); }
}
function ok(label: string, value: boolean): void {
	if (value) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}`); }
}

const fixture = buildFixtureSession(resolve(".sandbox/fuzzy-explorer-fixture-test"));
const session = SessionManager.open(fixture.sessionFile);
const branch = session.getBranch();
const blocks = extractBlocks(branch, (id) => session.getLabel(id));
const indexed = blocks.map((block) => `${block.fields}\n${block.body}`).join("\n");

ok("fixture full-output survivor exists", existsSync(fixture.fullOutputPath));
ok("fixture missing full-output path is absent", !existsSync(fixture.missingFullOutputPath));
eq("active branch excludes both abandoned entry ids",
	fixture.abandonedEntryIds.filter((id) => branch.some((entry) => entry.id === id)), []);
ok("every v1 block kind is represented", ["user", "assistant", "tool", "bash", "custom", "summary"]
	.every((kind) => blocks.some((block) => block.kind === kind)));
ok("fixture includes merged and orphan tool rows",
	blocks.some((block) => block.toolCallId === "call-read" && block.body.includes("STORED_RESULT_ONLY_NEEDLE"))
	&& blocks.some((block) => block.toolCallId === "orphan-call"));
eq("one fixture query combines fuzzy invocation fields with result-only body text",
	searchBlocks(blocks, "sconf STORED_RESULT_ONLY_NEEDLE").map((result) => result.block.toolCallId), ["call-read"]);
ok("label is searchable metadata", indexed.includes("configuration checkpoint"));
ok("hidden content and image bytes are absent",
	!["ABANDONED_SECRET_NEVER_INDEX", "HIDDEN_THINKING_NEVER_INDEX", "HIDDEN_CUSTOM_NEVER_INDEX", "BASE64_IMAGE_NEVER_INDEX"]
		.some((needle) => indexed.includes(needle)));
ok("search data never reads the surviving full-output file", !indexed.includes("deliberately not searchable"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
