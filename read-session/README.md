# Session reader

Run `/read-session` in Pi to open the current conversation in your browser. The page shows the newest messages first, with agent responses beside their matching prompts and an outline of the agent's headings. Read and copy text in the browser, then reply in Pi.

```text
/reload
/read-session
```

The reader includes every stored user and agent message on the current session branch, including messages from before compaction. Agent progress text and recorded tool activity are included throughout the conversation.

Failed or aborted turns without response text appear as compact notices. Expand a notice to read its recorded error details, when available. Notices do not appear in the answer outline. A session with no text messages can still show its failure notices.

Messages and tool calls appear newest first. Paragraphs, lists, code, and headings keep their original order inside each message. On a large screen, the outline sits on the left, agent responses in the center, and their matching prompts on the right. A narrower screen moves the outline into a floating menu. Phone screens stack the messages in newest-first order.

Tool activity stays between the corresponding messages. Each call shows its name, a short path or command, and its recorded result status. A call without a result is marked `awaiting result`. Raw tool output and agent thinking are omitted. Generation uses recorded fields only and never calls a model.

Markdown includes headings, lists, checkboxes, blockquotes, links, tables, and syntax-highlighted fenced code. Copy icons preserve the original Markdown or code. Raw HTML is shown as text. Image attachments get a placeholder, and Markdown images become links. Local Markdown links resolve relative to the session's working directory; browser rules still govern opening them.

Light and dark colors follow the system preference automatically, including changes while the page is open. The page starts directly on the conversation. A floating return icon appears after scrolling down and returns to the newest message.

The reader is one standalone HTML file with embedded styles and browser code. It needs no server or network connection. Each invocation replaces `<session working directory>/.sandbox/read-session/<session key>/index.html` and opens that file with macOS `open`. Existing browser tabs remain snapshots until reloaded. Streaming text that Pi has not stored yet is absent. Interrupted messages retain their text and show their recorded status.

This extension is discovered by the package's existing `./*/index.ts` glob. Browser opening requires macOS. If opening fails, the generated file remains at the path reported in Pi.

Run the reader's tests with `node --test read-session/tests/*-test.ts`. Run `make check` for repository formatting, lint, typechecking, and tests.

## Editing the reader

| File | What to edit |
| --- | --- |
| `reader.html` | Page layout, outline placement, floating controls, and accessibility labels |
| `reader.css` | Spacing, typography, responsive layouts, and system light/dark colors |
| `render.ts` | Repeated markup for exchanges, messages, headings, code blocks, tool activity, and failure notices |
| `reader.js` | Copying, scrolling, and closing the outline menu |
| `session.ts` | Which recorded messages and events appear in the reader |

The HTML file has five named slots: `{{title}}`, `{{styles}}`, `{{script}}`, `{{outline}}`, and `{{transcript}}`. `renderSession` fills them once with the escaped title and generated page content. Slot-like text inside a session message stays literal. Styles and browser code are embedded so the output remains a standalone file.

Repeated elements use indented multiline HTML in named rendering functions. Keep content directly against its `<pre>`, `<code>`, and `<textarea>` tags so indentation does not become visible text or copied content. Escape recorded text before placing it in markup; error details are plain text, and message Markdown goes through the configured renderer.

After editing, run `/reload` and `/read-session` in Pi to generate a fresh page. Existing output files remain snapshots until regenerated.
