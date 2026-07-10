/**
 * session.ts — working directly with pi session files.
 *
 * A pi session is a JSONL file: line 1 is a header entry
 * `{type: "session", version: 3, id, timestamp, cwd, parentSession?}` and
 * every following line is one entry (messages, model changes, etc.).
 *
 * Because sessions are "just files", we can:
 *  - FORK a session for a child by copying the parent's entries under a fresh
 *    header (pi then opens it with `pi --session <file>` like any session), and
 *  - extract a child's result by reading its last assistant message.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// One parsed line of a session file. We only care about a few fields; the
// index signature lets everything else pass through untouched.
interface SessionEntry {
	type: string;
	/** pi links entries into a chain via id/parentId; we read ids when appending. */
	id?: string;
	/** Present when type === "message"; the fields this module reads from it. */
	message?: {
		role: string;
		content: Array<{ type: string; text?: string }>;
		stopReason?: string;
		errorMessage?: string;
	};
	[key: string]: unknown;
}

/** Parse a session file into entries, skipping blank or corrupt lines. */
function readEntries(sessionFile: string): SessionEntry[] {
	const raw = readFileSync(sessionFile, "utf8");
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A corrupt line shouldn't break spawning or result extraction.
		}
	}
	return entries;
}

/** Count the entries currently in a session file (0 if it doesn't exist yet). */
export function countEntries(sessionFile: string): number {
	try {
		return readEntries(sessionFile).length;
	} catch {
		return 0;
	}
}

// ── seeding building blocks ──────────────────────────────────────────────

/**
 * The header line every seeded child session starts with. Build it through
 * pi so provider routing receives pi's UUIDv7 session ID and the format stays
 * aligned with the installed pi version.
 */
function headerLine(childCwd: string, parentSessionFile: string): string {
	const header = SessionManager.inMemory(childCwd, { parentSession: parentSessionFile }).getHeader();
	if (!header) throw new Error("Could not create a subagent session header.");
	return JSON.stringify(header);
}

/**
 * A `session_info` line carrying the session's display name. The picker
 * shows this name instead of the session's first message — which for our
 * children is unreadable `@file` task text. Same entry pi appends when a
 * human renames a session in the picker.
 */
function sessionInfoLine(name: string, parentId: string | null): string {
	return JSON.stringify({
		type: "session_info",
		// A FULL uuid, not pi's usual 8-hex: it can never collide with the ids
		// of entries copied from a parent. A colliding id would shadow that
		// entry in pi's index and hang its context walk in a parentId cycle.
		id: randomUUID(),
		parentId,
		timestamp: new Date().toISOString(),
		// Same sanitization pi applies when a human renames in the picker.
		name: name.replace(/[\r\n]+/g, " ").trim(),
	});
}

// ── fresh seeding ────────────────────────────────────────────────────────

/**
 * Create a child session file for a FRESH child: a header and a display
 * name, no conversation. Pre-creating the file (instead of letting pi make
 * its own on first open) buys the two picker niceties the header/name
 * helpers above describe: threading under the parent, and a readable label.
 */
export function seedFreshSession(options: {
	parentSessionFile: string;
	childSessionFile: string;
	childCwd: string;
	name: string;
}): void {
	const lines = [
		headerLine(options.childCwd, options.parentSessionFile),
		sessionInfoLine(options.name, null),
	];
	mkdirSync(dirname(options.childSessionFile), { recursive: true });
	writeFileSync(options.childSessionFile, lines.join("\n") + "\n", "utf8");
}

// ── fork seeding ─────────────────────────────────────────────────────────

/**
 * Create a child session file seeded with the parent's conversation.
 *
 * Two rules make this correct:
 *  1. Copy entries only UP TO (and excluding) the parent's most recent user
 *     message. That last user turn is the one that triggered this spawn and
 *     is still in flight in the parent — the child must not see it twice.
 *  2. Drop the parent's own `{type: "session"}` header line — the child gets
 *     a fresh header (new id, its own cwd, and a `parentSession` pointer for
 *     lineage).
 *
 * Because the copied entries are byte-identical to the parent's, a fork child
 * that keeps the same model/tools presents an identical prompt prefix to the
 * provider — which is what makes prompt-cache reuse possible.
 */
