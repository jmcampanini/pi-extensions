# fuzzy-explorer

Keyboard-first search and navigation for the active branch of the current Pi transcript.

Open it with `/fuzzy-explorer`. It only reads `sessionManager.getBranch()` and never changes the session leaf.

## Search

Plain terms are ANDed. Each term fuzzy-matches a block's short search key (kind, tool name, title, and argument subtitle), or substring-matches the complete text stored in a message/result body. Separators (`- _ . / :`) are normalized with a small ranking penalty, so `sub-agent` finds `subagent` and vice versa.

- `is:user`, `is:assistant`, `is:tool`, `is:bash`, `is:custom`, `is:summary` — fuzzy patterns, so `is:s` keeps summaries and assistants
- `tool:read`, `tool:bash`, or a fuzzy fragment of another tool name
- `any:toolu_01` — substring search across everything indexed (arguments, tool call ids, entry ids, timestamps, full body) for hunting concrete needles

Paths stay intact, so `src/config.ts` is one term. Unknown operators are treated as plain terms.

While a query is active, results are ordered by relevance (best first; newest first among ties) and typing re-selects the top result. With an empty query the list is chronological and anchored on the newest block.

## Keys

List mode uses arrows or `j`/`k`, `u`/`d` to page, `g`/`G` for first/last, `/` to filter, Enter or `l` for detail, `y` to copy, `o` to open, and `q` or Escape to close. In filter mode, printable keys edit the query while arrows still navigate; `Ctrl+U` clears it and Escape returns to list mode without clearing it.

Detail mode uses arrows or `j`/`k` to scroll, `u`/`d` to page, `J`/`K` to visit adjacent filtered blocks, `y`/`o` for actions, and `h`, `q`, or Escape to return to the list.

Detail content renders as markdown for the block kinds Pi's transcript renders that way — assistant text, user text, summaries, custom messages — plus `subagent_*` tool blocks; other tool and bash output stays raw. `m` toggles rendered/raw for the current block. `y` copy and `o` open always use the raw stored text.

Subagent traffic gets structured treatment (via the format contract exported by the interactive-subagents extension): spawn/resume rows show `name=… agent=…` metadata while the preview and detail show the full task prompt; result envelopes split into metadata fields plus the delivered response, unwrapped from its `<result>` markers so it renders as markdown.

## Configuration

No keyboard shortcut is registered by default. To add one, create `$PI_CODING_AGENT_DIR/fuzzy-explorer.json` (normally `~/.pi/agent/fuzzy-explorer.json`) and run `/reload` after editing:

```json
{
  "openShortcut": "ctrl+r",
  "openMode": "list"
}
```

Pi binds `Ctrl+R` to `app.session.rename` by default. To use it for fuzzy-explorer without a shortcut conflict, reassign or unbind that action in `~/.pi/agent/keybindings.json`:

```json
{
  "app.session.rename": []
}
```

Environment variables override the file:

- `PI_FUZZY_EXPLORER_OPEN_SHORTCUT`
- `PI_FUZZY_EXPLORER_OPEN_MODE`

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
