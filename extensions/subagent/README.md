# subagent

Delegate a task to a separate Pi agent session that runs inside the same Pi process. The child has its own context window and its own session file. It loads the extensions, skills, and project instructions for the directory it runs in, mirrors the parent's `-e` and `--no-extensions` flags, and declares exactly the parent's active tools minus `subagent`, so a child never has more than its parent (codemode and MCP tools included). Pi's built-in codemode, tool search, and MCP extensions are loaded the way the CLI loads them, so `-builtin:<name>` and replacement extensions apply to children too. Pi runs at most two codemode workers per process, so a parent and several children all using codemode take turns.

Tested against Pi 1.4.0.

## Tool

The extension registers one tool, `subagent`, declared to the model only (codemode scripts cannot call it).

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `task` | string | required | The child's brief. Its only user message. |
| `title` | string | first line of `task` | Label in the footer, `/subagents`, and the worktree name. |
| `mode` | `background`, `foreground` | `background` | Background returns at once; the result arrives later as a user message beginning `Subagent "<title>"`. Foreground blocks until the child finishes. |
| `context` | `fresh`, `fork` | `fresh` | Fork continues the parent's current branch: Pi copies it into the child's session file, and every pending tool call of the delegating message gets a result that explains the fork. |
| `cwd` | path | the parent's cwd | Directory the child runs in. |
| `isolation` | `none`, `worktree` | `none` | Worktree runs `git worktree add -b <branch> <path> <from>` in the repo containing `cwd` and runs the child there. The worktree is left in place. |
| `from` | git ref | `HEAD` | Start point for the worktree branch. |
| `model` | `provider/id`, id, or unique substring | the parent's model | Scoped models (`enabledModels`) are matched first, then every model with credentials. |
| `effort` | `off` … `max` | the parent's thinking level | Clamped to the chosen model. |

Background reports are queued as steering messages: when the parent is idle one starts a new turn, when a turn is running it is injected at the next tool boundary, and reports that finish together arrive in one message. While Pi compacts it accepts no prompts, so reports wait and are retried; after five minutes of waiting they are parked for the next turn and a notice says so.

A child in the parent's project, or in a worktree created from it, inherits the parent's project trust. A child elsewhere follows the trust decision stored for that directory, and is trusted only when nothing there needs trust.

## Command and footer

`/subagents` lists every child started in this session with its id, model, elapsed time, and latest progress. Pick a running child to cancel it, or a finished one to read its report. The footer shows how many children are running. Starting a new session, resuming another, reloading, or quitting cancels running children and says which ones.

## Settings

Under a `subagent` key in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "subagent": {
    "worktreePath": "~/.pi/worktrees/{repo}/{slug}",
    "worktreeBranch": "pi/{slug}",
    "resultMaxChars": 50000,
    "resultMaxLines": 2000
  }
}
```

`worktreePath` accepts `~`, `$VAR`, `${VAR}`, and the placeholders `{repo}` (directory name), `{repoPath}`, `{host}`, `{owner}` (from the `origin` remote), `{slug}`, and `{branch}`. An unset variable or a relative result fails the call. `worktreeBranch` accepts the same placeholders except `{branch}`; when the name is taken, `-2`, `-3`, and so on are appended to the slug. Results longer than the limits are cut, and the child session file is named so the rest can be read.

## Development

```sh
npm install          # dev dependencies only; peer packages come from the installed Pi
npm run link-pi      # symlink the installed Pi packages for typechecking and tests
npm run typecheck
npm test
pi -e ./extensions/subagent
```
