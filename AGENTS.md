# When designing Pi TUI surfaces

- Prefer Pi's native presentation patterns. Use the default boxed shell when available; when self-rendering a card-like surface, start with `Box(1, 1)` and the matching theme background unless the design explicitly requires different spacing.
- Follow Pi's native tool typography using semantic theme tokens:
  - Render a tool keyword or title with `theme.fg("toolTitle", theme.bold(...))`.
  - Render its primary argument or path unbolded with `theme.fg("accent", ...)`.
  - Render secondary metadata unbolded with `theme.fg("muted", ...)`. For example, Bash renders ` (timeout 300s)` this way.
  - Use `theme.fg("dim", ...)` for tertiary previews, hints, and less important metadata.
  - Render tool body output with `theme.fg("toolOutput", ...)`.
- In TUI code, use semantic theme tokens rather than palette names or literal colors. Palette-specific mappings belong in theme JSON.
- Never truncate card text with pi-tui's `truncateToWidth` — it injects `\x1b[0m` resets that kill the enclosing background. Use `interactive-subagents/text-fit.ts`: `fitText` on raw text before styling (the ellipsis inherits the style), `clampStyled` to hard-clamp an already-styled line.
