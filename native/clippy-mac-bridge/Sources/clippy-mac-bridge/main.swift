// main.swift — clippy-mac-bridge subcommand dispatcher.
//
// Usage:
//   clippy-mac-bridge <subcommand> [args...]
//
// Subcommands (see per-file implementations):
//   screenshot         (Screenshot.swift)   — vision
//   ocr                (OCR.swift)          — Vision text recognition on a PNG
//   ocr-screen         (OCR.swift)          — screenshot + ocr chained
//   a11y-tree          (A11y.swift)         — AX tree of a process or all
//   a11y-find          (A11y.swift)         — find element by text/role
//   a11y-focused       (A11y.swift)         — currently focused element
//   a11y-click         (A11y.swift)         — invoke an element by AX path
//   a11y-set-value     (A11y.swift)         — set value on an editable element
//   a11y-focused-set-value (A11y.swift)     — read+rewrite the focused element's value
//   a11y-selected-text (A11y.swift)         — text the user has highlighted/selected
//   a11y-press         (A11y.swift)         — AXPressAction on an element
//   windows            (WindowMgr.swift)    — list windows
//   active-window      (WindowMgr.swift)    — frontmost window
//   focus-window       (WindowMgr.swift)    — focus by pid (+ title substring)
//   minimize-window    (WindowMgr.swift)    — collapse to Dock
//   maximize-window    (WindowMgr.swift)    — zoom button equivalent
//   hide-app           (WindowMgr.swift)    — App → Hide
//   minimize-all       (WindowMgr.swift)    — Mission Control "show desktop"
//   show-desktop       (WindowMgr.swift)    — same; toggle
//   type               (Input.swift)        — typed text via CGEvent unicode
//   keypress           (Input.swift)        — key combo (cmd+s etc.)
//   click              (Input.swift)        — mouse click at (x,y)
//   hover              (Input.swift)        — mouse move only
//   drag               (Input.swift)        — real drag from→to
//   scroll             (Input.swift)        — scroll-wheel event at (x,y)
//   active-app         (Sys.swift)          — frontmost NSRunningApplication
//   running-apps       (Sys.swift)          — list all
//   browser-url        (Sys.swift)          — frontmost browser URL+tabs
//   clipboard-read     (Sys.swift)          — NSPasteboard.general string
//   clipboard-write    (Sys.swift)          — write to NSPasteboard
//   permissions        (Sys.swift)          — TCC probe (screen, AX, automation)
//   request-screen-recording (Sys.swift)   — trigger native Screen-Recording dialog
//
// Exit codes: see JSON.swift.

import Foundation

guard CommandLine.arguments.count >= 2 else {
    emitError(
        "usage: clippy-mac-bridge <subcommand> [args...]. See main.swift for the list.",
        code: 2
    )
}

let subcommand = CommandLine.arguments[1]

switch subcommand {
// Vision
case "screenshot":      runScreenshot()
case "ocr":             runOCR()
case "ocr-screen":      runOCRScreen()

// A11y
case "a11y-tree":       runA11yTree()
case "a11y-find":       runA11yFind()
case "a11y-focused":    runA11yFocused()
case "a11y-click":      runA11yClick()
case "a11y-set-value":  runA11ySetValue()
case "a11y-focused-set-value": runA11yFocusedSetValue()
case "a11y-selected-text": runA11ySelectedText()
case "a11y-press":      runA11yPress()

// Window mgmt
case "windows":         runListWindows()
case "active-window":   runActiveWindow()
case "focus-window":    runFocusWindow()
case "minimize-window": runMinimizeWindow()
case "maximize-window": runMaximizeWindow()
case "hide-app":        runHideApp()
case "minimize-all":    runMinimizeAll()
case "show-desktop":    runShowDesktop()

// Input
case "type":            runType()
case "keypress":        runKeypress()
case "click":           runClick()
case "hover":           runHover()
case "drag":            runDrag()
case "scroll":          runScroll()

// System state
case "active-app":      runActiveApp()
case "running-apps":    runRunningApps()
case "browser-url":     runBrowserURL()
case "clipboard-read":  runClipboardRead()
case "clipboard-write": runClipboardWrite()
case "permissions": runPermissions()
case "request-screen-recording": runRequestScreenRecording()

// Help
case "-h", "--help", "help":
    emit([
        "name": "clippy-mac-bridge",
        "version": "0.20.0",
        "subcommands": [
            "vision": ["screenshot", "ocr", "ocr-screen"],
            "a11y": ["a11y-tree", "a11y-find", "a11y-focused", "a11y-click", "a11y-set-value", "a11y-focused-set-value", "a11y-selected-text", "a11y-press"],
            "windows": ["windows", "active-window", "focus-window", "minimize-window", "maximize-window", "hide-app", "minimize-all", "show-desktop"],
            "input": ["type", "keypress", "click", "hover", "drag", "scroll"],
            "sys": ["active-app", "running-apps", "browser-url", "clipboard-read", "clipboard-write", "permissions", "request-screen-recording"]
        ]
    ])

default:
    emitError(
        "unknown subcommand: \(subcommand). Run `clippy-mac-bridge help` for the list.",
        code: 2
    )
}
