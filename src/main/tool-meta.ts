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
  /**
   * Present-progressive narration the renderer shows in Clippy's bubble while
   * this tool is running. Short — fits in a 300px bubble. No trailing punctuation;
   * the renderer appends an ellipsis loader when the tool is in flight.
   *
   * Examples: "Reading your inbox", "Drafting reply", "Saving file".
   *
   * If omitted, narrationFor() falls back to a humanized verb derived from the
   * tool name AND emits a `missing_crumb` telemetry warning so we can fill the
   * table. New tools get visible narration by setting this field — no other
   * file needs to change. This is the structural fix for the "Clippy is silent
   * during execution" pattern (5 of 12 substantive support reports).
   */
  narration?: string;
}

/**
 * Resolve the narration crumb for a tool. Always returns *something* — even
 * unknown tools get a humanized fallback so the bubble is never empty during
 * execution.
 *
 * The verbose-warning path here is the SINGLE place to add a missing crumb:
 * patch the metadata above, don't special-case the tool name in the renderer.
 */
export function narrationFor(toolName: string): string {
  const meta = TOOL_META[toolName];
  if (meta?.narration) return meta.narration;
  // Humanize a tool name into a present-progressive verb.
  //   outlook_send_email      → "Outlook send email"
  //   cdp_wait_for_selector   → "Cdp wait for selector"
  // It's not pretty, but it's better than a blank bubble and gives us a
  // visible reminder to set `narration` on the tool in tool-meta.ts.
  const humanized = toolName.replace(/^skill__/, '').replace(/_/g, ' ');
  return `Working on ${humanized}`;
}

