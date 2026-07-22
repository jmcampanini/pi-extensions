# Auto Compact

Requests Pi's standard compaction when context usage reaches a configurable percentage of the active model's context window. The default threshold is 70%.

## When compaction runs

The percentage threshold is evaluated at `agent_settled`, after the current agent workflow and all automatic retries, native compaction, queued steering messages, and follow-up messages have finished. Auto Compact does not interrupt an active tool-driven workflow or evaluate the percentage after each turn.

The extension observes `agent_end` only to detect an aborted run. If the run was aborted, percentage compaction is deferred until the next completed workflow. Pi's native compaction and overflow recovery remain independent backstops during agent operation.

Unknown context usage never triggers compaction. A compaction already in progress is not duplicated. After a percentage compaction failure, further percentage attempts are disabled until a successful compaction or model switch prevents a retry loop.

## Configuration

Defaults:

```json
{
  "thresholdPercent": 70,
  "enabled": true
}
```

Override them in `~/.pi/agent/autocompact.json`. When `PI_CODING_AGENT_DIR` is set, the file is read from that directory instead.

Environment variables override the file:

- `PI_AUTO_COMPACT_THRESHOLD_PERCENT`: integer from `1` through `100`
- `PI_AUTO_COMPACT_ENABLED`: `true` or `false`
