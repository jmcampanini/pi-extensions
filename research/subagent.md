# Pi Subagents Research

Date: 2026-06-02

## Executive Summary

Pi does **not** currently treat subagents as a built-in core primitive. Pi’s design keeps the core small and expects subagent workflows to be implemented through extensions, custom tools, SDK sessions, subprocesses, RPC, packages, skills, and prompt templates.

The most common implementation pattern is:

1. Parent Pi session exposes a `subagent`/`Agent`/`delegate` tool.
2. The parent model calls that tool.
3. The tool launches or creates a child agent/session.
4. The child works in isolated context.
5. The parent receives a summary, result, artifact path, child session path, or status handle.

The current best general-purpose package appears to be **`pi-subagents` by nicobailon/nicopreme**, because it has the strongest public adoption signals and the richest workflow surface: chains, parallel runs, background runs, resume/status controls, worktree isolation, built-in agents, skills, prompt shortcuts, and saved workflows.

## Main Subagent Mechanisms

### 1. SDK In-Process Child Session

Use `createAgentSession()` from `@earendil-works/pi-coding-agent` inside a custom Node/TypeScript app or custom tool.

Typical shape:

```ts
const { session: child } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
  tools: ["read", "grep", "find", "ls"],
});

await child.prompt("Do this focused delegated task...");
```

Best for:

- embedding Pi in a Node/TypeScript app
- type-safe orchestration
- disposable child runs
- custom models/tools/context per child

Tradeoff:

- less process isolation than subprocess mode
- you must manage event subscriptions and output capture yourself

### 2. Extension Tool Spawning a Child Agent

Pi extensions can register tools with `pi.registerTool()`. A parent model can call that tool, and the tool can run child agents.

This is the main Pi-native pattern.

```ts
pi.registerTool({
  name: "subagent",
  label: "Subagent",
  description: "Delegate work to a focused child agent.",
  parameters: SubagentParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    // create SDK child, spawn subprocess, or call RPC child
  },
});
```

Best for:

- normal interactive Pi workflows
- LLM-callable delegation
- reusable package distribution

### 3. Subprocess Child Pi

The official Pi subagent example uses this subprocess shape:

```ts
["--mode", "json", "-p", "--no-session"]
```

Meaning:

- `--mode json`: child emits JSONL events
- `-p`: one-shot print mode
- `--no-session`: disposable child; no persisted `.jsonl` session

The parent extension parses child JSON events, accumulates messages, usage, tool calls, errors, and final output, then returns a result to the parent model.

Best for:

- isolated context windows
- isolated process state
- parallel children
- consuming structured child events

Tradeoff:

- if `--no-session` is used, the child cannot be resumed later

### 4. RPC Child Pi

Use:

```sh
pi --mode rpc --no-session
```

RPC mode uses JSONL commands over stdin/stdout. It is better for a long-lived external host or IDE-like integration.

Best for:

- long-lived child agents
- external orchestrators
- custom UIs
- persistent control channel

### 5. Pi Package

Pi packages bundle extensions, skills, prompt templates, and themes.

Example:

```sh
pi install npm:pi-subagents
```

Package manifest example:

```json
{
  "pi": {
    "extensions": ["./src/extension/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

Best for sharing subagent systems with a team or the public.

### 6. Prompt Template Orchestration

Prompt templates can instruct the parent model to call the subagent tool in a known workflow.

Examples from the official subagent example:

- `/implement`: scout → planner → worker
- `/scout-and-plan`: scout → planner
- `/implement-and-review`: worker → reviewer → worker

This is a lightweight way to encode reusable workflows on top of a subagent tool.

### 7. Session Fork/Handoff

A child can be created as a fork/clone/new session rather than fresh context.

Useful when:

- child needs parent context
- child should become a primary session later
- child work should be separately resumable

Relevant APIs:

- `SessionManager.create(..., { parentSession })`
- `SessionManager.forkFrom(...)`
- `ctx.newSession({ parentSession, setup, withSession })`
- `ctx.switchSession(childSessionFile, { withSession })`
- `AgentSessionRuntime.fork(...)`
- `AgentSessionRuntime.switchSession(...)`

## Session Tree Behavior

Pi session files are JSONL files with a tree structure. Entries have:

```ts
id: string
parentId: string | null
```

The `/tree` command only shows the tree for the **current session file**.

### Do subagents show up in the current `/tree`?

Usually **no**, not as real child tree nodes.

With the official subprocess subagent example, the parent session tree sees:

```text
assistant -> toolCall(subagent) -> toolResult(summary/details)
```

The child’s internal assistant/tool/user turns are not grafted into the parent `/tree`.

### Where child history can live

| Mechanism | Child history location | Visible in parent `/tree`? |
|---|---|---:|
| Official `--no-session` child | not persisted; maybe stored in tool details | partially |
| SDK in-memory child | memory only | no |
| Persistent child session | separate `.jsonl` file | no |
| Forked child session | separate `.jsonl` file copied/forked from parent branch | no |
| Same current session | current parent branch | yes, but not isolated |
| Manually grafted custom entries | parent session file | possible, custom/unsupported |

### Can multiple agents share the same session tree?

Technically, multiple actors could append to the same `SessionManager`, but it is not a first-class safe pattern.

Risks:

- active leaf pointer races
- parent/child agent state divergence
- interleaved tool/message writes
- confusing branch semantics
- hard-to-reason context reconstruction

Recommended pattern: keep child sessions separate and put a compact result/link/handoff in the parent tree.

## Linked Child Sessions

A “linked session” means a child session file records its parent in the session header:

```json
{
  "type": "session",
  "version": 3,
  "id": "child-session-id",
  "timestamp": "...",
  "cwd": "/repo",
  "parentSession": "/path/to/parent-session.jsonl"
}
```

This is lineage metadata. It does **not** merge trees or automatically include parent context.

A parent can also store the child path in the parent tool result:

```ts
return {
  content: [{ type: "text", text: `Child session: ${child.sessionFile}\n\n${summary}` }],
  details: {
    childSession: child.sessionFile,
    parentSession: parent.sessionFile,
  },
};
```

The model is:

```text
Parent session tree
  └─ assistant calls subagent tool
      └─ tool result includes child session path + summary

Child session file
  └─ header.parentSession = parent session path
  └─ full child conversation/tree
