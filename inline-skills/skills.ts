import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InstalledSkill {
	name: string;
	description?: string;
}

/** Installed skills, read live from pi's command registry ("skill:<name>" entries). */
export function listInstalledSkills(pi: ExtensionAPI): InstalledSkill[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({ name: command.name.slice("skill:".length), description: command.description }));
}
