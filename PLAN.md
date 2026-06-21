# fast-openai PLAN

## Purpose

Define a minimal Pi extension for enabling OpenAI Codex Fast mode through a simple provider-request payload hook, while keeping behavior explicit, conservative, config-driven, and easy to reason about.

## Extension Layout

Follow the existing repo package pattern:

```text
fast-openai/
  index.ts
```

The repo `package.json` already loads extensions via:

```json
{
  "pi": {
    "extensions": ["./*/index.ts"]
  }
}
```

So `fast-openai/index.ts` is discovered like the existing sibling extensions.

## Core Behavior

Fast mode is a single global on/off setting. It only injects OpenAI Codex priority service tier for a narrow, conservative set of eligible requests.

No footer/status display. No bare `/fast` toggle.

Runtime rule:

```text
config.enabled === true
AND model.provider is listed in config.providers
AND model.provider === "openai-codex"
AND model.api === "openai-codex-responses"
AND model.id is "gpt-5.4" or "gpt-5.5"
AND modelRegistry reports OAuth/ChatGPT auth for the model
AND provider request payload is an object
AND payload does not already contain service_tier
AND payload.model is absent or matches the current model id
→ inject service_tier: "priority"

otherwise
→ leave payload unchanged
```

When fast mode is off, omit `service_tier` entirely. Do not send `service_tier: "default"`.

## Config

Use a dedicated extension config file:

```text
~/.pi/agent/extensions/fast-openai.json
```

Missing config means fast mode is disabled.

Effective default when the config file is absent or invalid:

```json
{
  "enabled": false,
  "providers": ["openai-codex"]
}
```

Persisted config shape:

```json
{
  "enabled": false,
  "providers": ["openai-codex"]
}
```

`providers` contains Pi model provider IDs, not API handler names. In this conservative version, only `openai-codex` can actually inject priority.

## Commands

Register only:

```text
/fast on
/fast off
/fast status
```

No bare `/fast` toggle.

Command behavior:

- `/fast on`
  - write config with `enabled: true`
  - preserve existing provider list if valid; otherwise use default providers
- `/fast off`
  - write config with `enabled: false`
  - preserve existing provider list if valid; otherwise use default providers
- `/fast status`
  - show current effective config
  - show conservative eligibility checks for the current model/provider/auth state
  - warn that raw `service_tier` injection may not apply Pi's native priority cost multiplier
- any other args, including empty args
  - show usage/help and do not change config

## Provider Request Hook

Use Pi's `before_provider_request` hook and inject OpenAI's wire-level payload field:

```ts
service_tier: "priority"
```

Why this approach:

- It is simpler than provider registry wrapping.
- It avoids the lazy-provider capture/cold-start race that can happen with wrapper-based delegation.
- It matches the common public Pi extension pattern for Fast mode/service-tier extensions.

## Cost Accounting

Raw payload injection may not trigger Pi-AI's internal service-tier cost multiplier, because installed Pi-AI applies that multiplier from native `serviceTier` stream options.

The extension intentionally does not patch usage or rewrite costs. `/fast status` surfaces this warning instead.

Observed installed Pi-AI native behavior, for context:

```text
priority: 2x cost for most models
priority: 2.5x cost for gpt-5.5
flex:     0.5x cost
other:    1x cost
```

This implementation only injects:

```ts
service_tier: "priority"
```

No custom cost rewriting should be added.

## UI / Status

No automatic footer/status UI.

Do not call:

```ts
ctx.ui.setStatus(...)
```

The only user-visible state display is `/fast status`.

## Expected Implementation Shape

`fast-openai/index.ts` should contain:

- config types and constants
- config path resolution using the Pi agent config dir
- config load with default fallback
- config save for `/fast on/off`
- strict Codex eligibility helpers
- command parser for exactly `on`, `off`, `status`
- `before_provider_request` handler that returns a copied payload with `service_tier: "priority"` only when eligible

Each request should reload/read config near request time so `/fast on/off` affects subsequent requests without requiring `/reload`.

## Non-Goals

- No native provider wrapping in v1 of this simplified implementation.
- No footer/status indicator.
- No bare `/fast` toggle.
- No support for regular `openai` provider requests.
- No support for API-key OpenAI Codex requests.
- No support for models other than `gpt-5.4` and `gpt-5.5`.
- No support for `openai-completions`.
- No Azure OpenAI support.
- No multiple service tiers in v1.
- No custom cost calculation or message usage rewriting.

## Source-Resolved Decisions

- We used this repo's `package.json` to answer extension layout: use `<dir>/index.ts`, specifically `fast-openai/index.ts`.
- We used existing `fast-openai/index.ts` to answer command/config conventions: keep `/fast on`, `/fast off`, `/fast status`, `~/.pi/agent/extensions/fast-openai.json`, and default providers `['openai-codex']`.
- We used installed Pi extension type definitions and public implementations to answer hook mechanics: use `before_provider_request` to replace the outgoing payload.
- We used `diegopetrucci/pi-extensions/extensions/openai-fast/index.ts` to answer conservative eligibility checks: Codex provider/API, exact model IDs, OAuth auth, payload object, no existing `service_tier`, and payload model matching.
- We used installed Pi-AI source to answer cost-accounting trade-off: native `serviceTier` options apply priority cost multipliers, while raw payload injection may not.
- We used the decision workflow to answer whether to keep broader provider support: no, implement literal strict Codex-only checks.
- We used the decision workflow to answer how to handle cost accounting: do not patch costs; warn in `/fast status` and document the trade-off in code comments.

## Open Questions

None required before implementation.
