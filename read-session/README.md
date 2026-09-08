# Session reader

Run `/read-session` in Pi to open the current conversation in your browser. The page shows the newest messages first, with agent responses beside their matching prompts and an outline of the agent's headings. Read and copy text in the browser, then reply in Pi.

The reader's default shortcut is **Ctrl+R**. Pi also assigns this key to session renaming; follow the [shortcut setup](#configuring-the-shortcut) to free it before use.

```text
/reload
/read-session
```

The reader includes every stored user and agent message on the current session branch, including messages from before compaction. Agent progress text and recorded tool activity are included throughout the conversation.

Failed or aborted turns without response text appear as compact notices. Expand a notice to read its recorded error details, when available. Notices do not appear in the answer outline. A session with no text messages can still show its failure notices.

Messages and tool calls appear newest first. Paragraphs, lists, code, and headings keep their original order inside each message. On a large screen, the outline sits on the left, agent responses in the center, and their matching prompts on the right. A narrower screen moves the outline into a floating menu. Phone screens stack the messages in newest-first order.

Tool activity stays between the corresponding messages. Each call shows its name, a short path or command, and its recorded result status. A call without a result is marked `awaiting result`. Raw tool output and agent thinking are omitted. Generation uses recorded fields only and never calls a model.

Markdown includes headings, lists, checkboxes, blockquotes, links, tables, and syntax-highlighted fenced code. Complete `<skill name="..." location="...">...</skill>` blocks become non-expandable cards showing only the skill name. Multiple cards stay in their original positions among the message text. Copy icons preserve the Markdown or code, except that message copying replaces each compacted skill block with `$skill-name`. Replacement is literal, including inside code examples. A wrapper without a closing tag stays unchanged. Other raw HTML is shown as text. Image attachments get a placeholder, and Markdown images become links. Local Markdown links resolve relative to the session's working directory; browser rules still govern opening them.

Light and dark colors follow the system preference automatically, including changes while the page is open. The page starts directly on the conversation. A floating return icon appears after scrolling down and returns to the newest message.

The reader is one standalone HTML file with embedded styles and browser code. It needs no server or network connection. Each invocation replaces `<session working directory>/.sandbox/read-session/<session key>/index.html` and opens that file with macOS `open`. Existing browser tabs remain snapshots until reloaded. Streaming text that Pi has not stored yet is absent. Interrupted messages retain their text and show their recorded status.

This extension is discovered by the package's existing `./*/index.ts` glob. Browser opening requires macOS. If opening fails, the generated file remains at the path reported in Pi.

Run the reader's tests with `node --test read-session/tests/*-test.ts`. Run `make check` for repository formatting, lint, typechecking, and tests.

## Configuring the shortcut

To use Ctrl+R without a conflict, reassign or unbind Pi's `app.session.rename` action in `~/.pi/agent/keybindings.json`:

```json
{
  "app.session.rename": []
}
```

If fuzzy explorer uses Ctrl+R, follow [its Ctrl+F setup](../fuzzy-explorer/README.md#configuration), including the cursor-right override in `keybindings.json`.

Create `$PI_CODING_AGENT_DIR/read-session.json` (normally `~/.pi/agent/read-session.json`) to choose a shortcut:

```json
{
  "openShortcut": "f6"
}
```

Run `/reload` after editing. Set `openShortcut` to `null` to disable the hotkey while keeping `/read-session`. Shortcuts accept Pi key names with `ctrl`, `alt`, or `super` modifiers, or function keys such as `f6`.

`PI_READ_SESSION_OPEN_SHORTCUT` overrides the file. An empty value disables the hotkey. For example, `PI_READ_SESSION_OPEN_SHORTCUT=f6 pi` uses F6 for that Pi process.

Choose a key that is free in your Pi bindings and other extensions. Pi reports shortcut conflicts when loading extensions and skips bindings reserved by its editor. The reader does not change `keybindings.json`.

## Editing the reader

The visual components are Handlebars HTML templates in `components/`. A parent includes a child with `{{> component-name data}}`. The composition is visible in the HTML:

```text
reader.html
├── outline.html
├── exchange.html
│   ├── message.html
│   │   └── copy-button.html
│   ├── tool-activity.html
│   └── failure.html
└── controls.html
    └── outline.html
```

Message Markdown uses `heading.html`, `link.html`, `table.html`, `code-block.html`, and `skill-card.html`. Code blocks also include `copy-button.html`. Marked handles ordinary paragraphs, lists, and inline formatting.

| File | What to edit |
| --- | --- |
| `reader.html` | Page layout and outline placement |
| `components/exchange.html` | How a prompt, responses, and activity fit together |
| `components/message.html` | Message metadata, copy control, and content placement |
| `components/tool-activity.html` | Tool summary and individual call rows |
| `components/failure.html` | Failed or aborted turns and expandable details |
| `components/outline.html` | Answer and heading links, shared by both outline locations |
| `components/controls.html` | Floating outline and return controls |
| `components/copy-button.html` | The shared copy icon, button, and accessibility labels |
| `components/code-block.html` | Highlighted code and its copy control |
| `components/skill-card.html` | A compact skill name without its body or location |
| `components/heading.html`, `components/link.html`, `components/table.html` | Markdown headings, links, and scrolling tables |
| `reader.css` | Spacing, typography, responsive layouts, and system light/dark colors |
| `reader.js` | Copying, scrolling, and closing the outline menu |
| `render.ts` | Markdown conversion, URL policy, and preparing component data in newest-first order |
| `components.ts` | Component input types, file registration, and template compilation |
| `session.ts` | Which recorded messages and events appear in the reader |

### Preview components without a Pi session

From the repository root, generate and open the component gallery:

```shell
node read-session/preview.ts --open
```

The gallery shows components beside their actual template source, including normal and interrupted messages, complete exchanges, tool statuses, failure notices, code, and outlines. Copy buttons and expandable details use the production browser code. Its link opens a complete sample session with the production layout. Both pages use synthetic examples in `preview.ts`.

After editing a template or stylesheet, run `node read-session/preview.ts` again and refresh the open page. The command replaces `.sandbox/read-session-preview/components.html` and `index.html`. The gallery's layout lives in `gallery.html` and `gallery.css`; it does not change the page generated by `/read-session`.

For a real conversation, run `/reload` and `/read-session` in Pi. Existing pages remain snapshots until regenerated.

### Template inputs and escaping

Use `{{value}}` for recorded text and attribute values. Handlebars escapes these bindings automatically. Use `{{{valueHtml}}}` only for HTML produced by the configured Markdown renderer or another component. Page templates also embed the repository's CSS and JavaScript. Session text is data and is never compiled as a template.

`{{#each calls}}` repeats a section, and `{{#if details}}` shows an optional section. Partial arguments are explicit. For example, changing `copy-button.html` updates both message and code copying. Missing inputs fail during rendering, and `ComponentData` in `components.ts` describes each template's expected data.

Keep content directly against `<pre>`, `<code>`, and `<textarea>` tags. Template compilation disables automatic partial indentation so nesting a component does not change code or copied Markdown. Add a new component to `componentFiles` and `ComponentData`, then include it from its parent template. Add a gallery example in `preview.ts` when it has a state worth inspecting separately.
