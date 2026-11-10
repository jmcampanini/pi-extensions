# codex-web-search

Adds a `web_search` tool that runs a `codex exec` web search and returns the fetched source data under `## Answer` and `## Sources`. The answer includes the relevant data inline, so the calling model can answer without fetching the same sources again. This is the Pi version of the `codex-web-search` Claude Code plugin in `claude-code-mods-work`.


## Inputs

- `query`: what to search for.
- `extract` (optional): the subset or shape to return, such as "just the version numbers".
- `effort` (optional): Codex reasoning effort, one of `low`, `medium`, `high`, `xhigh`. Defaults to `medium`.


## How it runs

Each call runs `codex exec` with GPT-6 Luna (`gpt-6-luna`) in Fast mode, a `workspace-write` sandbox with network access, and `approval_policy="never"`, in the session's working directory. A search times out after 10 minutes, and Esc cancels it.

The tool saves the prompt and Codex's final message under `.codex-web-search/` in the working directory as `<yymmddhhmmss>-<random>-prompt.md` and `-response.md`. The tool result starts with `Saved path:` and the response file's path. Answers over 2000 lines or 50KB are truncated in the tool result; the saved file keeps the full answer.


## GitHub issue and pull request lookups

The tool refuses a query for a specific GitHub issue or pull request and tells the model to use `gh` instead. It matches an issues or pull URL with a number, `owner/repo#123`, `issue #123`, and `issue 4744` (four or more digits, so `issue 404` still searches).

To search anyway, include `force-web` as a word in your prompt. The override lasts until Pi delivers your next prompt to the model, so a prompt you queue while Pi is working takes effect only when its turn starts. The tool removes `force-web` from the query before searching. Only prompts typed in Pi or sent over RPC, which is how T3 Code sends them, count; messages sent by extensions reset the override.


## Configuration

None. `codex` must be on `PATH` and signed in with access to `gpt-6-luna`.


## Limits

- The model and Codex flags are fixed in code.
- A [subagent](../subagent/README.md) child receives its task as an interactive prompt, so a task that contains `force-web` turns the override on in that child.
- Add `.codex-web-search/` to a project's `.gitignore` to keep the saved files out of commits.
