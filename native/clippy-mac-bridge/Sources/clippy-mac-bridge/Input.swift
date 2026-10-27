// Input.swift
//
// CGEvent-based input synthesis: keyboard typing, key-combo presses,
// mouse clicks, hover, drag, and scroll-wheel events.
//
// Why CGEvent (and not AppleScript / pbcopy+cmd+v / arrow-key fakes)
// ──────────────────────────────────────────────────────────────────
// The Windows codebase reached for clipboard-paste to "type" text and
// arrow-key presses to "scroll". Both break user state (clobbers
// clipboard, fights focused element) and neither maps to real input.
//
// CGEvent is the same path the OS itself uses to deliver input. Posted
// events flow through `kCGHIDEventTap` and get translated by the
// system event server — they're indistinguishable to receivers from
// real hardware events. The cost is the Accessibility permission gate
// (synthesizing input into OTHER apps is what Accessibility actually
// authorizes; Input Monitoring is for receiving global events, not
// sending them — different TCC entry).
//
// Coordinate space
// ────────────────
// CGEvent uses **top-left origin in points** — the same space as the
// AX bounds the find subcommand emits and the same space accepted by
// `/usr/sbin/screencapture -R`. We do NOT flip Y here. The Cocoa
// flipped/unflipped distinction only bites when you cross into
// NSWindow.frame land; CGEvent is consistently top-left.
//
// Permission failures
// ───────────────────
// `AXIsProcessTrusted()` is the gate. If it returns false, every
// subcommand here exits with code 1 + a structured error so the TS
// wrapper can surface "open System Settings → Privacy & Security →
// Accessibility" to the user. We do NOT call `AXIsProcessTrustedWithOptions`
// with the prompt flag — pre-prompting from a CLI is jarring and
// macOS already shows its own dialog the first time we try to post.

import Foundation
import CoreGraphics
import AppKit

// MARK: - Permission gate

/// Centralised AX-trust check. All input synthesis funnels through this.
/// On denial: emit standard permission-denied JSON and exit 1.
private func requireAXTrust() {
    if !AXIsProcessTrusted() {
        emitError(
            "Accessibility permission denied — open System Settings → Privacy & Security → Accessibility and enable ClippyAI.",
            code: 1,
            extra: ["permission": "accessibility"]
        )
    }
}

// MARK: - Tunables

/// Sleep between per-character keyDown/keyUp pairs in `type`. 5ms is
/// the empirical sweet spot — fast enough to feel instant for a 100-char
/// prompt (~500ms total), slow enough that React/SwiftUI re-render
/// loops don't drop input events on contended apps.
private let TYPE_INTER_CHAR_MICROS: UInt32 = 5_000

/// Sleep between a click's mouseDown and mouseUp. Real users click
/// faster than this but 10ms is close enough that apps treat it as a
/// click rather than a hold gesture.
private let CLICK_DOWN_UP_MICROS: UInt32 = 10_000

/// Number of interpolated mouseDragged events between drag start and
/// end. >=8 is the spec floor for "smooth"; we ship 10 to leave headroom.
private let DRAG_STEPS = 10

// MARK: - Key code lookup

/// US-ANSI key codes (HIToolbox kVK_*). Position-based — these are
/// physical key positions, NOT character mappings. That means `cmd+s`
/// on AZERTY hits the same physical key as `cmd+s` on QWERTY,
/// matching how the user actually pressed it.
///
/// Source: HIToolbox/Events.h kVK_ANSI_* constants. Hardcoded rather
/// than imported because we only need a small subset and want zero
/// Carbon dependency in the binary.
private let KEY_CODES: [String: Int64] = [
    // Letters
    "a": 0,  "b": 11, "c": 8,  "d": 2,  "e": 14, "f": 3,  "g": 5,  "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1,  "t": 17, "u": 32, "v": 9,  "w": 13, "x": 7,
    "y": 16, "z": 6,
    // Digits (top row, not numpad)
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
    // Named keys
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    // Function row
    "f1": 122, "f2": 120, "f3": 99,  "f4": 118, "f5": 96,  "f6": 97,
    "f7": 98,  "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    // Punctuation
    "comma": 43, ",": 43,
    "period": 47, ".": 47,
    "slash": 44, "/": 44,
    "semicolon": 41, ";": 41,
    "quote": 39, "'": 39,
    "backslash": 42, "\\": 42,
    "minus": 27, "-": 27,
    "equal": 24, "=": 24,
    "leftbracket": 33, "[": 33,
    "rightbracket": 30, "]": 30,
    "grave": 50, "`": 50,
]

