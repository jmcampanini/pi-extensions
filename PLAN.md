# Plan: complete, consistently-ordered subagent result surfaces (issue #109)

## Problem

A subagent result is presented on three surfaces, and each drops or misorders information:

1. **The envelope** — the prose string in the result message's `content`, built by
   `buildSubagentResultEnvelope` (`interactive-subagents/result-content.ts`). It is what the parent
   model reads and what the transcript stores. It omits model, effort, tools, and the mode flags
   (forked / interactive / worktree), and it buries `Failure:`/`Notice:` below the cost metrics.
2. **The expanded TUI card** (`interactive-subagents/result-message.ts`) — reads the message
   `details`, but `parseSubagentResultDetails` silently drops fields the watcher already sends
   (`model`, `tools`, `harness`, `exitCode`, `reason`, `contextWindow`, `worktree*`), and the
   metadata it does show is scattered around the response instead of grouped.
3. **The fuzzy-finder entry** (`fuzzy-explorer/subagent.ts` + `render.ts`) — re-parses the envelope
   text (custom-message blocks carry no `details`), shows a metadata wall *above* the response, and
   cannot show model/effort because the envelope doesn't carry them.

Root cause of the drift: the envelope and the `details` blob are hand-assembled independently at
two call sites in `interactive-subagents/watcher.ts` (`finalizeDelivery`, stopped path ~line 451
and completion path ~line 564), so nothing forces the representations to agree. The stopped path
already drifted (no model/tools).

One genuine data gap: the effort/thinking level is never stored on `RunningSubagent` — both
`trackChild` call sites have `spec.thinking` in scope and drop it.

## Settled design (do not relitigate)

These were decided with the maintainer; implement as stated.

- **Envelope stays metadata-first.** The agent-facing head keeps metadata before `<result>`. Only
  the *display* surfaces (TUI expanded card, fuzzy preview/detail) go result-first.
- **Display surfaces put the response first**, then one aligned key–value metadata table, then the
  resume/session action tail. Fuzzy raw mode (`m`) keeps showing the raw envelope untouched.
- **One typed record, one builder.** A single function in `result-content.ts` produces `{content,
  details}` from one input struct; every watcher send path feeds it. A new field added in one place
  or the compiler complains.
- **Envelope head field set (option "A")** — see exact format below. `Model:` and `Effort:` are
  added; `Mode:` lists only non-default flags; `Tools:` appears only when the child was restricted;
  `Failure:`/`Notice:` hoist to directly under `Status:`.
- **`Model:` reports the actual model when knowable**: liveness snapshot `modelId` → spawn-resolved
  `child.model` → line omitted (e.g. external child on its harness default). Note
  `ActivitySnapshot.modelId` is `string | null`, so `obs.snapshot?.modelId ?? child.model` does the
  right thing.
- **Stopped results get full parity**: same model/effort/mode/tools/metrics fields as completed
  results (result tokens naturally absent — no response).
- **The flags key is named `Mode:`** (`Context:` is taken by the token count). Do NOT rename
  `Context:`.
- **Details-only fields** (never in the envelope): `contextWindow`, `worktreeDir`,
  `worktreeBranch`, `worktreeStatus`, `exitCode`, `reason`. Exit codes stay folded into `Failure:`
  prose as today.
- **Table order = envelope order, verbatim** on every display surface: status, failure?, notice?
  (TUI card excepted, see below), name, agent, harness?, id, model?, effort?, mode?, tools?,
  elapsed, context?, result?, cost? — then the action tail (resume, session, worktree note).
- **On the TUI card, verdict stays above the response**: `failure`/`notice` lines render before the
  response markdown (they frame it; a stopped run has no response). The table below carries
  everything else including a `status` row.
- **Fuzzy list row keeps its role**: compact identity lead (name, agent, status — current
  `PRIORITY_KEYS` behavior), further fields following in canonical order. The preview pane goes
  content-first and may clip the table (full table in the detail view).
- **The collapsed TUI result card is out of scope** — unchanged.
- **Pings (`subagent_ping`) are not results** — unchanged.
- **Backward compatibility mode: additive.** All new envelope lines and details fields are
  optional. Old stored sessions keep rendering (with fewer rows). Do not bump
  `presentation.version` (2) or `expanded.version` (1); new fields live on the details root as
  optional members that `parseSubagentResultDetails` tolerates when absent.

## Target envelope format

Head groups: **verdict** → **identity & capabilities** → **run metrics**. `[...]` = omitted when
absent/default. Tail is unchanged from today.

