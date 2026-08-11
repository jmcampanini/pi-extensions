# Auto Compact

Requests Pi's standard compaction when context usage reaches a per-model threshold derived from the model's context window size. Models are matched into weight classes, and each class expresses its threshold as either a fixed token count or a percentage of the window.

## Threshold resolution

The active model's `contextWindow` is matched against the ordered `classes` list: the first class with `contextWindow <= windowMax` applies; when none matches, `default` applies. Each class and the default set exactly one of:

- `thresholdTokens`: compact when estimated context tokens reach this count
- `thresholdPercent`: compact when context usage reaches this percentage of the window

Defaults:

```json
{
  "enabled": true,
  "classes": [
    { "windowMax": 300000, "thresholdPercent": 90 },
    { "windowMax": 500000, "thresholdPercent": 70 }
  ],
  "default": { "thresholdTokens": 400000 }
}
```

Effect of the defaults across common context windows:

| Context window | Compacts at | Rule |
| --- | --- | --- |
| 128k | — (native compacts at ~112k first) | 90% class, unreachable |
| 200k | 180k | 90% class |
| 272k | 244.8k | 90% class |
| 372k | 260.4k | 70% class |
| 400k | 280k | 70% class |
| 1M+ | 400k | default |

## Interplay with Pi's native compaction

Pi's native compaction fires between turns once context tokens exceed `contextWindow - 16384` (`compaction.reserveTokens` in Pi's settings). A class threshold at or past that point can never fire first: the extension posts a one-time warning per model when that model becomes active and leaves compaction to Pi. The adaptive-footer `compact @` chip always shows the effective compaction point — the lower of the class threshold and the native point.

## When compaction runs

The threshold is evaluated at `agent_settled`, after the current agent workflow and all automatic retries, native compaction, queued steering messages, and follow-up messages have finished. Auto Compact does not interrupt an active tool-driven workflow or evaluate the threshold after each turn.

The extension observes `agent_end` only to detect an aborted run. If the run was aborted, threshold compaction is deferred until the next completed workflow. Pi's native compaction and overflow recovery remain independent backstops during agent operation.

Unknown context usage never triggers compaction. A compaction already in progress is not duplicated. After a threshold compaction failure, further attempts are disabled until a successful compaction or model switch prevents a retry loop.

## Configuration

Override the defaults in `~/.pi/agent/autocompact.json`. When `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead. A partial file merges with the defaults key-by-key; setting `classes` replaces the whole list.

Validation is strict: unknown keys are rejected, `windowMax` values must be positive integers in strictly ascending order, `thresholdTokens` must be a positive integer, `thresholdPercent` an integer from `1` through `100`, and every class (and the default) must set exactly one of the two. `classes` may be `[]` to apply the default threshold to every model.

Environment variable override:

- `PI_AUTO_COMPACT_ENABLED`: `true` or `false`
