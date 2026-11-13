// A11y.swift
//
// Accessibility (AX) subcommands for clippy-mac-bridge.
//
// Why this file exists
// ────────────────────
// Before v0.20.0, ClippyAI on macOS had no working way to read or
// drive UI structure. `read_screen` ran a PowerShell script that
// always failed `spawn ENOENT`; `smart_click` fell back to OCR-only
// heuristics; `set_field_value` ended in `pbcopy` + cmd+v which
// clobbers the clipboard. Production logs (May 21–23, 2026) showed
// 14 user tasks across 3 days with 0 successful completions — the
// model was operating blind. This module fixes that at the source by
// exposing the macOS Accessibility tree as JSON.
//
// Subcommands (dispatched from main.swift)
// ────────────────────────────────────────
//   a11y-tree       — full AX tree of an app (or frontmost) as JSON
//   a11y-find       — search the AX tree for title/role match
//   a11y-focused    — currently focused element (system-wide)
//   a11y-click      — AXPress an element addressed by [pid, path]
//   a11y-set-value  — write into a text field via AX (no clipboard)
//   a11y-press      — same as a11y-click but explicit (semantic alias)
//
// Path-based addressing
// ─────────────────────
// We don't ship opaque element IDs back to the TS layer. Instead each
// element is identified by its index trail through `kAXChildrenAttribute`
// arrays: `[0, 3, 1]` means "first window of the app → fourth child of
// that window → second child of that". The TS side stashes the path on
// a candidate match, then calls a11y-click / a11y-set-value with the
// same path. This way we don't have to keep AXUIElementRef handles
// alive between bridge invocations (which would require a daemon).
// Trade-off: paths go stale if the UI tree rearranges between calls,
// but that's a normal AX failure mode the model already handles via
// re-tree-on-error.
//
// Permission model
// ────────────────
// Every entry point calls `AXIsProcessTrusted()` first. If false, we
// exit code 1 with a structured error — the TS wrapper maps that to
// the "grant accessibility" UI prompt. The FIRST call from a fresh
// install also triggers macOS's TCC dialog automatically; we don't
// pre-prompt because that would force users to grant before they've
// seen Clippy ever do anything.
//
// Cycle / depth protection
// ────────────────────────
// AX trees can cycle (rare but real on Slack, Discord, some Electron
// apps that wire parent links incorrectly). We track a tail of the
// last ~200 visited AXUIElement refs via CFEqual and bail out with
// `"cycle":true` when we re-encounter an ancestor. Depth is capped
// at 6 by default and total nodes per app at 5000 to bound the walk
// on deep AX trees. Past either limit we emit
// `"truncated":true` and stop descending.
//
// Coordinate space
// ────────────────
// macOS AX returns positions and sizes in display-space POINTS with a
// TOP-LEFT origin (unlike Cocoa's NSScreen which is bottom-left). We
// emit them as-is — do NOT flip the y axis. This matches the
// coordinate space that `screencapture -R`, screenshot-helper, and
// Electron's `screen` module already use, so downstream click
// synthesis lands on the right pixel.

import Foundation
import AppKit
import ApplicationServices

// MARK: - AX attribute / action name aliases
//
// The kAX… constants are CFString globals exported as `let kAXFooAttribute: String`,
// but the AX C functions take `CFString`. We cast once here so the call
// sites stay readable.

private let attrChildren        = kAXChildrenAttribute        as CFString
private let attrTitle           = kAXTitleAttribute           as CFString
private let attrValue           = kAXValueAttribute           as CFString
private let attrRole            = kAXRoleAttribute            as CFString
private let attrSubrole         = kAXSubroleAttribute         as CFString
private let attrPosition        = kAXPositionAttribute        as CFString
private let attrSize            = kAXSizeAttribute            as CFString
private let attrEnabled         = kAXEnabledAttribute         as CFString
private let attrFocused         = kAXFocusedAttribute         as CFString
private let attrFocusedUIElem   = kAXFocusedUIElementAttribute as CFString
private let attrParent          = kAXParentAttribute          as CFString
private let attrWindows         = kAXWindowsAttribute         as CFString
private let attrDescription     = kAXDescriptionAttribute     as CFString
private let attrHelp            = kAXHelpAttribute            as CFString
private let attrSelectedText    = kAXSelectedTextAttribute    as CFString
private let attrSelectedTextRange = kAXSelectedTextRangeAttribute as CFString
private let actionPress         = kAXPressAction              as CFString

