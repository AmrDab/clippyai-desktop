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

export interface ToolMeta {
  tier: 1 | 2 | 3 | 4 | 5;
  /** Hint for the router: 'cheap' = sub-100ms; 'medium' = 1-3s; 'expensive' = 5s+ */
  cost: 'cheap' | 'medium' | 'expensive';
  /** Brief task-level description shown to the model in the tier-aware prompt */
  description: string;
  /** Optional: alternate names of the same conceptual tool at higher tiers (for fallback) */
  fallback_alternative?: string;
}

export const TOOL_META: Record<string, ToolMeta> = {
  // ── Tier 1 — local artifact generation (added by PR 2) ──────────────
  generate_qrcode:   { tier: 1, cost: 'cheap',  description: 'Render text to a QR-code PNG file' },
  generate_excel:    { tier: 1, cost: 'medium', description: 'Build an .xlsx workbook from row data (multi-sheet, exceljs, no Excel needed)' },
  generate_docx:     { tier: 1, cost: 'medium', description: 'Build a .docx document from heading/paragraph/list blocks (no Word needed)' },
  generate_pdf:      { tier: 1, cost: 'medium', description: 'Build a .pdf from text content with auto word-wrap (pdf-lib, no Word needed)' },

  // ── Tier 2 — OS / shell direct ──────────────────────────────────────
  read_screen:        { tier: 2, cost: 'medium',    description: 'Read what is currently on screen via the Windows accessibility tree (UIA)' },
  smart_read:         { tier: 2, cost: 'medium',    description: 'Alias of read_screen — read the foreground UIA tree' },
  get_active_window:  { tier: 2, cost: 'cheap',     description: 'Identify the foreground window (process name, title, bounds)' },
  get_windows:        { tier: 2, cost: 'cheap',     description: 'List all top-level windows on the desktop' },
  get_focused_element:{ tier: 2, cost: 'cheap',     description: 'Inspect the currently focused UI element via UIA' },
  open_app:           { tier: 2, cost: 'medium',    description: 'Launch a desktop application by name (Start-Process)' },
  desktop_screenshot: { tier: 2, cost: 'medium',    description: 'Capture a downscaled screenshot of the primary display' },
  ocr_read_screen:    { tier: 2, cost: 'expensive', description: 'Run Windows.Media.Ocr over the current screenshot to read text' },
  read_clipboard:     { tier: 2, cost: 'cheap',     description: 'Read the current Windows clipboard text' },
  write_clipboard:    { tier: 2, cost: 'cheap',     description: 'Write text to the Windows clipboard' },
  read_file:          { tier: 2, cost: 'cheap',     description: 'Read a local file from disk' },
  write_file:         { tier: 2, cost: 'cheap',     description: 'Write a local file to disk' },
  list_files:         { tier: 2, cost: 'cheap',     description: 'List files in a directory' },
  search_files_content:{ tier: 2, cost: 'medium',   description: 'Search file contents for a regex/string pattern' },
  // run_powershell removed v0.12.3 — security audit (prompt-injection → RCE).
  // Bundled PS scripts (outlook_*, excel_*, file ops) cover legitimate use.
  system_info:        { tier: 2, cost: 'cheap',     description: 'Get OS / hardware / disk info' },
  list_processes:     { tier: 2, cost: 'cheap',     description: 'List running processes' },
  kill_process:       { tier: 2, cost: 'cheap',     description: 'Kill a process by name or PID' },
  ping_host:          { tier: 2, cost: 'medium',    description: 'Ping a network host' },
  http_request:       { tier: 2, cost: 'medium',    description: 'Make an HTTP request to an arbitrary URL' },
  speak_text:         { tier: 2, cost: 'medium',    description: 'Speak text via the OS TTS engine' },
  minimize_all_windows:{ tier: 2, cost: 'cheap',    description: 'Minimize every top-level window (Win+M equivalent)' },
  show_desktop:       { tier: 2, cost: 'cheap',     description: 'Show the desktop (toggle minimize-all)' },
  minimize_window:    { tier: 2, cost: 'cheap',     description: 'Minimize a specific window by process or title' },
  wait:               { tier: 2, cost: 'cheap',     description: 'Sleep for N milliseconds (synchronization primitive)' },
  plan:               { tier: 2, cost: 'cheap',     description: 'Record an internal plan step (no side effects)' },
  detect_webview_apps:{ tier: 2, cost: 'medium',    description: 'Detect Electron/CEF apps that may have a CDP port available' },

  // ── Tier 3a — COM application APIs ───────────────────────────────────
  outlook_send_email:  { tier: 3, cost: 'medium',    description: 'Send an email via Outlook COM (no UI)' },
  outlook_read_inbox:  { tier: 3, cost: 'medium',    description: 'Read recent inbox messages via Outlook COM' },
  outlook_create_event:{ tier: 3, cost: 'medium',    description: 'Create a calendar event via Outlook COM' },
  outlook_upcoming:    { tier: 3, cost: 'medium',    description: 'List upcoming calendar events via Outlook COM' },
  excel_read:          { tier: 3, cost: 'medium',    description: 'Read cells from an Excel workbook via COM' },
  excel_write:         { tier: 3, cost: 'medium',    description: 'Write cells to an Excel workbook via COM' },
  word_to_pdf:         { tier: 3, cost: 'expensive', description: 'Convert a Word document to PDF via Word COM' },
  create_reminder:     { tier: 3, cost: 'medium',    description: 'Create a Windows reminder / scheduled toast' },

  // ── Tier 3b — Web service APIs (added by PR 3) ───────────────────────
  github_create_issue: { tier: 3, cost: 'medium',    description: 'Create a GitHub issue via REST API (requires PAT in keytar:clippy.github)' },
  github_list_issues:  { tier: 3, cost: 'medium',    description: 'List GitHub issues for a repo via REST API' },
  github_get_pr:       { tier: 3, cost: 'medium',    description: 'Fetch a GitHub pull request by number via REST API' },

  // ── Tier 3c — URL scheme / shell.openExternal ────────────────────────
  navigate_browser:    { tier: 3, cost: 'medium',    description: 'Open a URL in the default browser via shell.openExternal' },
  open_url:            { tier: 3, cost: 'cheap',     description: 'Open a URL or deep-link via the OS handler — allowlisted schemes (mailto, spotify, vscode, slack, ms-teams, zoommtg, https, http, tel, sms)' },
  spotify_play_uri:    { tier: 3, cost: 'cheap',     description: 'Play a Spotify track/album/playlist/artist by URI via the spotify: deep link' },

  // ── Tier 4 — Browser automation via CDP ──────────────────────────────
  cdp_connect:           { tier: 4, cost: 'medium',    description: 'Attach to a Chromium debugging port (CDP)' },
  cdp_page_context:      { tier: 4, cost: 'cheap',     description: 'Get the active CDP tab URL/title' },
  cdp_read_text:         { tier: 4, cost: 'medium',    description: 'Read text content from the CDP page (selector or full-doc)' },
  cdp_click:             { tier: 4, cost: 'medium',    description: 'Click a CSS selector on the CDP page' },
  cdp_type:              { tier: 4, cost: 'medium',    description: 'Type text into a CSS selector on the CDP page' },
  cdp_select_option:     { tier: 4, cost: 'medium',    description: 'Set a <select> value via CDP' },
  cdp_evaluate:          { tier: 4, cost: 'medium',    description: 'Run arbitrary JS in the CDP page context' },
  cdp_wait_for_selector: { tier: 4, cost: 'medium',    description: 'Wait for a CSS selector to appear in the CDP page' },
  cdp_list_tabs:         { tier: 4, cost: 'cheap',     description: 'List CDP tabs/targets' },
  cdp_switch_tab:        { tier: 4, cost: 'cheap',     description: 'Switch active CDP tab' },
  cdp_scroll:            { tier: 4, cost: 'cheap',     description: 'Scroll the CDP page' },

  // ── Tier 5 — Desktop UI automation (PSBridge UIA + mouse/keyboard) ──
  smart_click:          { tier: 5, cost: 'expensive', description: 'Click an element by label using UIA fuzzy match (last-resort UI)' },
  smart_type:           { tier: 5, cost: 'expensive', description: 'Type into a labeled element via UIA + keyboard (last-resort UI)' },
  focus_window:         { tier: 5, cost: 'medium',    description: 'Bring a window to the foreground via UIA / Win32' },
  type_text:            { tier: 5, cost: 'medium',    description: 'Synthesize keystrokes to type literal text into the focused window' },
  key_press:            { tier: 5, cost: 'medium',    description: 'Synthesize a keyboard shortcut (e.g. Ctrl+S)' },
  mouse_click:          { tier: 5, cost: 'medium',    description: 'Click at absolute screen coordinates' },
  mouse_double_click:   { tier: 5, cost: 'medium',    description: 'Double-click at absolute screen coordinates' },
  mouse_right_click:    { tier: 5, cost: 'medium',    description: 'Right-click at absolute screen coordinates' },
  mouse_hover:          { tier: 5, cost: 'cheap',     description: 'Move the cursor to absolute screen coordinates' },
  mouse_drag:           { tier: 5, cost: 'medium',    description: 'Drag from one set of screen coordinates to another' },
  mouse_scroll:         { tier: 5, cost: 'cheap',     description: 'Scroll the mouse wheel at the cursor position' },

  // ── Tier 5 diagnostic (added by PR 4) ────────────────────────────────
  // clawd_status reads the clawdcursor fallback subprocess state. Tagged
  // tier 2 because it is a status read with no UI driving — it just exposes
  // whether the Tier-5 fallback is ready, installing, or disabled.
  clawd_status:         { tier: 2, cost: 'cheap',     description: 'Diagnostic — current state of the Tier-5 clawdcursor fallback subprocess (ready / disabled / installing)' },

  // ── v0.12.4 additions ──
  zip_files:            { tier: 2, cost: 'medium',    description: 'Compress files/folders into a ZIP archive' },
  unzip_files:          { tier: 2, cost: 'medium',    description: 'Decompress a ZIP archive into a destination directory' },
  hash_file:            { tier: 2, cost: 'cheap',     description: 'Return SHA256/MD5/SHA1/SHA384/SHA512 hash of a local file' },
  ocr_from_image:       { tier: 2, cost: 'medium',    description: 'Extract text from an image file on disk via Windows OCR' },
  windows_service_control: { tier: 2, cost: 'cheap',  description: 'Query / start / stop / restart a Windows service by name (start/stop need admin)' },
  get_current_time_tz:  { tier: 1, cost: 'cheap',     description: 'Current time in any IANA timezone (e.g. "America/Los_Angeles")' },
  weather_current:      { tier: 3, cost: 'cheap',     description: 'Current weather + 24h forecast via Open-Meteo (free, no API key)' },
  shortcuts_execute:    { tier: 5, cost: 'medium',    description: 'Execute a keyboard shortcut by semantic intent (e.g. "save document") — clawdcursor resolves the right combo per app' },

  // ── v0.13.0 additions ──
  // outlook_send_email is the canonical dispatcher; the two web recipes
  // are exposed individually too so the model can pick them deliberately
  // when it knows the user is on outlook-web or gmail-web specifically.
  outlook_web_send_email: { tier: 4, cost: 'medium', description: 'Send email via outlook.live.com using a deterministic CDP recipe (with verified "Message sent" toast)' },
  gmail_web_send_email:   { tier: 4, cost: 'medium', description: 'Send email via mail.google.com using a deterministic CDP recipe (with verified "Message sent" snackbar)' },
  // clawd_task is L5 — plain-English desktop task delegation to clawdcursor
  // for tasks that don't fit any L1-L4 native or recipe path.
  clawd_task:             { tier: 5, cost: 'expensive', description: 'L5 LAST RESORT — delegate a plain-English desktop task to clawdcursor when no native tool, browser recipe, or installed skill fits' },

  // ── v0.14.0 additions: ClawHub skill registry ──
  find_skill:             { tier: 3, cost: 'cheap',     description: 'Search ClawHub (public skill registry) for a skill matching a user intent. Returns top results with safety classification.' },
  install_skill:          { tier: 3, cost: 'medium',    description: 'Download + install a ClawHub skill into ~/.clippyai/skills/. After install, the skill is callable as skill__<slug> on the next turn — promoted to L1.' },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_META[name];
}

export function tierOf(name: string): number | undefined {
  return TOOL_META[name]?.tier;
}
