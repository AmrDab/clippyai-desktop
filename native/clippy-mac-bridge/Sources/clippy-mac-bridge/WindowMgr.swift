// WindowMgr.swift
//
// Window enumeration + per-window management for clippy-mac-bridge.
//
// Stack used here
// ───────────────
//   CGWindowListCopyWindowInfo — read-only enumeration of every window
//                                across every app. Cheap, no permission
//                                needed (except titles since 14.4).
//   NSWorkspace                — running-app + frontmost-app queries.
//   NSRunningApplication       — per-app actions: activate, hide.
//   AXUIElement                — per-window actions: focus this specific
//                                window, minimize, zoom (maximize),
//                                fullscreen. Requires Accessibility.
//
// Why both CG and AX? CGWindowList is the only API that gives a true
// cross-app window list with pid + bounds + titles. AX is per-app and
// doesn't enumerate other apps' windows. We use CG to discover, then
// AX to act on a specific window.
//
// macOS 14.4 title gating
// ───────────────────────
// In Sonoma 14.4 Apple moved `kCGWindowName` behind the Screen
// Recording entitlement. Without it, every window's title comes back
// empty. We don't error out — we degrade: emit empty strings + set
// `"titlesGated": true` on the response so the TS wrapper can surface
// "grant Screen Recording for window titles" if the user asks why
// titles are blank. This matches how the reference Mac automation
// tools handle it (Raycast, BetterTouchTool).
//
// Coordinate space
// ────────────────
// `kCGWindowBounds` returns a CGRect in **top-left origin points** —
// the same space CGEvent, AX, and screencapture use. We do NOT flip y.
// Don't be fooled by the NSWindow.frame convention (bottom-left); that
// only applies inside Cocoa.

import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

// MARK: - Permission helpers

/// Top-of-function gate for AX-dependent ops. Soft permission warnings
/// (e.g. "you might want Screen Recording for titles") are handled
/// inline; this is the hard gate for "you can't touch other apps'
/// windows without this".
private func requireAXTrustForWindow() {
    if !AXIsProcessTrusted() {
        emitError(
            "Accessibility permission denied — open System Settings → Privacy & Security → Accessibility and enable ClippyAI.",
            code: 1,
            extra: ["permission": "accessibility"]
        )
    }
}

/// Read-only probe for Screen Recording. Used to decide whether window
/// titles will be populated; never errors out from this helper.
private func screenRecordingGranted() -> Bool {
    return CGPreflightScreenCaptureAccess()
}

// MARK: - resolveAXPath (shared stub)
//
// A11y.swift will own the real implementation of `resolveAXPath(pid:
// path:)` (walking `kAXChildrenAttribute` along an integer index trail
// to land on a specific element). Window focus uses a different
// path — find by title rather than by tree index — so we never call
// resolveAXPath from here. We leave this comment as a coordination
// marker for the A11y agent: do NOT add resolveAXPath here.

// MARK: - AX window helpers

/// Get the AXUIElement array of windows owned by `pid`. Returns []
/// if AX rejects the query (app sandboxed against AX, app died, etc).
/// This is the only AX call window mgmt needs — once we have the
/// window element we can set attributes directly.
private func axWindows(forPID pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    var rawValue: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawValue)
    guard err == .success, let value = rawValue else { return [] }
    // CFArray of AXUIElement — bridge via NSArray for safe iteration.
    if CFGetTypeID(value) == CFArrayGetTypeID() {
        let arr = value as! CFArray
        var out: [AXUIElement] = []
        for i in 0..<CFArrayGetCount(arr) {
            let raw = CFArrayGetValueAtIndex(arr, i)!
            let elem = Unmanaged<AXUIElement>.fromOpaque(raw).takeUnretainedValue()
            out.append(elem)
        }
        return out
    }
    return []
}

/// Read a string attribute from an AXUIElement. Returns empty string
/// on missing/wrong-type rather than nil — every caller treats both
/// the same.
private func axString(_ element: AXUIElement, _ attr: String) -> String {
    var rawValue: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &rawValue)
    guard err == .success, let value = rawValue else { return "" }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as! String }
    return ""
}

/// Find the AX window for `pid` whose title contains `substring`. If
/// `substring` is nil/empty, returns the first window (typically the
/// frontmost). Returns nil if no AX windows or no match.
private func findAXWindow(pid: pid_t, titleSubstring: String?) -> AXUIElement? {
    let windows = axWindows(forPID: pid)
    if windows.isEmpty { return nil }
    guard let needle = titleSubstring, !needle.isEmpty else {
        return windows.first
    }
    let lowerNeedle = needle.lowercased()
    return windows.first { axString($0, kAXTitleAttribute).lowercased().contains(lowerNeedle) }
        ?? windows.first  // fall back to first window — better than error if title is gated
}