// MARK: - Permission gate

/// Returns true if Accessibility is granted to this binary. First call
/// from a fresh install will trigger the TCC prompt on its own — we
/// pass `false` for prompt to avoid double-prompting, since macOS will
/// surface it the next time any AX call actually runs.
private func ensureAXOrExit() {
    if AXIsProcessTrusted() { return }
    emitError(
        "Accessibility permission denied. Grant in System Settings → Privacy & Security → Accessibility.",
        code: 1
    )
}

// MARK: - Error class translation

/// Translate an AXError from a low-level AX call into a structured
/// JSON error + exit code. Never returns.
private func emitAXError(_ err: AXError, context: String) -> Never {
    switch err {
    case .apiDisabled:
        emitError("Accessibility disabled (\(context))", code: 1)
    case .noValue, .attributeUnsupported, .actionUnsupported, .parameterizedAttributeUnsupported:
        emitError("unsupported attribute (\(context))", code: 3, extra: ["axError": String(describing: err)])
    case .cannotComplete:
        emitError("operation timed out (target may be stuck) (\(context))", code: 3)
    case .invalidUIElement, .invalidUIElementObserver:
        emitError("stale element (re-fetch tree) (\(context))", code: 3)
    case .notImplemented:
        emitError("not implemented by target (\(context))", code: 3)
    case .notEnoughPrecision:
        emitError("not enough precision (\(context))", code: 3)
    default:
        emitError("AX error \(err.rawValue) (\(context))", code: 3)
    }
}

// MARK: - Low-level attribute helpers

/// Read any AX attribute. Returns nil on noValue / failure; doesn't
/// exit, because partial reads are normal — many UI elements don't
/// implement every attribute.
private func axCopy(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute, &value)
    if err == .success { return value }
    return nil
}

/// Read a String attribute (title, role, description, value-if-string).
private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    guard let v = axCopy(element, attribute) else { return nil }
    if let s = v as? String { return s }
    // Some apps return NSString-typed values that bridge automatically;
    // others return CFString. Both paths land in `as? String`. We also
    // accept `value` attribute on text fields which may come back as
    // NSAttributedString — flatten it.
    if let attr = v as? NSAttributedString { return attr.string }
    return nil
}

/// Read a Bool attribute (enabled, focused).
private func axBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    guard let v = axCopy(element, attribute) else { return nil }
    if let b = v as? Bool { return b }
    // CFBoolean bridges to NSNumber on Swift's side.
    if let n = v as? NSNumber { return n.boolValue }
    return nil
}

/// Read the children array. Returns [] if the element has no children
/// attribute or it's empty/unreadable. Children are returned in the
/// document order AX promises (left-to-right, top-to-bottom).
private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let v = axCopy(element, attrChildren) else { return [] }
    if let arr = v as? [AXUIElement] { return arr }
    // CFArray → Swift array bridge sometimes needs explicit cast on
    // older SDKs. Belt-and-braces.
    let cfArr = v as! CFArray
    let n = CFArrayGetCount(cfArr)
    var out: [AXUIElement] = []
    out.reserveCapacity(n)
    for i in 0..<n {
        let raw = CFArrayGetValueAtIndex(cfArr, i)
        if let raw = raw {
            let elem = Unmanaged<AXUIElement>.fromOpaque(raw).takeUnretainedValue()
            out.append(elem)
        }
    }
    return out
}

/// Read a CGPoint from an AXValue-wrapped position attribute.
private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let v = axCopy(element, attribute) else { return nil }
    // Force-cast is safe here: AX returns AXValue for position/size or
    // we wouldn't have read the attribute at all.
    let axVal = v as! AXValue
    var pt = CGPoint.zero
    if AXValueGetValue(axVal, .cgPoint, &pt) { return pt }
    return nil
}

/// Read a CGSize from an AXValue-wrapped size attribute.
private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let v = axCopy(element, attribute) else { return nil }
    let axVal = v as! AXValue
    var sz = CGSize.zero
    if AXValueGetValue(axVal, .cgSize, &sz) { return sz }
    return nil
}

