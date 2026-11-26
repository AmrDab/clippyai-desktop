// clippy-input-monitor — long-running, listen-only keyboard monitor.
//
// Privacy contract
// ────────────────
//   • Starts DISABLED. Emits nothing until the parent sends `enable`.
//   • `disable` calls CGEventTapEnable(tap, false) so the OS delivers ZERO
//     events to us — used when Clippy sleeps or "closes its eyes".
//   • Password fields: macOS suppresses key content during secure input;
//     we double-guard with IsSecureEventInputEnabled() and never emit a
//     character while secure input is on.
//   • Listen-only tap: we never modify or block events (.listenOnly).
//   • `enable-wake` ("hey clippy" listening): only a-z, space and a few named
//     keys leave this process; nothing posted by another process (Clippy's
//     own typing) and nothing typed with ⌘/⌃/⌥ held.
//
// Protocol
// ────────
//   stdout (NDJSON, one object per line):
//     {"t":"ready","listen":true|false}
//     {"t":"key","ch":"a"}            ("syn":true when posted by a process)
//     {"t":"special","key":"escape"}
//     {"t":"secure","on":true|false}
//     {"t":"perm","listen":false}
//     {"t":"reset"}                   (frontmost app changed)
//   stdin (one command per line): enable | enable-wake | disable | quit
//
// Permission: a listen-only CGEventTap needs the Input Monitoring TCC grant.
// We preflight with CGPreflightListenEventAccess() and, on first `enable`,
// trigger the system prompt with CGRequestListenEventAccess().

import Foundation
import AppKit
import CoreGraphics
import Carbon

// ── Global state (the tap callback is a C function pointer; it needs to
//    reach state without a captured context, so we keep a singleton). ──
final class Monitor {
    static let shared = Monitor()
    var tap: CFMachPort?
    var runLoopSource: CFRunLoopSource?
    var enabled = false
    var wakeOnly = false
    var lastSecure = false
}

// Non-text keys we surface by name (keyDown that produces no printable char).
let specialKeys: [Int64: String] = [
    53: "escape",
    36: "return",
    48: "tab",
    51: "delete",
    123: "left", 124: "right", 125: "down", 126: "up",
]

// Named keys in wake-only mode: backspace edits the phrase, the rest clear it.
let wakeSpecialKeys: [Int64: String] = [
    51: "backspace",
    53: "escape",
    36: "return", 76: "return",
    48: "tab",
    123: "left", 124: "right", 125: "down", 126: "up",
]

/// Emit one NDJSON line to stdout and flush. Single-threaded (main run loop).
func emit(_ obj: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    if let out = line.data(using: .utf8) {
        FileHandle.standardOutput.write(out)
    }
}

func isSecureInputOn() -> Bool {
    // Swift imports IsSecureEventInputEnabled() as returning Bool.
    return IsSecureEventInputEnabled()
}

/// The listen-only tap callback. Runs on the main run loop.
func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    let m = Monitor.shared

    // The OS disables a tap if it ever blocks/times out. Re-arm it.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = m.tap, m.enabled { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    guard m.enabled else { return Unmanaged.passUnretained(event) }

    // Secure input (password fields): report state transitions, never emit.
    let secure = isSecureInputOn()
    if secure != m.lastSecure {
        m.lastSecure = secure
        emit(["t": "secure", "on": secure])
    }
    if secure { return Unmanaged.passUnretained(event) }

    guard type == .keyDown else { return Unmanaged.passUnretained(event) }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    // Real keyboard events carry source pid 0; events posted by a process
    // (CGEventPost, e.g. Clippy typing for the user) carry that process's pid.
    let synthetic = event.getIntegerValueField(.eventSourceUnixProcessID) != 0

    // Extract the produced unicode character(s), if any.
    var length: Int = 0
    var chars = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(
        maxStringLength: 8,
        actualStringLength: &length,
        unicodeString: &chars
    )

    if m.wakeOnly {
        if synthetic { return Unmanaged.passUnretained(event) }
        let flags = event.flags
        if flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate) {
            return Unmanaged.passUnretained(event)
        }
        if let name = wakeSpecialKeys[keyCode] {
            emit(["t": "special", "key": name])
        } else if length == 1 {
            var v = UInt32(chars[0])
            if v >= 0x41 && v <= 0x5A { v += 0x20 } // A-Z → a-z
            if v == 0x20 || (v >= 0x61 && v <= 0x7A), let u = Unicode.Scalar(v) {
                emit(["t": "key", "ch": String(Character(u))])
            }
        }
        return Unmanaged.passUnretained(event)
    }

    if length > 0 {
        let s = String(utf16CodeUnits: chars, count: length)
        // Only surface printable text (>= U+0020). Control chars produced by
        // modifier combos are ignored here; named special keys handled below.
        let isPrintable = s.unicodeScalars.contains { $0.value >= 0x20 }
        if isPrintable {
            var ev: [String: Any] = ["t": "key", "ch": s]
            if synthetic { ev["syn"] = true }
            emit(ev)
            return Unmanaged.passUnretained(event)
        }
    }

    // No printable char → surface as a named special key if we track it.
    if let name = specialKeys[keyCode] {
        emit(["t": "special", "key": name])
    }

    return Unmanaged.passUnretained(event)
}

/// Create the listen-only tap (DISABLED). Returns false if the tap can't be
/// created — almost always means Input Monitoring isn't granted yet.
@discardableResult
func createTap() -> Bool {
    let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue)
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: eventCallback,
        userInfo: nil
    ) else {
        return false
    }
    let m = Monitor.shared
    m.tap = tap
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    m.runLoopSource = src
    CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: false) // privacy: start disabled
    return true
}

func setEnabled(_ on: Bool, wakeOnly: Bool = false) {
    let m = Monitor.shared
    if on && m.tap == nil {
        // First enable without an existing tap: ensure access (prompts once),
        // then build the tap.
        if !CGPreflightListenEventAccess() {
            _ = CGRequestListenEventAccess()
            emit(["t": "perm", "listen": false])
        }
        _ = createTap()
    }
    guard let tap = m.tap else { return }
    m.enabled = on
    m.wakeOnly = wakeOnly
    CGEvent.tapEnable(tap: tap, enable: on)
}

/// Read control commands off stdin on a background queue; apply on main.
func startStdinReader() {
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine(strippingNewline: true) {
            let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                switch cmd {
                case "enable":  setEnabled(true)
                case "enable-wake": setEnabled(true, wakeOnly: true)
                case "disable": setEnabled(false)
                case "quit":    exit(0)
                default:        break
                }
            }
        }
        // stdin closed → parent process is gone → exit cleanly.
        DispatchQueue.main.async { exit(0) }
    }
}

// ── main ──
let hasAccess = CGPreflightListenEventAccess()
createTap() // best-effort; if access not yet granted, (re)built on first enable
emit(["t": "ready", "listen": hasAccess])
startStdinReader()
// The wake phrase must be typed in one app: an app switch clears it.
_ = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { _ in
    if Monitor.shared.enabled { emit(["t": "reset"]) }
}
CFRunLoopRun()
