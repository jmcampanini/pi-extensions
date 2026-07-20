# Fuzzy Explorer redesign — interview handoff

Spin-up prompt to resume a design interview about improving the `fuzzy-explorer` Pi
extension. This is a plain TUI/text-search feature: fuzzy string matching, list
layout, and colors. Nothing sensitive.

## How to resume

You are continuing an `interview-me`-style design session. Ask one question at a
time, 2–4 options each, mark one **recommended**, and give a one-line "why choose
this" for every option. Do not use the AskUserQuestion tool. Walk the remaining
design tree in order. When a question can be answered from the code, read the code
instead of asking.

Model rule: design/answering can happen on any model; **only write code on Fable**.

## What this is

Redesigning the `fuzzy-explorer` extension after hands-on complaints. It's a modal
transcript explorer (opens on `ctrl+r` / `/fuzzy-explorer`) that indexes transcript
blocks and offers list / filter / preview / detail views.

Worktree: `~/Code/github.com/jmcampanini/pi-extensions/wt-better-fuzzy-explorer`
Code dir: `fuzzy-explorer/`

Key files:
- `search.ts` — `matchBlock`, `searchBlocks`, ordering, highlight spans
- `query.ts` — parses `is:`/`tool:` operators + free tokens
- `render.ts` — result rows, preview pane, detail lines, header, footer
- `component.ts` — controller, styles (theme tokens), `titleLine`/`queryLine`, layout
- `state.ts` — mode/selection/viewport state; `listOrder`
- `extract.ts` — builds `Block`s (fields blob, body, canonicalText) from entries
- `config.ts` — layered config (defaults → file → env); `openShortcut`, `openMode`, `listOrder`
- `types.ts` — `Block`, `BlockMatch`, `HighlightSpan`, etc.
- pi-tui `fuzzyMatch` lives at (main worktree) `node_modules/@earendil-works/pi-tui/dist/fuzzy.js`:
  subsequence match, lower score = better, rewards consecutive + word-boundary hits.

## The user's complaints (source of the redesign)

- Add a **border**; keep the default background color.
- The list header wastes space: `fuzzy-explorer · N blocks · list`, `query › …`,
  ` 1–35 of N` — compress the title + query lines; we know we're in fuzzy-explorer.
- Two-line header looks bad in **detail** mode too.
- Tool coloring / multi-color rows feel like **too much**; hard to read.
- **Fuzziness isn't working**: searching "subagent" doesn't surface subagent blocks;
  "sub-agent" fails; `is:ass` won't match `assistant` until fully typed.
- Wants a **better row layout** when a query is active (right now every row starts
  with `Assistant · assistant ·` before anything useful).

## Diagnosis (root causes, from reading the code)

1. `matchBlock` fuzzy-matches each token against one giant ~700-char `fields` blob
   (`role:… type:… tool:… toolCallId:… args:…`). Subsequence over a huge string
   matches almost everything → no real filtering.
2. Default `listOrder` is `chronological`, and in that mode `searchBlocks` **computes
   the fuzzy score then discards it** (search.ts ~143-150). So even matched blocks
   aren't ranked — you get near-everything in timestamp order.
3. Body search is exact substring (`bodyLower.includes(token)`); no `-`/`_`/space
   normalization, so "sub-agent" never matches "subagent_spawn".
4. `is:`/`tool:` use exact equality (`kind === value`), so partials never match.

## Decisions so far

- **Q1 — what a token matches (RESOLVED):** Option A — match against a short curated
  **search key** per block (kind + tool name + title/subtitle only), not the big
  fields blob. Body is separate/opt-in. PLUS an opt-in operator (working name `any:`
  or `global:`) that widens matching to the whole block text (args, toolCallId, etc.)
  when explicitly requested.

- **Q2 — `is:`/`tool:` matching (RESOLVED):** Option C — full fuzzy subsequence,
  same matcher as free-text tokens. Consequence accepted: `is:` becomes a pattern,
  not a pin (`is:s` keeps summary/assistant/bash/custom), so ordering decides the top row.

- **Q3 — default result ordering (PENDING — answer this next):**
  - **A (recommended):** relevance when a query is active, chronological when empty.
    Fixes the core bug; browsing stays chronological; selection tracked by block id.
  - **B:** always relevance (empty query = all scores 0 → same as chronological anyway).
  - **C:** keep chronological default, add a live toggle. Leaves default experience broken.

## Remaining design tree (after Q3)

Search branch:
- Separator normalization (treat `-`/`_`/space/`.` as equivalent so "sub-agent" == "subagent").
- Body matching: keep exact-substring, or fold into fuzzy / behind the `any:`/`global:` operator.
- Exact-order tie-breaking / score weighting details.

Presentation branch:
- Border style + keep default bg (self-rendered box, since pi-tui `Box` has no border;
  Pi's editor only draws top/bottom rules).
- Compress list header: fold title + query into one line; drop redundant `fuzzy-explorer`.
- Detail-mode header: collapse the two-line header.
- Result-row layout under an active query (avoid leading `Assistant · assistant ·`;
  surface the matched content / better use of horizontal space).
- Color toning: reduce the multi-color tool rows using semantic theme tokens
  (`toolTitle`/`accent`/`muted`/`dim`/`toolOutput` per AGENTS.md).
- Preview pane + footer adjustments to match.

## Working agreements

- Options: 2–4 per question, one recommended, one-line rationale each. No AskUserQuestion tool.
- Follow project AGENTS.md TUI rules: Pi native patterns, `Box(1,1)` + theme bg unless the
  design needs otherwise, semantic theme tokens (never literal colors) in TUI code.
- Plan must end with an agent-verified end-to-end check (or a manual-verify prompt).
- Every plan branch: resolve dependencies one at a time.