/// Bounds dict in the JSON shape downstream tools expect.
/// macOS AX coords are top-left origin in display-space points; we
/// emit them as-is.
private func boundsDict(position: CGPoint?, size: CGSize?) -> [String: Any]? {
    guard let p = position, let s = size else { return nil }
    return [
        "x": Int(p.x.rounded()),
        "y": Int(p.y.rounded()),
        "width": Int(s.width.rounded()),
        "height": Int(s.height.rounded())
    ]
}

/// Best-effort string for the element's user-facing label. Title wins,
/// then description, then role-as-fallback for unlabelled containers.
private func elementLabel(_ element: AXUIElement) -> String? {
    if let t = axString(element, attrTitle), !t.isEmpty { return t }
    if let d = axString(element, attrDescription), !d.isEmpty { return d }
    if let h = axString(element, attrHelp), !h.isEmpty { return h }
    return nil
}

// MARK: - PID / app resolution

/// Resolve the target pid: explicit `--pid`, or NSWorkspace frontmost.
/// Exits with code 3 if there's no frontmost app and no pid given.
private func resolveTargetPid() -> pid_t {
    if let s = argValue(name: "--pid"), let n = Int32(s) {
        return pid_t(n)
    }
    if let app = NSWorkspace.shared.frontmostApplication {
        return app.processIdentifier
    }
    emitError("no frontmost application", code: 3)
}

/// Get NSRunningApplication for a pid, or nil if it died between
/// the calling subcommand starting and now.
private func runningApp(for pid: pid_t) -> NSRunningApplication? {
    return NSRunningApplication(processIdentifier: pid)
}

/// Friendly name for a pid — localizedName falls back to bundle id
/// falls back to "(unknown:\(pid))" for headless helpers.
private func appName(for pid: pid_t) -> String {
    if let ra = runningApp(for: pid) {
        if let n = ra.localizedName, !n.isEmpty { return n }
        if let b = ra.bundleIdentifier, !b.isEmpty { return b }
    }
    return "(unknown:\(pid))"
}

// MARK: - Path resolution

/// Walk a path of child indices from the application root. Returns
/// nil if any index is out of bounds — caller surfaces a 3 error.
///
/// Path semantics: `path[0]` indexes the app's windows array (we use
/// kAXWindowsAttribute when present, falling back to children for
/// odd apps that don't expose AXWindows). `path[1..]` walks AXChildren
/// from there. So `[0, 3, 1]` is "first window, 4th child, 2nd
/// grandchild" — the same path the tree walk emits.
private func resolveAXPath(app: AXUIElement, path: [Int]) -> AXUIElement? {
    guard !path.isEmpty else { return nil }
    // Top-level: prefer kAXWindowsAttribute (an actual array of windows)
    // over generic children, because some apps put menu bars / status
    // items as top-level children and we'd index them by mistake.
    let topChildren: [AXUIElement] = {
        if let v = axCopy(app, attrWindows), let arr = v as? [AXUIElement] { return arr }
        return axChildren(app)
    }()
    let firstIdx = path[0]
    guard firstIdx >= 0 && firstIdx < topChildren.count else { return nil }
    var current = topChildren[firstIdx]
    for i in 1..<path.count {
        let kids = axChildren(current)
        let idx = path[i]
        guard idx >= 0 && idx < kids.count else { return nil }
        current = kids[idx]
    }
    return current
}

// MARK: - Tree serialization

/// Encoded tree-walk state. We pass this around by reference so the
/// global node-cap and cycle ring buffer are visible across recursion
/// without making every caller juggle out-params.
private final class WalkState {
    var nodeCount = 0
    var truncated = false
    let maxNodes: Int
    let maxDepth: Int
    let includeEmpty: Bool
    // Cycle detection: ring buffer of recently visited AXUIElement refs.
    // 200 is enough to catch ancestor cycles in pathological trees
    // (Slack's old AX bug, some Electron menus) without leaking memory.
    var visited: [AXUIElement] = []
    let visitedCap = 200

    init(maxDepth: Int, maxNodes: Int, includeEmpty: Bool) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.includeEmpty = includeEmpty
    }

    /// True if this element is already on our recent-visited list.
    func sawAncestor(_ element: AXUIElement) -> Bool {
        for v in visited {
            if CFEqual(v, element) { return true }
        }
        return false
    }

    func remember(_ element: AXUIElement) {
        visited.append(element)
        if visited.count > visitedCap {
            visited.removeFirst(visited.count - visitedCap)
        }
    }
}

