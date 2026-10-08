---
name: clippy
description: Use ClippyAI (the Clippy desktop buddy) as your face and hands on the user's desktop over MCP. Use when you want to show the user something on their screen, point at a UI element, confirm a choice with buttons, celebrate or narrate progress, take a screenshot, or run a desktop action (read screen, click, type, open apps/files, clipboard, email) with the user's approval. Requires the "clippy" MCP server (ClippyAI → Settings → Connect an agent).
compatibility: Needs ClippyAI running with "Connect an agent" enabled and the clippy MCP server configured in your client.
metadata:
  author: ClippyAI
  version: "1"
---

# Clippy — your face and hands on the desktop

Clippy is a small animated paperclip that lives on the user's desktop (Windows
and macOS). When you are connected over MCP you can speak through his bubble,
move him around the screen, ask the user quick questions, and run his desktop
tools. The user sees everything you do through him, and approves anything
risky in his bubble.

Start with `clippy_status` once: it tells you the platform, whether Clippy is
busy, every display's bounds, and which desktop tools you may run.

## When to use Clippy

- **Show where something is** — `clippy_point_at` the button, field or window
  you are talking about so the user can follow along.
- **Confirm before acting** — `clippy_ask_user` with 2-4 options instead of
  guessing ("Save to Desktop", "Save to Downloads", "Cancel").
- **Narrate progress** — a short `clippy_say` before and after a desktop
  action ("Opening Excel…", "Done — 3 rows added.").
- **Celebrate / react** — `clippy_animate` Congratulate when a task lands,
  Alert when something went wrong, Thinking while you work.
- **See the screen** — `clippy_screenshot` when you need to know what the
  user is looking at.
- **Act on the desktop** — `clippy_run_tool` for Clippy's built-in tools
  (read_screen, smart_click, type_text, open_app, read_file, write_file,
  read_clipboard, browser_navigate, …). Read-only tools run at once; anything
  that writes, sends, spends, executes or publishes asks the user first.

Do not use Clippy for long text — his bubble is a glance, not a document.
Put long content in your own reply and have Clippy point at it or summarize.

## Tools

### clippy_say `{ text, wait_for_dismiss? }`
Shows `text` in Clippy's bubble (light markdown ok). Max 600 characters;
longer text is visibly cut. With `wait_for_dismiss: true` the bubble gets an
OK button and the call returns when the user clicks it (or after 2 minutes).

```json
{ "text": "I'll open the report in Excel and add the totals row. One sec…" }
```

### clippy_animate `{ animation }`
One sprite animation, no text. Names: Wave, GoodBye, Greeting, Congratulate,
GetArtsy, GetAttention, GetTechy, GetWizardy, Searching, Thinking, Writing,
Processing, CheckingSomething, Alert, Explain, Print, Save, SendMail,
EmptyTrash, RestPose, GestureUp/Down/Left/Right, LookUp/Down/Left/Right.

```json
{ "animation": "Congratulate" }
```

### clippy_point_at `{ x, y, label? }`
Clippy glides next to screen point (x, y) — device-independent pixels, any
monitor — and gestures toward it. `label` is a short bubble caption.

```json
{ "x": 1180, "y": 42, "label": "Click Share up here" }
```

Get coordinates from `clippy_run_tool` → `read_screen` (accessibility tree
with element bounds) or from `clippy_screenshot` (the text part explains how
to convert image pixels to screen coordinates).

### clippy_ask_user `{ question, options[2..4], timeout_seconds? }`
Bubble with buttons. Returns the chosen label verbatim, `"dismissed"` if the
user closed the bubble, or `"timeout"` (default 60 s, max 300 s).

```json
{ "question": "Which file should I attach?", "options": ["Q3 report.pdf", "Q3 draft.docx", "Neither"] }
```

### clippy_screenshot `{}`
Downscaled PNG of the primary display plus a text note with the scale
factor. Use sparingly — it is the most expensive call.

### clippy_status `{}`
Version, platform, `busy`, Clippy's window bounds, displays (bounds,
workArea, scaleFactor), animation names, and `allowed_tools` for
`clippy_run_tool`.

### clippy_run_tool `{ name, args }`
Runs one of Clippy's desktop tools under the user's Guardrails policy.

```json
{ "name": "open_app", "args": { "name": "Notepad" } }
{ "name": "read_screen", "args": {} }
{ "name": "write_file", "args": { "path": "~/Desktop/notes.txt", "content": "hello" } }
```

Rules the server enforces:
- The name must be in `clippy_status.allowed_tools` (platform-specific).
- Destructive classes (file writes, sending, spending, executing, posting)
  always show an Approve / Deny prompt in Clippy's bubble, even if the user
  trusts Clippy himself. Denied or unanswered (25 s) → an error result. Do
  not retry; ask the user what they want instead.
- Tool output is the same text Clippy's own brain sees; results starting with
  `(error:…)` are failures.

## Etiquette

1. **Explain, then act.** `clippy_say` what you are about to do before any
   `clippy_run_tool` that changes something. The approval prompt only shows a
   one-line summary; your sentence is the context.
2. **Short bubbles.** One or two sentences. No headings, no code blocks.
3. **Don't spam animations.** One per moment — not one per sentence, never
   in a loop. `clippy_say` already animates.
4. **Ask, don't assume.** When there are a few sensible options, use
   `clippy_ask_user` rather than picking silently.
5. **Respect "busy".** If a call returns `(error:busy)`, Clippy is doing
   something for the user — wait a few seconds and retry once.
6. **Respect "no".** A `user_denied` result means stop that line of action.
7. **Coordinates:** `clippy_point_at` takes device-independent pixels;
   `mouse_*` tools inside `clippy_run_tool` take native pixels — read each
   tool's result text for the conversion.

## Limits

- Clippy must be running with "Connect an agent" enabled; the endpoint is
  local-only (127.0.0.1) and token-protected.
- One driver at a time: while you are mid-call, Clippy's own chat and
  proactive tips pause; while Clippy runs his own task, your calls get
  `(error:busy)`.
- Screenshots cover the primary display only.
- Some desktop tools exist on one OS only — always consult `allowed_tools`.
- The user can close the bubble, deny any action, or switch the feature off
  at any time.
