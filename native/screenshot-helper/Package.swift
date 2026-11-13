// swift-tools-version:5.9
//
// screenshot-helper — tiny silent screenshot CLI for ClippyAI macOS.
//
// Why this exists
// ───────────────
// macOS Sonoma 14.5+ / Sequoia / Tahoe changed the behavior of the
// `/usr/sbin/screencapture` CLI: every invocation now flashes the
// screen and pops a thumbnail preview in the bottom-right corner,
// even with `-x` (silent) + `-o` (no shadow). That's fine for an
// interactive shortcut but jarring when ClippyAI fires a capture
// dozens of times per task in the background.
//
// The system-wide workaround (`defaults write com.apple.screencapture
// show-thumbnail -bool false`) breaks the Markup-before-save flow for
// every screenshot tool on the user's Mac, not just ours — explicitly
// rejected by the user as a "shortcut". This helper is the root-cause
// fix: a bundled native binary that calls the same CoreGraphics +
// ScreenCaptureKit APIs the system uses internally, with NONE of the
// shutter UX (no flash, no thumbnail, no sound, no notification).
//
// Deployment target
// ─────────────────
// macOS 12 (Monterey) — matches the floor of Electron 29's macOS
// support. ScreenCaptureKit's preferred API `SCScreenshotManager`
// requires macOS 14+, so 12-13 takes a CoreGraphics fallback path.
//
// Universal binary
// ────────────────
// scripts/build-native.js drives `swift build --arch arm64 --arch
// x86_64` to produce a fat binary that runs on both Apple Silicon
// and Intel Macs without Rosetta.

import PackageDescription

let package = Package(
    name: "screenshot-helper",
    platforms: [
        // macOS 12 = Monterey. Matches Electron 29's floor.
        .macOS(.v12)
    ],
    targets: [
        .executableTarget(
            name: "screenshot-helper",
            path: "Sources/screenshot-helper"
        )
    ]
)