/// Serialize an element to a dict and recurse into its children.
/// `path` is the path FROM THE APP ROOT to this element, used for
/// re-targeting via a11y-click / a11y-set-value.
private func serializeElement(
    _ element: AXUIElement,
    path: [Int],
    depth: Int,
    state: WalkState
) -> [String: Any]? {
    if state.nodeCount >= state.maxNodes {
        state.truncated = true
        return nil
    }
    state.nodeCount += 1

    // Cycle check. If we've already been here, mark and stop descending —
    // but still emit the node so callers see the loop.
    let isCycle = state.sawAncestor(element)
    state.remember(element)

    let role = axString(element, attrRole) ?? "AXUnknown"
    let subrole = axString(element, attrSubrole)
    let title = axString(element, attrTitle)
    let valueStr = axString(element, attrValue)
    let description = axString(element, attrDescription)
    let enabled = axBool(element, attrEnabled)
    let focused = axBool(element, attrFocused)
    let bounds = boundsDict(
        position: axPoint(element, attrPosition),
        size: axSize(element, attrSize)
    )

    // Skip "noise" nodes if include-empty is false: AXGroup/AXLayoutItem
    // with no label, no value, no children of interest. We still recurse
    // so we don't miss labelled descendants; we just don't emit the
    // wrapper itself unless it has bounds or a role that matters.
    // (The default is to include them — the tree gets dense but
    // smart_click depends on the path indices being predictable.)

    var dict: [String: Any] = [
        "role": role,
        "path": path
    ]
    if let s = subrole, !s.isEmpty { dict["subrole"] = s }
    if let t = title, !t.isEmpty { dict["title"] = t }
    else { dict["title"] = NSNull() }
    if let v = valueStr, !v.isEmpty { dict["value"] = v }
    else { dict["value"] = NSNull() }
    if let d = description, !d.isEmpty { dict["description"] = d }
    if let b = bounds { dict["bounds"] = b }
    if let e = enabled { dict["enabled"] = e }
    if let f = focused { dict["focused"] = f }
    if isCycle {
        dict["cycle"] = true
        return dict
    }

    // Stop descending past max depth — but emit the node itself so the
    // parent sees something at index `path[-1]`.
    if depth >= state.maxDepth {
        let kidCount = axChildren(element).count
        if kidCount > 0 {
            dict["truncated"] = true
            dict["childCount"] = kidCount
        }
        return dict
    }

    let kids = axChildren(element)
    if !kids.isEmpty {
        var childDicts: [[String: Any]] = []
        childDicts.reserveCapacity(kids.count)
        for (i, kid) in kids.enumerated() {
            if state.nodeCount >= state.maxNodes {
                state.truncated = true
                break
            }
            var childPath = path
            childPath.append(i)
            if let cd = serializeElement(kid, path: childPath, depth: depth + 1, state: state) {
                childDicts.append(cd)
            }
        }
        if !childDicts.isEmpty || state.includeEmpty {
            dict["children"] = childDicts
        }
    }

    return dict
}

/// Serialize one window of an app. The window is itself an AXUIElement
/// (role AXWindow); we emit its title/bounds at the top level and the
/// element subtree under "elements".
private func serializeWindow(
    _ window: AXUIElement,
    index: Int,
    state: WalkState
) -> [String: Any] {
    let title = axString(window, attrTitle) ?? ""
    let bounds = boundsDict(
        position: axPoint(window, attrPosition),
        size: axSize(window, attrSize)
    )
    let role = axString(window, attrRole) ?? "AXWindow"

    // The window's own children become the `elements` array. We start
    // the path at [index] so callers can address children as
    // [index, childIdx, ...].
    let kids = axChildren(window)
    var elementDicts: [[String: Any]] = []
    elementDicts.reserveCapacity(kids.count)
    state.remember(window)
    for (i, kid) in kids.enumerated() {
        if state.nodeCount >= state.maxNodes {
            state.truncated = true
            break
        }
        if let cd = serializeElement(kid, path: [index, i], depth: 2, state: state) {
            elementDicts.append(cd)
        }
    }

    var out: [String: Any] = [
        "title": title,
        "role": role,
        "elements": elementDicts
    ]
    if let b = bounds { out["bounds"] = b }

    // Sandboxed-app hint: WebViews (Safari content, Mail's message body)
    // expose very thin AX trees. We surface a hint so the model knows to
    // fall back to OCR rather than retry with a tighter selector.
    if kids.count < 3 {
        out["sandboxedHint"] = "this app may expose limited AX info"
    }
    return out
}

