// Sys.swift
//
// `clippy-mac-bridge` system-state subcommands.
//
//   active-app        frontmost NSRunningApplication (with Electron sniff)
//   running-apps      every NSRunningApplication (filtered)
//   browser-url       URL + tabs of the frontmost browser via AppleScript
//   clipboard-read    NSPasteboard.general string + available UTIs
//   clipboard-write   NSPasteboard.general set string (--text or --stdin)
//   permissions       read-only TCC probe (screen / a11y / automation)
//
// Permission notes
// ────────────────
//   `active-app`, `running-apps`, `clipboard-read`, `clipboard-write`,
//   `permissions` all run without any TCC permission.
//
//   `browser-url` triggers the per-app Automation prompt on first call
//   against each browser bundleID. We catch `errAEEventNotPermitted`
//   and `-1743` (user declined) and surface them as exit code 1 with
//   `permission: automation` so the UI can deep-link to System Settings
//   → Privacy → Automation.
//
//   `permissions` is pure inspection — it never triggers a dialog. The
//   Automation probe uses `AEDeterminePermissionToAutomateTarget` with
//   `kAESuppressDialog=true`, which returns immediately with one of
//   three statuses without prompting the user.

import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

// MARK: - active-app

func runActiveApp() -> Never {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        emitError("no frontmost application", code: 3)
    }
    let bundleID = app.bundleIdentifier ?? ""
    let isElectron = appIsElectron(app)
    var payload: [String: Any] = [
        "app": app.localizedName ?? "",
        "pid": Int(app.processIdentifier),
        "bundleID": bundleID,
        "isElectron": isElectron
    ]
    if let url = app.bundleURL?.path {
        payload["bundlePath"] = url
    }
    if let exec = app.executableURL?.path {
        payload["executablePath"] = exec
    }
    emit(payload)
}

/// True if the .app bundle ships an Electron framework. We look for
/// `Contents/Frameworks/Electron Framework.framework` — that's the
/// canonical filesystem signature; bundleID heuristics fall over for
/// repackaged apps. We deliberately don't probe child processes (would
/// need Mach inspection); the framework check matches what `tools.ts`
/// uses to decide between AX vs CDP-via-debug-port flows.
private func appIsElectron(_ app: NSRunningApplication) -> Bool {
    guard let bundleURL = app.bundleURL else { return false }
    let candidates = [
        "Contents/Frameworks/Electron Framework.framework",
        "Contents/Frameworks/Electron Helper.app",
        "Contents/Frameworks/Electron Helper (Renderer).app"
    ]
    let fm = FileManager.default
    for c in candidates {
        if fm.fileExists(atPath: bundleURL.appendingPathComponent(c).path) {
            return true
        }
    }
    return false
}

// MARK: - running-apps

func runRunningApps() -> Never {
    let includeAccessory = argBool(name: "--include-accessory", default: false)
    let apps = NSWorkspace.shared.runningApplications
    let filtered = apps.filter { app in
        // .regular = appears in Dock + cmd+tab. .accessory = menubar/agent.
        // .prohibited = background daemon, no UI presence. Default to
        // user-visible apps; opt in to accessory when callers ask.
        switch app.activationPolicy {
        case .regular: return true
        case .accessory: return includeAccessory
        case .prohibited: return false
        @unknown default: return false
        }
    }
    let list: [[String: Any]] = filtered.map { app in
        let policy: String
        switch app.activationPolicy {
        case .regular: policy = "regular"
        case .accessory: policy = "accessory"
        case .prohibited: policy = "prohibited"
        @unknown default: policy = "unknown"
        }
        var d: [String: Any] = [
            "app": app.localizedName ?? "",
            "pid": Int(app.processIdentifier),
            "bundleID": app.bundleIdentifier ?? "",
            "activationPolicy": policy,
            "isActive": app.isActive,
            "isHidden": app.isHidden
        ]
        if let p = app.bundleURL?.path { d["bundlePath"] = p }
        return d
    }
    emit(["apps": list])
}

// MARK: - browser-url

/// Sentinel delimiters shared between the AppleScript that builds the tab
/// blob and the Swift parser that reads it back. US (0x1F) separates the
/// url/title fields of one tab; RS (0x1E) separates tab entries. These
/// replace the old ", "/"\t" scheme that collided with titles containing
/// a comma-space or tab.
private let fieldSeparator = "\u{1F}"
private let entrySeparator = "\u{1E}"

