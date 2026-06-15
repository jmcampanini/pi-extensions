import {
  createBashToolDefinition,
  keyHint,
  truncateToVisualLines,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";

const LIVE_PREVIEW_LINES = 10;

type BashResult = {
  content: Array<{ type: string; text?: string }>;
};

type BashTheme = Parameters<
  NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>
>[2];

class BashPreviewComponent extends Container {
  state = {
    cachedWidth: undefined as number | undefined,
    cachedLines: undefined as string[] | undefined,
    cachedSkipped: undefined as number | undefined,
  };
}

function getTextOutput(result: BashResult): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const originalBash = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...originalBash,
    renderResult(result, options, theme: BashTheme, context) {
      if (!options.isPartial || options.expanded) {
        return (
          originalBash.renderResult?.(result, options, theme, context) ??
          new Container()
        );
      }

      const component =
        (context.lastComponent as BashPreviewComponent | undefined) ??
        new BashPreviewComponent();
      component.clear();

      const output = getTextOutput(result as BashResult).trim();
      if (!output) {
        return component;
      }

      const styledOutput = output
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");

      component.addChild({
        render: (width: number) => {
          const state = component.state;
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(
              styledOutput,
              LIVE_PREVIEW_LINES,
              width,
            );
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }

          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint =
              theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return [
              "",
              truncateToWidth(hint, width, "..."),
              ...(state.cachedLines ?? []),
            ];
          }

          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          component.state.cachedWidth = undefined;
          component.state.cachedLines = undefined;
          component.state.cachedSkipped = undefined;
        },
      });

      component.invalidate();
      return component;
    },
  });
}
