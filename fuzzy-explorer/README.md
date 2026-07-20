# fuzzy-explorer

Keyboard-first search and navigation for the active branch of the current Pi transcript.

Open it with `/fuzzy-explorer` or `Ctrl+R`. It only reads `sessionManager.getBranch()` and never changes the session leaf.

## Search

Plain terms are ANDed. Each term fuzzy-matches compact fields such as tool names, arguments, paths, labels, timestamps, and entry IDs, or substring-matches the complete text stored in a message/result body.

- `is:user`, `is:assistant`, `is:tool`, `is:bash`, `is:custom`, `is:summary`
- `tool:read`, `tool:bash`, or another exact tool name

Paths stay intact, so `src/config.ts` is one term. Unknown operators are treated as plain terms.

## Keys

List mode uses arrows or `j`/`k`, `u`/`d` to page, `g`/`G` for first/last, `/` to filter, Enter for detail, `y` to copy, `o` to open, and Escape to close. In filter mode, printable keys edit the query while arrows still navigate; `Ctrl+U` clears it and Escape returns to list mode without clearing it.

Detail mode uses arrows or `j`/`k` to scroll, `u`/`d` to page, `J`/`K` to visit adjacent filtered blocks, `y`/`o` for actions, and Escape to return to the list.

## Configuration

Create `$PI_CODING_AGENT_DIR/fuzzy-explorer.json` (normally `~/.pi/agent/fuzzy-explorer.json`) and run `/reload` after editing:

```json
{
  "openShortcut": "ctrl+r",
  "openMode": "list",
  "listOrder": "chronological"
}
```

Environment variables override the file:

- `PI_FUZZY_EXPLORER_OPEN_SHORTCUT`
- `PI_FUZZY_EXPLORER_OPEN_MODE`
- `PI_FUZZY_EXPLORER_LIST_ORDER`

Unknown keys, invalid values, and shortcuts reserved by Pi's main editor fail when the extension loads.

## Indexed content

Version 1 indexes user text, assistant text, merged tool calls/results, orphan tool results, user bash executions, visible custom messages, compaction summaries, branch summaries, and labels attached to those blocks. It intentionally excludes assistant thinking, hidden custom messages, extension state entries, model/thinking changes, and session metadata. Images are represented only by `[image]`; base64 and tool `details` payloads are never searchable.

Future extractors can add those excluded content kinds without changing the picker or matcher.

## Verification fixture

`tests/fixture-session.ts` builds a branched JSONL transcript for smoke testing. An optional second argument appends many user blocks for responsiveness checks:

```sh
node --experimental-strip-types fuzzy-explorer/tests/fixture-session.ts .sandbox/fuzzy-explorer-fixture 5000
```

Run the full non-mutating suite with `make check`.