/// Known browser bundle IDs we support. The map covers detection of the
/// frontmost browser when `--app` is omitted + name normalization for
/// the JSON output.
private let knownBrowsers: [(name: String, bundleID: String, display: String)] = [
    ("safari",  "com.apple.Safari",          "Safari"),
    ("chrome",  "com.google.Chrome",         "Google Chrome"),
    ("edge",    "com.microsoft.edgemac",     "Microsoft Edge"),
    ("brave",   "com.brave.Browser",         "Brave Browser"),
    ("arc",     "company.thebrowser.Browser","Arc")
]

func runBrowserURL() -> Never {
    let explicit = argValue(name: "--app")?.lowercased()
    let browser = resolveBrowser(explicit: explicit)
    guard let b = browser else {
        if let e = explicit {
            emitError("unknown browser: \(e). Supported: safari, chrome, edge, brave, arc", code: 2)
        } else {
            emitError("no supported browser is frontmost — pass --app safari|chrome|edge|brave|arc", code: 3)
        }
    }

    let script = appleScriptForBrowser(b.name)
    let result = runAppleScript(script)
    switch result {
    case .success(let descriptor):
        let payload = parseBrowserResult(b: b, descriptor: descriptor)
        emit(payload)
    case .permissionDenied(let msg):
        emitError("Automation permission denied for \(b.display): \(msg)", code: 1, extra: [
            "permission": "automation",
            "bundleID": b.bundleID
        ])
    case .appNotRunning:
        emitError("\(b.display) is not running", code: 3, extra: ["bundleID": b.bundleID])
    case .failure(let msg):
        emitError("AppleScript failed for \(b.display): \(msg)", code: 3, extra: [
            "bundleID": b.bundleID
        ])
    }
}

/// Pick the browser to query. Priority: explicit `--app`, else frontmost
/// app if it's a known browser, else nil.
private func resolveBrowser(explicit: String?) -> (name: String, bundleID: String, display: String)? {
    if let e = explicit {
        return knownBrowsers.first(where: { $0.name == e })
    }
    if let front = NSWorkspace.shared.frontmostApplication,
       let bid = front.bundleIdentifier,
       let match = knownBrowsers.first(where: { $0.bundleID == bid }) {
        return match
    }
    return nil
}

/// AppleScript per browser. Returns a record-ish structure we can pull
/// fields out of. Safari/Chrome/Edge/Brave all expose tab URLs through
/// Apple Events; Arc only exposes the front window URL (no tab API).
///
/// We try to get the full tab list when available; tabs are useful for
/// agents that need to switch focus or scan multiple pages.
private func appleScriptForBrowser(_ name: String) -> String {
    // Sentinel delimiters for the tab blob. Using ASCII control chars
    // (US = 0x1F between url/title, RS = 0x1E between tab entries) instead of
    // ", " / "\t" so that page titles or URLs that legitimately contain a
    // comma-space or tab can't collide with the field/record boundaries.
    // The separators are built in-script via `ASCII character` so we never
    // embed raw control bytes in the AppleScript source; parseBrowserResult()
    // splits on these exact code points (see fieldSeparator/entrySeparator).
    switch name {
    case "safari":
        return """
        tell application "Safari"
            if not running then return "__not_running__"
            if (count of windows) is 0 then return "__no_windows__"
            set fieldSep to (ASCII character 31)
            set entrySep to (ASCII character 30)
            set frontWin to front window
            set curTab to current tab of frontWin
            set curURL to URL of curTab
            set curTitle to name of curTab
            set tabList to {}
            repeat with t in tabs of frontWin
                set end of tabList to (URL of t) & fieldSep & (name of t)
            end repeat
            set AppleScript's text item delimiters to entrySep
            set tabBlob to (tabList as string)
            set AppleScript's text item delimiters to ""
            return curURL & "\n" & curTitle & "\n" & tabBlob
        end tell
        """
    case "chrome", "brave":
        let appName = name == "chrome" ? "Google Chrome" : "Brave Browser"
        return """
        tell application "\(appName)"
            if not running then return "__not_running__"
            if (count of windows) is 0 then return "__no_windows__"
            set fieldSep to (ASCII character 31)
            set entrySep to (ASCII character 30)
            set frontWin to front window
            set curTab to active tab of frontWin
            set curURL to URL of curTab
            set curTitle to title of curTab
            set tabList to {}
            repeat with t in tabs of frontWin
                set end of tabList to (URL of t) & fieldSep & (title of t)
            end repeat
            set AppleScript's text item delimiters to entrySep
            set tabBlob to (tabList as string)
            set AppleScript's text item delimiters to ""
            return curURL & "\n" & curTitle & "\n" & tabBlob
        end tell
        """
    case "edge":
        return """
        tell application "Microsoft Edge"
            if not running then return "__not_running__"
            if (count of windows) is 0 then return "__no_windows__"
            set fieldSep to (ASCII character 31)
            set entrySep to (ASCII character 30)
            set frontWin to front window
            set curTab to active tab of frontWin
            set curURL to URL of curTab
            set curTitle to title of curTab
            set tabList to {}
            repeat with t in tabs of frontWin
                set end of tabList to (URL of t) & fieldSep & (title of t)
            end repeat
            set AppleScript's text item delimiters to entrySep
            set tabBlob to (tabList as string)
            set AppleScript's text item delimiters to ""
            return curURL & "\n" & curTitle & "\n" & tabBlob
        end tell
        """
    case "arc":
        // Arc's scripting dictionary is more limited; we get the active
        // tab URL/title but no tab enumeration.
        return """
        tell application "Arc"
            if not running then return "__not_running__"
            if (count of windows) is 0 then return "__no_windows__"
            set frontWin to front window
            set curTab to active tab of frontWin
            set curURL to URL of curTab
            set curTitle to title of curTab
            return curURL & "\n" & curTitle & "\n"
        end tell
        """
    default:
        return ""
    }
}

