import {
	AGENT_IDENTIFIER_MAX_COLUMNS,
	agentIdentifierProblem,
	assertValidAgentIdentifier,
	isValidAgentIdentifier,
} from "../agent-identifier.ts";

let pass = 0, fail = 0;
function eq(label: string, got: unknown, want: unknown): void {
	if (got === want) { pass++; console.log(`  ok  ${label}`); }
	else { fail++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function throws(label: string, value: unknown, contains: string): void {
	try {
		assertValidAgentIdentifier(value);
		fail++;
		console.log(`  FAIL ${label}: expected throw`);
	} catch (error) {
		if (String(error).includes(contains)) { pass++; console.log(`  ok  ${label}`); }
		else { fail++; console.log(`  FAIL ${label}: ${String(error)}`); }
	}
}

const family = "👨‍👩‍👧‍👦";
eq("identifier maximum is 20 display columns", AGENT_IDENTIFIER_MAX_COLUMNS, 20);
eq("20 ASCII columns are valid", isValidAgentIdentifier("abcdefghijklmnopqrst"), true);
eq("21 ASCII columns are invalid", isValidAgentIdentifier("abcdefghijklmnopqrstu"), false);
eq("five CJK pairs occupy the valid boundary", isValidAgentIdentifier("検索".repeat(5)), true);
eq("one more wide glyph exceeds the boundary", isValidAgentIdentifier("検索".repeat(5) + "検"), false);
eq("ten family emoji graphemes occupy the valid boundary", isValidAgentIdentifier(family.repeat(10)), true);
eq("eleven family emoji graphemes exceed the boundary", isValidAgentIdentifier(family.repeat(11)), false);
eq("combining marks use terminal display width", isValidAgentIdentifier("e\u0301".repeat(20)), true);
throws("empty identifiers are rejected", "", "non-empty");
throws("spaces are rejected", "code reviewer", "whitespace");
throws("tabs are rejected", "code\treviewer", "whitespace");
throws("newlines are rejected", "code\nreviewer", "whitespace");
throws("non-strings are rejected", 20, "non-empty string");
eq("problem reports measured overage", agentIdentifierProblem("検索".repeat(6))?.includes("got 24"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
