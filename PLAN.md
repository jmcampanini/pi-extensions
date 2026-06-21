# fast-openai PLAN

## Purpose

Define a minimal Pi extension for enabling OpenAI/Codex fast mode through Pi's native provider option, while keeping behavior explicit, config-driven, and easy to reason about.

This plan is design-only. Implementation should not add extra UI/status concepts or broader provider support beyond what is described here.

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

So `fast-openai/index.ts` will be discovered like the existing sibling extensions.

## Core Behavior

Fast mode is a single global on/off setting. It applies to every model whose `model.provider` is listed in config.

No model-level allow-list. No per-provider on/off toggle. No footer/status display.

Runtime rule:

```text
config.enabled === true
AND model.provider is in config.providers
AND model.api is one of the supported native service-tier APIs
→ pass serviceTier: "priority"

otherwise
→ pass no serviceTier
```

When fast mode is off, omit `serviceTier` entirely. Do not send `serviceTier: "default"`.

## Config

Use a dedicated extension config file:

```text
~/.pi/agent/extensions/fast-openai.json
```

Missing config means fast mode is disabled.

Effective default when the config file is absent or incomplete:

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

`providers` contains Pi model provider IDs, not API handler names.

Examples:

```text
openai-codex/gpt-5.5 → model.provider = "openai-codex", model.api = "openai-codex-responses"
openai/gpt-5.5       → model.provider = "openai",       model.api = "openai-responses"
```

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
  - show current effective config and whether fast mode would apply to the current model/provider
- any other args, including empty args
  - show usage/help and do not change config

## Native Provider Wrapping

Use Pi's native `serviceTier` option, not raw `before_provider_request` payload injection.

Wrap/register stream handlers for these Pi API handlers:

- `openai-codex-responses`
- `openai-responses`

Why these two:

- Installed Pi-AI source shows native `serviceTier` support and service-tier cost adjustment for `openai-responses`.
- Installed Pi-AI source shows native `serviceTier` support and service-tier cost adjustment for `openai-codex-responses`.
- `openai-completions` does not appear to support native `serviceTier` or service-tier cost adjustment.
- `azure-openai-responses` does not appear to support native `serviceTier` or service-tier cost adjustment.

Relationship between config and wrappers:

- Wrappers are keyed by `model.api`.
- Config is keyed by/listed as `model.provider`.
- The wrapper runs for supported API handlers, then checks whether the current model's provider is listed in config.

## Cost Accounting

Using native `serviceTier` lets Pi-AI apply its built-in service-tier pricing.

Observed installed Pi-AI behavior:

```text
priority: 2x cost for most models
priority: 2.5x cost for gpt-5.5
flex:     0.5x cost
other:    1x cost
```

This plan only uses:

```ts
serviceTier: "priority"
```

No custom cost rewriting should be added.

## UI / Status

No automatic footer/status UI.

Do not call:

```ts
ctx.ui.setStatus(...)
```

The only user-visible state display is `/fast status`.

This keeps the extension behavior-only and avoids coupling to the existing footer extension. A future change can add exported helpers if needed, but v1 should not include a status concept.

## Expected Implementation Shape

`fast-openai/index.ts` should contain:

- config types and constants
- config path resolution using the Pi agent config dir
- config load with default fallback
- config save for `/fast on/off`
- provider/API support helpers
- command parser for exactly `on`, `off`, `status`
- provider stream wrappers for:
  - `openai-codex-responses`
  - `openai-responses`

Pseudo-flow:

```ts
const DEFAULT_CONFIG = {
  enabled: false,
  providers: ["openai-codex"],
};

function shouldUseFast(model, config) {
  return config.enabled && config.providers.includes(model.provider);
}

function withFastOptions(model, options, config) {
  if (!shouldUseFast(model, config)) return options;
  return { ...options, serviceTier: "priority" };
}
```

Each wrapper should reload/read config near request time so `/fast on/off` affects subsequent requests without requiring `/reload`.

## Non-Goals

- No raw `service_tier` injection through `before_provider_request`.
- No footer/status indicator.
- No bare `/fast` toggle.
- No model allow-list.
- No per-provider enabled flags.
- No support for `openai-completions` unless Pi later exposes native cost-aware `serviceTier` there.
- No Azure OpenAI support unless Pi later exposes native cost-aware `serviceTier` there.
- No multiple service tiers in v1.
- No custom cost calculation or message usage rewriting.

## Source-Resolved Decisions

- We used this repo's `package.json` to answer extension layout: use `<dir>/index.ts`, specifically `fast-openai/index.ts`.
- We used installed Pi-AI source to answer whether native `serviceTier` costs correctly: yes for `openai-responses` and `openai-codex-responses`.
- We used installed Pi-AI source to answer why only those API wrappers are in scope: they are the OpenAI API handlers with native service-tier support and cost adjustment.
- We used installed Pi model registry to answer provider/API mapping: `openai-codex` models use `openai-codex-responses`; `openai` models use `openai-responses`.
- We used Pi extension docs to answer command/provider-extension mechanics: use a Pi extension with `registerCommand` and provider registration/wrapping.

## Open Questions

None required before implementation.
