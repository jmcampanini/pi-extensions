import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentConfigDir, config, configFilePath, loadConfig } from "../config.ts";

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

eq("default agent config directory", agentConfigDir({}), join(homedir(), ".pi", "agent"));
eq("custom agent config directory", agentConfigDir({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi");
eq("config file path", configFilePath({ PI_CODING_AGENT_DIR: "/custom/pi" }), "/custom/pi/autocompact.json");
eq("module config has the public keys", Object.keys(config).sort(), ["enabled", "thresholdPercent"]);

eq("defaults", loadConfig({ PI_CODING_AGENT_DIR: dirWith(null) }), {
	thresholdPercent: 70,
	enabled: true,
});
eq("full file applies", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":55,"enabled":false}'),
}), {
	thresholdPercent: 55,
	enabled: false,
});
eq("partial threshold file merges with defaults", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":40}'),
}), {
	thresholdPercent: 40,
	enabled: true,
});
eq("partial enabled file merges with defaults", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
}), {
	thresholdPercent: 70,
	enabled: false,
});
eq("threshold env parses", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "82",
}).thresholdPercent, 82);
eq("env beats file", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":25,"enabled":true}'),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "90",
	PI_AUTO_COMPACT_ENABLED: "false",
}), {
	thresholdPercent: 90,
	enabled: false,
});
eq("true env beats false file", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
	PI_AUTO_COMPACT_ENABLED: "true",
}).enabled, true);
eq("empty env values are unset", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":35,"enabled":false}'),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "",
	PI_AUTO_COMPACT_ENABLED: "",
}), {
	thresholdPercent: 35,
	enabled: false,
});

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
throws("unknown key", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"threshold":70}'),
}), "unknown key(s) threshold");
throws("prototype key is unknown", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"toString":70}'),
}), "unknown key(s) toString");

eq("threshold accepts file minimum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":1}'),
}).thresholdPercent, 1);
eq("threshold accepts file maximum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":100}'),
}).thresholdPercent, 100);
eq("threshold accepts env minimum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "1",
}).thresholdPercent, 1);
eq("threshold accepts env maximum", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "100",
}).thresholdPercent, 100);
throws("threshold rejects zero", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":0}'),
}), "integer from 1 through 100");
throws("threshold rejects values above 100", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":101}'),
}), "integer from 1 through 100");
throws("threshold rejects fractions", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":69.5}'),
}), "integer from 1 through 100");
throws("threshold rejects numeric strings in file", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":"70"}'),
}), '"70"');
throws("threshold rejects null", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"thresholdPercent":null}'),
}), "thresholdPercent");
throws("threshold env rejects zero", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "0",
}), "PI_AUTO_COMPACT_THRESHOLD_PERCENT");
throws("threshold env rejects values above 100", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "101",
}), "PI_AUTO_COMPACT_THRESHOLD_PERCENT");
throws("threshold env rejects fractions", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "2.5",
}), "PI_AUTO_COMPACT_THRESHOLD_PERCENT");
throws("threshold env rejects junk", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_THRESHOLD_PERCENT: "many",
}), '"many"');

eq("enabled accepts file true", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":true}'),
}).enabled, true);
eq("enabled accepts file false", loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":false}'),
}).enabled, false);
eq("enabled accepts exact true env", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "true",
}).enabled, true);
eq("enabled accepts exact false env", loadConfig({
	PI_CODING_AGENT_DIR: dirWith(null),
	PI_AUTO_COMPACT_ENABLED: "false",
}).enabled, false);
throws("enabled rejects strings in file", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":"false"}'),
}), '"false"');
throws("enabled rejects numbers in file", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":1}'),
}), "enabled");
throws("enabled rejects null", () => loadConfig({
	PI_CODING_AGENT_DIR: dirWith('{"enabled":null}'),
}), "enabled");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
