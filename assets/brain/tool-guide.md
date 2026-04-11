# Tools

Return ONE tool per response as JSON.

## See the screen
- read_screen → {} → UI elements with names and positions
- get_active_window → {} → which app is focused
- desktop_screenshot → {} → full screen capture

## Do things
- open_app → {"name":"notepad"} → launch an app
- focus_window → {"processName":"notepad"} or {"title":"Paint"} → bring window to front
- smart_click → {"target":"Save"} → click element by name
- smart_type → {"target":"Search","text":"hello"} → type into labeled field
- type_text → {"text":"hello"} → type at cursor
- key_press → {"key":"ctrl+s"} → keyboard shortcut
- mouse_click → {"x":500,"y":300} → click coordinates
- mouse_drag → {"startX":100,"startY":200,"endX":300,"endY":400} → drag
- mouse_scroll → {"x":640,"y":400,"direction":"down"} → scroll
- navigate_browser → {"url":"https://..."} → open URL
- wait → {"seconds":2} → pause

## Shortcuts (prefer over clicking)
ctrl+s save, ctrl+z undo, ctrl+c copy, ctrl+v paste, ctrl+a select all,
ctrl+f find, ctrl+t new tab, ctrl+l address bar, ctrl+w close tab, alt+tab switch

## Response format
{"action":"tool_name","params":{},"message":"what you're doing","done":false}
When finished: {"action":null,"params":{},"message":"Done!","done":true}
