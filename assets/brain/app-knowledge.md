# Clippy App Knowledge

## Browser (Edge / Chrome)

**Process names:** msedge, chrome

**Key behaviors:**
- DON'T close existing tabs — work with what's open
- DON'T open a new browser if one is already open — use focus_window()
- Use ctrl+l to focus address bar, then type_text() for URLs
- Use ctrl+t for new tab (keeps existing tabs)
- Use mouse_scroll for scrolling: mouse_scroll(640, 400, "down")
- Use key_press("Page_Down") for page scrolling
- Use ctrl+f then type_text() for find-in-page
- Tab navigation: ctrl+tab (next), ctrl+shift+tab (previous), ctrl+1-9 (specific tab)

**Scrolling a page:**
- PREFERRED: key_press("Page_Down") or key_press("Page_Up")
- ALTERNATIVE: mouse_scroll(640, 400, "down") or mouse_scroll(640, 400, "up")
- NEVER close the page to "scroll" — that makes no sense

## Notepad

**Process name:** notepad

**Key behaviors:**
- Full accessibility support — smart_click and smart_type work well
- Keyboard shortcuts preferred for speed
- ctrl+n = new file, ctrl+o = open, ctrl+s = save
- Just type_text() after focusing — cursor is ready

## Microsoft Paint (mspaint)

**Process name:** mspaint

**Key behaviors:**
- Use smart_click to select tools: smart_click("Brushes"), smart_click("Pencil"), smart_click("Rectangle")
- Use mouse_drag for drawing shapes and lines
- Color selection: smart_click on color palette
- Canvas area is roughly center-right of the window
- After selecting a tool, wait(1) before drawing
- Typical drawing flow: smart_click(tool) → wait(1) → mouse_drag(start, end)

## Microsoft Outlook

**Process name:** olk (New Outlook), OUTLOOK (Classic)

**Key behaviors:**
- KEYBOARD ONLY — accessibility tree is unreliable
- New email: key_press("ctrl+n")
- Navigate fields: key_press("Tab") moves To → Cc → Subject → Body
- Send: key_press("ctrl+Return") — SENDS IMMEDIATELY, always confirm with user first
- After sending, don't try to verify — just report done

## File Explorer

**Process name:** explorer

**Key behaviors:**
- Use read_screen() to see file list
- Navigate with smart_click on folder names
- Address bar: key_press("ctrl+l") then type_text(path)
- Back: key_press("alt+Left")

## VS Code / Code Editors

**Process name:** Code

**Key behaviors:**
- Command palette: key_press("ctrl+shift+p")
- Quick open file: key_press("ctrl+p")
- Toggle terminal: key_press("ctrl+`")
- Save: key_press("ctrl+s")
- Find: key_press("ctrl+f")
- Don't try to smart_click on code — use keyboard navigation

## Canvas Apps (Google Docs, Figma, Notion in browser)

**Key behaviors:**
- Accessibility tree is EMPTY — use type_text() for input
- NEVER use smart_click — will hang or crash
- Click into canvas area with mouse_click, then type_text()
- Use keyboard shortcuts extensively
