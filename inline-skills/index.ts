import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planSubmit } from "./plan.ts";
import { createInlineSkillsProvider } from "./provider.ts";
import { listInstalledSkills } from "./skills.ts";

export function registerInlineSkills(pi: ExtensionAPI): void {
	// Pi has no removeAutocompleteProvider and session_start fires again for new
	// sessions in the same process; a second registration would stack duplicates.
	let providerRegistered = false;

	pi.on("input", (event, ctx) => {
		const known = new Set(listInstalledSkills(pi).map((skill) => skill.name));
		const plan = planSubmit(event.text, known);
		if (plan.kind === "hoist") return { action: "transform", text: plan.text };
		if (plan.kind === "conflict") {
			// Without a UI there is no editor to hand the text back to, so the
			// message passes through untransformed rather than vanishing.
			if (!ctx.hasUI) return { action: "continue" };
			ctx.ui.notify(
				`inline-skills: one skill per message — found ${plan.names.map((name) => `$${name}`).join(", ")}. Edit and resend.`,
				"error",
			);
			ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.on("session_start", (_event, ctx) => {
		if (providerRegistered || !ctx.hasUI) return;
		providerRegistered = true;
		ctx.ui.addAutocompleteProvider((current) =>
			createInlineSkillsProvider(current, () => listInstalledSkills(pi)),
		);
	});
}

export default registerInlineSkills;
