# What Clippy Can Do

A reference for everything ClippyAI can execute on a Windows desktop, as of v0.11.16.

Clippy operates on a **4-tier capability stack**, picked per step. The model always reaches for the highest tier that fits, falling through if a tier fails or doesn't apply. The result is that almost any task on a Windows machine — sending email, editing spreadsheets, scheduling meetings, navigating the web, controlling running apps — is one prompt away.

---

## The 4-Tier Stack

| Tier | What it does | When it's used |
|---|---|---|
| **0 — Browser (CDP)** | Drives Chrome, Edge, and any Electron app (Slack, Teams, VS Code, Notion, New Outlook) directly via Chrome DevTools Protocol. DOM-level access, no screenshots. | Any web task. Reliable on Gmail compose, web forms, search results, dashboards. |
| **1 — Scripts (COM/PowerShell)** | 19 dedicated PowerShell scripts that talk to Windows COM, the file system, the network, and Office apps. | System info, files, Outlook, Excel, Word, processes, network. |
| **2 — Smart UI (accessibility tree)** | `smart_click`, `smart_type`, `key_press` — finds elements by visible label or text using Windows UI Automation. | Desktop apps with no COM and no embedded browser. |
| **3 — Raw mouse + keyboard** | Last resort. `mouse_click`, `mouse_drag` at exact coordinates after `read_screen`. | Drawing, games, custom UIs that ignore both UIA and CDP. |

**Tiers are picked per step, not per task.** A multi-step task ("look up Bob on LinkedIn → email him via Outlook") naturally crosses Tier 0 → Tier 1 in one task.

---

## Complete Tool Catalog

### Tier 0 — Browser & Electron (12 tools)

| Tool | What it does |
|---|---|
| `cdp_connect` | Connects to Chrome/Edge via CDP. Auto-launches a debug-enabled browser if none is running. |
| `cdp_page_context` | Returns a structured list of interactive elements on the current page (selectors, labels, types). |
| `cdp_read_text` | Reads text content from a CSS selector. Far cheaper than screenshot+OCR. |
| `cdp_click` | Clicks a DOM element by CSS selector or visible text. |
| `cdp_type` | Types into an input by selector or by associated label. Fires React/Vue change events correctly. |
| `cdp_select_option` | Selects an option in a `<select>` dropdown. |
| `cdp_evaluate` | Evaluates arbitrary JavaScript in the page. |
| `cdp_wait_for_selector` | Waits for an element to appear and become visible. |
| `cdp_list_tabs` | Lists all open browser tabs with URLs and titles. |
| `cdp_switch_tab` | Switches to a tab by URL or title substring. |
| `cdp_scroll` | Page-level scroll via DOM (more reliable than mouse scroll). |
| `detect_webview_apps` | Flags running Electron/WebView2 apps (Slack, Teams, VS Code, Discord, Notion, New Outlook) and tells the agent how to attach CDP to them. |

### Tier 1 — Scripts (19 tools)

**Office: Outlook**
| Tool | What it does |
|---|---|
| `outlook_send_email` | Send via Outlook COM. Recipient, subject, body, CC, attachments. Sends instantly, no UI. |
| `outlook_read_inbox` | Read recent emails (sender, subject, preview, unread flag). |
| `outlook_create_event` | Schedule appointments or meetings. Sends invites if attendees provided. |
| `outlook_upcoming` | List upcoming calendar events for the next N days. |

**Office: Excel & Word**
| Tool | What it does |
|---|---|
| `excel_read` | Read a range from `.xlsx` / `.xls` / `.csv`. Returns 2D array. |
| `excel_write` | Write a 2D array to a sheet. Creates the file/sheet if missing. Saves automatically. |
| `word_to_pdf` | Convert `.docx` / `.doc` / `.rtf` to PDF via Word COM. |

**Files**
| Tool | What it does |
|---|---|
| `read_file` | Read text files (`.txt .md .csv .log .json .ps1 .py .js .ts .html .xml`) up to 100 KB. |
| `write_file` | Write text content. Modes: `create` (fail if exists), `overwrite`, `append`. |
| `list_files` | List directory contents with sizes and modified times. Glob filter, optional recurse. |
| `search_files_content` | Grep file contents (text/code files only) for a pattern. |

**System & Processes**
| Tool | What it does |
|---|---|
| `system_info` | Battery %, RAM free/total, disk free, CPU load, OS version, uptime. |
| `list_processes` | Top processes by CPU or RAM (PID, name, RAM, CPU seconds, window title). |
| `kill_process` | Terminate a process by PID or name. Refuses OS-critical processes (svchost, explorer, lsass, dwm, Clippy itself). |

**Network**
| Tool | What it does |
|---|---|
| `ping_host` | Test-Connection wrapper. Returns latency stats (avg/min/max). |
| `http_request` | Raw HTTP request. GET/POST/PUT/DELETE/PATCH. Custom headers + body. |

**Productivity**
| Tool | What it does |
|---|---|
| `create_reminder` | Create a Windows scheduled-task reminder that pops a MessageBox at a given time. |
| `speak_text` | Speak text aloud via Windows SAPI text-to-speech. Returns immediately. |
| `run_powershell` | Escape hatch — run arbitrary PowerShell code. Sandboxed (blocks deletes, downloads, privilege escalation). |

### Tier 2 — Smart UI (12 tools)