```
Subagent result
Status: completed|failed|stopped
[Failure: <reason>]                       ← hoisted (was below Cost)
[Notice: <stop notice>]                   ← hoisted
Name: <name>
Agent: <agent>
[Harness: claude-code]
ID: <short id>
[Model: claude-sonnet-5]                  ← new
[Effort: high]                            ← new; only when a thinking level was set
[Mode: forked · interactive · worktree]   ← new; only non-default flags, in this order;
                                            line omitted when all flags are default
[Tools: read,edit,bash]                   ← new; only when a tools allowlist was set
Elapsed: 3m 3s
[Context: 78k tokens]
[Result: ~551 tokens]
[Cost: $0.92]

<result>
...child's final message, verbatim (sanitized)...
</result>

Resume|Retry: subagent_resume({ id: "...", message: "..."|"<guidance>" })
Session: <path>            (or `Session ref: ... (pass as sessionPath ...)` for external children)
[<worktree note>]
```

Typical completed result grows by exactly 2 lines (Model, Effort).

## Target display layouts

**Expanded TUI card** (`structuredExpandedResult`), top to bottom:

1. Header line, unchanged: `subagent result · <agent> · <name> · done 3m3s`
2. `notice` and/or `failure · <reason>` lines, unchanged position (verdict frames the response)
3. Response markdown (with the existing `last output` label on failed runs)
4. Aligned key–value table: dim/muted keys padded to one fixed column, values in `toolOutput`;
   rows in canonical order (status, name, agent, [harness], id, [model], [effort], [mode],
   [tools], elapsed, [context], [result], [cost]). `context` shows `78k / 200k tokens` when
   `contextWindow` is known, else `78k tokens`. Undefined fields → row omitted.
5. Action tail as today: worktree note, `session <path>`, `resume|retry subagent_resume({...})`
   with the path/snippet in `accent`.

**Fuzzy finder** (rendered mode only; raw mode untouched):

- Preview pane + detail view: response content first, blank line, then the metadata table as plain
  aligned text (`status    completed` …), which includes the parsed tail fields (`resume`,
  `session`) last because they parse after the head. Preview clips the table when its line budget
  runs out.
- List row: unchanged mechanism — `formatSubagentFields`-style compact fields with name/agent/status
  leading, new fields appended in canonical order.

## Implementation steps

### 1. `interactive-subagents/state.ts` — carry the effort level

Add `thinking?: string` to `RunningSubagent`.

### 2. `interactive-subagents/tool-spawn.ts` and `tool-resume.ts` — populate it

Both `trackChild({...})` call sites (tool-spawn.ts ~line 727, tool-resume.ts ~line 524) add
`thinking: spec.thinking`. Both specs already carry it (spawn `SpawnSpec.thinking`; resume spec
feeds `spec.thinking` to the launch command builders).

### 3. `interactive-subagents/result-content.ts` — widen the record, unify the builder

- Widen the envelope input with `model?`, `effort?`, `forked?`, `interactive?`, `worktree?`
  (booleans; builder composes the `Mode:` line), `tools?`.
- Reorder the head per the format above (Failure/Notice hoist; new lines in the identity group).
- Add a single message builder, e.g. `buildSubagentResultMessage(input): { content: string;
  details: <typed details payload> }`, that:
  - derives `action`/`actionMessage` from status (failed → `Retry`/`"<guidance>"`, else
    `Resume`/`"..."`), removing those from the input;
  - computes `elapsed` from `elapsedSeconds` (move `humanElapsed` here from `result-message.ts`,
    re-exporting or updating its importers — internal move, fully updated in this change);
  - owns the presentation preview per status (completed → response; failed → response ??
    failureReason; stopped → the existing fixed prose), calling `resultPresentation`;
  - emits the details payload with everything the current completion path sends **plus**
    `effort`, `forked`, `interactive`, and an explicit `worktree` boolean, and with the same
    fields on every status path (stopped-path parity);
  - keeps `expanded` exactly `{version: 1, response?, failureReason?, notice?, worktreeNote?}`.
- `parseSubagentResultEnvelope` needs no logic change (generic `Key: value` lines both sides of
  `<result>`); its tests pin the new order.

### 4. `interactive-subagents/watcher.ts` — feed the one builder