// MARK: - Modifier parsing

/// Map a modifier name to its CGEventFlags bit. Returns nil if the
/// token isn't a recognised modifier — caller treats it as the main
/// key in that case.
private func modifierFlag(_ token: String) -> CGEventFlags? {
    switch token.lowercased() {
    case "cmd", "command", "meta", "win":   return .maskCommand
    case "shift":                           return .maskShift
    case "alt", "option", "opt":            return .maskAlternate
    case "ctrl", "control":                 return .maskControl
    case "fn":                              return .maskSecondaryFn
    default:                                return nil
    }
}

/// Parse "cmd+shift+s" → (CGEventFlags, "s"). Throws no errors; an
/// unrecognised final key is reported by the caller doing key-code lookup.
private func parseCombo(_ combo: String) -> (flags: CGEventFlags, key: String) {
    let parts = combo.split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    var flags: CGEventFlags = []
    var key = ""
    for p in parts {
        if let f = modifierFlag(p) {
            flags.insert(f)
        } else {
            // Last non-modifier token wins. "cmd+s" → "s".
            key = p.lowercased()
        }
    }
    return (flags, key)
}

/// Parse a comma-separated modifier list ("cmd,shift") → CGEventFlags.
private func parseModifierList(_ list: String) -> CGEventFlags {
    var flags: CGEventFlags = []
    for token in list.split(separator: ",") {
        if let f = modifierFlag(String(token).trimmingCharacters(in: .whitespaces)) {
            flags.insert(f)
        }
    }
    return flags
}

// MARK: - Coordinate sanity

/// Sanity-check (x,y) against the union of all displays. We allow
/// slightly off-screen coordinates (negative-y secondary display
/// layouts, etc.) but reject obvious garbage like 1e9. Returns true
/// if the point is reasonable.
private func pointIsReasonable(_ p: CGPoint) -> Bool {
    // Union of all screen frames, padded by 200pt on each side to
    // tolerate scaling math + small layout quirks.
    var union: CGRect = .null
    for screen in NSScreen.screens {
        // NSScreen.frame is in bottom-left Cocoa space; we just need
        // a bounding box to reject 1e9-style garbage, so we treat
        // it as opaque rect math.
        union = union.union(screen.frame)
    }
    if union.isNull { return p.x >= -2000 && p.x <= 20000 && p.y >= -2000 && p.y <= 20000 }
    let padded = union.insetBy(dx: -200, dy: -200)
    // We need to compare against both top-left and bottom-left spaces
    // since the user can pass either; allow if EITHER orientation fits.
    let pTL = p
    let pBL = CGPoint(x: p.x, y: union.maxY - p.y)
    return padded.contains(pTL) || padded.contains(pBL)
}

// MARK: - `type` — unicode payload