| Tool | What it does |
|---|---|
| `read_screen` | Lists the focused window's controls, one line each: id, role, name, value, state and the actions it supports. `find` filters by name. Use OCR mode for canvas/PDFs. |
| `smart_click` | Clicks an element by visible label or text. Preferred over coordinate clicks. |
| `smart_type` | Types into a labeled input field. |
| `key_press` | Press a key or combo (`ctrl+s`, `alt+tab`, `Page_Down`). |
| `type_text` | Type text at the current cursor position (no field targeting). |
| `focus_window` | Bring a window to the foreground by process name. |
| `open_app` | Open a Windows app by name. |
| `get_active_window` | Info about the currently focused window. |
| `get_focused_element` | Info about the UI element with keyboard focus. |
| `get_windows` | List all open windows with PIDs and titles. |
| `read_clipboard` / `write_clipboard` | Read/set clipboard text. |
| `wait` | Pause for UI to settle (e.g. after `open_app`). |

### Tier 3 — Raw input (4 tools)

| Tool | What it does |
|---|---|
| `mouse_click` / `mouse_double_click` / `mouse_right_click` / `mouse_hover` | Click/hover at exact coordinates. |
| `mouse_drag` | Drag from one coordinate to another. Used for drawing. |
| `mouse_scroll` | Scroll wheel at a coordinate. |
| `desktop_screenshot` | Full-screen screenshot. Vision-grade — only used when accessibility tree can't describe what's on screen. |

### Browser navigation & misc

| Tool | What it does |
|---|---|
| `navigate_browser` | Open a URL in the default browser (or focus an existing tab). |
| `plan` | Emit a step-by-step plan for tasks needing 3+ tool calls. Helps the model self-organize. |
| `task_complete` | Sentinel — marks the end of a task with an honest one-sentence summary. |

---

## Example Tasks Clippy Can Do

These are real prompts that exercise multiple tiers in one task:

| Prompt | Tools used |
|---|---|
| "Email Bob about tomorrow's meeting." | `outlook_send_email` (Tier 1) |
| "Schedule a 30-min call with Sarah at 3pm tomorrow." | `outlook_create_event` (Tier 1) |
| "What's on my calendar today?" | `outlook_upcoming` (Tier 1) |
| "Add this expense ($45, lunch) to my budget.xlsx." | `excel_read` → `excel_write` (Tier 1) |
| "Convert C:\docs\report.docx to PDF." | `word_to_pdf` (Tier 1) |
| "What's the weather in Berlin tomorrow?" | `cdp_connect` → Google search → `cdp_read_text` (Tier 0) |
| "Open Gmail and send hello to alice@example.com." | `cdp_connect` → `cdp_type` → `cdp_click("Send")` (Tier 0) |
| "How much battery do I have?" | `system_info` (Tier 1) |
| "What's eating my CPU?" | `list_processes` (Tier 1) |
| "Force-quit Spotify." | `kill_process` (Tier 1) |
| "Find the file on my desktop that mentions 'Q3 budget'." | `search_files_content` (Tier 1) |
| "What's in C:\Users\me\notes.txt?" | `read_file` (Tier 1) |
| "Remind me to take my pills at 9pm tonight." | `create_reminder` (Tier 1) |
| "Read this email aloud." | `read_clipboard` → `speak_text` (Tier 1+2) |
| "Open Paint and draw a stick figure." | `open_app` → `read_screen` → `mouse_drag` × N (Tier 2 + 3) |
| "Look up Bob on LinkedIn, then email him via Outlook." | `cdp_connect` → search → read profile → `outlook_send_email` (Tier 0 + 1) |
| "What's on my Slack right now?" | `detect_webview_apps` → `cdp_connect` → `cdp_page_context` (Tier 0) |
| "Is google.com reachable?" | `ping_host` (Tier 1) |
| "Hit api.github.com/users/torvalds and tell me his bio." | `http_request` (Tier 1) |

---

## Safety Rails

The model always operates within these guardrails:

- **Email confirmation** — recipient + subject restated to the user before any send.
- **Process protection** — `kill_process` refuses OS-critical processes (`svchost`, `explorer`, `lsass`, `dwm`, `winlogon`, etc.) and Clippy itself.
- **File scope** — `read_file` limited to text-like extensions, max 100 KB; binary files refused with a clear message.
- **Script sandbox** — `run_powershell` blocks deletions, network downloads, and privilege escalation patterns.
- **Anti-loop** — model is forbidden from calling the same tool with the same args twice in one task.
- **Honest task completion** — `task_complete` summary must reflect what *actually* happened, including failures and fallbacks. No "task done!" if a step failed.
- **No silent destructive actions** — closing windows, deleting files, sending invitations, or making purchases all require explicit user confirmation.

---

## Privacy

- Screenshots **never leave the device**. Only structured UI element names and text are sent to the model.
- License keys validated server-side; usage is metered (token budget per plan) but no chat content is logged.
- Log reports (Help → Report a Problem) are opt-in, scrubbed of PII, and TTL'd to 30 days.

---

## Plans

| Plan | Price | Token budget | Tier 0 (browser) | Tier 1 (scripts) | Tier 2/3 (UI/raw) |
|---|---|---|---|---|---|
| **Basic** | $4.99/mo | 500K tokens | ❌ | ❌ | ❌ (chat only) |
| **Pro** | $9.99/mo | 2M tokens | ✅ | ✅ | ✅ |
| **Power** | $19.99/mo | 5M tokens | ✅ | ✅ + multi-monitor + custom personas | ✅ |

Pro and Power both unlock the full 4-tier stack. Power adds priority support and quality-of-life features.