// MARK: - Subcommand: a11y-tree

/// Emit the full AX tree of an app as JSON.
///
/// Args:
///   --pid <int>           — target app pid (default: frontmost)
///   --max-depth <int>     — recursion cap (default: 6)
///   --include-empty <b>   — include unlabelled wrappers (default: false)
func runA11yTree() {
    ensureAXOrExit()

    let pid = resolveTargetPid()
    let maxDepth = Int(argValue(name: "--max-depth") ?? "") ?? 6
    let includeEmpty = argBool(name: "--include-empty", default: false)
    let maxNodes = 5000

    let app = AXUIElementCreateApplication(pid)
    let name = appName(for: pid)

    // Prefer kAXWindowsAttribute — gives a clean list of AXWindow refs
    // without menu bars, status items, etc. mixed in. Falls back to
    // generic children for non-conforming apps (rare).
    let windows: [AXUIElement] = {
        if let v = axCopy(app, attrWindows), let arr = v as? [AXUIElement] { return arr }
        return axChildren(app).filter { axString($0, attrRole) == "AXWindow" }
    }()

    let state = WalkState(maxDepth: maxDepth, maxNodes: maxNodes, includeEmpty: includeEmpty)
    var windowDicts: [[String: Any]] = []
    for (i, w) in windows.enumerated() {
        if state.nodeCount >= state.maxNodes {
            state.truncated = true
            break
        }
        windowDicts.append(serializeWindow(w, index: i, state: state))
    }

    var payload: [String: Any] = [
        "app": name,
        "pid": Int(pid),
        "windows": windowDicts,
        "maxDepth": maxDepth,
        "nodeCount": state.nodeCount
    ]
    if state.truncated { payload["truncated"] = true }

    emit(payload)
}

// MARK: - Subcommand: a11y-find

/// Search the AX tree for elements matching --text (and optionally
/// --role). Substring, case-insensitive against title, then value,
/// then description.
///
/// Args:
///   --text <string>  — required, the substring to search for
///   --role <AXRole>  — optional role filter (e.g. AXButton, AXTextField)
///   --pid  <int>     — target app (default: frontmost)
///   --all  <bool>    — return all matches (capped at 50) vs first only
func runA11yFind() {
    ensureAXOrExit()

    guard let needle = argValue(name: "--text"), !needle.isEmpty else {
        emitError("--text is required", code: 2)
    }
    let needleLower = needle.lowercased()
    let roleFilter = argValue(name: "--role")
    let returnAll = argBool(name: "--all", default: false)
    let pid = resolveTargetPid()

    let app = AXUIElementCreateApplication(pid)
    let name = appName(for: pid)

    let windows: [AXUIElement] = {
        if let v = axCopy(app, attrWindows), let arr = v as? [AXUIElement] { return arr }
        return axChildren(app).filter { axString($0, attrRole) == "AXWindow" }
    }()

    let matchCap = 50
    var matches: [[String: Any]] = []

    // Visited ring is per-search, scoped to this whole walk (across
    // all windows) to avoid loops in apps with shared subtrees.
    var visited: [AXUIElement] = []
    let visitedCap = 500

    /// Recursive matcher. Returns true if we should stop (matchCap hit
    /// or returnAll=false and one match found).
    func walk(_ element: AXUIElement, path: [Int]) -> Bool {
        // Cycle guard.
        for v in visited { if CFEqual(v, element) { return false } }
        visited.append(element)
        if visited.count > visitedCap {
            visited.removeFirst(visited.count - visitedCap)
        }

        let role = axString(element, attrRole)
        let title = axString(element, attrTitle)
        let valueStr = axString(element, attrValue)
        let desc = axString(element, attrDescription)

        let roleOK: Bool = {
            guard let rf = roleFilter, !rf.isEmpty else { return true }
            return (role ?? "") == rf
        }()

        let textOK: Bool = {
            if let t = title, t.lowercased().contains(needleLower) { return true }
            if let v = valueStr, v.lowercased().contains(needleLower) { return true }
            if let d = desc, d.lowercased().contains(needleLower) { return true }
            return false
        }()

        if roleOK && textOK {
            let bounds = boundsDict(
                position: axPoint(element, attrPosition),
                size: axSize(element, attrSize)
            )
            var m: [String: Any] = [
                "role": role ?? "AXUnknown",
                "pid": Int(pid),
                "app": name,
                "path": path
            ]
            if let t = title { m["title"] = t } else { m["title"] = NSNull() }
            if let v = valueStr { m["value"] = v }
            if let d = desc { m["description"] = d }
            if let b = bounds { m["bounds"] = b }
            matches.append(m)
            if matches.count >= matchCap { return true }
            if !returnAll { return true }
        }

        // Descend.
        let kids = axChildren(element)
        for (i, kid) in kids.enumerated() {
            var p = path
            p.append(i)
            if walk(kid, path: p) { return true }
        }
        return false
    }

    outer: for (wi, w) in windows.enumerated() {
        if walk(w, path: [wi]) { break outer }
    }

    emit([
        "matches": matches,
        "count": matches.count,
        "truncated": matches.count >= matchCap
    ])
}