```

### Continuing a child as the primary session

If the child has a persisted session file, an extension command can switch the UI into that child session:

```ts
await ctx.switchSession(childSessionFile, {
  withSession: async (newCtx) => {
    await newCtx.sendUserMessage("Continue this child session as the primary session.");
  },
});
```

Or create a new primary session seeded from a child handoff:

```ts
await ctx.newSession({
  parentSession: parentSessionFile,
  setup: async (sm) => {
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: childHandoff }],
      timestamp: Date.now(),
    });
  },
});
```

Important: after `ctx.newSession()`, `ctx.switchSession()`, or `ctx.fork()`, use only the `ctx` passed to `withSession`. Old captured session-bound objects are stale.

## Visible / Resumable / Rehydratable Subagents

### Official Pi subagent example

- visible as parent tool result and TUI expanded output
- streams progress/tool calls
- tracks child usage
- uses `--no-session`
- not resumable by default
- no child session file

### `pi-subagents`

Supports:

- foreground runs
- background runs
- status
- interrupt
- resume
- chains
- parallel runs
- saved workflows
- worktree isolation
- optional forked context
- child artifacts/session handling

Background runs can be checked by ID. Completed async children may be resumed by starting a new async child from stored session state rather than reviving the same OS process.

### `@tintinweb/pi-subagents`

Exposes Claude Code-style tools:

```ts
Agent(...)
get_subagent_result(...)
steer_subagent(...)
```

Supports:

- background agents
- `get_subagent_result({ wait, verbose })`
- mid-run steering
- resume by previous agent ID
- live widget
- scheduling
- persistent memory concepts
- worktree isolation
- lifecycle events

Resume example:

```ts
Agent({
  subagent_type: "general-purpose",
  prompt: "Continue where you left off and finish the remaining work.",
  resume: "agent-id-here",
});
```

### `oira666_pi-subagent`

Clearest researched example of rehydration.

Reported behavior:

- child sessions persisted under `sessions-subagents`
- unfinished subagent calls detected when parent session resumes
- finished subagents reused as completed
- unfinished subagents continue from saved sessions
- nested subagents can resume recursively
- TUI mode can prompt “Resume subagents?”
- non-UI modes can auto-resume

Environment variables mentioned in research:

```sh
PI_SUBAGENT_RESUME_PROMPT=false
PI_SUBAGENT_DISABLE_RESUME=true
```

## Cost and Token Usage

Parent and child usage are separate. A parent model call that invokes a subagent tool does not include the child process’s model usage in the parent assistant message usage.

Total cost should be calculated as:

```text
parent assistant message usage
+ subagent aggregated usage
```

Avoid double-counting nested subagents.

### Official example accounting

The official example parses child `message_end` events and accumulates:

- input tokens
- output tokens
- cache read
- cache write
- cost
- context tokens
- turns
- model

Rendered style:

```text
3 turns ↑12k ↓2k R40k W5k $0.1234 ctx:60k claude-sonnet
```

### `@tintinweb/pi-subagents`

Research found token totals and tool counts, not a documented dollar-cost field.

It uses:

```text
total = input + output + cacheWrite
```

It intentionally excludes `cacheRead` from the lifetime token total because cache-read values may represent cumulative cached prefixes and summing them can overcount.

### `oira666_pi-subagent`

Reported detailed accounting shape:

```ts
interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface UsageTreeNode {
  agent: string;
  task: string;
  ownUsage: UsageStats;
  aggregatedUsage: UsageStats;
  children: UsageTreeNode[];
}
```

Key distinction:

```text
SingleResult.usage = that agent’s own work only
aggregatedUsage = that agent plus nested child subagents
```

`contextTokens` is a final context snapshot and should not be summed across agents.

## Most Effective Subagent Types

| Agent | Purpose | Recommended tools |
|---|---|---|
| `scout` / explorer | Fast codebase reconnaissance and compressed handoff | `read`, `grep`, `find`, `ls`, maybe read-only `bash` |
| `planner` | Turn findings into concrete implementation plan | read-only tools |
| `worker` | Implement bounded approved task | edit/write/bash as needed |
| `reviewer` | Independent code review after implementation | read-only tools, maybe read-only `bash` |
| `debugger` | Investigate failing tests/errors and root causes | `read`, `grep`, `find`, `ls`, `bash`, maybe edit |
| `verifier` / test-runner | Run checks and report evidence | `bash`, read tools |
| `security-auditor` | Adversarial review of auth/trust boundaries/secrets/injection | read-only tools |
| `docs-writer` | Update docs from code/context | read/write as needed |
| `refactorer` | Behavior-preserving cleanup | edit/write/bash as needed |
| `oracle` | Critique a plan and challenge assumptions | read-only or no tools |
| `researcher` | Web/docs research | web tool package, read tools |
| `context-builder` | Produce durable handoff docs like `context.md` | read tools, maybe write |

## Recommended Workflows

### Context then implementation

```text
scout -> planner -> worker
```

### Implementation then review loop

```text
worker -> reviewer -> worker
```

### Parallel review

```text
parallel reviewers: correctness + tests + complexity + security
```

### Advisory second opinion

```text
oracle -> worker
```

### Larger feature with worktrees

```text
context-builder/scout -> planner -> parallel worktree-isolated workers -> reviewer
```

## Package Ranking

### 1. `pi-subagents`

Install:

```sh
pi install npm:pi-subagents
```

Why it is first:

- strongest public adoption signals found
- most complete workflow system
- extension + skills + prompts
- natural-language delegation
- `/run`, `/chain`, `/parallel`, `/run-chain`, `/subagents-doctor`
- background/status/resume/interrupt
- worktree isolation
- rich built-in agent set
- prompt shortcuts such as review loops and parallel research

Best for: broad day-to-day subagent workflows.

### 2. `@tintinweb/pi-subagents`

Install:

```sh
pi install npm:@tintinweb/pi-subagents
```

Why it is second:

- strong feature set and adoption
- Claude Code-style API
- `Agent`, `get_subagent_result`, `steer_subagent`
- live widget/status
- scheduling
- steering/resume
- persistent memory concepts
- worktree isolation
- lifecycle events and cross-extension RPC

Best for: Claude Code-style controllable background agents.

### 3. `pi-sub-agent`

Install:

```sh
pi install npm:pi-sub-agent
```

Why it is third:

- simpler and smaller
- much lower adoption signals found
- straightforward subprocess implementation
- single/parallel/chain modes
- security-conscious defaults
- recursion prevention
- bundled practical roles

Best for: minimal isolated delegation without a large orchestration framework.

## Design Recommendations

1. Prefer fresh/spawn context unless the child truly needs parent history.
2. Keep subagents narrow and explicit.
3. Make review/planning/security agents read-only.
4. Use stronger models for planner/reviewer/security; cheaper/faster models for scout.
5. Use worktrees for parallel edit-capable workers.
6. Do not merge child turns into the parent tree by default.
7. Store child session paths, summaries, and artifacts in parent tool result details.
8. If resumability matters, do not use `--no-session`; persist child sessions.
9. For traceability, set `parentSession` in child session headers.
10. Track parent and child cost separately, then aggregate intentionally.
11. Use `aggregatedUsage` for nested subagent trees when available.
12. Treat project-local `.pi/agents` as untrusted repo-controlled prompts unless reviewed.

## Key Sources

Web/package sources:

- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/json
- https://pi.dev/docs/latest/rpc
- https://pi.dev/docs/latest/sessions
- https://pi.dev/docs/latest/session-format
- https://pi.dev/docs/latest/packages
- https://pi.dev/packages/pi-subagents
- https://pi.dev/packages/%40tintinweb/pi-subagents
- https://pi.dev/packages/pi-sub-agent
- https://pi.dev/packages/oira666_pi-subagent
- https://pi.dev/packages/%40mjakl/pi-subagent

Local Pi files inspected:

- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/json.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents.ts`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/README.md`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `/opt/homebrew/Cellar/pi-coding-agent/0.77.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.d.ts`

Saved web-search response files:

- `.codex-web-search/260602222947-traditional-product-discussion-response.md`
- `.codex-web-search/260602222947-pretty-hot-english-major-of-the-year-response.md`
- `.codex-web-search/260602222947-your-precious-highly-academic-associate-vc-response.md`
- `.codex-web-search/260602222947-american-penthouse-suite-response.md`
- `.codex-web-search/260602223235-somewhat-disposable-compiler-flag-response.md`
- `.codex-web-search/260602223235-level-7-angry-bachelor-party-response.md`
- `.codex-web-search/260602223235-drunk-color-scheme-the-vii-response.md`
- `.codex-web-search/260602223235-crypto-dog-response.md`
- `.codex-web-search/260602225018-saturated-cto-response.md`
- `.codex-web-search/260602225018-lawless-structured-logger-response.md`
- `.codex-web-search/260602225018-semi-untalented-sunset-response.md`
- `.codex-web-search/260602225018-customer-centric-baby-response.md`
- `.codex-web-search/260602225422-bsd-based-day-trader-response.md`
- `.codex-web-search/260602225422-fist-of-the-unworthy-emacs-listserv-response.md`
- `.codex-web-search/260602225422-museum-of-the-lost-vacation-response.md`
