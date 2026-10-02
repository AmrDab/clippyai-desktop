/**
 * Tool tier metadata.
 *
 * Tier 1 — local artifact generation (file output, no GUI). Cheapest.
 * Tier 2 — OS / shell direct (PowerShell, system info, screenshots, file I/O).
 * Tier 3 — Application APIs: COM (3a), web service (3b), URL schemes (3c).
 * Tier 4 — Browser automation via CDP.
 * Tier 5 — Desktop UI automation (clawdcursor / nut.js / UIA bridge). Last resort.
 *
 * Brain should prefer the lowest-tier tool that fits the task. Tier 5 is only
 * picked when no API/COM/CDP equivalent exists.
 *
 * NOTE on system-prompt wiring: ClippyAI's system prompt + tool schema live
 * server-side in clippyai-api (`/v1/turn`). The orchestrator consumes
 * TOOL_META from this file when building the function-declaration list and
 * is responsible for prepending `[T<tier>]` to descriptions and adding the
 * "prefer lowest tier" line to the system prompt. See the brain.ts header
 * comment for the client/server split.
 */

/** v0.19.0 — action class for permission-policy gating. */
export type ActionClass =
  | 'destructive_file'     // creates / overwrites / deletes files
  | 'destructive_send'     // sends email / calendar invite
  | 'destructive_exec'     // executes code / shell commands
  | 'destructive_web'      // posts to external web APIs (issues, etc.)
  | 'destructive_purchase' // spends money / authorizes payments
  | 'share_public'         // publishes to public channels
  | 'system_control'       // controls OS / running processes
  | 'browser_navigate'     // opens URLs in browser
  | 'desktop_input'        // synthesizes keyboard/mouse input
  | 'read_only';           // no persistent side-effects

export interface ToolMeta {
  tier: 1 | 2 | 3 | 4 | 5;
  /** Hint for the router: 'cheap' = sub-100ms; 'medium' = 1-3s; 'expensive' = 5s+ */
  cost: 'cheap' | 'medium' | 'expensive';
  /** Brief task-level description shown to the model in the tier-aware prompt */
  description: string;
  /** Optional: alternate names of the same conceptual tool at higher tiers (for fallback) */
  fallback_alternative?: string;
  /** v0.19.0 — permission-policy action class. Phase 3: required on every
   *  entry; permission-policy falls back to destructive_exec if absent. */
  actionClass?: ActionClass;
  /** v0.19.0 — human-readable narration for activity log ("Wrote file …"). */
  narration?: string;
  /**
   * v0.20.0 — platforms where this tool is implemented + dispatchable.
   * Absent = all platforms (default). When present, executeTool short-circuits
   * with a structured `(error:PLATFORM_UNSUPPORTED)` on platforms not listed,
   * and buildToolTiers omits the tool from the catalog sent to the model so it
   * never picks something it can't run.
   *
   * Forensic background (May 21-23 logs): 31 of 32 OS-bridge sites still
   * dispatched to powershell.exe on macOS and failed ENOENT in 5-30ms each.
   * The model would still see `minimize_all_windows`, `outlook_send_email`,
   * etc. in its catalog, pick them, fail, and apologize to the user with
   * Windows-flavored copy ("Try pressing Win+D yourself"). Tagging the
   * Windows-only tools with platforms: ['win32'] is the structural fix.
   *
   * NOTE: as the macOS Swift bridge (v0.20.0) lands native implementations,
   * the matching tool entries should add 'darwin' here (e.g. read_screen
   * becomes `['win32', 'darwin']` once the AX-tree path lands). This field
   * is the source of truth for "where does this work?".
   */
  platforms?: ('win32' | 'darwin' | 'linux')[];
  /**
   * v0.19.1 — should the turn loop inject a fresh read_screen AFTER this tool
   * runs, so the model sees the new screen state before its next decision?
   *
   *   'always'   — re-read every time (tool materially changes what's on
   *                screen: launches an app, navigates the browser, focuses a
   *                different window).
   *   'on_error' — re-read only when the tool returned an error-shaped result,
   *                so the model can see why it failed.
   *   'never'    — never re-read (also the default when the field is absent).
   *
   * Default (field absent) = 'never'.
   *
   * Background: prior to v0.19.1 the loop ran read_screen after EVERY tool in
   * a hard-coded UI_MODIFYING_TOOLS set. On macOS read_screen walks the AX
   * tree (3-8s each), so a 12-step task with 6 UI-modifying tools wasted ~30s
   * on dead verification reads. Most click/type/key/mouse tools don't change
   * screen state in a way the model needs verified before its next step — and
   * it can always call read_screen voluntarily when it does. So verification
   * is now opt-in per tool. See shouldVerifyAfter() + brain.ts turn loop.
   */
  verifyAfter?: 'always' | 'never' | 'on_error';
}