In `finalizeDelivery`, replace the stopped-path and completion-path inline envelope+details
assemblies with calls to `buildSubagentResultMessage`. Model resolution at these call sites:
`obs.snapshot?.modelId ?? child.model`; effort: `child.thinking`; flags from the values already on
the record (`record.forked`, `record.interactive`, `record.worktree` / `child.context`,
`child.autoExit`, `child.worktree`). The ping path is untouched.

### 5. `interactive-subagents/result-message.ts` — parse more, render result-first + table

- `parseSubagentResultDetails`: accept the new optional fields (`model`, `effort`, `tools`,
  `harness`, `forked`, `interactive`, `worktree`, `contextWindow`) with type-checked optional
  parsing like the existing fields. Absent → undefined, never a parse failure.
- `structuredExpandedResult`: reorder to the layout above and add the table renderer. Follow
  AGENTS.md TUI rules: semantic theme tokens only (`muted` keys, `toolOutput` values, `accent`
  paths/snippets); never `truncateToWidth` — use `fitText`/`clampStyled` from
  `interactive-subagents/text-fit.ts`.
- The non-structured fallback path (plain markdown of the whole content) stays as is.

### 6. `fuzzy-explorer/subagent.ts` + `render.ts` — flip composition, add the table

- Keep `resultView` parsing as is; fields arrive in canonical order automatically once the
  envelope is reordered.
- Keep the `prioritized()` reorder for the **row** line only.
- `displayContent`/`formatPreviewLines` path: compose `content` first, then the aligned plain-text
  table built from the parsed fields (canonical order — i.e. un-prioritized parse order). Body-match
  highlight spans are re-derived against displayed text (already documented in render.ts), so the
  new layout keeps highlights for free.
- Raw mode (`formatDetailLines` on `canonicalText`) untouched.

### 7. Docs

- `interactive-subagents/README.md`: update the results-presentation paragraph (grep for
  "Expanded results place worktree, session, and resume guidance below the response") to describe
  the new order, and any envelope-format description elsewhere in the file.
- `fuzzy-explorer/README.md`: update the subagent-traffic paragraph ("result envelopes split into
  metadata fields plus the delivered response") to say response-first with the metadata table below.

## Tests

Follow the repo's test philosophy (one primary owner per behavior, closest layer to the defect):

- `interactive-subagents/tests/result-content-test.ts` — primary owner of the format contract:
  - round-trip: `parseSubagentResultEnvelope(buildSubagentResultMessage(x).content)` recovers every
    field, for completed/failed/stopped × flags on/off × optional fields present/absent;
  - head order (verdict → identity → metrics), `Mode:` composed only from non-default flags,
    `Tools:`/`Model:`/`Effort:` omitted when unset;
  - content/details consistency from the unified builder (details.model equals the input model,
    response offsets slice the exact response, stopped path carries the full field set).
- `interactive-subagents/tests/result-message-test.ts` — parser accepts/round-trips the new details
  fields; expanded layout order (verdict lines → response → table → action tail); rows omitted for
  absent fields; old-shape details (no new fields) still render.
- `fuzzy-explorer/tests/subagent-test.ts` — result view field order is canonical; row line keeps
  name/agent/status lead.
- `fuzzy-explorer/tests/render-test.ts` — preview/detail are content-first with the table below;
  preview clips the table, not the content, when the line budget runs out; highlights still land.
- Update any watcher/delivery tests (`delivery-test.ts`, `redelivery-test.ts`, …) that pin the old
  envelope text.

## Verification workflow (run all of it)

1. Run the repo's full check suite (see `Makefile` / `package.json` scripts — typecheck + all
   tests for both extensions) and get it green.
2. Agent-verified end-to-end: build one complete result message through the real pipeline —
   construct a `DeliveryRecord`-shaped input, call `buildSubagentResultMessage`, then
   (a) feed its `content` to `parseSubagentResultEnvelope` and render the fuzzy preview/detail via
   the exported render helpers, and (b) feed its `details`+`content` through the registered
   `subagent_result` renderer (as `result-message-test.ts` does, with a fake theme) — asserting the
   response text appears before the metadata table on both surfaces and that model + effort are
   present on both. If an existing e2e harness test (`claude-harness-e2e-test.ts` pattern) can
   spawn a real child cheaply, prefer that for (b)'s input.
3. The purely visual qualities (colors, alignment at real terminal widths, dark/light themes)
   cannot be agent-verified — after the above is green, prompt the maintainer to manually verify:
   spawn a trivial subagent in a live pi session, expand its result card, and open the result in
   the fuzzy finder (rendered and raw modes).
