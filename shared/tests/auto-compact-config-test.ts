import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentConfigDir, config, configFilePath, loadConfig } from "../auto-compact-config.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown): void {
	const actual = JSON.stringify(got);
	const expected = JSON.stringify(want);
	if (actual === expected) {
		pass++;
		console.log(`  ok  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL ${label}: got ${actual}, want ${expected}`);
	}
}

function throws(label: string, fn: () => void, contains: string): void {
	try {
		fn();
		fail++;
		console.log(`  FAIL ${label}: expected throw`);
	} catch (error) {
		if (String(error).includes(contains)) {
			pass++;
			console.log(`  ok  ${label}`);
		} else {
			fail++;
			console.log(`  FAIL ${label}: message missing "${contains}": ${error}`);
		}
	}
}

function dirWith(content: string | null): string {
	const dir = mkdtempSync(join(tmpdir(), "auto-compact-config-"));
	if (content !== null) writeFileSync(join(dir, "autocompact.json"), content);
	return dir;
}

const DEFAULT_CLASSES = [
	{ windowMax: 300_000, thresholdPercent: 90 },
	{ windowMax: 500_000, thresholdPercent: 70 },
];

eq("default agent config directory", agentConfigDir({}), join(homedir(), ".pi", "agent"));
eq("custom agent config directory", agentConfigDir({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi");
eq("config file path", configFilePath({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi/autocompact.json");
eq("module config has the public keys", Object.keys(config).sort(), ["classes", "default", "enabled"]);

eq("defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), {
	enabled: true,
	classes: DEFAULT_CLASSES,
	default: { thresholdTokens: 400_000 },
});
eq("full file applies", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(
		'{"enabled":false,"classes":[{"windowMax":256000,"thresholdPercent":85},{"windowMax":500000,"thresholdTokens":250000}],"default":{"thresholdPercent":50}}',
	),
}), {
	enabled: false,
	classes: [
		{ windowMax: 256_000, thresholdPercent: 85 },
		{ windowMax: 500_000, thresholdTokens: 250_000 },
	],
	default: { thresholdPercent: 50 },
});
eq("partial enabled file merges with defaults", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
}), {
	enabled: false,
	classes: DEFAULT_CLASSES,
	default: { thresholdTokens: 400_000 },
});
eq("partial classes file replaces the whole list", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":272000,"thresholdTokens":250000}]}'),
}), {
	enabled: true,
	classes: [{ windowMax: 272_000, thresholdTokens: 250_000 }],
	default: { thresholdTokens: 400_000 },
});
eq("partial default file merges with default classes", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":50}}'),
}), {
	enabled: true,
	classes: DEFAULT_CLASSES,
	default: { thresholdPercent: 50 },
});
eq("empty classes list is legal and default-only", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[]}'),
}).classes, []);
eq("single class is accepted", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1,"thresholdTokens":1}]}'),
}).classes, [{ windowMax: 1, thresholdTokens: 1 }]);

eq("enabled env parses true", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "true",
}).enabled, true);
eq("enabled env parses false", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "false",
}).enabled, false);
eq("env beats file", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
	PI_AUTO_COMPACT_ENABLED: "true",
}).enabled, true);
eq("empty env value is unset", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
	PI_AUTO_COMPACT_ENABLED: "",
}).enabled, false);
throws("enabled env rejects uppercase", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "TRUE",
}), "PI_AUTO_COMPACT_ENABLED");
throws("enabled env rejects numeric forms", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "1",
}), "PI_AUTO_COMPACT_ENABLED");
throws("enabled env rejects padded forms", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: " false ",
}), '" false "');

throws("malformed JSON", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith("{nope"),
}), "not valid JSON");
throws("null root", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith("null"),
}), "must be a JSON object");
throws("array root", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith("[]"),
}), "must be a JSON object");
throws("scalar root", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('"nope"'),
}), "must be a JSON object");
throws("unknown root key", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"threshold":70}'),
}), "unknown key(s) threshold");
throws("prototype key is unknown", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"toString":70}'),
}), "unknown key(s) toString");

throws("enabled rejects strings", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":"false"}'),
}), '"false"');
throws("enabled rejects numbers", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":1}'),
}), "enabled");
throws("enabled rejects null", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":null}'),
}), "enabled");

throws("classes rejects non-arrays", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":{}}'),
}), "must be an array of classes");
throws("class entries must be objects", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[42]}'),
}), "classes[0]");
throws("class rejects unknown keys", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000,"thresholdPercent":50,"extra":1}]}'),
}), "unknown key(s) extra");
throws("class requires windowMax", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"thresholdPercent":50}]}'),
}), "windowMax");
throws("windowMax rejects zero", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":0,"thresholdPercent":50}]}'),
}), "windowMax");
throws("windowMax rejects fractions", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000.5,"thresholdPercent":50}]}'),
}), "windowMax");
throws("windowMax rejects numeric strings", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":"1000","thresholdPercent":50}]}'),
}), '"1000"');
throws("class rejects both threshold kinds", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000,"thresholdPercent":50,"thresholdTokens":100}]}'),
}), "exactly one of thresholdTokens or thresholdPercent");
throws("class requires a threshold kind", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000}]}'),
}), "exactly one of thresholdTokens or thresholdPercent");
throws("equal windowMax values are rejected", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(
		'{"classes":[{"windowMax":1000,"thresholdPercent":50},{"windowMax":1000,"thresholdPercent":60}]}',
	),
}), "strictly ascending");
throws("descending windowMax values are rejected", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(
		'{"classes":[{"windowMax":2000,"thresholdPercent":50},{"windowMax":1000,"thresholdPercent":60}]}',
	),
}), "strictly ascending");

throws("default must be an object", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":50}'),
}), "must be a JSON object");
throws("default rejects unknown keys", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"windowMax":1000,"thresholdPercent":50}}'),
}), "unknown key(s) windowMax");
throws("default rejects both threshold kinds", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":50,"thresholdTokens":100}}'),
}), "exactly one of thresholdTokens or thresholdPercent");
throws("default requires a threshold kind", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{}}'),
}), "exactly one of thresholdTokens or thresholdPercent");

eq("percent accepts the minimum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":1}}'),
}).default, { thresholdPercent: 1 });
eq("percent accepts the maximum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":100}}'),
}).default, { thresholdPercent: 100 });
throws("percent rejects zero", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":0}}'),
}), "integer from 1 through 100");
throws("percent rejects values above 100", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":101}}'),
}), "integer from 1 through 100");
throws("percent rejects fractions", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":69.5}}'),
}), "integer from 1 through 100");
throws("percent rejects numeric strings", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":"70"}}'),
}), '"70"');
throws("percent rejects null", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":null}}'),
}), "thresholdPercent");
throws("tokens reject zero", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":0}}'),
}), "positive integer");
throws("tokens reject negatives", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":-1}}'),
}), "positive integer");
throws("tokens reject fractions", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":1.5}}'),
}), "positive integer");
throws("tokens reject numeric strings", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":"100"}}'),
}), '"100"');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