export function seedForkSession(options: {
	parentSessionFile: string;
	childSessionFile: string;
	childCwd: string;
	/** Display name for the picker; omitted = no session_info entry. */
	name?: string;
}): void {
	const raw = readFileSync(options.parentSessionFile, "utf8");

	// Parse every line exactly once, keeping the ORIGINAL text alongside the
	// parsed entry: the seed is written from the original lines (byte-identical
	// copies are what make prompt-cache reuse possible), while all the
	// decisions below are made on the parsed entries. A corrupt line parses to
	// `entry: null` and is kept — pi tolerates lines it can't read.
	const parsed = raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				return { line, entry: JSON.parse(line) as SessionEntry };
			} catch {
				return { line, entry: null };
			}
		});

	// Walk backwards to find where the in-flight turn STARTED, then cut there.
	// A turn can be started by a plain user message OR by a custom message —
	// our own steered subagent results/pings are persisted as
	// `{type: "custom_message"}` entries and trigger turns that contain no
	// user message at all. Cutting only at user messages would, on such a
	// turn, land on the PREVIOUS turn's user message and silently drop the
	// whole completed exchange in between.
	let cutAt = parsed.length;
	for (let i = parsed.length - 1; i >= 0; i--) {
		const entry = parsed[i].entry;
		const isUserMessage = entry?.type === "message" && entry.message?.role === "user";
		if (isUserMessage || entry?.type === "custom_message") {
			cutAt = i;
			break;
		}
	}

	// Keep everything before the cut, minus the parent's header line.
	const copied = parsed.slice(0, cutAt).filter(({ entry }) => entry?.type !== "session");

	// Safety net: never let the seed END on an assistant message that makes
	// tool calls — its tool RESULTS were cut away with the in-flight turn,
	// and providers reject a conversation that stops on an unanswered tool
	// call. Trim such trailing entries.
	while (copied.length > 0) {
		const last = copied[copied.length - 1].entry;
		const isAssistant = last?.type === "message" && last.message?.role === "assistant";
		const makesToolCalls =
			isAssistant && (last?.message?.content ?? []).some((block) => block.type === "toolCall");
		if (!makesToolCalls) break;
		copied.pop();
	}

	const lines = [headerLine(options.childCwd, options.parentSessionFile), ...copied.map(({ line }) => line)];

	// The display name goes AFTER the copied conversation. session_info is
	// metadata, not a message, so the copied message prefix stays
	// byte-identical and prompt-cache reuse is unaffected. It links to the
	// last copied entry that PARSES and has an id — the same entry pi will
	// treat as the leaf. (Linking to null past a corrupt trailing line would
	// orphan the whole copied conversation: pi builds the child's context by
	// walking parentId links backwards, and a null parent ends that walk.)
	if (options.name) {
		let lastId: string | null = null;
		for (let i = copied.length - 1; i >= 0; i--) {
			const id = copied[i].entry?.id;
			if (typeof id === "string") {
				lastId = id;
				break;
			}
		}
		lines.push(sessionInfoLine(options.name, lastId));
	}

	mkdirSync(dirname(options.childSessionFile), { recursive: true });
	writeFileSync(options.childSessionFile, lines.join("\n") + "\n", "utf8");
}

// ── header inspection ────────────────────────────────────────────────────

/**
 * Read the `cwd` recorded in a session file's header. Used on resume: the
 * child's tools should run in the same directory the original run used, so
 * the resume command `cd`s there before starting pi.
 */
export function readSessionCwd(sessionFile: string): string | null {
	try {
		const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0];
		const header = JSON.parse(firstLine);
		return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
	} catch {
		return null;
	}
}

// ── display name ─────────────────────────────────────────────────────────

/**
 * Read the session's display name. pi renames by APPENDING session_info
 * entries rather than rewriting, so the LATEST one wins — and an empty name
 * is an explicit "clear the name", not a missing entry.
 */
export function readSessionName(sessionFile: string): string | undefined {
	let entries: SessionEntry[];
	try {
		entries = readEntries(sessionFile);
	} catch {
		return undefined; // file missing or unreadable
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") {
			return typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : undefined;
		}
	}
	return undefined;
}

/**
 * Append a display name to an EXISTING session file — the resume-time
 * backfill for children created before names were seeded at spawn. Must run
 * before the child pi process reopens the file, so there is only ever one
 * writer. Callers should check readSessionName() first: appending
 * unconditionally would override a name a human chose in the picker.
 */
export function appendSessionName(sessionFile: string, name: string): void {
	const raw = readFileSync(sessionFile, "utf8");

	// Link the new entry to the last real entry's id. The header line does
	// not count — pi's entry chain starts at null, the header sits outside it.
	let parentId: string | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as SessionEntry;
			if (entry.type !== "session" && typeof entry.id === "string") parentId = entry.id;
		} catch {
			// Corrupt lines can't be linked to; skip them.
		}
	}

	// Guard against a file that ends without a trailing newline — appending
	// straight onto it would corrupt the last line.
	const separator = raw === "" || raw.endsWith("\n") ? "" : "\n";
	appendFileSync(sessionFile, separator + sessionInfoLine(name, parentId) + "\n", "utf8");
}

// ── result extraction ────────────────────────────────────────────────────

/**
 * The child's "result" is simply the last assistant message in its session
 * file. `skipEntries` supports resume: pass the entry count from before the
 * resume so we only look at what was said afterwards.
 *
 * One important fallback: when pi exhausts its provider auto-retries, the
 * final assistant message has `stopReason: "error"` and no usable text but
 * carries an `errorMessage`. Without this fallback we would return an older,
 * stale message and the failure would masquerade as a success.
 */
export function extractSummary(sessionFile: string, skipEntries = 0): string | null {
	let entries: SessionEntry[];
	try {
		entries = readEntries(sessionFile).slice(skipEntries);
	} catch {
		return null; // file missing or unreadable
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "assistant") continue;

		// Join all non-empty text blocks of this assistant message.
		const text = (msg.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("\n")
			.trim();
		if (text !== "") return text;

		// No text — was this an error turn (auto-retry exhausted)?
		if (msg.stopReason === "error" && msg.errorMessage?.trim()) {
			return `Subagent error: ${msg.errorMessage.trim()}`;
		}
	}
	return null;
}