/**
 * v0.20.0 — predicate used by both executeTool (dispatcher gate) and
 * buildToolTiers (model catalog filter). Centralized so the two paths stay
 * in sync — if the model never sees a tool, the dispatcher should never
 * see it either, and vice versa.
 */
export function isToolSupportedOnPlatform(
  meta: ToolMeta | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!meta) return false;
  if (!meta.platforms || meta.platforms.length === 0) return true;
  return (meta.platforms as readonly string[]).includes(platform);
}

export const TOOL_META: Record<string, ToolMeta> = {
  // ── Tier 1 — local artifact generation (added by PR 2) ──────────────
  generate_qrcode:   { tier: 1, cost: 'cheap',  description: 'Render text to a QR-code PNG file', actionClass: 'destructive_file' },
  generate_excel:    { tier: 1, cost: 'medium', description: 'Build an .xlsx workbook from row data (multi-sheet, exceljs, no Excel needed)', actionClass: 'destructive_file' },
  generate_docx:     { tier: 1, cost: 'medium', description: 'Build a .docx document from heading/paragraph/list blocks (no Word needed)', actionClass: 'destructive_file' },
  generate_pdf:      { tier: 1, cost: 'medium', description: 'Build a .pdf from text content with auto word-wrap (pdf-lib, no Word needed)', actionClass: 'destructive_file' },

  // ── Tier 2 — OS / shell direct ──────────────────────────────────────
  // v0.20.0 — platforms gating. UIA-based reads + OCR were Windows-only
  // through v0.19.x; the macOS Swift bridge (clippy-mac-bridge a11y-tree /
  // ocr-screen / active-window / windows / a11y-focused) lands the darwin
  // equivalents in v0.20.0 — see src/main/mac-bridge-native.ts. Each of the
  // tools tagged ['win32', 'darwin'] below now routes to the bridge on
  // darwin via the matching tools.ts implementation.
  read_screen:        { tier: 2, cost: 'medium',    description: 'Read what is currently on screen via the OS accessibility tree (UIA on Windows, AX on macOS)', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  smart_read:         { tier: 2, cost: 'medium',    description: 'Alias of read_screen — read the foreground accessibility tree', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  get_active_window:  { tier: 2, cost: 'cheap',     description: 'Identify the foreground window (process name, title, bounds)', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  get_windows:        { tier: 2, cost: 'cheap',     description: 'List all top-level windows on the desktop', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  get_focused_element:{ tier: 2, cost: 'cheap',     description: 'Inspect the currently focused UI element via the accessibility tree', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  get_selection:      { tier: 2, cost: 'cheap',     description: 'Read the text the user currently has highlighted/selected (in any app, via Accessibility)', platforms: ['darwin'], actionClass: 'read_only' },
  replace_focused_text:{ tier: 5, cost: 'cheap',    description: 'Replace the text of the currently-focused field in any app (e.g. apply a grammar/clarity rewrite). Reads+writes the focused field via accessibility; falls back to select-all+type if AX write is unsupported', platforms: ['darwin'], actionClass: 'desktop_input' },
  open_app:           { tier: 2, cost: 'medium',    description: 'Launch a desktop application by name (Start-Process on Windows, `open -a` on macOS)', platforms: ['win32', 'darwin'], verifyAfter: 'always', actionClass: 'system_control' },
  desktop_screenshot: { tier: 2, cost: 'medium',    description: 'Capture a downscaled screenshot of the primary display', actionClass: 'read_only' },
  ocr_read_screen:    { tier: 2, cost: 'expensive', description: 'OCR the current screenshot to read text (Windows.Media.Ocr on Windows, Apple Vision on macOS)', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  read_clipboard:     { tier: 2, cost: 'cheap',     description: 'Read the current clipboard text', narration: 'Checking the clipboard', actionClass: 'read_only' },
  write_clipboard:    { tier: 2, cost: 'cheap',     description: 'Write text to the clipboard', actionClass: 'destructive_file', narration: 'Copying to clipboard' },
  read_file:          { tier: 2, cost: 'cheap',     description: 'Read a local file from disk', narration: 'Reading the file', actionClass: 'read_only' },
  write_file:         { tier: 2, cost: 'cheap',     description: 'Write a local file to disk', narration: 'Saving the file', actionClass: 'destructive_file' },
  // v0.19.0 — file management tools (delete uses move-to-trash for undoability)
  delete_file:        { tier: 2, cost: 'cheap',     description: 'Move a local file to ~/.clippy-trash (restorable via Undo within 7 days)', narration: 'Deleting the file', actionClass: 'destructive_file' },
  rename_file:        { tier: 2, cost: 'cheap',     description: 'Rename a local file (from → to path)', narration: 'Renaming the file', actionClass: 'destructive_file' },
  move_file:          { tier: 2, cost: 'cheap',     description: 'Move a local file to a new location (from → to path)', narration: 'Moving the file', actionClass: 'destructive_file' },
  list_files:         { tier: 2, cost: 'cheap',     description: 'List files in a directory', narration: 'Listing files', actionClass: 'read_only' },
  search_files_content:{ tier: 2, cost: 'medium',   description: 'Search file contents for a regex/string pattern', actionClass: 'read_only' },
  // run_powershell removed v0.12.3 — security audit (prompt-injection → RCE).
  // Bundled PS scripts (outlook_*, excel_*, file ops) cover legitimate use.
  // v0.20.0 (track2) — these three still dispatch via com-*.ps1
  // (runComScript → powershell.exe) with NO darwin path and NO matching
  // Swift bridge verb, so they're gated win32-only to stop the model
  // picking them on Mac and ENOENTing. The brain can fall back to
  // shell_exec (`sw_vers`/`system_profiler`, `ps`, `ping`) on macOS.
  // TODO(track2-phase3): add darwin impls (native fs/os for sysinfo +
  // process list; `say` already covers TTS) and re-tag cross-platform.
  system_info:        { tier: 2, cost: 'cheap',     description: 'Get OS / hardware / disk info', platforms: ['win32'], actionClass: 'read_only' },
  list_processes:     { tier: 2, cost: 'cheap',     description: 'List running processes', platforms: ['win32'], actionClass: 'read_only' },
  // TODO(track2-phase3): kill_process dispatches com-kill-process.ps1 with
  // no darwin path / bridge verb; gated win32-only. macOS users can use
  // shell_exec (`kill`/`pkill`) until a native impl lands.
  kill_process:       { tier: 2, cost: 'cheap',     description: 'Kill a process by name or PID', platforms: ['win32'], actionClass: 'destructive_exec' },
  ping_host:          { tier: 2, cost: 'medium',    description: 'Ping a network host', platforms: ['win32'], actionClass: 'read_only' },
  http_request:       { tier: 2, cost: 'medium',    description: 'Make an HTTP request to an arbitrary URL', actionClass: 'destructive_web' },
  // v0.20.0 — generic shell. destructive_exec actionClass triggers a
  // permission-policy prompt in cautious + standard modes (the default).
  // See tools.ts `shellExec` header for the screen-text-RCE history that
  // shaped this design and the system-prompt rule that pairs with it.
  shell_exec:         { tier: 2, cost: 'medium',    description: 'Run a shell command (zsh on mac/linux, cmd.exe on windows). Use for ad-hoc CLI tasks (df, git, brew, npm, python -c, curl, lsof). Output capped at 32 KB, 30s default timeout (120s max). destructive_exec — prompts the user in cautious/standard mode.', actionClass: 'destructive_exec', narration: 'Running a shell command' },
  web_search:         { tier: 2, cost: 'cheap',     description: 'Search the web via DuckDuckGo and return the top results (title, URL, snippet). Use for "what is the latest X", "find a tutorial for Y", or any question that needs fresh info from the open internet.', actionClass: 'read_only' },
  // TODO(track2-phase3): speak_text dispatches com-speak-text.ps1 (no darwin
  // path / bridge verb). Gated win32-only; macOS `say` would be the native
  // impl. shell_exec(`say "…"`) covers it meanwhile.
  speak_text:         { tier: 2, cost: 'medium',    description: 'Speak text via the OS TTS engine', platforms: ['win32'], actionClass: 'system_control' },
  play_animation:     { tier: 1, cost: 'cheap',     description: 'Play a specific Clippy sprite animation on demand (wave, celebrate, dance, think, etc.). Use when the user asks Clippy to animate/react expressively.', narration: 'Showing off', actionClass: 'read_only' },
  // v0.20.0 — Win+M / Show-desktop / per-window minimize all go through
  // PowerShell on Windows. macOS equivalent ships in v0.20.0 via the Swift
  // bridge (`clippy-mac-bridge minimize-all|show-desktop|minimize-window`).
  // minimize_all_windows + show_desktop route through the bridge on darwin
  // via tools.ts. v0.20.0 (track2) — minimize_window now also has a darwin
  // path: resolve app name → pid (getAppPidByName) then call the bridge's
  // minimize-window verb, so it's cross-platform too.
  minimize_all_windows:{ tier: 2, cost: 'cheap',    description: 'Minimize every top-level window (Win+M / Cmd+Opt+H+M equivalent)', platforms: ['win32', 'darwin'], actionClass: 'system_control' },
  show_desktop:       { tier: 2, cost: 'cheap',     description: 'Show the desktop (toggle minimize-all)', platforms: ['win32', 'darwin'], actionClass: 'system_control' },
  minimize_window:    { tier: 2, cost: 'cheap',     description: 'Minimize a specific window by process or title', platforms: ['win32', 'darwin'], actionClass: 'system_control' },
  wait:               { tier: 2, cost: 'cheap',     description: 'Sleep for N seconds (param: `seconds`, clamped 0.1-30; synchronization primitive)', actionClass: 'read_only' },
  plan:               { tier: 2, cost: 'cheap',     description: 'Record an internal plan step (no side effects)', actionClass: 'read_only' },
  detect_webview_apps:{ tier: 2, cost: 'medium',    description: 'Detect Electron/CEF apps that may have a CDP port available', actionClass: 'read_only' },

  // ── Tier 3a — COM application APIs (Windows-only by definition) ─────
  // These all dispatch via COM bridges that don't exist on macOS. The
  // macOS-equivalent paths use AppleScript (Mail.app, Outlook for Mac via
  // applescript) and live in mac-bridge.ts — exposed as different tool names
  // (mail_send_email etc., gated by `platforms: ['darwin']`). Tagging the
  // COM versions ['win32'] means the model never picks them on Mac and we
  // don't have to ship Windows error apologies through to users.
  outlook_send_email:  { tier: 3, cost: 'medium',    description: 'Send an email via Outlook COM (no UI)', narration: 'Sending email', actionClass: 'destructive_send', platforms: ['win32'] },
  // v0.20.0-alpha.2 — Apple Mail send via AppleScript. THE macOS native
  // email path. Drives Mail.app: opens a visible compose window, fills
  // to/subject/body/cc/bcc, fires send. First call surfaces a TCC
  // Automation dialog (Privacy → Automation → ClippyAI → Mail). When
  // mail_env.apple_mail_installed is true this is the model's preferred
  // L3 path on macOS — beats outlook_web/gmail_web (which need CDP-attached
  // Chrome) because Mail.app is always present on Mac.
  apple_mail_send_email:{ tier: 3, cost: 'medium',    description: 'Send an email via Apple Mail (Mail.app) using AppleScript. macOS native — works without a browser. Use this on Mac unless the user explicitly asks for Gmail/Outlook web.', narration: 'Sending via Apple Mail', actionClass: 'destructive_send', platforms: ['darwin'] },
  outlook_read_inbox:  { tier: 3, cost: 'medium',    description: 'Read recent inbox messages via Outlook COM', narration: 'Reading your inbox', platforms: ['win32'], actionClass: 'read_only' },
  outlook_create_event:{ tier: 3, cost: 'medium',    description: 'Create a calendar event via Outlook COM', narration: 'Adding to your calendar', actionClass: 'destructive_send', platforms: ['win32'] },
  // Local Calendar.app write with no attendees — nothing is "sent" to
  // anyone, so this is destructive_file (local write), not destructive_send.
  // Escalate to destructive_send only if attendee-invite support is added.
  apple_calendar_create_event:{ tier: 3, cost: 'cheap', description: 'Create an event in the native macOS Calendar app via AppleScript — no browser/login needed. The reliable way to add a calendar event on Mac. Required: title + numeric date components year/month/day (hour/minute default to 09:00). Optional: durationMinutes (default 60), calendar (name; default first writable), notes, location.', narration: 'Adding to your calendar', actionClass: 'destructive_file', platforms: ['darwin'] },
  outlook_upcoming:    { tier: 3, cost: 'medium',    description: 'List upcoming calendar events via Outlook COM', narration: 'Checking your calendar', platforms: ['win32'], actionClass: 'read_only' },
  excel_read:          { tier: 3, cost: 'medium',    description: 'Read cells from an Excel workbook via COM', narration: 'Reading the spreadsheet', platforms: ['win32'], actionClass: 'read_only' },
  excel_write:         { tier: 3, cost: 'medium',    description: 'Write cells to an Excel workbook via COM', narration: 'Updating the spreadsheet', actionClass: 'destructive_file', platforms: ['win32'] },
  word_to_pdf:         { tier: 3, cost: 'expensive', description: 'Convert a Word document to PDF via Word COM', platforms: ['win32'], actionClass: 'destructive_file' },
  create_reminder:     { tier: 3, cost: 'medium',    description: 'Create a Windows reminder / scheduled toast', platforms: ['win32'], actionClass: 'system_control' },

  // ── Tier 3b — Web service APIs (added by PR 3) ───────────────────────
  github_create_issue: { tier: 3, cost: 'medium',    description: 'Create a GitHub issue via REST API (requires PAT in keytar:clippy.github)', actionClass: 'destructive_web', narration: 'Created GitHub issue' },
  github_list_issues:  { tier: 3, cost: 'medium',    description: 'List GitHub issues for a repo via REST API', actionClass: 'read_only' },
  github_get_pr:       { tier: 3, cost: 'medium',    description: 'Fetch a GitHub pull request by number via REST API', actionClass: 'read_only' },

  // ── Tier 3c — URL scheme / shell.openExternal ────────────────────────
  navigate_browser:    { tier: 3, cost: 'medium',    description: 'Open a URL in the default browser via shell.openExternal', verifyAfter: 'always', actionClass: 'browser_navigate' },
  open_url:            { tier: 3, cost: 'cheap',     description: 'Open a URL or deep-link via the OS handler — allowlisted schemes (mailto, spotify, vscode, slack, ms-teams, zoommtg, https, http, tel, sms)', verifyAfter: 'always', actionClass: 'browser_navigate' },
  spotify_play_uri:    { tier: 3, cost: 'cheap',     description: 'Play a Spotify track/album/playlist/artist by URI via the spotify: deep link', actionClass: 'browser_navigate' },

  // ── Tier 4 — Browser automation via CDP ──────────────────────────────
  cdp_connect:           { tier: 4, cost: 'medium',    description: 'Attach to a Chromium debugging port (CDP)', actionClass: 'read_only' },
  cdp_page_context:      { tier: 4, cost: 'cheap',     description: 'Get the active CDP tab URL/title', actionClass: 'read_only' },
  cdp_read_text:         { tier: 4, cost: 'medium',    description: 'Read text content from the CDP page (selector or full-doc)', actionClass: 'read_only' },
  cdp_click:             { tier: 4, cost: 'medium',    description: 'Click a CSS selector on the CDP page', actionClass: 'desktop_input' },
  cdp_type:              { tier: 4, cost: 'medium',    description: 'Type text into a CSS selector on the CDP page', actionClass: 'desktop_input' },
  cdp_select_option:     { tier: 4, cost: 'medium',    description: 'Set a <select> value via CDP', actionClass: 'desktop_input' },
  cdp_evaluate:          { tier: 4, cost: 'medium',    description: 'Run arbitrary JS in the CDP page context', actionClass: 'destructive_exec' },
  cdp_wait_for_selector: { tier: 4, cost: 'medium',    description: 'Wait for a CSS selector to appear in the CDP page', actionClass: 'read_only' },
  cdp_list_tabs:         { tier: 4, cost: 'cheap',     description: 'List CDP tabs/targets', actionClass: 'read_only' },
  cdp_switch_tab:        { tier: 4, cost: 'cheap',     description: 'Switch active CDP tab', actionClass: 'desktop_input' },
  cdp_scroll:            { tier: 4, cost: 'cheap',     description: 'Scroll the CDP page', actionClass: 'desktop_input' },

  // ── Tier 5 — Desktop UI automation (PSBridge UIA + mouse/keyboard) ──
  // v0.20.0 — five tools migrated to the macOS Swift bridge in v0.20.0:
  //   smart_click  → a11y-find + a11y-press, OCR + click fallback
  //   smart_type   → a11y-find + a11y-set-value, smart_click + type fallback
  //   type_text    → `type` (CGEvent unicode payload, no clipboard)
  //   key_press    → `keypress` (CGEvent combo with modifier flags)
  //   mouse_click  → `click` (CGEvent left/right/middle at coordinates)
  // The remaining Tier-5 tools (focus_window, mouse_double_click, mouse_*
  // variants, mouse_drag, mouse_scroll) keep their existing AppleScript /
  // PowerShell paths until the next bridge migration pass.
  smart_click:          { tier: 5, cost: 'expensive', description: 'Click an element by label using accessibility fuzzy match (UIA on Windows, AX on macOS, OCR fallback)', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  smart_type:           { tier: 5, cost: 'expensive', description: 'Type into a labeled element via accessibility + keyboard (last-resort UI)', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  focus_window:         { tier: 5, cost: 'medium',    description: 'Bring a window to the foreground (UIA / Win32 on Windows, AppleScript activate on macOS)', platforms: ['win32', 'darwin'], verifyAfter: 'always', actionClass: 'desktop_input' },
  type_text:            { tier: 5, cost: 'medium',    description: 'Synthesize keystrokes to type literal text into the focused window', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  key_press:            { tier: 5, cost: 'medium',    description: 'Synthesize a keyboard shortcut (e.g. Ctrl+S / Cmd+S)', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  mouse_click:          { tier: 5, cost: 'medium',    description: 'Click at absolute screen coordinates', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  // v0.20.0 (track2) — these four now route to the Swift bridge on darwin
  // (click count:2 / click button:right / drag / scroll CGEvent verbs).
  mouse_double_click:   { tier: 5, cost: 'medium',    description: 'Double-click at absolute screen coordinates', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  mouse_right_click:    { tier: 5, cost: 'medium',    description: 'Right-click at absolute screen coordinates', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  mouse_hover:          { tier: 5, cost: 'cheap',     description: 'Move the cursor to absolute screen coordinates', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  mouse_drag:           { tier: 5, cost: 'medium',    description: 'Drag from one set of screen coordinates to another', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },
  mouse_scroll:         { tier: 5, cost: 'cheap',     description: 'Scroll the mouse wheel at the cursor position', platforms: ['win32', 'darwin'], actionClass: 'desktop_input' },

  // ── Tier 5 diagnostic (added by PR 4) ────────────────────────────────
  // clawd_status reads the clawdcursor fallback subprocess state. Tagged
  // tier 2 because it is a status read with no UI driving — it just exposes
  // whether the Tier-5 fallback is ready, installing, or disabled.
  clawd_status:         { tier: 2, cost: 'cheap',     description: 'Diagnostic — current state of the Tier-5 clawdcursor fallback subprocess (ready / disabled / installing)', actionClass: 'read_only' },

  // ── v0.12.4 additions ──
  // TODO(track2-phase3): zip/unzip/hash dispatch zip-files.ps1 / unzip-files.ps1
  // / hash-file.ps1 with no darwin path / bridge verb — gated win32-only.
  // macOS: shell_exec(`zip`/`unzip`/`shasum`) or a native Node impl (zlib +
  // crypto) would make these cross-platform.
  zip_files:            { tier: 2, cost: 'medium',    description: 'Compress files/folders into a ZIP archive', platforms: ['win32'], actionClass: 'destructive_file' },
  unzip_files:          { tier: 2, cost: 'medium',    description: 'Decompress a ZIP archive into a destination directory', platforms: ['win32'], actionClass: 'destructive_file' },
  hash_file:            { tier: 2, cost: 'cheap',     description: 'Return SHA256/MD5/SHA1/SHA384/SHA512 hash of a local file', platforms: ['win32'], actionClass: 'read_only' },
  security_sweep:       { tier: 2, cost: 'expensive', description: 'Read-only security check: auto-start entries, scheduled tasks, services, processes, hijack points, hosts file, Defender status — explains suspicious items in plain English, never changes anything', platforms: ['win32'], actionClass: 'read_only' },
  ocr_from_image:       { tier: 2, cost: 'medium',    description: 'Extract text from an image file on disk via Windows OCR', platforms: ['win32'], actionClass: 'read_only' },
  windows_service_control: { tier: 2, cost: 'cheap',  description: 'Query / start / stop / restart a Windows service by name (start/stop need admin)', platforms: ['win32'], actionClass: 'destructive_exec' },
  get_current_time_tz:  { tier: 1, cost: 'cheap',     description: 'Current time in any IANA timezone (e.g. "America/Los_Angeles")', actionClass: 'read_only' },
  weather_current:      { tier: 3, cost: 'cheap',     description: 'Current weather + 24h forecast via Open-Meteo (free, no API key)', actionClass: 'read_only' },
  shortcuts_execute:    { tier: 5, cost: 'medium',    description: 'Execute a keyboard shortcut by semantic intent (e.g. "save document") — clawdcursor resolves the right combo per app', actionClass: 'desktop_input' },

  // ── v0.13.0 additions ──
  // outlook_send_email is the canonical dispatcher; the two web recipes
  // are exposed individually too so the model can pick them deliberately
  // when it knows the user is on outlook-web or gmail-web specifically.
  outlook_web_send_email: { tier: 4, cost: 'medium', description: 'Send email via outlook.live.com using a deterministic CDP recipe (with verified "Message sent" toast)', narration: 'Sending via Outlook web', actionClass: 'destructive_send' },
  gmail_web_send_email:   { tier: 4, cost: 'medium', description: 'Send email via mail.google.com using a deterministic CDP recipe (with verified "Message sent" snackbar)', narration: 'Sending via Gmail', actionClass: 'destructive_send' },
  // clawd_task is L5 — plain-English desktop task delegation to clawdcursor
  // for tasks that don't fit any L1-L4 native or recipe path.
  clawd_task:             { tier: 5, cost: 'expensive', description: 'L5 LAST RESORT — delegate a plain-English desktop task to clawdcursor when no native tool, browser recipe, or installed skill fits', actionClass: 'destructive_exec' },

  // ── v0.14.0 additions: ClawHub skill registry ──
  // darwin added 2026-06-13: clawhub.ts is cross-platform (ditto extraction +
  // sh/js entry points on macOS), so the agent can self-serve ClawHub skills
  // on Mac too — the win32-only gate was the loose end behind "Clippy can't
  // use ClawHub skills". Mirrors the backend ungate (clippyai-api).
  find_skill:             { tier: 3, cost: 'cheap',     description: 'Search ClawHub (public skill registry) for a skill matching a user intent. Returns top results with safety classification.', platforms: ['win32', 'darwin'], actionClass: 'read_only' },
  install_skill:          { tier: 3, cost: 'medium',    description: 'Download + install a ClawHub skill into ~/.clippyai/skills/. After install, the skill is callable as skill__<slug> on the next turn — promoted to L1.', platforms: ['win32', 'darwin'], actionClass: 'destructive_exec' },

  // ── v0.15.0 additions: high-level browser tools (mcp-chrome → CDP fallback) ──
  browser_navigate:  { tier: 4, cost: 'medium', description: 'Navigate the browser to a URL. Uses the user\'s real signed-in browser when mcp-chrome extension is installed; otherwise spawns a debug-flagged browser.', verifyAfter: 'always', actionClass: 'browser_navigate' },
  browser_click:     { tier: 4, cost: 'medium', description: 'Click an element by CSS selector OR text. Routes through mcp-chrome if available (real signed-in browser).', actionClass: 'desktop_input' },
  browser_type:      { tier: 4, cost: 'medium', description: 'Type text into a form field (selector or aria-label). Routes through mcp-chrome if available.', actionClass: 'desktop_input' },
  browser_read_text: { tier: 4, cost: 'cheap',  description: 'Read text content from a page element (default body). Routes through mcp-chrome if available.', actionClass: 'read_only' },
  browser_list_tabs: { tier: 4, cost: 'cheap',  description: 'List all open browser tabs. mcp-chrome only — CDP attach is single-tab.', actionClass: 'read_only' },
  browser_switch_tab:{ tier: 4, cost: 'cheap',  description: 'Switch to a tab by id, url-substring, or title-substring. mcp-chrome only.', actionClass: 'desktop_input' },
  // v0.19.0 — follow-me cursor mode
  follow_me:      { tier: 2, cost: 'cheap', description: "Have Clippy follow the user's cursor around the screen until told to stop", actionClass: 'desktop_input', narration: 'Following you' },
  stop_following: { tier: 2, cost: 'cheap', description: 'Stop following the cursor and stay in place', actionClass: 'desktop_input', narration: 'Standing still' },
  // v0.20.0-alpha.8 — profile / bootstrap ritual (openclaw-inspired)
  update_user_profile:    { tier: 1, cost: 'cheap', description: 'Persist a single field to USER.md (the user profile bundle). Used during the BOOTSTRAP ritual and any time the user reveals something durable about themselves.', actionClass: 'read_only', narration: 'Remembering' },
  finish_onboarding_chat: { tier: 1, cost: 'cheap', description: 'Mark the first-run BOOTSTRAP onboarding ritual complete. Deletes BOOTSTRAP.md so the ritual never runs again. Call exactly once when all profile questions are answered or explicitly skipped.', actionClass: 'read_only', narration: 'Got it' },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_META[name];
}

export function tierOf(name: string): number | undefined {
  return TOOL_META[name]?.tier;
}

/**
 * v0.19.1 — decide whether the turn loop should inject a fresh read_screen
 * after a tool call. Pure + side-effect-free so it's trivially unit-testable
 * (see scripts/test-verify-after.js).
 *
 *   verifyAfter 'always'   → true
 *   verifyAfter 'on_error' → true only when the call errored
 *   verifyAfter 'never' / absent / unknown tool → false
 */
export function shouldVerifyAfter(toolName: string, errored: boolean): boolean {
  const mode = TOOL_META[toolName]?.verifyAfter ?? 'never';
  if (mode === 'always') return true;
  if (mode === 'on_error') return errored;
  return false;
}
