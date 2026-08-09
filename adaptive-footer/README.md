# Adaptive footer

The first footer row shows repository context:

```text
cwd • session                                    issue • PR • branch
```

Issue and pull-request labels are OSC 8 links when the terminal supports them. Full labels include state, such as `is#456 o` and `pr#123 m`; constrained layouts use `i456` and `p123` before dropping remote links.

PR states are `o` (open), `d` (draft), `c` (closed), and `m` (merged). Issue states are `o` (open) and `c` (closed).

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
