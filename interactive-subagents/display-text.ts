import { stripVTControlCharacters } from "node:util";

/**
 * Best-effort defense for terminal display. Terminal parsers vary, so callers
 * must not treat this as a complete security boundary.
 */
export function sanitizeDisplayText(text: string): string {
	return Array.from(stripVTControlCharacters(text))
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0x7f && code <= 0x9f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}
