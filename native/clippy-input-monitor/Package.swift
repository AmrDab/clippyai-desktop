// swift-tools-version:5.9
//
// clippy-input-monitor — long-running, listen-only keyboard monitor for ClippyAI.
//
// Separate from clippy-mac-bridge because capturing input requires a live
// CGEventTap + CFRunLoop (a persistent process), whereas the bridge is a
// spawn-per-call CLI. This helper holds the tap; ClippyAI's main process
// spawns it once and controls it over stdin (enable/disable/quit).
//
// Deployment target: macOS 12 (matches the bridge + screenshot-helper).
// Universal binary built by scripts/build-native.js (arm64 + x86_64).

import PackageDescription

let package = Package(
    name: "clippy-input-monitor",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "clippy-input-monitor",
            path: "Sources/clippy-input-monitor"
        )
    ]
)
