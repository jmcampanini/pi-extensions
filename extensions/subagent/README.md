# subagent

Delegate a task to a separate Pi agent session that runs inside the same Pi process. The child has its own context window and its own session file, and uses your normal tools, skills, extensions, and project instructions for the directory it runs in. Children also get `codemode` (active), `tool_search`, and your `mcp.json` servers, the same built-ins the Pi CLI loads. Pi runs at most two codemode workers per process, so a parent and several children all using codemode take turns.

## Tool

The extension registers one tool, `subagent`.

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `task` | string | required | The child's brief. Its only user message. |
| `title` | string | first line of `task` | Label in the footer, `/subagents`, and the worktree name. |
| `mode` | `background`, `foreground` | `background` | Background returns at once; the result arrives later as a user message that starts with `Subagent "<title>" completed`. Foreground blocks until the child finishes. |
| `context` | `fresh`, `fork` | `fresh` | Fork copies the parent's conversation into the child before the task. |
| `cwd` | path | the parent's cwd | Directory the child runs in. |
| `isolation` | `none`, `worktree` | `none` | Worktree runs `git worktree add -b pi/<slug> <path> <from>` in the repo containing `cwd` and runs the child there. The worktree is left in place. |
| `from` | git ref | `HEAD` | Start point for the worktree branch. |
| `model` | `provider/id`, id, or unique substring | the parent's model | Scoped models (`enabledModels`) are matched first, then every model with credentials. |
| `effort` | `off` … `max` | the parent's thinking level | Clamped to the chosen model. |

A background child that finishes while the parent is streaming is delivered as a steering message; when the parent is idle it starts a new turn.

## Command and footer

`/subagents` lists every child started in this session and offers to cancel a running one. The footer shows how many children are running.

## Settings

Under a `subagent` key in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "subagent": {
    "worktreePath": "~/.pi/worktrees/{repo}/{slug}",
    "resultMaxChars": 50000,
    "resultMaxLines": 2000
  }
}
```

`worktreePath` accepts `~`, `$VAR`, `${VAR}`, and the placeholders `{repo}` (directory name), `{repoPath}`, `{host}`, `{owner}` (from the `origin` remote), `{slug}`, and `{branch}`. An unset variable or a relative result fails the call. Results longer than the limits are cut, and the child session file is named so the rest can be read.

## Development

```sh
npm install          # dev dependencies only; peer packages come from the installed Pi
npm run link-pi      # symlink the installed Pi packages for typechecking and tests
npm run typecheck
npm test
pi -e ./extensions/subagent
```