/// AppleScript execution result categories. Distinguishing these is the
/// whole point of having structured error codes downstream.
private enum AppleScriptResult {
    case success(String)
    case permissionDenied(String)
    case appNotRunning
    case failure(String)
}

private func runAppleScript(_ source: String) -> AppleScriptResult {
    guard let script = NSAppleScript(source: source) else {
        return .failure("could not compile AppleScript")
    }
    var error: NSDictionary?
    let descriptor = script.executeAndReturnError(&error)
    if let err = error {
        let code = (err[NSAppleScript.errorNumber] as? Int) ?? 0
        let msg = (err[NSAppleScript.errorMessage] as? String) ?? "unknown error"
        // -1743: not authorized to send Apple events to <app> — TCC denial.
        // -600: application isn't running.
        // -1728: can't get object (e.g. no front window) — surface as failure.
        if code == -1743 {
            return .permissionDenied(msg)
        }
        if code == -600 {
            return .appNotRunning
        }
        return .failure("[\(code)] \(msg)")
    }
    let str = descriptor.stringValue ?? ""
    if str == "__not_running__" { return .appNotRunning }
    if str == "__no_windows__" { return .failure("no windows open") }
    return .success(str)
}

/// Parse the AppleScript-returned blob: three lines, then tabs encoded as
/// `url<US>title` entries separated by `<RS>` (the sentinel delimiters set in
/// appleScriptForBrowser). Using control-char sentinels instead of ", "/"\t"
/// means titles or URLs containing a comma-space or tab don't break parsing.
private func parseBrowserResult(
    b: (name: String, bundleID: String, display: String),
    descriptor: String
) -> [String: Any] {
    let lines = descriptor.components(separatedBy: "\n")
    let url = lines.count > 0 ? lines[0] : ""
    let title = lines.count > 1 ? lines[1] : ""
    let tabsBlob = lines.count > 2 ? lines[2] : ""
    var tabs: [[String: Any]] = []
    if !tabsBlob.isEmpty {
        let entries = tabsBlob.components(separatedBy: entrySeparator)
        for entry in entries {
            let parts = entry.components(separatedBy: fieldSeparator)
            if parts.count >= 2 {
                tabs.append([
                    "url": parts[0],
                    "title": parts[1],
                    "active": parts[0] == url
                ])
            }
        }
    }
    var payload: [String: Any] = [
        "app": b.display,
        "bundleID": b.bundleID,
        "url": url,
        "title": title
    ]
    if !tabs.isEmpty { payload["tabs"] = tabs }
    return payload
}

// MARK: - clipboard-read

func runClipboardRead() -> Never {
    let pb = NSPasteboard.general
    let text = pb.string(forType: .string) ?? ""
    let types = (pb.types ?? []).map { $0.rawValue }
    emit([
        "text": text,
        "types": types,
        "changeCount": pb.changeCount
    ])
}

// MARK: - clipboard-write

func runClipboardWrite() -> Never {
    let useStdin = argBool(name: "--stdin", default: false)
    let payload: String
    if useStdin {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        payload = String(data: data, encoding: .utf8) ?? ""
    } else if let t = argValue(name: "--text") {
        payload = t
    } else {
        emitError("--text or --stdin is required", code: 2)
    }
    let pb = NSPasteboard.general
    pb.clearContents()
    let ok = pb.setString(payload, forType: .string)
    if !ok {
        emitError("NSPasteboard setString returned false", code: 3)
    }
    emit([
        "ok": true,
        "bytes": payload.utf8.count,
        "changeCount": pb.changeCount
    ])
}