// MARK: - CGWindowList shaping

/// Turn one `CGWindowListCopyWindowInfo` dict into our JSON shape.
/// Returns nil if the entry is missing fields we need (windowID, pid,
/// owner name) — those are universal so a missing one means the entry
/// is malformed and should be skipped rather than emitted as junk.
private func shapeWindowEntry(_ info: [String: Any], titlesGated: Bool) -> [String: Any]? {
    guard let windowID = info[kCGWindowNumber as String] as? Int,
          let pid = info[kCGWindowOwnerPID as String] as? Int,
          let app = info[kCGWindowOwnerName as String] as? String
    else { return nil }

    // kCGWindowName: empty pre-14.4 if user-app is sandboxed, empty
    // post-14.4 if we don't have Screen Recording. We surface whatever
    // we get and signal the gating state once at the top of the
    // response (not per-window).
    let title = (info[kCGWindowName as String] as? String) ?? ""

    // kCGWindowBounds is a CFDictionary with X/Y/Width/Height keys.
    // CGRect(dictionaryRepresentation:) reads them directly. The
    // dictionary uses top-left origin coords.
    // Emit width/height (not w/h) to match A11y.swift's boundsDict and the
    // AxBounds TS type — downstream (window-follow) reads .width/.height.
    var bounds: [String: Any] = ["x": 0, "y": 0, "width": 0, "height": 0]
    if let dict = info[kCGWindowBounds as String] as? [String: Any] {
        bounds["x"] = dict["X"] ?? 0
        bounds["y"] = dict["Y"] ?? 0
        bounds["width"] = dict["Width"] ?? 0
        bounds["height"] = dict["Height"] ?? 0
    }

    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    let alpha = info[kCGWindowAlpha as String] as? Double ?? 1.0

    // CGWindowList doesn't report minimized state directly. Minimized
    // windows are excluded from `.optionOnScreenOnly` lists entirely;
    // when included via the full list, they have `kCGWindowIsOnscreen`
    // = false. We expose that as `minimized` since for a user-app
    // window, "off-screen + alpha 1" = "minimized to Dock".
    let onscreen = (info[kCGWindowIsOnscreen as String] as? Bool) ?? true
    let minimized = !onscreen && alpha > 0.0 && layer == 0

    var entry: [String: Any] = [
        "windowID": windowID,
        "pid": pid,
        "app": app,
        "title": title,
        "bounds": bounds,
        "layer": layer,
        "alpha": alpha,
        "minimized": minimized,
    ]
    if titlesGated {
        // Per-window flag is redundant with the top-level one but
        // helps consumers who pluck single entries out of the array.
        entry["titleGated"] = true
    }
    return entry
}

// MARK: - `windows` — list all windows

/// Enumerate windows across all apps. By default we filter to layer 0
/// (normal app windows — excludes menubar items, Dock, system overlays,
/// the wallpaper, etc.). The `.optionOnScreenOnly` flag is the cheap
/// path; passing `false` switches to the full list which includes
/// minimized + offscreen windows.
func runListWindows() {
    let onScreenOnly = argBool(name: "--on-screen-only", default: true)
    let titlesGated = !screenRecordingGranted()

    let opts: CGWindowListOption = onScreenOnly
        ? [.optionOnScreenOnly, .excludeDesktopElements]
        : [.excludeDesktopElements]

    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        emitError("CGWindowListCopyWindowInfo returned nil", code: 3)
    }

    var windows: [[String: Any]] = []
    for info in raw {
        // Layer 0 = normal app windows. Menubar = 25, Dock = 20,
        // wallpaper = -2147483624, etc. Filtering here is cheaper
        // than asking callers to do it.
        let layer = info[kCGWindowLayer as String] as? Int ?? -1
        if layer != 0 { continue }
        if let entry = shapeWindowEntry(info, titlesGated: titlesGated) {
            windows.append(entry)
        }
    }

    var payload: [String: Any] = ["windows": windows]
    if titlesGated {
        payload["titlesGated"] = true
        payload["titlesGatedReason"] = "Screen Recording permission required for kCGWindowName since macOS 14.4"
    }
    emit(payload)
}

// MARK: - `active-window` — frontmost window of frontmost app