export const TOOL_META: Record<string, ToolMeta> = {
  // ── Tier 1 — local artifact generation (added by PR 2) ──────────────
  generate_qrcode:   { tier: 1, cost: 'cheap',  description: 'Render text to a QR-code PNG file', narration: 'Making a QR code' },
  generate_excel:    { tier: 1, cost: 'medium', description: 'Build an .xlsx workbook from row data (multi-sheet, exceljs, no Excel needed)', narration: 'Building your spreadsheet' },
  generate_docx:     { tier: 1, cost: 'medium', description: 'Build a .docx document from heading/paragraph/list blocks (no Word needed)', narration: 'Writing your document' },
  generate_pdf:      { tier: 1, cost: 'medium', description: 'Build a .pdf from text content with auto word-wrap (pdf-lib, no Word needed)', narration: 'Making a PDF' },

  // ── Tier 2 — OS / shell direct ──────────────────────────────────────
  read_screen:        { tier: 2, cost: 'medium',    description: 'Read what is currently on screen via the Windows accessibility tree (UIA)', narration: 'Looking at your screen' },
  smart_read:         { tier: 2, cost: 'medium',    description: 'Alias of read_screen — read the foreground UIA tree', narration: 'Looking at your screen' },
  get_active_window:  { tier: 2, cost: 'cheap',     description: 'Identify the foreground window (process name, title, bounds)', narration: 'Checking which window is active' },
  get_windows:        { tier: 2, cost: 'cheap',     description: 'List all top-level windows on the desktop', narration: 'Listing your windows' },
  get_focused_element:{ tier: 2, cost: 'cheap',     description: 'Inspect the currently focused UI element via UIA', narration: 'Inspecting the focused control' },
  open_app:           { tier: 2, cost: 'medium',    description: 'Launch a desktop application by name (Start-Process)', narration: 'Opening the app' },
  desktop_screenshot: { tier: 2, cost: 'medium',    description: 'Capture a downscaled screenshot of the primary display', narration: 'Taking a screenshot' },
  ocr_read_screen:    { tier: 2, cost: 'expensive', description: 'Run Windows.Media.Ocr over the current screenshot to read text', narration: 'Reading the screen with OCR' },
  read_clipboard:     { tier: 2, cost: 'cheap',     description: 'Read the current Windows clipboard text', narration: 'Checking the clipboard' },
  write_clipboard:    { tier: 2, cost: 'cheap',     description: 'Write text to the Windows clipboard', narration: 'Copying to clipboard' },
  read_file:          { tier: 2, cost: 'cheap',     description: 'Read a local file from disk', narration: 'Reading the file' },
  write_file:         { tier: 2, cost: 'cheap',     description: 'Write a local file to disk', narration: 'Saving the file' },
  list_files:         { tier: 2, cost: 'cheap',     description: 'List files in a directory', narration: 'Listing files' },
  search_files_content:{ tier: 2, cost: 'medium',   description: 'Search file contents for a regex/string pattern', narration: 'Searching through files' },
  // run_powershell removed v0.12.3 — security audit (prompt-injection → RCE).
  // Bundled PS scripts (outlook_*, excel_*, file ops) cover legitimate use.
  system_info:        { tier: 2, cost: 'cheap',     description: 'Get OS / hardware / disk info', narration: 'Checking system info' },
  list_processes:     { tier: 2, cost: 'cheap',     description: 'List running processes', narration: 'Listing running processes' },
  kill_process:       { tier: 2, cost: 'cheap',     description: 'Kill a process by name or PID', narration: 'Stopping the process' },
  ping_host:          { tier: 2, cost: 'medium',    description: 'Ping a network host', narration: 'Pinging' },
  http_request:       { tier: 2, cost: 'medium',    description: 'Make an HTTP request to an arbitrary URL', narration: 'Fetching from the web' },
  speak_text:         { tier: 2, cost: 'medium',    description: 'Speak text via the OS TTS engine', narration: 'Speaking' },
  minimize_all_windows:{ tier: 2, cost: 'cheap',    description: 'Minimize every top-level window (Win+M equivalent)', narration: 'Minimizing windows' },
  show_desktop:       { tier: 2, cost: 'cheap',     description: 'Show the desktop (toggle minimize-all)', narration: 'Showing the desktop' },
  minimize_window:    { tier: 2, cost: 'cheap',     description: 'Minimize a specific window by process or title', narration: 'Minimizing window' },
  wait:               { tier: 2, cost: 'cheap',     description: 'Sleep for N milliseconds (synchronization primitive)', narration: 'Waiting a moment' },
  plan:               { tier: 2, cost: 'cheap',     description: 'Record an internal plan step (no side effects)', narration: 'Thinking it through' },
  detect_webview_apps:{ tier: 2, cost: 'medium',    description: 'Detect Electron/CEF apps that may have a CDP port available', narration: 'Looking for browser-like apps' },

  // ── Tier 3a — COM application APIs ───────────────────────────────────
  outlook_send_email:  { tier: 3, cost: 'medium',    description: 'Send an email via Outlook COM (no UI)', narration: 'Sending email' },
  outlook_read_inbox:  { tier: 3, cost: 'medium',    description: 'Read recent inbox messages via Outlook COM', narration: 'Reading your inbox' },
  outlook_create_event:{ tier: 3, cost: 'medium',    description: 'Create a calendar event via Outlook COM', narration: 'Adding to your calendar' },
  outlook_upcoming:    { tier: 3, cost: 'medium',    description: 'List upcoming calendar events via Outlook COM', narration: 'Checking your calendar' },
  excel_read:          { tier: 3, cost: 'medium',    description: 'Read cells from an Excel workbook via COM', narration: 'Reading the spreadsheet' },
  excel_write:         { tier: 3, cost: 'medium',    description: 'Write cells to an Excel workbook via COM', narration: 'Updating the spreadsheet' },
  word_to_pdf:         { tier: 3, cost: 'expensive', description: 'Convert a Word document to PDF via Word COM', narration: 'Converting Word to PDF' },
  create_reminder:     { tier: 3, cost: 'medium',    description: 'Create a Windows reminder / scheduled toast', narration: 'Setting your reminder' },

  // ── Tier 3b — Web service APIs (added by PR 3) ───────────────────────
  github_create_issue: { tier: 3, cost: 'medium',    description: 'Create a GitHub issue via REST API (requires PAT in keytar:clippy.github)', narration: 'Filing a GitHub issue' },
  github_list_issues:  { tier: 3, cost: 'medium',    description: 'List GitHub issues for a repo via REST API', narration: 'Listing GitHub issues' },
  github_get_pr:       { tier: 3, cost: 'medium',    description: 'Fetch a GitHub pull request by number via REST API', narration: 'Reading the pull request' },

  // ── Tier 3c — URL scheme / shell.openExternal ────────────────────────
  navigate_browser:    { tier: 3, cost: 'medium',    description: 'Open a URL in the default browser via shell.openExternal', narration: 'Opening the browser' },
  open_url:            { tier: 3, cost: 'cheap',     description: 'Open a URL or deep-link via the OS handler — allowlisted schemes (mailto, spotify, vscode, slack, ms-teams, zoommtg, https, http, tel, sms)', narration: 'Opening the link' },
  spotify_play_uri:    { tier: 3, cost: 'cheap',     description: 'Play a Spotify track/album/playlist/artist by URI via the spotify: deep link', narration: 'Queueing Spotify' },

  // ── Tier 4 — Browser automation via CDP ──────────────────────────────
  cdp_connect:           { tier: 4, cost: 'medium',    description: 'Attach to a Chromium debugging port (CDP)', narration: 'Connecting to the browser' },
  cdp_page_context:      { tier: 4, cost: 'cheap',     description: 'Get the active CDP tab URL/title', narration: 'Checking which page you\'re on' },
  cdp_read_text:         { tier: 4, cost: 'medium',    description: 'Read text content from the CDP page (selector or full-doc)', narration: 'Reading the page' },
  cdp_click:             { tier: 4, cost: 'medium',    description: 'Click a CSS selector on the CDP page', narration: 'Clicking on the page' },
  cdp_type:              { tier: 4, cost: 'medium',    description: 'Type text into a CSS selector on the CDP page', narration: 'Typing in the page' },
  cdp_select_option:     { tier: 4, cost: 'medium',    description: 'Set a <select> value via CDP', narration: 'Picking an option' },
  cdp_evaluate:          { tier: 4, cost: 'medium',    description: 'Run arbitrary JS in the CDP page context', narration: 'Inspecting the page' },
  cdp_wait_for_selector: { tier: 4, cost: 'medium',    description: 'Wait for a CSS selector to appear in the CDP page', narration: 'Waiting for the page to load' },
  cdp_list_tabs:         { tier: 4, cost: 'cheap',     description: 'List CDP tabs/targets', narration: 'Listing your tabs' },
  cdp_switch_tab:        { tier: 4, cost: 'cheap',     description: 'Switch active CDP tab', narration: 'Switching tabs' },
  cdp_scroll:            { tier: 4, cost: 'cheap',     description: 'Scroll the CDP page', narration: 'Scrolling the page' },

  // ── Tier 5 — Desktop UI automation (PSBridge UIA + mouse/keyboard) ──
  smart_click:          { tier: 5, cost: 'expensive', description: 'Click an element by label using UIA fuzzy match (last-resort UI)', narration: 'Finding and clicking' },
  smart_type:           { tier: 5, cost: 'expensive', description: 'Type into a labeled element via UIA + keyboard (last-resort UI)', narration: 'Typing into the field' },
  focus_window:         { tier: 5, cost: 'medium',    description: 'Bring a window to the foreground via UIA / Win32', narration: 'Focusing the window' },
  type_text:            { tier: 5, cost: 'medium',    description: 'Synthesize keystrokes to type literal text into the focused window', narration: 'Typing' },
  key_press:            { tier: 5, cost: 'medium',    description: 'Synthesize a keyboard shortcut (e.g. Ctrl+S)', narration: 'Pressing the shortcut' },
  mouse_click:          { tier: 5, cost: 'medium',    description: 'Click at absolute screen coordinates', narration: 'Clicking' },
  mouse_double_click:   { tier: 5, cost: 'medium',    description: 'Double-click at absolute screen coordinates', narration: 'Double-clicking' },
  mouse_right_click:    { tier: 5, cost: 'medium',    description: 'Right-click at absolute screen coordinates', narration: 'Right-clicking' },
  mouse_hover:          { tier: 5, cost: 'cheap',     description: 'Move the cursor to absolute screen coordinates', narration: 'Hovering' },
  mouse_drag:           { tier: 5, cost: 'medium',    description: 'Drag from one set of screen coordinates to another', narration: 'Dragging' },
  mouse_scroll:         { tier: 5, cost: 'cheap',     description: 'Scroll the mouse wheel at the cursor position', narration: 'Scrolling' },

  // ── Tier 5 diagnostic (added by PR 4) ────────────────────────────────
  // clawd_status reads the clawdcursor fallback subprocess state. Tagged
  // tier 2 because it is a status read with no UI driving — it just exposes
  // whether the Tier-5 fallback is ready, installing, or disabled.
  clawd_status:         { tier: 2, cost: 'cheap',     description: 'Diagnostic — current state of the Tier-5 clawdcursor fallback subprocess (ready / disabled / installing)' },

  // ── v0.12.4 additions ──
  zip_files:            { tier: 2, cost: 'medium',    description: 'Compress files/folders into a ZIP archive', narration: 'Zipping files' },
  unzip_files:          { tier: 2, cost: 'medium',    description: 'Decompress a ZIP archive into a destination directory', narration: 'Unzipping' },
  hash_file:            { tier: 2, cost: 'cheap',     description: 'Return SHA256/MD5/SHA1/SHA384/SHA512 hash of a local file', narration: 'Hashing the file' },
  ocr_from_image:       { tier: 2, cost: 'medium',    description: 'Extract text from an image file on disk via Windows OCR', narration: 'Reading text from the image' },
  windows_service_control: { tier: 2, cost: 'cheap',  description: 'Query / start / stop / restart a Windows service by name (start/stop need admin)', narration: 'Managing the Windows service' },
  get_current_time_tz:  { tier: 1, cost: 'cheap',     description: 'Current time in any IANA timezone (e.g. "America/Los_Angeles")', narration: 'Checking the time' },
  weather_current:      { tier: 3, cost: 'cheap',     description: 'Current weather + 24h forecast via Open-Meteo (free, no API key)', narration: 'Checking the weather' },
  shortcuts_execute:    { tier: 5, cost: 'medium',    description: 'Execute a keyboard shortcut by semantic intent (e.g. "save document") — clawdcursor resolves the right combo per app', narration: 'Running the shortcut' },

  // ── v0.13.0 additions ──
  // outlook_send_email is the canonical dispatcher; the two web recipes
  // are exposed individually too so the model can pick them deliberately
  // when it knows the user is on outlook-web or gmail-web specifically.
  // Result shape: { ok, via, to, subject, sent: true | false | 'unverified', confirmation, error?, warning? }.
  // CRITICAL — if sent === 'unverified', the email may or may not have gone out.
  // Tell the user verbatim that you couldn't confirm the send and to check their
  // Sent Items. Never report a verified-send to the user when sent is 'unverified'
  // or false.
  outlook_web_send_email: { tier: 4, cost: 'medium', description: 'Send email via outlook.live.com using a deterministic CDP recipe. Returns sent: true ONLY on positive confirmation (Sent toast, sent-items count incremented, or URL→/sentitems). Returns sent: \'unverified\' when compose closed but no positive signal — DO NOT claim success in that case.', narration: 'Sending via Outlook web' },
  gmail_web_send_email:   { tier: 4, cost: 'medium', description: 'Send email via mail.google.com using a deterministic CDP recipe (with verified "Message sent" snackbar)', narration: 'Sending via Gmail' },
  // clawd_task is L5 — plain-English desktop task delegation to clawdcursor
  // for tasks that don't fit any L1-L4 native or recipe path.
  clawd_task:             { tier: 5, cost: 'expensive', description: 'L5 LAST RESORT — delegate a plain-English desktop task to clawdcursor when no native tool, browser recipe, or installed skill fits', narration: 'Handing off to the fallback agent' },

  // ── v0.14.0 additions: ClawHub skill registry ──
  find_skill:             { tier: 3, cost: 'cheap',     description: 'Search ClawHub (public skill registry) for a skill matching a user intent. Returns top results with safety classification.', narration: 'Searching for a skill' },
  install_skill:          { tier: 3, cost: 'medium',    description: 'Download + install a ClawHub skill into ~/.clippyai/skills/. After install, the skill is callable as skill__<slug> on the next turn — promoted to L1.', narration: 'Installing the skill' },

  // ── v0.15.0 additions: high-level browser tools (mcp-chrome → CDP fallback) ──
  browser_navigate:  { tier: 4, cost: 'medium', description: 'Navigate the browser to a URL. Uses the user\'s real signed-in browser when mcp-chrome extension is installed; otherwise spawns a debug-flagged browser.', narration: 'Opening the page' },
  browser_click:     { tier: 4, cost: 'medium', description: 'Click an element by CSS selector OR text. Routes through mcp-chrome if available (real signed-in browser).', narration: 'Clicking on the page' },
  browser_type:      { tier: 4, cost: 'medium', description: 'Type text into a form field (selector or aria-label). Routes through mcp-chrome if available.', narration: 'Typing in the field' },
  browser_read_text: { tier: 4, cost: 'cheap',  description: 'Read text content from a page element (default body). Routes through mcp-chrome if available.', narration: 'Reading the page' },
  browser_list_tabs: { tier: 4, cost: 'cheap',  description: 'List all open browser tabs. mcp-chrome only — CDP attach is single-tab.', narration: 'Listing your tabs' },
  browser_switch_tab:{ tier: 4, cost: 'cheap',  description: 'Switch to a tab by id, url-substring, or title-substring. mcp-chrome only.', narration: 'Switching tabs' },
  clawd_status:         { tier: 2, cost: 'cheap',     description: 'Diagnostic — current state of the Tier-5 clawdcursor fallback subprocess (ready / disabled / installing)', narration: 'Checking fallback status' },
};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_META[name];
}

export function tierOf(name: string): number | undefined {
  return TOOL_META[name]?.tier;
}