/// Send `text` as a stream of synthetic keyboard events, one
/// keyDown+keyUp pair per Swift Character. We use
/// `CGEventKeyboardSetUnicodeString` so the OS treats the event as
/// "type this glyph" rather than "press this physical key" — which
/// is the only way emoji, RTL Arabic, ZWJ-composed sequences, and
/// accented characters round-trip correctly without a key-code lookup
/// table that would still be wrong on non-US layouts.
///
/// We deliberately do NOT use `pbcopy` + `cmd+v` — the legacy Windows
/// port did, and it clobbers whatever the user had on the clipboard.
/// The unicode-payload approach is the entire reason this subcommand
/// exists.
func runType() {
    requireAXTrust()
    guard let text = argValue(name: "--text") else {
        emitError("--text is required", code: 2)
    }
    if text.isEmpty {
        emit(["ok": true, "chars": 0])
    }

    // We iterate Swift Characters (extended grapheme clusters), not
    // bytes or scalars. A single user-perceived character like an
    // emoji-with-skin-tone may be multiple UTF-16 code units — we want
    // to send them as ONE keyboard event so the target app sees it
    // atomically.
    var sent = 0
    for char in text {
        let utf16 = Array(String(char).utf16)
        // keyCode=0 is a dummy — when SetUnicodeString is called, the
        // event delivers the unicode payload instead of looking up a
        // glyph for the key code. We still need keyDown + keyUp so the
        // receiving app gets a complete press cycle.
        guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        else {
            emitError("CGEvent creation failed for character at index \(sent)", code: 3)
        }
        utf16.withUnsafeBufferPointer { ptr in
            if let base = ptr.baseAddress {
                keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: base)
                keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: base)
            }
        }
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
        sent += 1
        usleep(TYPE_INTER_CHAR_MICROS)
    }
    emit(["ok": true, "chars": sent])
}

// MARK: - `keypress` — combo or explicit key code

/// Synthesize a single keyDown+keyUp with optional modifier flags
/// riding on the events. Two argument shapes:
///
///   --combo "cmd+shift+s"           parsed into (flags, key) and looked up
///   --key-code 36 [--modifiers cmd] explicit code, no parsing
///
/// We do NOT post separate keyDown/Up events for each modifier — the
/// system handles modifier flags as event metadata, and firing
/// e.g. cmdDown / sDown / sUp / cmdUp introduces a window where the
/// target sees "lonely cmd" which can trigger menus etc.
func runKeypress() {
    requireAXTrust()

    var flags: CGEventFlags = []
    var keyCode: Int64 = -1
    var label = ""

    if let combo = argValue(name: "--combo") {
        let parsed = parseCombo(combo)
        flags = parsed.flags
        guard let code = KEY_CODES[parsed.key] else {
            emitError("unknown key in combo: '\(parsed.key)' (combo: '\(combo)')", code: 2)
        }
        keyCode = code
        label = combo
    } else if let raw = argValue(name: "--key-code") {
        guard let code = Int64(raw) else {
            emitError("--key-code must be an integer", code: 2)
        }
        keyCode = code
        if let mods = argValue(name: "--modifiers") {
            flags = parseModifierList(mods)
        }
        label = "key-code \(code)"
    } else {
        emitError("--combo or --key-code is required", code: 2)
    }

    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(keyCode), keyDown: false)
    else {
        emitError("CGEvent creation failed for key code \(keyCode)", code: 3)
    }

    // Modifier flags ride on BOTH events. If we only set on keyDown,
    // the OS sometimes clears the modifier mid-event when keyUp arrives
    // without it set, causing apps like Xcode to see "cmd+s released
    // before s actually went up" and dropping the shortcut.
    keyDown.flags = flags
    keyUp.flags = flags

    keyDown.post(tap: .cghidEventTap)
    usleep(CLICK_DOWN_UP_MICROS)
    keyUp.post(tap: .cghidEventTap)

    emit(["ok": true, "combo": label])
}

// MARK: - `click` — single / double / triple, any button

/// Map the `--button` arg to (CGMouseButton, downType, upType).
/// `.otherMouseDown` / `.otherMouseUp` for middle-click — there's no
/// dedicated middle-button type on macOS, you set the button via
/// CGEventCreateMouseEvent's `mouseButton` arg.
private func mouseEventTypes(button: String) -> (CGMouseButton, CGEventType, CGEventType)? {
    switch button.lowercased() {
    case "left":   return (.left, .leftMouseDown, .leftMouseUp)
    case "right":  return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default:       return nil
    }
}

