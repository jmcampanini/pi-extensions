# PLAN: `fuzzy-explorer`

Keyboard-driven fuzzy navigator for the **active transcript branch** of the current Pi session
(issue #26). This document is the contract: it captures every decision made during design review.
An implementing agent should treat everything here as settled unless the user says otherwise.
It deliberately avoids implementation details — it defines decisions, contracts, APIs, and
surface areas.

## Why

Pi transcripts become hard to navigate after many turns. `/tree` navigates branches but has no
content search, block-level selection, preview, copy, or external-open. Pi Peek (npm `pi-peek`)
is *interaction inspiration only* — it is a scrollback pager over rendered lines. This extension
is a different shape: a filterable **list-of-blocks picker** with semantic search documents built
from session source data, not from rendered rows.

## Identity

| Thing            | Value                                              |
| ---------------- | -------------------------------------------------- |
| Extension dir    | `fuzzy-explorer/` (this repo's one-dir-per-extension convention) |
| Slash command    | `/fuzzy-explorer`                                  |
| Default shortcut | `ctrl+r` (verified free on Pi's main editor; see "Shortcut safety") |
| Env prefix       | `PI_FUZZY_EXPLORER_*`                              |
| Config file      | `$PI_CODING_AGENT_DIR/fuzzy-explorer.json`         |

## Core decisions (locked)

### Surface and interaction

- Overlay via `ctx.ui.custom<T>(factory, { overlay: true, overlayOptions })`, centered,
  ~92% width / ~90% max height. Styling per repo `AGENTS.md`: semantic theme tokens only
  (`toolTitle`+bold for titles, `accent` for primary args, `muted`/`dim` for metadata/hints,
  `toolOutput` for body text).
- Layout: query input line + result list on top, **bottom preview pane** for the selection,
  always visible. `Enter` opens a **full-screen detail view** of the selected block.
- **Two modes**: `list` (default on open; configurable) and `filter`.
  - List mode: `j`/`k` and arrows move the selection; plain-key actions live here.
  - Filter mode: printable keys edit the query; **arrows still move the selection** while
    typing (filtering and navigation are always available together).
  - `/` enters filter mode. `Esc` in filter mode returns to list mode **keeping the query
    active**; `Esc` in list mode closes. `ctrl+u` in filter mode clears the query.
  - `Enter` opens the detail view from either mode.
- **Paging is the letters `u` (up) and `d` (down)** — in list mode they page the result list,
  in the detail view they page the content. **Do not bind PageUp/PageDown.** (In filter mode
  `u`/`d` type into the query; arrows are the only navigation there.)
- Detail view: `j`/`k`/arrows scroll, `u`/`d` page, **`J`/`K` jump to next/previous block in
  the current filtered result set without leaving the detail view**, `Esc` returns to the list
  with the selection synced to wherever you ended up.
- **Help text** (footer hints in the overlay) must show the action keys **and the query
  operators** (`is:`, `tool:`) so operators are discoverable without reading docs.
- Never call `navigateTree()` — this feature views transcript content; it must not move the
  session's leaf.

### Keymap (complete)

| Context     | Key            | Action                                                    |
| ----------- | -------------- | --------------------------------------------------------- |
| list mode   | `j`/`k`, arrows | move selection (down = later in time, up = earlier)      |
| list mode   | `u` / `d`      | page selection up / down                                  |
| list mode   | `g` / `G`      | first / last row (chosen default, not user-mandated)      |
| list mode   | `/`            | enter filter mode                                         |
| list mode   | `Enter`        | open detail view                                          |
| list mode   | `y`            | copy block canonical text to clipboard                    |
| list mode   | `o`            | smart external open (see Actions)                         |
| list mode   | `Esc`          | close explorer                                            |
| filter mode | printable      | edit query (live re-filter, no debounce assumed needed)   |
| filter mode | arrows         | move selection                                            |
| filter mode | `Enter`        | open detail view                                          |
| filter mode | `ctrl+u`       | clear query                                               |
| filter mode | `Esc`          | back to list mode, query stays active                     |
| detail view | `j`/`k`, arrows | scroll content                                           |
| detail view | `u` / `d`      | page content                                              |
| detail view | `J` / `K`      | next / previous block in filtered results, stay in detail |
| detail view | `y` / `o`      | same actions as list mode                                 |
| detail view | `Esc`          | back to list, selection synced                            |

### Blocks (rows) and indexing

Source of truth: `ctx.sessionManager.getBranch()` — the root→leaf path of the active branch,
**including pre-compaction history** (this is the transcript view, not the LLM-context view;
do not use `buildContextEntries()`). Abandoned branches must never appear.

Block extraction is a **per-entry-type registry**: each extractor maps a `SessionEntry` (or a
content block within one) to zero or more blocks. This registry is the designed extension
point — adding a new content kind later is a new extractor plus a config flag, not a redesign.

v1 coverage:

| Session source                                              | Block kind          | Notes |
| ----------------------------------------------------------- | ------------------- | ----- |
| `message` / role `user`                                     | user message        | |
| `message` / role `assistant`, text content                  | assistant text      | one block per assistant message's text |
| `message` / role `assistant`, `toolCall` content parts      | **merged tool block** | merged with its result (below) |
| `message` / role `toolResult`                               | folded into the matching tool block by `toolCallId`; **orphaned results get their own row** | |
| `message` / role `bashExecution`                            | bash block          | command + output + exit code |
| `message` / role `custom` with displayable content          | custom block        | |
| `custom_message` entry with `display: true`                 | custom block        | |
| `compaction` entry                                          | summary block       | |
| `branch_summary` entry                                      | summary block       | |
| `branchSummary` / `compactionSummary` message roles         | summary block       | if present on the branch |
| `label` entries                                             | not a row — label attaches to its target block as searchable metadata | |

**Excluded in v1** (each is a documented future extractor, not indexed now): assistant thinking
text, `custom_message` with `display: false`, `custom` state entries, `model_change`,
`thinking_level_change`, `session_info`. Never index base64 image data (`[image]` placeholder),
and never index tool `details` payloads.

Each block yields a search document with two zones:

- `fields` (compact, structured): role/type word, tool name, tool-call ID, flattened args
  summary, extracted file paths, label, formatted timestamp, entry ID.
- `body` (bulk): full message text / stored result text / command output — the **complete
  textual content stored in the session entry**, even when Pi's compact rendering truncates
  the display. Display or resize choices must never change document contents.

### Search (field-aware hybrid — the load-bearing decision)

Rationale discovered in Pi's source: `fuzzyMatch` (from `@earendil-works/pi-tui`) is
order-preserving subsequence matching. Over short fields it gives the desired fzf behavior
(`sconf` → `src/config.ts`); over multi-kilobyte bodies almost any token "matches" by
scattering, so pure fuzzy stops filtering exactly when sessions get large. It also returns
only `{matches, score}` — no character positions. It is **not** typo correction (transpositions
don't match). These facts force the hybrid:

- Query = whitespace-split tokens (do **not** split on `/` — paths stay whole). All tokens
  must match (AND).
- A token matches a block if it **fuzzy-matches `fields`** (Pi's `fuzzyMatch`) **or is a
  case-insensitive substring of `body`**.
- **Operators**: `is:<type>` (e.g. `is:user`, `is:tool`, `is:bash`, `is:summary`) and
  `tool:<name>` (e.g. `tool:read`) scope exactly, because plain tokens cannot ("user" as a
  token also matches bodies containing the word "user"). The operator grammar is the second
  designed extension point (future: `path:`, `label:`, quoted phrases). No filter toggle keys
  in v1; if added later they are UI sugar that rewrites query operators — the matcher never
  changes.
- Ordering: **chronological** (oldest top, newest bottom), cursor starts at the **newest
  matching block**; filtering removes rows but never reorders. Match scores are computed and
  kept so the `relevance` ordering config value is cheap.
- Highlighting: substring occurrences painted in rows and preview; for fuzzy-only hits on
  `fields`, recover positions with a small greedy subsequence walk (Pi's matcher decides
  membership/score; the walk only decides where to paint). Highlighting applies to plain text
  **before** theme styling — never splice into already-styled ANSI, never corrupt Markdown
  rendering.

### Freshness

**Live-updating**: new active-branch entries appear as they arrive (append-only incremental
index; full rebuild if the leaf/branch changed underneath). Selection is pinned by block ID
across updates, filtering, and resize. The repo's precedent for this idiom is
`interactive-subagents/command-running.ts` (selection-follows-id across refresh).

### Actions

- `y` — copy: one consistent behavior; a plain-text canonical rendering of the whole block
  (tool name + args, then stored result text; bash: command then output), ANSI-stripped,
  untruncated-as-stored. Uses `copyToClipboard` from `@earendil-works/pi-coding-agent`
  (native/platform tools with OSC52 fallback built in). Section-specific copies are future
  type-specific actions.
- `o` — smart external open, first applicable target wins:
  1. the file the block references (path args of read/edit/write/grep etc.), at the line when
     known — line targeting (`+<line>`) only for editors known to accept it;
  2. for a truncated bash block, the surviving `fullOutputPath` file;
  3. otherwise the block's canonical text written to a temp file.
  The footer hint reflects which behavior applies to the selection. Editor resolution mirrors
  Pi: settings `externalEditor` → `$VISUAL` → `$EDITOR`; suspend the TUI (`tui.stop()` /
  `tui.start()` + full re-render) around the spawn.
- Truncation honesty: when `details.truncation.truncated` (or `bashExecution.truncated`),
  preview and detail show an explicit marker built from the truncation metadata — kept lines /
  total lines, and whether a full-output file still exists on disk or the data is simply gone.
  The **search index only ever contains session-stored text** — never the contents of
  `fullOutputPath` — so results don't depend on temp-file survival.

### Configuration

Read-only layered config, matching `interactive-subagents/config.ts`: defaults <
`$PI_CODING_AGENT_DIR/fuzzy-explorer.json` < env vars. Validated fail-fast at extension load
with precise per-key errors; unknown keys rejected. No in-app writes (user hand-edits +
`/reload`; fits the user's dotfiles-overlay workflow).

| JSON key       | Env var                          | Values                                                    | Default         |
| -------------- | -------------------------------- | --------------------------------------------------------- | --------------- |
| `openShortcut` | `PI_FUZZY_EXPLORER_OPEN_SHORTCUT`| a Pi `KeyId` string                                       | `ctrl+r`        |
| `openMode`     | `PI_FUZZY_EXPLORER_OPEN_MODE`    | `list` \| `filter`                                        | `list`          |
| `listOrder`    | `PI_FUZZY_EXPLORER_LIST_ORDER`   | `chronological` \| `reverse-chronological` \| `relevance` | `chronological` |

No other knobs in v1 (explicitly decided: no keymap remapping, no sizing knobs yet).

## Pi API surface (verified against `@earendil-works/*` 0.80.6)

- `ctx.sessionManager` (`ReadonlySessionManager`): `getBranch()` root→leaf `SessionEntry[]`;
  `getLabel(id)`; `getLeafId()`. Entry union: `message` (inner `message.role`: `user` /
  `assistant` / `toolResult` / `bashExecution` / `custom` / `branchSummary` /
  `compactionSummary`), `compaction`, `branch_summary`, `custom_message`, `custom`, `label`,
  `model_change`, `thinking_level_change`, `session_info`. Entry `id` is 8-char hex;
  entry `timestamp` is ISO string.
- Tool calls: `toolCall` content parts on assistant messages (`{id, name, arguments}`).
  Results: `ToolResultMessage` (`toolCallId`, `toolName`, `content`, `isError`, `details`).
  Truncation: `details.truncation: TruncationResult` (`truncated`, `truncatedBy`,
  `totalLines`, `outputLines`, …); bash also `details.fullOutputPath` and
  `bashExecution.{truncated, fullOutputPath}`.
- UI: `ctx.ui.custom` (component with `render(width): string[]`, `handleInput(data)`,
  `invalidate()`), `ctx.ui.notify`, `matchesKey(data, keyId)` / `Key` helpers
  (note: pi camelCases key names), `fuzzyMatch` / `fuzzyFilter`, width utilities
  (`visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`), `Markdown` component +
  `getMarkdownTheme()`, `copyToClipboard`.
- Registration: `pi.registerCommand(name, {description, handler})`,
  `pi.registerShortcut(keyId, {description, handler})`.

### Shortcut safety (why `ctrl+r`)

Extension shortcuts dispatch **only while Pi's main editor has focus** (`defaultEditor.
onExtensionShortcut`); selector overlays get input first. Pi blocks extensions from a reserved
set (`ctrl+c/d/z/l/o/t/g/p`, enter, esc, `ctrl+k`, …) and the editor's emacs-style bindings
(`ctrl+a/b/e/f/u/w/y/j`) would break if shadowed. The genuinely free ctrl+letter chords are
`ctrl+r`, `ctrl+x`, `ctrl+n`; the user chose **`ctrl+r`**.

## Internal contracts (surface area, not implementation)

- **Extractor registry**: `SessionEntry[] → Block[]`. A `Block` carries: stable id (derived
  from entry id + part index), kind, correlated entry ids, `fields`, `body`, compact-row
  descriptor, preview/detail descriptor, optional file reference (path + line), optional
  truncation info, optional label.
- **Query parser**: query string → `{ tokens: string[], operators: {key, value}[] }`.
  Extensible grammar; unknown operator keys are treated as plain tokens (forgiving).
- **Matcher**: `(parsedQuery, block) → { matches, score, highlightSpans }`. Pure function.
- **Explorer component**: owns mode state (list / filter / detail), selection-by-block-id,
  viewport, and live-refresh subscription. Rendering follows the repo's
  **pure-renderer / stateful-controller split**: row/preview/detail formatting are pure
  functions taking injected style callbacks, so tests drive them without a TUI.
- All rendered lines sanitized (strip terminal control sequences from session text) and
  width-clamped — Pi treats over-wide lines as fatal.

## Repo conventions that bind this work

- Structure: `fuzzy-explorer/index.ts` + small single-responsibility sibling modules +
  `fuzzy-explorer/tests/*-test.ts`.
- Tests: framework-free executable `.ts` files (hand-rolled `eq`/`ok`, pass/fail counters),
  run by `make check` (`tsc --noEmit` + `node --experimental-strip-types` per test file).
- Comments: the user is newer to TypeScript — simple code, section-level comments explaining
  intent (this overrides the global "skip comments" rule for this repo).
- Temp/scratch: use `.sandbox/` in the repo root, not `/tmp`.

## Acceptance criteria

1. Explorer indexes the active branch; every v1 block kind is keyboard-navigable; abandoned
   branches never appear.
2. One query can match a tool invocation (`read path/to/file`, fuzzy on fields) and text that
   exists only in the stored result body (substring) — including text absent from the compact
   row display.
3. `is:` / `tool:` operators scope exactly; operators are visible in the in-app help text.
4. `j`/`k`, `u`/`d` paging, filtering, selection, preview, detail view, and `Esc` behavior all
   work mouse-free exactly per the keymap table; PageUp/PageDown are not bound.
5. `y` copy, `o` smart open, and the detail view work on applicable blocks; `o` respects the
   file → fullOutputPath → canonical-text precedence.
6. Truncated-output blocks display the honest marker; search never depends on `fullOutputPath`
   contents.
7. Selection stays stable (by block id) across filtering, live updates, and resize; rendering
   stays width-safe; large sessions stay responsive.

## Verification workflow

1. `make check` (typecheck + all tests).
2. Fixture-session builder producing a JSONL session with: user + assistant messages, several
   tool calls/results (including one truncated with a surviving full-output file and one
   without), a bash execution, a compaction summary, a branch summary, a label, a
   `display:false` custom message (must NOT appear), and an **abandoned branch** (must NOT
   appear).
3. Agent-verified end-to-end run: launch Pi inside tmux (split with `-t "$TMUX_PANE"`) using an
   **isolated `PI_CODING_AGENT_DIR`** (auth/models copied in, packages-free, per the
   established smoke-test setup) with the fixture session; drive the explorer via
   `tmux send-keys` + `capture-pane` to verify: every active-branch block reachable, abandoned
   branch absent, operator + fuzzy + substring queries behave, `u`/`d` paging, copy/open
   actions, truncation marker, resize width-safety, and responsiveness on a large generated
   session.

## Out of scope (unchanged from issue #26)

Searching/navigating abandoned branches; customizing `/tree`; scrolling Pi's main transcript
to an entry; requiring external `fzf`; mutating historical messages. Explicitly deferred:
filter toggle keys, thinking/hidden/meta extractors, type-specific actions, keymap remapping,
sizing knobs, quoted phrases and additional operators.
