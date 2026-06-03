# PLAN

## Purpose

Define a very small first version of a Pi subagent concept. The MVP is intentionally implementation-free at this stage: this document captures the decisions, expectations, and desired outcomes before any code is written.

## Core Concept

A subagent is a foreground child agent run that receives a prompt string, executes that prompt as its own Pi agent session, and returns the child agent's final answer to the parent agent.

The child should start from a fork of the current parent session so it can reuse the relevant conversation context and provider-side cache affinity where possible. The child is not a separate background worker in the MVP; the parent waits for it to finish.

## Decisions

- The MVP subagent is exposed as a model-callable Pi extension tool.
- The tool accepts one primary input: a prompt string.
- The child runs in-process through the Pi SDK, not as a spawned `pi` subprocess.
- The child is a persistent linked fork session, not an ephemeral in-memory run.
- The child is a pure subagent and may use normal available tools.
- The child should inherit the parent session context, cwd, model, thinking level, system context, and active tool shape as closely as practical.
- The child should preserve provider cache affinity with the parent where the SDK/provider supports it.
- Recursive subagents are visible but depth-limited for the MVP: max depth is 1.
- The parent model-visible result is only the child agent's final answer.
- Metadata such as child session path, usage, model, depth, and status belongs in tool details/UI, not in the parent model-visible text.
- Foreground UX is completion-only for the MVP: show a simple running indicator, then the final result.

## Expectations

- The parent agent can call `subagent` when it wants to delegate a focused prompt.
- The child runs immediately and synchronously from the user's perspective.
- The parent session records the subagent call and final result as a normal tool call/result.
- The child session is independently inspectable because it is persisted as its own linked session file.
- The child session records lineage back to the parent session.
- The child should not inherit an unresolved parent `subagent` tool call as part of its context.
- The MVP should favor clear semantics and minimal behavior over orchestration features.
- No background execution, status polling, steering, parallelism, agent roles, or workflow chains are part of this first version.
- No custom child UI beyond a running/completed tool row is required for the MVP.

## Outcomes

- A bare-bones subagent primitive exists and can be exercised from normal Pi sessions.
- The parent can delegate work and receive a concise final answer.
- Child work is traceable through a linked persistent session.
- Cache reuse is preserved as much as practical by using an SDK child and parent-compatible context/cache affinity.
- The design remains easy to grow later into richer subagent behavior.

## Explicit Non-Goals for MVP

- No background subagents.
- No parallel subagent runs.
- No agent role registry.
- No project/user agent definition files.
- No resumability controls beyond having a persisted child session.
- No streaming child transcript into the parent UI.
- No child tool restriction or sandboxing beyond normal Pi behavior.
- No nested subagent recursion beyond a clear max-depth error.

## Future Growth Paths

- Add streaming progress from the child session into the parent tool row.
- Add named agent profiles or roles.
- Add background runs, status checks, and result retrieval.
- Add parallel and chained subagent workflows.
- Add configurable depth limits.
- Add explicit cache strategy controls.
- Add commands for opening or switching to child sessions.
- Add richer rendering of child usage and session metadata.
