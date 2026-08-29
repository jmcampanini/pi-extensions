# inline-skills

Codex-style `$skill-name` mentions for Pi: fuzzy-autocomplete any installed
skill anywhere in a message, and have it expand through Pi's native `/skill:`
machinery at submit time.

## Usage

Type `$` anywhere in the editor — start of the message, mid-sentence, any line.
A popup lists installed skills (name + description), narrowing with fuzzy
matching as you type. Accepting inserts `$skill-name ` and you keep writing.

On submit, a message like

```
tests are green, so please $write-pr-body for this branch
```

is rewritten to

```
/skill:write-pr-body tests are green, so please $write-pr-body for this branch
```

Pi then inlines the SKILL.md as its native `<skill>` block and renders the
collapsed `[skill]` row, with your sentence (sigil kept, exactly as typed) as
the trailing message.

## Rules

- Only exact installed-skill names expand. Typos and lookalikes (`$writepr`)
  pass through as plain text, silently. `$PATH`-style uppercase tokens can
  never match — Pi skill names are lowercase `[a-z0-9-]` only.
- Quoted (`"$name"`) and doubled (`$$name`) sigils never trigger.
- One skill per message. Two or more known mentions block the send with an
  error notification and restore your text to the editor — no guessing.
- Messages that already start with `/` are never touched.
- Start-of-message `/skill:name` keeps working exactly as before.
- In non-TUI modes (RPC), a multi-mention message passes through untransformed
  instead of blocking; single mentions still expand.

No configuration.