// MARK: - Subcommand: a11y-focused

/// Find the currently-focused element across the whole system. The owning
/// app is resolved directly via AXUIElementGetPid on the focused element
/// (no parent walk needed).
func runA11yFocused() {
    ensureAXOrExit()

    let systemWide = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(systemWide, attrFocusedUIElem, &focusedRef)
    if err != .success {
        if err == .noValue || err == .attributeUnsupported {
            // No focus right now (e.g. user is on the desktop). Not an
            // error — emit a structured "none" so the TS side can
            // handle it without parsing exceptions.
            emit(["focused": NSNull(), "reason": "no focused element"])
        }
        emitAXError(err, context: "focused-element")
    }
    guard let raw = focusedRef else {
        emit(["focused": NSNull(), "reason": "no focused element"])
    }
    let focused = raw as! AXUIElement

    // Walk up to find the owning app (AXApplication role). On the way
    // we may need pid — AXUIElementGetPid is the canonical answer.
    var pid: pid_t = 0
    _ = AXUIElementGetPid(focused, &pid)
    let name = appName(for: pid)

    let role = axString(focused, attrRole) ?? "AXUnknown"
    let title = axString(focused, attrTitle)
    let valueStr = axString(focused, attrValue)
    let bounds = boundsDict(
        position: axPoint(focused, attrPosition),
        size: axSize(focused, attrSize)
    )

    var payload: [String: Any] = [
        "role": role,
        "pid": Int(pid),
        "app": name
    ]
    if let t = title { payload["title"] = t } else { payload["title"] = NSNull() }
    if let v = valueStr { payload["value"] = v } else { payload["value"] = NSNull() }
    if let b = bounds { payload["bounds"] = b }

    emit(payload)
}

// MARK: - Path argument parsing

/// Parse `--path 0,3,1` into [Int]. Exits with arg error on failure.
private func requirePath() -> [Int] {
    guard let s = argValue(name: "--path") else {
        emitError("--path is required (comma-separated indices, e.g. 0,3,1)", code: 2)
    }
    guard let path = parseInts(s), !path.isEmpty else {
        emitError("--path must be comma-separated integers", code: 2)
    }
    return path
}

/// Common path-resolution preamble for click / set-value / press.
private func resolveTargetElement() -> AXUIElement {
    let pid = resolveTargetPid()
    let path = requirePath()
    let app = AXUIElementCreateApplication(pid)
    guard let element = resolveAXPath(app: app, path: path) else {
        emitError(
            "path out of bounds (UI may have changed; re-fetch tree)",
            code: 3,
            extra: ["path": path, "pid": Int(pid)]
        )
    }
    return element
}

// MARK: - Subcommand: a11y-click / a11y-press

/// Perform AXPressAction on the element at [pid, path]. Most buttons,
/// links, and menu items respond to AXPress; for things that don't
/// (e.g. raw text fields), the caller should use a11y-set-value or
/// fall back to real CGEvent click via the `click` subcommand.
func runA11yClick() {
    ensureAXOrExit()
    let element = resolveTargetElement()
    let err = AXUIElementPerformAction(element, actionPress)
    if err != .success { emitAXError(err, context: "press") }
    emit(["ok": true])
}