// MARK: - permissions

func runPermissions() -> Never {
    // Screen Recording: CGPreflightScreenCaptureAccess returns Bool.
    // It returns false for both "denied" and "never asked" on modern
    // macOS — we can't disambiguate without firing a capture. Callers
    // that need to distinguish should attempt a tiny screenshot and
    // check the exit code.
    let screenGranted = CGPreflightScreenCaptureAccess()
    let screenStatus = screenGranted ? "granted" : "denied"

    // Accessibility: AXIsProcessTrusted is fast + non-prompting.
    let axGranted = AXIsProcessTrusted()
    let axStatus = axGranted ? "granted" : "denied"

    // Automation: per-app probe via AEDeterminePermissionToAutomateTarget.
    // Available on macOS 10.14+. With kAESuppressDialog = true it returns
    // immediately with one of:
    //   noErr (0)               → granted
    //   errAEEventNotPermitted (-1743) → user declined OR never asked
    //   procNotFound (-600)     → target app not running (can't tell)
    //   errAEPrivilegeError (-10004) → some macOS versions return this
    //                                  for denied
    //
    // We CANNOT distinguish "denied" from "undetermined" without
    // triggering the dialog. We map -1743 → "denied" because that's
    // what the UI needs to act on (deep-link to System Settings);
    // procNotFound → "unknown" so the UI doesn't claim a denial that
    // isn't real.
    var automation: [String: String] = [:]
    for b in knownBrowsers {
        automation[b.bundleID] = automationStatus(forBundleID: b.bundleID)
    }

    emit([
        "screenRecording": screenStatus,
        "accessibility": axStatus,
        "automation": automation,
        // Best-effort hints for callers that want to render a dialog.
        "_hint": [
            "screenRecording": "denied may also mean 'never asked' — attempt a screenshot to disambiguate",
            "automation": "denied may also mean 'never asked' — first attempt at browser-url surfaces the dialog"
        ]
    ])
}

/// Triggers macOS's native Screen-Recording permission dialog (preflight alone
/// can't surface it, and can't distinguish denied vs never-asked). Emits the
/// resulting grant state. macOS often needs an app relaunch for the grant to
/// take effect — callers should surface that.
func runRequestScreenRecording() -> Never {
    let granted = CGRequestScreenCaptureAccess()
    emit(["granted": granted])
}

/// Probe Automation permission for a given bundle ID. Always uses
/// kAESuppressDialog so we never prompt the user from a status probe.
private func automationStatus(forBundleID bundleID: String) -> String {
    // AEDeterminePermissionToAutomateTarget is macOS 10.14+. Our deploy
    // target is 12, so it's always available — but guard for safety.
    if #available(macOS 10.14, *) {
        // Build an AEAddressDesc for the target bundle ID.
        var addressDesc = AEAddressDesc()
        // typeApplicationBundleID = 'bund'
        let bundleData = Array(bundleID.utf8)
        let status: OSErr = bundleData.withUnsafeBufferPointer { ptr in
            AECreateDesc(
                typeApplicationBundleID,
                ptr.baseAddress,
                bundleData.count,
                &addressDesc
            )
        }
        if status != noErr {
            return "unknown"
        }
        defer { AEDisposeDesc(&addressDesc) }

        // 'evcl' / 'evid' isn't required for the probe; we pass the
        // wildcard "any event" by using typeWildCard with no specific
        // event class/id. macOS's docs say: pass the event class/id
        // you'd send. We use kCoreEventClass + kAEOpenApplication as
        // a benign event that virtually every app handles.
        let osErr = AEDeterminePermissionToAutomateTarget(
            &addressDesc,
            kCoreEventClass,
            kAEOpenApplication,
            /* askUserIfNeeded: */ false
        )
        switch osErr {
        case noErr:
            return "granted"
        case OSStatus(-1743):           // errAEEventNotPermitted
            return "denied"
        case OSStatus(-600):            // procNotFound
            return "unknown"
        case OSStatus(-10004):          // errAEPrivilegeError
            return "denied"
        case OSStatus(-1744):           // errAEEventWouldRequireUserConsent
            return "undetermined"
        default:
            return "unknown"
        }
    } else {
        return "unknown"
    }
}
