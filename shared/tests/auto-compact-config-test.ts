import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentConfigDir, config, configFilePath, loadConfig } from "../auto-compact-config.ts";

const sandbox = join(process.cwd(), ".sandbox");
mkdirSync(sandbox, { recursive: true });
const testRoot = mkdtempSync(join(sandbox, "auto-compact-config-"));

after(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

let nextDirectory = 0;
function dirWith(content: string | null): string {
	const dir = join(testRoot, String(nextDirectory++));
	mkdirSync(dir);
	if (content !== null) writeFileSync(join(dir, "autocompact.json"), content);
	return dir;
}

const DEFAULT_CLASSES = [
	{ windowMax: 300_000, thresholdPercent: 90 },
	{ windowMax: 500_000, thresholdPercent: 70 },
];

describe("auto-compact-config", () => {
	it("default agent config directory", () => {
		assert.strictEqual(agentConfigDir({}), join(homedir(), ".pi", "agent"));
	});

	it("custom agent config directory", () => {
		assert.strictEqual(agentConfigDir({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi");
	});

	it("config file path", () => {
		assert.strictEqual(configFilePath({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi/autocompact.json");
	});

	it("module config has the public keys", () => {
		assert.deepStrictEqual(Object.keys(config).sort(), ["classes", "default", "enabled"]);
	});

	it("defaults", () => {
		assert.deepStrictEqual(loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), {
			enabled: true,
			classes: DEFAULT_CLASSES,
			default: { thresholdTokens: 400_000 },
		});
	});

	it("full file applies", () => {
		assert.deepStrictEqual(loadConfig({
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
	});

	it("partial enabled file merges with defaults", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
		}), {
			enabled: false,
			classes: DEFAULT_CLASSES,
			default: { thresholdTokens: 400_000 },
		});
	});

	it("partial classes file replaces the whole list", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":272000,"thresholdTokens":250000}]}'),
		}), {
			enabled: true,
			classes: [{ windowMax: 272_000, thresholdTokens: 250_000 }],
			default: { thresholdTokens: 400_000 },
		});
	});

	it("partial default file merges with default classes", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":50}}'),
		}), {
			enabled: true,
			classes: DEFAULT_CLASSES,
			default: { thresholdPercent: 50 },
		});
	});

	it("empty classes list is legal and default-only", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"classes":[]}'),
		}).classes, []);
	});

	it("single class is accepted", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1,"thresholdTokens":1}]}'),
		}).classes, [{ windowMax: 1, thresholdTokens: 1 }]);
	});

	it("enabled env parses true", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith(null),
			PI_AUTO_COMPACT_ENABLED: "true",
		}).enabled, true);
	});

	it("enabled env parses false", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith(null),
			PI_AUTO_COMPACT_ENABLED: "false",
		}).enabled, false);
	});

	it("env beats file", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
			PI_AUTO_COMPACT_ENABLED: "true",
		}).enabled, true);
	});

	it("empty env value is unset", () => {
		assert.strictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
			PI_AUTO_COMPACT_ENABLED: "",
		}).enabled, false);
	});

	it("enabled env rejects uppercase", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_AUTO_COMPACT_ENABLED: "TRUE" }),
			(error) => String(error).includes("PI_AUTO_COMPACT_ENABLED"),
		);
	});

	it("enabled env rejects numeric forms", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_AUTO_COMPACT_ENABLED: "1" }),
			(error) => String(error).includes("PI_AUTO_COMPACT_ENABLED"),
		);
	});

	it("enabled env rejects padded forms", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(null), PI_AUTO_COMPACT_ENABLED: " false " }),
			(error) => String(error).includes('" false "'),
		);
	});

	it("malformed JSON", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith("{nope") }),
			(error) => String(error).includes("not valid JSON"),
		);
	});

	it("non-object config roots are rejected", () => {
		for (const [label, content] of [
			["null root", "null"],
			["array root", "[]"],
			["scalar root", '"nope"'],
		] as const) {
			assert.throws(
				() => loadConfig({ PI_CODING_AGENT_DIR: dirWith(content) }),
				(error) => String(error).includes("must be a JSON object"),
				label,
			);
		}
	});

	it("unknown root key", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"threshold":70}') }),
			(error) => String(error).includes("unknown key(s) threshold"),
		);
	});

	it("prototype key is unknown", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"toString":70}') }),
			(error) => String(error).includes("unknown key(s) toString"),
		);
	});

	it("enabled rejects strings", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"enabled":"false"}') }),
			(error) => String(error).includes('"false"'),
		);
	});

	it("enabled rejects numbers", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"enabled":1}') }),
			(error) => String(error).includes("enabled"),
		);
	});

	it("enabled rejects null", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"enabled":null}') }),
			(error) => String(error).includes("enabled"),
		);
	});

	it("classes rejects non-arrays", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":{}}') }),
			(error) => String(error).includes("must be an array of classes"),
		);
	});

	it("class entries must be objects", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[42]}') }),
			(error) => String(error).includes("classes[0]"),
		);
	});

	it("class rejects unknown keys", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000,"thresholdPercent":50,"extra":1}]}') }),
			(error) => String(error).includes("unknown key(s) extra"),
		);
	});

	it("class requires windowMax", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"thresholdPercent":50}]}') }),
			(error) => String(error).includes("windowMax"),
		);
	});

	it("windowMax rejects zero", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":0,"thresholdPercent":50}]}') }),
			(error) => String(error).includes("windowMax"),
		);
	});

	it("windowMax rejects fractions", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000.5,"thresholdPercent":50}]}') }),
			(error) => String(error).includes("windowMax"),
		);
	});

	it("windowMax rejects numeric strings", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":"1000","thresholdPercent":50}]}') }),
			(error) => String(error).includes('"1000"'),
		);
	});

	it("class rejects both threshold kinds", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000,"thresholdPercent":50,"thresholdTokens":100}]}') }),
			(error) => String(error).includes("exactly one of thresholdTokens or thresholdPercent"),
		);
	});

	it("class requires a threshold kind", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"classes":[{"windowMax":1000}]}') }),
			(error) => String(error).includes("exactly one of thresholdTokens or thresholdPercent"),
		);
	});

	it("equal windowMax values are rejected", () => {
		assert.throws(
			() => loadConfig({
				PI_CODING_AGENT_DIR: dirWith(
					'{"classes":[{"windowMax":1000,"thresholdPercent":50},{"windowMax":1000,"thresholdPercent":60}]}',
				),
			}),
			(error) => String(error).includes("strictly ascending"),
		);
	});

	it("descending windowMax values are rejected", () => {
		assert.throws(
			() => loadConfig({
				PI_CODING_AGENT_DIR: dirWith(
					'{"classes":[{"windowMax":2000,"thresholdPercent":50},{"windowMax":1000,"thresholdPercent":60}]}',
				),
			}),
			(error) => String(error).includes("strictly ascending"),
		);
	});

	it("default must be an object", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":50}') }),
			(error) => String(error).includes("must be a JSON object"),
		);
	});

	it("default rejects unknown keys", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"windowMax":1000,"thresholdPercent":50}}') }),
			(error) => String(error).includes("unknown key(s) windowMax"),
		);
	});

	it("default rejects both threshold kinds", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":50,"thresholdTokens":100}}') }),
			(error) => String(error).includes("exactly one of thresholdTokens or thresholdPercent"),
		);
	});

	it("default requires a threshold kind", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{}}') }),
			(error) => String(error).includes("exactly one of thresholdTokens or thresholdPercent"),
		);
	});

	it("percent accepts the minimum", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":1}}'),
		}).default, { thresholdPercent: 1 });
	});

	it("percent accepts the maximum", () => {
		assert.deepStrictEqual(loadConfig({
			PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":100}}'),
		}).default, { thresholdPercent: 100 });
	});

	it("percent rejects zero", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":0}}') }),
			(error) => String(error).includes("integer from 1 through 100"),
		);
	});

	it("percent rejects values above 100", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":101}}') }),
			(error) => String(error).includes("integer from 1 through 100"),
		);
	});

	it("percent rejects fractions", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":69.5}}') }),
			(error) => String(error).includes("integer from 1 through 100"),
		);
	});

	it("percent rejects numeric strings", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":"70"}}') }),
			(error) => String(error).includes('"70"'),
		);
	});

	it("percent rejects null", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdPercent":null}}') }),
			(error) => String(error).includes("thresholdPercent"),
		);
	});

	it("tokens reject zero", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":0}}') }),
			(error) => String(error).includes("positive integer"),
		);
	});

	it("tokens reject negatives", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":-1}}') }),
			(error) => String(error).includes("positive integer"),
		);
	});

	it("tokens reject fractions", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":1.5}}') }),
			(error) => String(error).includes("positive integer"),
		);
	});

	it("tokens reject numeric strings", () => {
		assert.throws(
			() => loadConfig({ PI_CODING_AGENT_DIR: dirWith('{"default":{"thresholdTokens":"100"}}') }),
			(error) => String(error).includes('"100"'),
		);
	});
});
