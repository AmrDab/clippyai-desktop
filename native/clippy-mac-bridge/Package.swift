// swift-tools-version:5.9
//
// clippy-mac-bridge — unified macOS automation CLI for ClippyAI.
//
// Why this exists
// ───────────────
// Through v0.19.x the macOS port forwarded ~31 of 32 tool dispatches to
// powershell.exe + .ps1 scripts from the Windows codebase. On Mac those
// fail `spawn ENOENT` in 5-30ms each, leaving the brain operating blind.
// Production logs (May 21-23, 2026) showed 15 user tasks ending across
// 3 days, 0 with task_complete, 1 successful tool action total.
//
// v0.20.0 replaces the PowerShell layer entirely on darwin with this
// single Swift CLI. Subcommands cover the 8 essential automation
// capability areas:
//
//   screenshot     vision (already shipped via separate screenshot-helper,
//                  bridged here for one-binary consolidation later)
//   ocr            VNRecognizeTextRequest on already-captured pixels
//   a11y-*         AXUIElement tree walk, find by text/role, click, set value
//   windows        CGWindowListCopyWindowInfo, NSWorkspace, AX focus
//   input          CGEvent keyboard + mouse synthesis (real drag, real wheel)
//   sys            Active app, browser URL, clipboard, permission probe
//
// Deployment target: macOS 12 (Monterey). Matches Electron 29's floor
// and the existing screenshot-helper.
//
// Universal binary: built via `swift build --arch arm64 --arch x86_64`
// (see scripts/build-native.js) so a single fat binary ships in the
// .app bundle for both Apple Silicon and Intel.
//
// Permissions: TCC-gated.
//   • Screen Recording — needed for ocr-screen, modern window titles
//   • Accessibility    — needed for a11y-*, input synthesis, focus
//   • Automation (per-app) — needed for browser-url to Safari/Chrome
//
// The binary does NOT pre-prompt the user; first call that needs a
// permission lets macOS surface the OS dialog. Exit code 1 + a JSON
// payload `{"error":"…permission denied…","code":1}` signals the TS
// wrapper to update its permission-state and surface to the brain so
// the model degrades gracefully (e.g. "Accessibility is denied, ask
// the user to grant it" instead of repeatedly trying clicks).
//
// Spawn-per-call vs persistent daemon: spawn cost ~5-10ms (measured
// from screenshot-helper). At ~5 calls per turn that's 50ms — well
// inside the tier-2 budget. Daemon mode deferred to v0.21.0 unless
// telemetry shows >20 calls/turn. The CLI shape maps 1:1 to a future
// `{"cmd":"a11y-tree","args":{…}}` JSONL stdio protocol so the upgrade
// is mechanical.

import PackageDescription

let package = Package(
    name: "clippy-mac-bridge",
    platforms: [
        // macOS 12 = Monterey. Matches Electron 29's floor + screenshot-helper.
        .macOS(.v12)
    ],
    targets: [
        .executableTarget(
            name: "clippy-mac-bridge",
            path: "Sources/clippy-mac-bridge"
        )
    ]
)
