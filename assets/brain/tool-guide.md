# Clippy Tool Guide

## Available Tools & When to Use Them

### Perception Tools (Read the screen)
| Tool | Use When | Params |
|------|----------|--------|
| read_screen | FIRST ALWAYS — see UI elements | {} or {"filter":"interactive"} |
| get_active_window | Quick check what app is focused | {} |
| desktop_screenshot | Only when text methods fail | {} |

### Action Tools (Do things)
| Tool | Use When | Params |
|------|----------|--------|
| smart_click | Click a button/menu by its text | {"target":"Save"} |
| smart_type | Type into a labeled input field | {"target":"Search","text":"query"} |
| type_text | Type at current cursor position | {"text":"hello world"} |
| key_press | Keyboard shortcut | {"key":"ctrl+s"} |
| mouse_click | Click specific coordinates | {"x":500,"y":300} |
| mouse_drag | Draw or drag | {"startX":300,"startY":400,"endX":500,"endY":400} |
| mouse_scroll | Scroll up/down | {"x":640,"y":400,"direction":"down"} |

### App Management
| Tool | Use When | Params |
|------|----------|--------|
| open_app | Open an application | {"name":"notepad"} |
| focus_window | Bring existing window to front | {"title":"Paint"} or {"processName":"mspaint"} |
| wait | Pause for UI to settle | {"seconds":2} |

### Browser Tools (Web pages)
| Tool | Use When | Params |
|------|----------|--------|
| navigate_browser | Open a URL (auto-enables CDP) | {"url":"https://..."} |
| cdp_connect | Connect to browser for DOM control | {} |
| cdp_read_text | Read text from a webpage | {} or {"selector":"article"} |
| cdp_click | Click element by CSS selector or text | {"selector":"#submit"} or {"text":"Sign In"} |
| cdp_type | Type into a web input | {"selector":"#search","text":"query"} or {"label":"Search","text":"query"} |
| cdp_page_context | List all interactive elements on page | {} |
| cdp_list_tabs | List open browser tabs | {} |
| cdp_switch_tab | Switch to a tab by URL or title | {"target":"github"} |
| cdp_evaluate | Run JavaScript on the page | {"javascript":"document.title"} |
| cdp_scroll | Scroll the page | {"direction":"down"} |

### Web Browsing Flow
To browse and interact with web pages:
1. navigate_browser(url) — opens URL and enables CDP
2. cdp_connect() — connect to the browser
3. cdp_read_text() — read the page content
4. cdp_click(text) / cdp_type(label, text) — interact with elements

To read current page without navigating:
1. cdp_connect() — connect to current browser
2. cdp_read_text() — read visible text

## Common Keyboard Shortcuts (prefer these over clicking)

| Action | Shortcut |
|--------|----------|
| Save | ctrl+s |
| Undo | ctrl+z |
| Redo | ctrl+y |
| Copy | ctrl+c |
| Paste | ctrl+v |
| Select all | ctrl+a |
| Find | ctrl+f |
| New tab | ctrl+t |
| Close tab | ctrl+w |
| Address bar | ctrl+l |
| Switch window | alt+tab |
| Scroll down | Page_Down |
| Scroll up | Page_Up |
| Confirm dialog | Return |
| Cancel dialog | Escape |

## Error Recovery Matrix

| Problem | Solution |
|---------|----------|
| smart_click can't find element | read_screen() to get coordinates → mouse_click(x,y) |
| type_text goes to wrong place | focus_window() first, then try again |
| App didn't open | wait(3), then read_screen() to check |
| Wrong window focused | get_active_window() → focus_window(correct_one) |
| Action seems to do nothing | read_screen() to see current state, try different approach |
