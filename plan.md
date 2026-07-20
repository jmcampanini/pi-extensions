# PLAN: fuzzy-explorer redesign

Implementation contract from the design interview (2026-07-19/20). Everything here is
settled; an implementing agent should treat it as decided unless the user says otherwise.
Session-wide breaking-change mode: **clean break** (old forms live only in git history and
commit bodies; no aliases, guards, or migration errors).

Model rule: code is written on Fable only.

## Search behavior

### What a token matches
- Each block gets a short curated **search key**: kind + tool name + title/subtitle.
  Free tokens fuzzy-match (pi-tui `fuzzyMatch`) against this key — never against the old
  ~700-char `fields` blob.
- Body matching stays **exact substring** (`includes`), OR'd with the key match per token.
- New operator **`any:`** widens matching to the full haystack (fields blob + canonicalText:
  args, toolCallId, entry ids, timestamps, full body) as **substring**, never fuzzy.
  Use case: hunting concrete needles (`any:toolu_01`, an entry id, an arg value).

### Separator normalization
- Separator class: `- _ . / :` (the matcher's existing word-boundary class).
- Everywhere a token is matched (key fuzzy, body substring, `any:` substring): try the
  **raw token first; on failure retry with separators stripped**, at a small score penalty
  (mirror the existing `swappedAlphaNumericToken` +5 fallback pattern).
- Precompute a separator-stripped copy of each body (and `any:` haystack) at extract time.
- Highlight spans keep working unchanged: they are greedily re-derived against the
  original text, which works for stripped tokens too.

### Operators
- `is:` / `tool:` use **full fuzzy subsequence** (same matcher as free tokens) against
  kind / toolName. `is:` is a pattern, not a pin: `is:s` keeps summary + assistant + etc.
- Operator fuzzy scores are **added into the block score** so e.g. `is:s` ranks `summary`
  (word-boundary hit) above `assistant`.

### Ordering, scoring, selection
- **Query active → relevance** (score ascending; lower = better).
  **Query empty → chronological**, with selection anchored on the newest block (existing
  first-load behavior).
- Tie-break among equal scores: **newest first** (reverse chronological index).
- Body-only matches contribute score 0 (emergent tiering: crisp key hits outrank body
  hits; garbage key hits don't). No occurrence counting.
- Selection **resets to the top (best) result on every query change** (`setQuery`).
  Block sync (`syncBlocks`) keeps sticky selection — only typing resets. Empty query
  re-anchors to the newest block.

### Config (clean break)
- **Delete** `listOrder` config key, `PI_FUZZY_EXPLORER_LIST_ORDER` env var, and the
  `ListOrder` type + all plumbing. Ordering is hardcoded as above. No replacement knob.
- `openShortcut` / `openMode` stay unchanged.
- User's live setup has no `fuzzy-explorer.json` and no env vars → commit body:
  `Manual update steps: none.`

## Presentation

Single self-rendered box, stacked layout (list above, preview below), full width.
All chrome lives in the border; interior lines are content only.

```
┌ fuzzy ──────────────────────────────────────────── 6/447 ┐   top: "fuzzy" (toolTitle bold) left,
│ › recon▌                                                 │        matches/total (muted) right
├──────────────────────────────────────────────────────────┤   input line: › + query (accent), then rule
│ ▸ subagent_spawn  agent=scout name=Repository recon tas… │   rows (see anatomy below)
│   read            path=/Users/jmcampanini/.pi/agent/ski… │
│                                                          │   one blank line before preview rule
├ subagent_spawn · 21:14 ──────────────────────────────────┤   titled rule: block identity (accent)
│ Sub-agent "Repository recon" started (id 5962bee9, fre…  │   preview body, wrapped (toolOutput)
└ enter detail · / filter · esc ───────────────────────────┘   hints in bottom border (muted)
```

- **Border**: square corners `┌ ┐ └ ┘`, `borderMuted`, **default background** (remove the
  `Box(1,1)` `toolPendingBg` fill), one cell inner padding.
- **Header**: no title line, no range line, no `query ›` label line. Match counts
  `{matches}/{total}` top-right in the border. Filter mode = live input with cursor on
  the input line; list mode = static query text.
- **List/preview split**: keep 55/45 height ratio. Preview wraps (never truncates).
  Drop the preview `match · …` line (redundant — rows highlight their own matches).
- **Footer**: keybind hints embedded in the bottom border (`muted`), truncating gracefully;
  degrade to top-priority keys when narrow. Delete the interior help-footer lines.
- **Detail mode**: block identity (`kind/tool · time · title`) replaces `fuzzy` in the top
  border; position `{n}/{total}` top-right; content starts on interior line 1; hints in
  bottom border. Old two-line header (title + `Detail n/m · Esc…`) is deleted.

### Row anatomy
`▸` selection marker (accent) · aligned tag column · detail text.

- **Tag column** (`toolTitle` **bold**, aligned width): tool name for tool blocks;
  `Asst` / `User` / customType / summary label otherwise.
- **Detail** (`muted`): tool blocks → args subtitle with **tail-aware truncation** for
  paths (keep `…/scripts/create-agent.sh`, not the `~/Code/github…` prefix); prose and
  custom blocks → first body line.
- **Matched characters**: `accent` bold, highlighted in place.
- **Body-only matches**: swap the detail for a grep-style excerpt around the first body
  match (`⋯ set -euo pipefail ⋯`), match highlighted. Key-matched rows keep normal detail.
- **No timestamps in rows** (identity + time live in the preview/detail border titles).
- No per-tool colors anywhere; semantic theme tokens only.

## Clean-break sweep checklist
- `listOrder` / `PI_FUZZY_EXPLORER_LIST_ORDER` / `ListOrder` type and tests pinning them.
- `titleLine`, `queryLine`, range line, interior help footer, `Detail n/m` status line.
- `toolPendingBg` box fill.
- Preview `match ·` line.
- Any surviving trace must be a change record (commit/PR text), nothing in code or docs.

## Verification

Agent-verified (must pass before done):
1. `npm ci && make check` — typecheck + full test suite.
2. Extend tests to cover the new contracts:
   - `search-test`: separator fallback (raw-first, stripped, penalty), `any:` substring
     semantics, operator fuzzy matching + score contribution, relevance-when-querying /
     chronological-when-empty, newest-first tie-break, body-only score 0.
   - `state-test`: selection resets on `setQuery`, sticky on `syncBlocks`, newest anchor
     on empty query.
   - `render-test`/`component-test`: border box (corners, embedded titles, counts, hints,
     truncation), input line, row anatomy (tag alignment, tail-aware paths, excerpt swap,
     highlight placement), blank line + titled preview rule, detail-mode border, narrow
     widths, default background (no fill).
   - `config-test`: `listOrder` gone; file/env handling without it.
3. End-to-end: extract blocks from a real session fixture and drive
   `component.render()` at 120 and 100 cols, asserting the full frame (search → rows →
   preview → detail) matches the contract.

Manual verify prompt (visual feel can't be asserted): open Pi in a real session,
`ctrl+r`, check — border/colors read calmly; `subagent`, `sub-agent`, and `is:ass`
surface the expected blocks ranked sensibly; typing re-selects the top hit; Enter/Esc
detail round-trip; narrow tmux pane still renders.