/// Post a click — single, double, or triple — at (x,y).
///
/// For multi-click (count>1), we set `.mouseEventClickState` on each
/// DOWN event to the click number (1, 2, 3). Without this, the target
/// app sees two independent single clicks instead of a double-click,
/// which means e.g. text fields don't enter "select word" mode and
/// folders in Finder don't open. Apple's docs are silent on this but
/// the field is documented in the CGEventField enum.
func runClick() {
    requireAXTrust()
    guard let xs = argValue(name: "--x"), let x = Double(xs) else {
        emitError("--x is required and must be numeric", code: 2)
    }
    guard let ys = argValue(name: "--y"), let y = Double(ys) else {
        emitError("--y is required and must be numeric", code: 2)
    }
    let point = CGPoint(x: x, y: y)
    if !pointIsReasonable(point) {
        emitError("(\(x),\(y)) is outside any display bounds", code: 2)
    }

    let buttonArg = argValue(name: "--button") ?? "left"
    guard let (button, downType, upType) = mouseEventTypes(button: buttonArg) else {
        emitError("--button must be one of: left, right, middle", code: 2)
    }

    let countArg = argValue(name: "--count").flatMap(Int.init) ?? 1
    let count = max(1, min(3, countArg))

    for i in 1...count {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
        else {
            emitError("CGEvent creation failed for click \(i)/\(count)", code: 3)
        }
        // Click-state: 1 for single, 2 for double, 3 for triple. The
        // DOWN event carries it; UP inherits via the same field for
        // symmetry (some apps gate on UP, others on DOWN).
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down.post(tap: .cghidEventTap)
        usleep(CLICK_DOWN_UP_MICROS)
        up.post(tap: .cghidEventTap)
        if i < count {
            // Inter-click spacing — short enough for the OS to count
            // it as a multi-click (default double-click interval is
            // ~500ms in System Settings).
            usleep(CLICK_DOWN_UP_MICROS)
        }
    }
    emit(["ok": true])
}

// MARK: - `hover` — pure mouseMoved

/// One `.mouseMoved` event at (x,y), no buttons. Used by the brain to
/// settle the cursor before a follow-up scroll (some apps only scroll
/// under the cursor) or to surface hover-only UI like tooltips.
func runHover() {
    requireAXTrust()
    guard let xs = argValue(name: "--x"), let x = Double(xs) else {
        emitError("--x is required and must be numeric", code: 2)
    }
    guard let ys = argValue(name: "--y"), let y = Double(ys) else {
        emitError("--y is required and must be numeric", code: 2)
    }
    let point = CGPoint(x: x, y: y)
    if !pointIsReasonable(point) {
        emitError("(\(x),\(y)) is outside any display bounds", code: 2)
    }
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    else {
        emitError("CGEvent creation failed for hover", code: 3)
    }
    move.post(tap: .cghidEventTap)
    emit(["ok": true])
}

// MARK: - `drag` — real CGEvent drag sequence

/// Parse "100,200" → (100.0, 200.0). Returns nil on parse failure.
private func parsePoint(_ s: String?) -> CGPoint? {
    guard let s = s else { return nil }
    let parts = s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard parts.count == 2, let x = Double(parts[0]), let y = Double(parts[1]) else { return nil }
    return CGPoint(x: x, y: y)
}