/// Identify the frontmost user-facing window. We start with
/// NSWorkspace.frontmostApplication (which gives us the pid) and then
/// filter the CGWindowList to entries owned by that pid at layer 0,
/// taking the topmost one (the list is z-ordered front-to-back).
func runActiveWindow() {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else {
        emitError("no frontmost application", code: 3)
    }
    let pid = frontApp.processIdentifier
    let appName = frontApp.localizedName ?? "(unknown)"
    let titlesGated = !screenRecordingGranted()

    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        emitError("CGWindowListCopyWindowInfo returned nil", code: 3)
    }

    // First layer-0 window owned by the frontmost app. CGWindowList
    // is z-ordered front-to-back, so first match = topmost.
    for info in raw {
        let layer = info[kCGWindowLayer as String] as? Int ?? -1
        if layer != 0 { continue }
        let ownerPID = info[kCGWindowOwnerPID as String] as? Int ?? -1
        if ownerPID != Int(pid) { continue }
        guard let entry = shapeWindowEntry(info, titlesGated: titlesGated) else { continue }
        // Drop the `pid`/`app` fields from the entry and lift them
        // to top-level alongside the active-window shape spec.
        var payload: [String: Any] = [
            "app": entry["app"] ?? appName,
            "pid": entry["pid"] ?? Int(pid),
            "title": entry["title"] ?? "",
            "bounds": entry["bounds"] ?? ["x": 0, "y": 0, "width": 0, "height": 0],
            "windowID": entry["windowID"] ?? 0,
        ]
        if titlesGated {
            payload["titlesGated"] = true
        }
        emit(payload)
    }

    // No on-screen windows for the frontmost app — could happen if the
    // app is "active" but all windows are minimized (rare but legal,
    // e.g. menubar apps that don't open a window). Report what we know
    // rather than error out.
    var payload: [String: Any] = [
        "app": appName,
        "pid": Int(pid),
        "title": "",
        "bounds": ["x": 0, "y": 0, "width": 0, "height": 0],
        "windowID": 0,
    ]
    if titlesGated { payload["titlesGated"] = true }
    emit(payload)
}

// MARK: - `focus-window` — bring app + specific window to front

/// Focus the window matching (pid + optional title substring).
///
/// Two-phase: NSRunningApplication.activate first (brings the app to
/// front, raises ALL its windows together), then AX `kAXMainAttribute`
/// = true on the specific window so the right one inside the app is
/// frontmost. If AX is denied, we still get the app-level focus,
/// which is better than nothing — caller sees `ok:true, partial:true`.
func runFocusWindow() {
    guard let pidStr = argValue(name: "--pid"), let pid = pid_t(pidStr) else {
        emitError("--pid is required and must be an integer", code: 2)
    }
    let titleSub = argValue(name: "--title-substring")

    guard let running = NSRunningApplication(processIdentifier: pid) else {
        emitError("no running application for pid \(pid)", code: 3)
    }

    // Phase 1: activate the app. .activateIgnoringOtherApps is the
    // standard "bring me to front even if I'm not the user's last
    // focus" — required for automation contexts.
    let activated = running.activate(options: [.activateIgnoringOtherApps])
    let appName = running.localizedName ?? "pid:\(pid)"

    // Phase 2 (AX): set kAXMainAttribute on the target window. If AX
    // is denied, we already activated the app — degrade gracefully.
    var axOK = false
    if AXIsProcessTrusted() {
        if let window = findAXWindow(pid: pid, titleSubstring: titleSub) {
            // Some apps require RaiseAction to actually surface the
            // window (vs just marking it main). Set main first then
            // perform raise — both no-ops if redundant.
            let setMain = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
            let _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            axOK = (setMain == .success)
        }
    }

    var payload: [String: Any] = ["ok": activated, "target": appName]
    if !axOK {
        // Either AX is denied or the window wasn't findable. Caller
        // can still treat ok:true as success (app is focused) but
        // we surface partial so the brain knows the title-substring
        // selection might not have landed.
        payload["partial"] = true
    }
    emit(payload)
}

// MARK: - `minimize-window` — collapse one window to Dock

/// Minimize a specific window via AX. macOS doesn't expose a "minimize
/// window N of app X" without AX — `osascript "tell app … to set
/// miniaturized of window N to true"` works but requires Automation
/// permission per-app, more permission surface area than AX which
/// covers everything.
func runMinimizeWindow() {
    requireAXTrustForWindow()
    guard let pidStr = argValue(name: "--pid"), let pid = pid_t(pidStr) else {
        emitError("--pid is required and must be an integer", code: 2)
    }
    let titleSub = argValue(name: "--title-substring")
    guard let window = findAXWindow(pid: pid, titleSubstring: titleSub) else {
        emitError("no window found for pid \(pid)", code: 3)
    }
    let err = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    if err != .success {
        emitError("AXUIElementSetAttributeValue(minimized) failed: \(err.rawValue)", code: 3)
    }
    let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid:\(pid)"
    emit(["ok": true, "target": appName])
}

