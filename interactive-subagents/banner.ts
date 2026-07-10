/**
 * banner.ts — rendering the child's identity banner.
 *
 * A child pi session looks exactly like a normal one, which is dangerous:
 * a human who wanders into the pane has no way to know their keystrokes are
 * being watched by a parent agent, or that the session will vanish the
 * moment a turn completes. The banner is that missing label — one line,
 * pinned above the editor, stating WHO this session is and HOW it will end:
 *
 *   ─ SUBAGENT · recon [scout] · auto-exit ────────────────────────────────
 *
 * Left to right: a rule dash, the SUBAGENT marker, the display name, the
 * agent-definition tag (omitted when unknown), the exit mode, and a rule
 * filling the rest of the width. The mode is the state-aware part:
 *
 *   auto-exit      the session closes itself when a turn completes
 *   interactive    it stays open until the model calls subagent_done
 *   ⚠ human driving …   an auto-exit child where the user pressed Escape —
 *                  the next completed turn WILL exit and report back
 *
 * When width runs short, the same philosophy as widget.ts applies: identity
 * and state win, the free-text name is sacrificial — it shrinks to a "…"
 * first, then the trailing rule disappears. Layout is computed on plain
 * text; styling hooks are applied last so ANSI codes never enter the width
 * math. Like widget.ts, this module imports nothing so it unit-tests under
 * plain node.
 */

import { sanitizeDisplayText } from "./display-text.ts";

/** Everything the banner states about the session. */
export interface BannerState {
	/** Display name — the `name` the parent chose at spawn time. */
	name: string;
	/** Agent-definition name ("scout", "worker"); absent = no bracket tag. */
	agent?: string;
	/** True when the child exits by itself after a completed turn. */
	autoExit: boolean;
	/** True once a human aborted a turn in an auto-exit child (sticky). */
	humanDriving: boolean;
}

/** Optional styling hooks; identity (no styling) when omitted. */
export interface BannerStyle {
	/** Applied to the mode text when it is "auto-exit" or "interactive". */
	dim?: (text: string) => string;
	/** Applied to the rule dashes (pi passes the theme's muted border color). */
	border?: (text: string) => string;
	/** Applied to the whole human-driving mode text (pi passes the warning color). */
	warn?: (text: string) => string;
}

export function formatBannerLine(state: BannerState, width: number, style: BannerStyle = {}): string {
	const nameText = sanitizeDisplayText(state.name);
	const agentText = state.agent === undefined ? undefined : sanitizeDisplayText(state.agent);
	const dim = style.dim ?? ((text: string) => text);
	const border = style.border ?? ((text: string) => text);
	const warn = style.warn ?? ((text: string) => text);

	const modeText = state.humanDriving
		? "⚠ human driving — next completed turn exits & reports to parent"
		: state.autoExit
			? "auto-exit"
			: "interactive";

	// The plain-text segments, in banner order. All width math happens on
	// these before any styling function touches them.
	const prefix = "─ SUBAGENT · ";
	const agentTag = agentText ? ` [${agentText}]` : "";
	const modeSegment = ` · ${modeText}`;

	// Name clipping: the identity marker, agent tag, and mode all win over
	// the free-text name, which shortens to a "…" suffix as width shrinks.
	const maxName = width - prefix.length - agentTag.length - modeSegment.length;
	let name = nameText;
	if (name.length > maxName) {
		name = maxName >= 2 ? name.slice(0, maxName - 1) + "…" : maxName === 1 ? "…" : "";
	}

	// Degenerate widths — narrower than even the fixed parts with no name at
	// all. Hard-cut the plain text (no styling: wrapping a mid-word sliver in
	// ANSI codes buys nothing) so the line still never exceeds the width.
	const bodyLength = prefix.length + name.length + agentTag.length + modeSegment.length;
	if (bodyLength > width) {
		return (prefix + name + agentTag + modeSegment).slice(0, Math.max(0, width));
	}

	// Trailing rule: a space, then dashes filling exactly to the width. When
	// the (possibly clipped) name leaves no leftover room, the rule is the
	// first thing to go — it is decoration, not information. (One leftover
	// column means a lone space: there is no room for a dash to style.)
	const fill = width - bodyLength - 1;
	const tail = fill > 0 ? " " + border("─".repeat(fill)) : fill === 0 ? " " : "";

	const mode = state.humanDriving ? warn(modeText) : dim(modeText);
	return border("─") + prefix.slice(1) + name + agentTag + " · " + mode + tail;
}