/// Synthesize a real mouse drag from `--from` to `--to`. The legacy
/// AppleScript stub did "click at A, click at B" which does NOT drag
/// — it leaves the target with two unrelated clicks and no selection
/// rectangle. Real drag = mouseDown at A → N mouseDragged steps
/// interpolating A→B → mouseUp at B, with small sleeps between steps
/// so the target sees a smooth gesture rather than a teleport.
///
/// Step count is `DRAG_STEPS` (10), exceeding the spec floor of 8.
/// Duration is `--duration-ms` (default 300, clamped 100-2000).
func runDrag() {
    requireAXTrust()
    guard let from = parsePoint(argValue(name: "--from")) else {
        emitError("--from is required, format 'x,y'", code: 2)
    }
    guard let to = parsePoint(argValue(name: "--to")) else {
        emitError("--to is required, format 'x,y'", code: 2)
    }
    if !pointIsReasonable(from) || !pointIsReasonable(to) {
        emitError("drag endpoints outside display bounds", code: 2)
    }
    let durationMs = max(100, min(2000, argValue(name: "--duration-ms").flatMap(Int.init) ?? 300))
    let perStepMicros = UInt32((durationMs * 1000) / DRAG_STEPS)

    // mouseDown at start. The button field IS clicked-state, not
    // independently controllable from up/down event types — we use
    // .leftMouseDown / .leftMouseUp.
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)
    else {
        emitError("CGEvent creation failed for drag start", code: 3)
    }
    down.post(tap: .cghidEventTap)
    usleep(perStepMicros)

    // Interpolated mouseDragged events. The OS will see N+1 distinct
    // points (including the start), which apps interpret as a
    // continuous drag.
    for step in 1...DRAG_STEPS {
        let t = Double(step) / Double(DRAG_STEPS)
        let p = CGPoint(
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t
        )
        guard let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
        else {
            emitError("CGEvent creation failed for drag step \(step)", code: 3)
        }
        drag.post(tap: .cghidEventTap)
        usleep(perStepMicros)
    }

    // mouseUp at end.
    guard let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)
    else {
        emitError("CGEvent creation failed for drag end", code: 3)
    }
    up.post(tap: .cghidEventTap)

    emit(["ok": true])
}

// MARK: - `scroll` — real wheel events

/// Post a scroll-wheel event at (x,y). We hover the cursor there first
/// because some apps (Safari, Chrome) only scroll under the cursor —
/// without the hover, the scroll goes to whatever was previously
/// focused, which is rarely what the brain wanted.
///
/// dy positive = scroll up (content moves down); dy negative = scroll
/// down. This matches the natural-scroll convention macOS ships with
/// by default; if the user inverted it in System Settings, the OS
/// re-inverts at delivery and downstream apps still see the "right"
/// direction. We pass the value through unchanged.
///
/// Replaces the arrow-key-press approximation that pretended to scroll
/// by hammering Down N times — broken on inputs/sidebars where Down
/// has its own meaning.
func runScroll() {
    requireAXTrust()
    guard let xs = argValue(name: "--x"), let x = Double(xs) else {
        emitError("--x is required and must be numeric", code: 2)
    }
    guard let ys = argValue(name: "--y"), let y = Double(ys) else {
        emitError("--y is required and must be numeric", code: 2)
    }
    let point = CGPoint(x: x, y: y)
    if !pointIsReasonable(point) {
        emitError("(\(x),\(y)) is outside any display bounds", code: 2)
    }
    guard let dys = argValue(name: "--dy"), let dy = Int32(dys) else {
        emitError("--dy is required and must be an integer", code: 2)
    }
    let dx = argValue(name: "--dx").flatMap(Int32.init) ?? 0

    // Hover first so the scroll lands under the cursor.
    if let hover = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        hover.post(tap: .cghidEventTap)
        usleep(5_000)
    }

    // Default unit is pixel — matches the trackpad's natural feel and
    // gives sub-line precision (lines = "this many notches of a real
    // scroll wheel", way too coarse for modern UIs). Caller can
    // override with `--unit line` for the rare case where a target app
    // ignores pixel scrolls (some old Carbon apps).
    let unitArg = argValue(name: "--unit") ?? "pixel"
    let unit: CGScrollEventUnit = unitArg.lowercased() == "line" ? .line : .pixel

    // wheelCount=2: wheel1=y, wheel2=x. The 3-wheel variant exists
    // but no current Mac has a Z-axis scroll wheel.
    guard let scroll = CGEvent(scrollWheelEvent2Source: nil, units: unit, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    else {
        emitError("CGEvent creation failed for scroll", code: 3)
    }
    scroll.post(tap: .cghidEventTap)

    emit(["ok": true])
}