// MARK: - `maximize-window` — zoom button press

/// "Maximize" on macOS is ambiguous — there's zoom (green button
/// short-press: fit-to-content), and there's fullscreen (green button
/// long-press / option-click: hide menu bar, separate Space). The spec
/// calls for "zoom button press" as default, which gives the user the
/// behavior they'd see clicking the green button — apps decide whether
/// that means full-screen or fit-content.
///
/// We perform AXPressAction on the zoom button rather than toggling
/// kAXFullScreenAttribute (which is the long-press behavior). If the
/// caller wants real fullscreen they can pass `--mode fullscreen`.
func runMaximizeWindow() {
    requireAXTrustForWindow()
    guard let pidStr = argValue(name: "--pid"), let pid = pid_t(pidStr) else {
        emitError("--pid is required and must be an integer", code: 2)
    }
    let titleSub = argValue(name: "--title-substring")
    let mode = (argValue(name: "--mode") ?? "zoom").lowercased()
    guard let window = findAXWindow(pid: pid, titleSubstring: titleSub) else {
        emitError("no window found for pid \(pid)", code: 3)
    }
    let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid:\(pid)"

    if mode == "fullscreen" {
        // True macOS fullscreen — separate Space, menu bar hides.
        let err = AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanTrue)
        if err != .success {
            emitError("AXSetAttributeValue(AXFullScreen) failed: \(err.rawValue) (window may not support fullscreen)", code: 3)
        }
        emit(["ok": true, "target": appName, "mode": "fullscreen"])
    }

    // Default: zoom button press.
    var rawButton: CFTypeRef?
    let getErr = AXUIElementCopyAttributeValue(window, kAXZoomButtonAttribute as CFString, &rawButton)
    if getErr != .success || rawButton == nil {
        emitError("zoom button not exposed (window may not have one)", code: 3)
    }
    let button = rawButton as! AXUIElement
    let pressErr = AXUIElementPerformAction(button, kAXPressAction as CFString)
    if pressErr != .success {
        emitError("AXPress on zoom button failed: \(pressErr.rawValue)", code: 3)
    }
    emit(["ok": true, "target": appName, "mode": "zoom"])
}

// MARK: - `hide-app` — App → Hide for the whole app

/// `NSRunningApplication.hide()` is the gentle equivalent of Cmd+H —
/// hides every window of the app without minimizing them. No AX
/// required (it's app-self management triggered cross-process via
/// the workspace).
func runHideApp() {
    guard let pidStr = argValue(name: "--pid"), let pid = pid_t(pidStr) else {
        emitError("--pid is required and must be an integer", code: 2)
    }
    guard let running = NSRunningApplication(processIdentifier: pid) else {
        emitError("no running application for pid \(pid)", code: 3)
    }
    let ok = running.hide()
    let appName = running.localizedName ?? "pid:\(pid)"
    if !ok {
        emitError("NSRunningApplication.hide() returned false for \(appName)", code: 3)
    }
    emit(["ok": true, "target": appName])
}

// MARK: - `minimize-all` / `show-desktop` — Mission Control "Show Desktop"

/// Synthesize the F11 chord that macOS maps to "Show Desktop" (Mission
/// Control). On modern macOS the default is actually Fn+F11 — F11 alone
/// is reserved for hardware volume — so we set the secondary-fn modifier.
///
/// Both `minimize-all` and `show-desktop` post the same chord; the OS
/// handles the toggle state internally. Calling it twice within a
/// short window re-shows the previously-hidden windows.
///
/// Alternative considered: `NSWorkspace.hideOtherApplications()`. It
/// hides "others" relative to the frontmost app, not "all", so it
/// can't satisfy minimize-all when the caller isn't itself the
/// frontmost app. The F11 chord is the correct primitive.
private func postShowDesktopChord() {
    // F11 = key code 103. Add .maskSecondaryFn to match the default
    // System Settings binding.
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 103, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 103, keyDown: false)
    else {
        emitError("CGEvent creation failed for F11 chord", code: 3)
    }
    down.flags = .maskSecondaryFn
    up.flags = .maskSecondaryFn
    down.post(tap: .cghidEventTap)
    usleep(10_000)
    up.post(tap: .cghidEventTap)
}

func runMinimizeAll() {
    requireAXTrustForWindow()
    postShowDesktopChord()
    emit(["ok": true, "target": "show-desktop"])
}

func runShowDesktop() {
    requireAXTrustForWindow()
    postShowDesktopChord()
    emit(["ok": true, "target": "show-desktop"])
}