/// Semantic alias for a11y-click. Some callers prefer the explicit
/// "press" name when the element isn't visually a button (toggle,
/// disclosure triangle, etc.). Behaviour is identical.
func runA11yPress() {
    runA11yClick()
}

// MARK: - Subcommand: a11y-set-value

/// Write a value into an editable element (text field, text area,
/// search field). Strategy:
///   1. Try kAXValueAttribute directly — fastest path, ~50ms, no
///      clipboard impact, atomic from the app's POV.
///   2. If that returns attributeUnsupported, try kAXSelectedTextAttribute
///      — works for editable text views (NSTextView, WebKit contentEditable
///      sometimes).
///   3. If both fail, surface the error so the TS side can fall back
///      to type-via-CGEvent.
///
/// Args:
///   --pid <int>        — target app
///   --path <ints>      — AX path to the element
///   --value <string>   — required, the new string value
func runA11ySetValue() {
    ensureAXOrExit()

    guard let newValue = argValue(name: "--value") else {
        emitError("--value is required", code: 2)
    }

    let element = resolveTargetElement()
    let previous = axString(element, attrValue)

    // Strategy 1: AXValue.
    let cfValue = newValue as CFString
    let err1 = AXUIElementSetAttributeValue(element, attrValue, cfValue)
    if err1 == .success {
        // .success only means the SETTER returned OK — some WebKit/Electron
        // fields accept the call but silently keep their old text. Re-read and
        // compare so we don't report a phantom success to the model.
        if axValueApplied(element, expected: newValue) {
            var payload: [String: Any] = ["ok": true, "strategy": "value"]
            if let p = previous { payload["previous"] = p }
            emit(payload)
        }
        // Setter said OK but the value didn't stick — fall through to the
        // AXSelectedText strategy below.
    } else if err1 != .attributeUnsupported && err1 != .illegalArgument {
        // A hard failure that the selected-text fallback can't help with.
        emitAXError(err1, context: "set-value")
    }

    // Strategy 2: AXSelectedText (for editable text views that don't
    // accept a full-value replacement, or that no-op'd strategy 1). The
    // element MUST be focused for this to land; if not, we attempt to
    // focus it first.
    _ = AXUIElementSetAttributeValue(element, attrFocused, kCFBooleanTrue)
    let err2 = AXUIElementSetAttributeValue(element, attrSelectedText, cfValue)
    if err2 == .success && axValueApplied(element, expected: newValue) {
        var payload: [String: Any] = ["ok": true, "strategy": "selected-text"]
        if let p = previous { payload["previous"] = p }
        emit(payload)
    }
    if err2 != .success {
        emitAXError(err2, context: "set-value/selected-text")
    }
    // Both setters returned OK but neither changed the field — surface a
    // structured error so the TS side falls back to type-via-CGEvent.
    emitError(
        "value did not apply (field may be a WebKit/Electron control)",
        code: 3,
        extra: ["strategy": "value+selected-text"]
    )
}

/// Re-read kAXValueAttribute and confirm it now equals `expected`. Used to
/// guard against setters that return .success but silently no-op (common in
/// WebKit/Electron text controls). If the element doesn't expose a readable
/// string value at all, we can't disprove the write, so we treat it as
/// applied (true) to avoid false negatives on write-only fields.
private func axValueApplied(_ element: AXUIElement, expected: String) -> Bool {
    guard let now = axString(element, attrValue) else { return true }
    return now == expected
}

// MARK: - Subcommand: a11y-focused-set-value

