# PLAN — Launch subagent panes with the command directly (issue #60)

Decision record from the design interview (2026-07-19). Every choice here was resolved
with the user or verified empirically on this machine (tmux 3.7b, fish as default shell);
nothing below is open. Full interview trail: issue #60, comment of 2026-07-19.

## Problem

Spawn and resume open a pane running the user's interactive shell, sleep
`shellReadyDelayMs` (default 500ms), then type `bash '<script>'` into it with send-keys.
The sleep is a timing heuristic against shell init swallowing typed input; a slow init can
still lose the launch, and every launch pays 500ms — compounding under the concurrency
queue. Goal: delete the timing-fragility class entirely by passing the launch command at
pane creation, so there is no typed input to race.

## Decisions

1. **Pane command is passed argv-style, and the argv is `bash <scriptPath>`.**
   tmux execs a multi-argument command directly; a single-string command is parsed by
   `default-shell` (the user's shell — arbitrary syntax). We therefore never pass a single
   string. The original proposal's `"$SHELL" -lc 'exec bash <script>'` wrapper is rejected
   wholesale: the shell children launch under is *specified* (bash), not inherited from
   the user's login shell.

2. **No login wrapper.** Children inherit the tmux *server* environment verbatim. The
   de-facto "interactive shell init repairs the env" behavior is consciously dropped;
   the README documents that `pi` (and external harness binaries) must be on the tmux
   server's PATH.

3. **The staged launch script keeps its pane alive: its first line sets its own pane's
   `remain-on-exit`**, guarded by a pane-env marker so hand re-runs of the script (a
   documented debugging move) cannot flip the option on a developer's own pane:

   ```
   pane created with:  split-window/new-window -d -e PI_SUBAGENT_LAUNCH=1 -- bash <scriptPath>
   script line 1:      if [ "$PI_SUBAGENT_LAUNCH" = "1" ]; then '<tmux-path>' set-option -p -t "$TMUX_PANE" remain-on-exit on; fi
   ```

   The tmux binary path is resolved by the parent when it writes the script. Script-side
   (not parent-side) because bare bash makes fast failures real: a vanished cwd or
   `pi: command not found` kills the pane in ~10ms, beating the parent's `set-option`
   round trip (~25ms measured). Line 1 is race-free for every failure after bash starts;
   if bash itself never starts, nothing ran and the generic pane-closed error is accurate.

4. **Exit detection is untouched.** The sidecar → screen-sentinel → pane-gone-with-grace
   priority, the watcher, `pollForExit`, and `closePane` all stay as they are. Verified:
   with `remain-on-exit on`, dead panes stay readable by `capture-pane` (including
   scrollback, which `readScreen` uses) and killable by `kill-pane`. The quote-split
   sentinel echo stays (it still protects hand re-runs typed into a shell).
   `remain-on-exit failed` was considered and rejected: an exit-0 child with no sidecar
   (a human quitting an interactive child normally) would lose its pane before the poll
   reads the sentinel. Replacing the sentinel with `#{pane_dead_status}` is follow-up #66,
   explicitly out of scope here.

5. **Clean break on the timing config** (session mode: clean break). Delete the sleep,
   the `shellReadyDelayMs` key + validator + tests, and `PI_SUBAGENT_SHELL_READY_DELAY_MS`.
   No aliases, no tolerated no-op key. The config loader's unknown-key rejection is the
   loud migration signal for file users; unknown env vars are inert by design of the env
   layer.

6. **The typing helpers die.** `sendCommand` and `sendLongCommand` have no callers outside
   the two launch pipelines and are deleted. Script staging (writing the script under the
   session's artifacts for debuggability) survives as its own helper; the launch pipelines
   hand the staged script's path to pane creation instead of typing anything.

7. **Boundary guards stay, recast as defensive assertions.** With the sleep gone,
   `runResumeLaunch` has zero awaits and `runSpawnLaunch` awaits only worktree creation,
   so the pre-send `assertLaunchStillWanted` can no longer witness a mid-pipeline
   interleave. Keep one guard per pipeline at the pane-creation boundary anyway — it is a
   free assertion that catches a future refactor inserting an await upstream — and rewrite
   its comment (and capacity.ts's "the sleep is the last interleave point" narrative) to
   say exactly that. Code enforcing the invariant beats comments describing it.

## Contracts and surface area

What changes, and the contract each surface must uphold:

- **`tmux.ts`** — `createPane` grows the launch-script parameter and owns the argv +
  `-e PI_SUBAGENT_LAUNCH=1` shape for all three layouts (window / main / off).
  `sendCommand`/`sendLongCommand` deleted; a staging helper writes the script. The
  `sleep` helper stays (the poller uses it); its "shared by the launch flow" comment
  tail goes. Contract: the pane command is *always* multi-argument — never a single
  string, or the user's default shell parses it.
- **`tool-spawn.ts` / `tool-resume.ts`** — drop the sleep, stage the script, pass its path
  to `createPane`. Contract: the launch command string itself (env prefix, cd, pi/claude
  flags, sentinel suffix) is byte-identical to today; only its delivery changes.
- **`launch.ts` / `harnesses.ts` / `protocol.ts` / `watcher.ts` / `implant.ts`** — no
  behavioral changes. The parent↔child protocol (env vars, `.exit` sidecar, sentinel) is
  untouched.
- **`config.ts`** — key, validator, env-var handling, and the `SubagentsConfig` field
  removed.
- **`README.md`** — config-table row removed; add the server-PATH note from decision 2.
- **Comments** — capacity.ts and both pipelines' interleave narratives updated per
  decision 7.

## Breaking change & migration

- Commit body declares `Manual update steps: required`, why, and one `sh` block that
  removes `shellReadyDelayMs` from `subagents.json` (only post-update, pre-`just all`
  actions).
- This machine specifically: `~/.pi/agent/subagents.json` sets `shellReadyDelayMs: 500`
  and is managed from the `~/.files/main` dotfiles. Remove it there and run `just sync`
  or `just overlay` (whichever that repo uses for this file) as part of the change —
  otherwise the extension refuses to load at the next `/reload`.

## Verified facts (do not re-derive)

- Single-string pane commands are parsed by `default-shell`; fish errors on POSIX-only
  syntax. Multi-argument commands are exec'd directly; supported since tmux 2.0.
- `split-window`+`set-option` round trip: ~25ms. Bare-bash fast failure to pane death:
  ~10ms. This gap is why the remain-on-exit set is script-side.
- Dead panes (remain-on-exit) are readable via `capture-pane -S` and killable; the
  "Pane is dead" banner appears in captured content but cannot match `SENTINEL_REGEX`.
- This machine's tmux server PATH already carries `~/.local/bin` (pi, claude) and
  `/opt/homebrew/bin` (node, tmux).
- A pane whose script starts but never emits the sentinel parks as a dead pane and hits
  the existing stall-steer machinery — the same class as today's lost-typing failure,
  not a new hang. If bash itself never starts, the pane closes and the existing generic
  pane-closed error is accurate.

## Verification (the plan must end agent-verified)

1. **Unit** — delete the `shellReadyDelayMs` rows from config-test (unknown-key rejection
   now covers the old key); keep launch-test's command-byte assertions; assert the staged
   script's shape (guarded remain-on-exit line 1 with resolved tmux path, then command +
   sentinel suffix).
2. **New tmux-layer test in `make test`** — isolated `tmux -L` server + stand-in `pi`,
   driving the real pane-creation code: sentinel readable on the dead pane,
   remain-on-exit effective, a fast crash still yields its exit code, `kill-pane` cleans
   up. Skips gracefully when tmux is absent.
3. **Live agent-verified smoke** — isolated `PI_CODING_AGENT_DIR` (auth/models copied,
   packages-free, per the established smoke-test pattern), scratch tmux session: spawn a
   fresh pi child, resume it with a follow-up, spawn a claude-code child on a cheap model
   (Haiku); each result must steer back, with zero sleeps in the launch path.

## Out of scope

- #66 — replace the screen-sentinel crash net with `#{pane_dead_status}` (filed, has the
  full rationale and requirements).
- Any change to exit detection, the watcher, liveness, or the concurrency queue beyond
  the comment updates named above.
