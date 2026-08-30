# Adaptive footer

The first footer row shows repository context:

```text
cwd • session                                    issue • PR • branch
```

Issue and pull-request labels are OSC 8 links when the terminal supports them. Full labels include state, such as `is#456 o` and `pr#123 m`; constrained layouts use `i456` and `p123` before dropping remote links. Remote state refreshes immediately on branch changes and at most once every 30 seconds when the agent settles.

PR states are `o` (open), `d` (draft), `c` (closed), and `m` (merged). Issue states are `o` (open) and `c` (closed).

The second row includes context and compaction progress:

```text
51% 140k/272k • compact @245k 57%
```

The context component reports current usage against the model's full context window. The separate compact-target component reports the configured Auto Compact threshold followed by progress toward it. At constrained widths, `compact @245k 57%` reduces to `C57%`. When current usage is unknown, the known target remains as `compact @245k` or `C@245k`. While Auto Compact is paused by its failure latch (published as the `auto-compact` status), the component renders `compact ⏸` (reducing to `C⏸`) and the context color bands fall back to the static 70/90 thresholds.

The right side ends with the current model and thinking level. When OpenAI Codex Fast mode is enabled, its indicator appears between them as `fast`, reducing to `f` in the compact layout:

```text
gpt-5.6-sol • fast • xhigh
gpt-5.6-sol • f • xhigh
gpt-5.6-sol • xhigh          # Fast mode disabled
```

## Issue inference

The footer checks explicit issue markers in the current branch, then the cwd basename. A candidate is displayed only after `gh issue view` verifies it.

Configure replacement patterns in `~/.pi/agent/adaptive-footer.json`, or under `$PI_CODING_AGENT_DIR` when set:

```json
{
  "issuePatterns": [
    "(?:^|[/_-])tickets?[#/_-](?<number>[1-9][0-9]*)(?=$|[/_-])"
  ]
}
```

Patterns are tried in order and must contain a named `number` capture. The configured array replaces the defaults; use an empty array to disable issue inference.

The default recognizes explicit `issue` and `issues` markers such as `feature/issue-456`, `issues/456`, and `issue#456`.

## Extension statuses

Statuses published by other extensions render on a third footer line. Three keys are promoted out of that line: `elapsed-time` becomes its own right-aligned component, `fast-openai` folds into the runtime identity, and `auto-compact` folds into the compact-target as the paused marker. Promoting another status requires four edits in `index.ts` - the status-key import, the `ownedKeys` list in `partitionFooterStatuses`, its return record, and the render wiring. Miss the owned-keys entry and the status renders twice.