/// Read-and-replace the text of the system-wide FOCUSED element in ONE shot.
/// Unlike a11y-set-value (which resolves by --pid/--path and can go stale
/// between a separate read and write), this operates on the live
/// AXFocusedUIElement handle, so the read (`previous`) and the write target the
/// exact same element — race-free for the "read the focused field, rewrite it,
/// write it back" (Grammarly-style) flow. The element is already focused, so the
/// AXSelectedText fallback lands without an extra focus step.
///
/// Args: --value <string>  (required) the replacement text
/// Emits: { ok, strategy, previous } on success.
func runA11yFocusedSetValue() {
    ensureAXOrExit()

    guard let newValue = argValue(name: "--value") else {
        emitError("--value is required", code: 2)
    }

    let systemWide = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(systemWide, attrFocusedUIElem, &focusedRef)
    if err != .success {
        emitAXError(err, context: "focused-set-value/focus")
    }
    guard let raw = focusedRef else {
        emitError("no focused element", code: 3)
    }
    let element = raw as! AXUIElement

    let previous = axString(element, attrValue)
    let cfValue = newValue as CFString

    // Strategy 1: AXValue (whole-field replace).
    let err1 = AXUIElementSetAttributeValue(element, attrValue, cfValue)
    if err1 == .success {
        // .success is not proof the value stuck — WebKit/Electron fields can
        // accept the setter and keep their old text. Re-read and compare.
        if axValueApplied(element, expected: newValue) {
            var payload: [String: Any] = ["ok": true, "strategy": "value"]
            if let p = previous { payload["previous"] = p }
            emit(payload)
        }
        // Setter OK but no-op'd — fall through to AXSelectedText.
    } else if err1 != .attributeUnsupported && err1 != .illegalArgument {
        emitAXError(err1, context: "focused-set-value")
    }

    // Strategy 2: AXSelectedText fallback (editable text views — NSTextView,
    // some WebKit contentEditable). The element is THE focused element, so no
    // extra focus step is needed.
    let err2 = AXUIElementSetAttributeValue(element, attrSelectedText, cfValue)
    if err2 == .success && axValueApplied(element, expected: newValue) {
        var payload: [String: Any] = ["ok": true, "strategy": "selected-text"]
        if let p = previous { payload["previous"] = p }
        emit(payload)
    }
    if err2 != .success {
        emitAXError(err2, context: "focused-set-value/selected-text")
    }
    emitError(
        "value did not apply (field may be a WebKit/Electron control)",
        code: 3,
        extra: ["strategy": "value+selected-text"]
    )
}

// MARK: - Subcommand: a11y-selected-text

/// Read whatever text the user currently has HIGHLIGHTED / box-selected in
/// the system-wide focused element. This is the at-root way to give Clippy
/// "I can see what you've selected" awareness across ANY app, because
/// kAXSelectedTextAttribute is the canonical selection of the focused UI
/// element (text fields, NSTextView, WebKit, terminals that adopt AX, etc.).
///
/// Important: "nothing selected" is NOT an error. When there is no focused
/// element, or it doesn't support a selection, or the selection is empty,
/// we emit a clean payload with hasSelection=false and selectedText="" so
/// the TS/brain side can read it without parsing exceptions.
///
/// Emits: { hasSelection, selectedText, length, app, role }
func runA11ySelectedText() {
    ensureAXOrExit()

    let systemWide = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(systemWide, attrFocusedUIElem, &focusedRef)
    if err != .success {
        if err == .noValue || err == .attributeUnsupported {
            // No focus right now (e.g. user is on the desktop). Clean "none".
            emit([
                "hasSelection": false,
                "selectedText": "",
                "length": 0,
                "app": "",
                "role": ""
            ])
        }
        emitAXError(err, context: "selected-text/focus")
    }
    guard let raw = focusedRef else {
        emit([
            "hasSelection": false,
            "selectedText": "",
            "length": 0,
            "app": "",
            "role": ""
        ])
    }
    let focused = raw as! AXUIElement

    // Owning app + role for context.
    var pid: pid_t = 0
    _ = AXUIElementGetPid(focused, &pid)
    let name = appName(for: pid)
    let role = axString(focused, attrRole) ?? "AXUnknown"

    // The highlighted text itself. Absent / empty → no selection.
    let selected = axString(focused, attrSelectedText) ?? ""

    // Prefer the AXSelectedTextRange length when available (an AXValue
    // wrapping a CFRange). It's the authoritative count of selected
    // characters; fall back to the string's own count if the element
    // doesn't expose a range.
    var length = selected.count
    if let rangeVal = axCopy(focused, attrSelectedTextRange) {
        let axVal = rangeVal as! AXValue
        var cfRange = CFRange(location: 0, length: 0)
        if AXValueGetValue(axVal, .cfRange, &cfRange) {
            length = cfRange.length
        }
    }

    let hasSelection = !selected.isEmpty

    emit([
        "hasSelection": hasSelection,
        "selectedText": selected,
        "length": length,
        "app": name,
        "role": role
    ])
}
