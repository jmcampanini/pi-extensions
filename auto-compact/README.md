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
| 128k | 115.2k | 90% class |
| 200k | 180k | 90% class |
| 272k | 244.8k | 90% class |
| 372k | 260.4k | 70% class |
| 400k | 280k | 70% class |
| 1M+ | 400k | default |

## Interplay with Pi's native compaction

Pi performs its native compaction check before the extension evaluates usage at `agent_settled`. Native compaction can be disabled and its reserved-token setting is configurable, but those effective settings are not exposed to extensions. Auto Compact therefore does not predict Pi's threshold: when native compaction runs, the resulting unknown or reduced usage prevents a duplicate request; when usage remains at or above the configured Auto Compact threshold, the extension compacts it.

When Pi reports an actual native threshold compaction, the extension posts a one-time warning for that model. A single large run can cross both thresholds, so repeated warnings—not one occurrence—suggest that the configured threshold is at or past Pi's native point. The adaptive-footer `compact @` chip and context color bands show the configured Auto Compact threshold; Pi may compact earlier according to its own settings.

## When compaction runs

The threshold is evaluated at `agent_settled`, after the current agent workflow and all automatic retries, native compaction, queued steering messages, and follow-up messages have finished. Auto Compact does not interrupt an active tool-driven workflow or evaluate the threshold after each turn.

The extension observes `agent_end` only to detect an aborted run. If the run was aborted, threshold compaction is deferred until the next completed workflow. Pi retains its own native compaction and overflow behavior according to its settings.

Unknown context usage never triggers compaction. A compaction already in progress is not duplicated. After a threshold compaction failure, further attempts are disabled until a successful compaction or model switch prevents a retry loop.

## Configuration

Override the defaults in `~/.pi/agent/autocompact.json`. When `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead. A partial file merges with the defaults key-by-key; setting `classes` replaces the whole list.

Validation is strict: unknown keys are rejected, `windowMax` values must be positive integers in strictly ascending order, `thresholdTokens` must be a positive integer, `thresholdPercent` an integer from `1` through `100`, and every class (and the default) must set exactly one of the two. `classes` may be `[]` to apply the default threshold to every model.

Environment variable override:

- `PI_AUTO_COMPACT_ENABLED`: `true` or `false`
