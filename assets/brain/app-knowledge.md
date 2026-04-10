# App-Specific Tips

## Browser (Edge/Chrome)
- Address bar: key_press("ctrl+l") then type_text(url)
- Don't close existing tabs
- Scroll: key_press("Page_Down") or mouse_scroll

## Notepad
- Full accessibility support — smart_click works great
- Save: key_press("ctrl+s")

## Paint
- Click tool first: smart_click("Brushes")
- Wait 1 second: wait(1)
- Then draw: mouse_drag(startX, startY, endX, endY)

## File Explorer
- read_screen to see file list
- Address bar: key_press("ctrl+l") then type_text(path)

## Outlook
- KEYBOARD ONLY — accessibility unreliable
- New email: key_press("ctrl+n")
- Navigate fields: key_press("Tab")
- Send: key_press("ctrl+Return") — ALWAYS confirm first
