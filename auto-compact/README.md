# Auto Compact

Requests Pi's standard compaction after a completed workflow if known context usage is at or above the configured threshold. The model's context window size selects a threshold expressed as either a fixed token count or a percentage of the window.

## Threshold resolution

The active model's `contextWindow` is matched against the ordered `classes` list. The first class with `contextWindow <= windowMax` applies; when none matches, `default` applies. `windowMax` selects models by their full context window size. Each class and the default set exactly one threshold for current context usage:

- `thresholdTokens`: a fixed token count
- `thresholdPercent`: a percentage of the context window, converted to a token count and rounded to the nearest integer

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

The defaults apply to these context window ranges:

| Model context window | Configured compaction threshold |
| --- | --- |
| Up to and including 300k | 90% of the window |
| Above 300k, up to and including 500k | 70% of the window |
| Above 500k | 400k tokens |

The fixed 400k threshold applies to every window above 500k. A model with a 400k window instead matches the 70% class, giving a 280k threshold. A model with a 1M window uses the 400k default, equivalent to 40% of its window.

Configured thresholds for example windows:

| Context window | Configured threshold | Rule |
| --- | --- | --- |
| 128k | 115.2k | 90% class |
| 200k | 180k | 90% class |
| 272k | 244.8k | 90% class |
| 372k | 260.4k | 70% class |
| 400k | 280k | 70% class |
| 500k | 350k | 70% class |
| 512k | 400k | default |
| 1M | 400k | default |

The extension checks these thresholds after the workflow settles, so a workflow can cross its threshold before compaction begins.

## Interplay with Pi's native compaction

Pi performs its native compaction check before the extension evaluates usage at `agent_settled`. Native compaction can be disabled and its reserved-token setting is configurable, but those effective settings are not exposed to extensions. Auto Compact therefore does not predict Pi's threshold. At settlement, unknown usage or usage below the Auto Compact threshold prevents another request. If known usage remains at or above that threshold, the extension can still request compaction under the conditions described below.

When Pi reports an actual native threshold compaction, the extension warns at most once per provider/model pair while the extension is loaded. Switching models does not reset that warning history. A single large run can cross both thresholds, so one warning does not establish that the configured threshold is at or past Pi's native point.

The adaptive-footer `compact @` chip shows the configured Auto Compact threshold followed by current progress toward it, and its context color bands also follow that target. Pi may compact earlier according to its own settings.

## When compaction runs

The threshold is evaluated at `agent_settled`, after the current agent workflow and all automatic retries, native compaction, queued steering messages, and follow-up messages have finished. Auto Compact does not interrupt an active tool-driven workflow or evaluate the threshold after each turn.

The extension observes `agent_end` only to detect an aborted run. If the run was aborted, threshold compaction is deferred until the next completed workflow. Pi retains its own native compaction and overflow behavior according to its settings.

Unknown context usage never triggers compaction. A compaction already in progress is not duplicated. After a threshold compaction failure, further attempts are disabled until a successful compaction or model switch prevents a retry loop. Cancelling an in-progress auto-compaction engages the same latch - reported as an informational pause rather than an error - so a declined compaction is not immediately re-requested. While the latch is engaged, the extension publishes an `auto-compact` status entry, which the adaptive-footer compact chip renders as paused.

## Configuration

Override the defaults in `~/.pi/agent/autocompact.json`. When `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead. A partial file merges with the defaults key-by-key; setting `classes` replaces the whole list.

Validation is strict: unknown keys are rejected, `windowMax` values must be positive integers in strictly ascending order, `thresholdTokens` must be a positive integer, `thresholdPercent` an integer from `1` through `100`, and every class (and the default) must set exactly one of the two. `classes` may be `[]` to apply the default threshold to every model.

Environment variable override:

- `PI_AUTO_COMPACT_ENABLED`: `true` or `false`
