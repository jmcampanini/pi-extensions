import {
	fuzzyFilter,
	type AutocompleteItem,
	type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type { InstalledSkill } from "./skills.ts";

const TOKEN_BEFORE_CURSOR = /(?:^|[ \t])\$([a-z0-9-]*)$/;

/**
 * Wrap pi's autocomplete provider with `$skill-name` completion at any token
 * boundary on any line. Everything outside a $token delegates to the wrapped
 * provider untouched.
 */
export function createInlineSkillsProvider(
	current: AutocompleteProvider,
	listSkills: () => InstalledSkill[],
): AutocompleteProvider {
	return {
		// Only "$": pi unions each wrapper's own characters onto the outermost
		// provider itself, so re-declaring the wrapped ones would duplicate them.
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = TOKEN_BEFORE_CURSOR.exec(beforeCursor);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const typed = match[1];
			const skills = listSkills();
			const ranked = typed === "" ? skills : fuzzyFilter(skills, typed, (skill) => skill.name);
			// A $token is ours even when nothing matches: delegating would offer
			// path rows for a token that is not a path.
			if (ranked.length === 0) return null;
			return { prefix: `$${typed}`, items: ranked.map(toItem) };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$")) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			// The built-in fallback branch inserts without a trailing space; a
			// mention should close its token so typing continues naturally.
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}${item.value} ${afterCursor}`;
			return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + 1 };
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function toItem(skill: InstalledSkill): AutocompleteItem {
	return { value: `$${skill.name}`, label: `$${skill.name}`, description: skill.description };
}
