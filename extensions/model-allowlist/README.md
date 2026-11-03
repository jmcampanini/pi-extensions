# Model allowlist

Make Pi's `enabledModels` list also limit the model catalog exposed to Pi and T3.

## Configuration

Load this package in Pi and set `enabledModels` in `~/.pi/agent/settings.json` or trusted project settings:

```json
{
  "enabledModels": [
    "openai/gpt-6-astra",
    "openai/gpt-6-luna",
    "openai/gpt-6.1-sol",
    "openai/gpt-6.1-terra"
  ]
}
```

Use exact `provider/model` IDs. Pi itself accepts patterns, fuzzy names, and thinking-level suffixes in this setting; this extension treats entries as literal IDs, so those forms are unsupported. Configure thinking separately with `defaultThinkingLevel` or `modelThinkingLevels`.

An unset or empty list leaves the catalog unrestricted, matching Pi's normal setting behavior. The list still controls Pi's startup selection and model cycling. Keep your default model in the list, and restart Pi after editing the settings. Refresh the Pi provider in T3 to discover the updated catalog.

## How it works

At session startup, the extension reads Pi's effective settings and filters each known provider's models and availability. It preserves authentication, request headers, and provider implementations. It keeps original registrations so later session starts can widen the list or restore the catalog when the setting is removed.

Pi 1.4 can briefly rebuild availability snapshots without applying provider filters during refresh. The extension guards snapshot reads for its own native provider registrations so excluded custom models do not reappear during that interval.

T3 discovers models through Pi's RPC interface, so it receives the filtered catalog. Its separate "Pi default" entry is added by T3 and can be hidden in T3 settings.

This filters model discovery; it is not an authorization boundary.
