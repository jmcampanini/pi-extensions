# Session reader

Run `/read-session` in Pi to open the current conversation in your browser. The page shows the newest messages first, with agent responses beside their matching prompts and an outline of the agent's headings. Read and copy text in the browser, then reply in Pi.

```text
/reload
/read-session
/read-session 40
```

The default is the last 20 user and agent messages combined. The optional positive integer changes that count. Agent progress text counts as a message; tool-only messages do not. Selection reads the current session branch, including stored messages from before compaction.

Messages and tool calls appear newest first. Paragraphs, lists, code, and headings keep their original order inside each message. On a large screen, the outline sits on the left, agent responses in the center, and their matching prompts on the right. A narrower screen moves the outline into a floating menu. Phone screens stack the messages in newest-first order.

Tool activity stays between the corresponding messages. Each call shows its name, a short path or command, and its recorded result status. A call without a result is marked `awaiting result`. Calls before the first selected message are excluded. Raw tool output and agent thinking are omitted. Generation uses recorded fields only and never calls a model.

Markdown includes headings, lists, checkboxes, blockquotes, links, tables, and syntax-highlighted fenced code. Copy icons preserve the original Markdown or code. Raw HTML is shown as text. Image attachments get a placeholder, and Markdown images become links. Local Markdown links resolve relative to the session's working directory; browser rules still govern opening them.

Light and dark colors follow the system preference automatically, including changes while the page is open. The page starts directly on the conversation. A floating return icon appears after scrolling down and returns to the newest message.

The reader is one standalone HTML file with embedded styles and browser code. It needs no server or network connection. Each invocation replaces `<session working directory>/.sandbox/read-session/<session key>/index.html` and opens that file with macOS `open`. Existing browser tabs remain snapshots until reloaded. Streaming text that Pi has not stored yet is absent. Interrupted messages retain their text and show their recorded status.

This extension is discovered by the package's existing `./*/index.ts` glob. Browser opening requires macOS. If opening fails, the generated file remains at the path reported in Pi.

Run the reader's tests with `node --test read-session/tests/*-test.ts`. Run `make check` for repository formatting, lint, typechecking, and tests.
