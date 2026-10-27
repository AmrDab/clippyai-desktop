// screenshot-helper/main.swift
//
// A silent macOS screenshot CLI for ClippyAI.
//
// Usage
// ─────
//   screenshot-helper --output /path/to/file.png
//   screenshot-helper --output /path/to/file.png --region 100,100,800,600
//
// Coordinates are in macOS display-space POINTS (the same units that
// `/usr/sbin/screencapture -R x,y,w,h` and Electron's `screen` module
// use). On Retina displays the output PNG's pixel dimensions will be
// roughly 2x the requested point dimensions; that matches the existing
// `screencapture` behavior so downstream code in cursor-vision.ts and
// tools.ts (which reads `img.getSize()` then downscales to the
// TARGET_SCREENSHOT_WIDTH) sees no change.
//
// Exit codes
// ──────────
//   0 — success (PNG written)
//   1 — permission denied / Screen Recording entitlement missing
//   2 — invalid arguments
//   3 — capture failed (display gone, API failure, write failure)
//
// Protocol
// ────────
//   stdout: nothing on success; JSON `{"error":"..."}` on failure
//   stderr: short human-readable failure reason
//   No NSLog, no shutter sound, no UI, no notifications.
//
// Capture strategy
// ────────────────
//   macOS 14+  →  ScreenCaptureKit's `SCScreenshotManager.captureImage`
//                 The modern, supported API. Goes through the same
//                 framework as the OS's own screenshot pipeline minus
//                 the UI. Properly handles HDR, multi-display, Stage
//                 Manager, etc.
//
//   macOS 12-13 →  CoreGraphics `CGWindowListCreateImage`
//                  Deprecated since macOS 14 but still functional and
//                  the only shutter-free option that ships with the
//                  system on Monterey/Ventura. CoreGraphics doesn't
//                  drive the screencapture daemon, so no shutter/thumbnail
//                  UI artifacts (the SCK path on 14+ still lights the
//                  system recording indicator — see screenshot-helper.ts).
//
// Why not just CGWindowListCreateImage everywhere? It's marked
// deprecated in macOS 14, prints a runtime warning in some Xcode
// build configs, and Apple has signalled it will eventually return
// blank/nil on future OS releases. ScreenCaptureKit is the long-term
// stable path; CG is our 12-13 safety net.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import AppKit

// MARK: - Output

/// Write a JSON error blob to stdout. The renderer parses stdout when
/// the helper exits non-zero; stderr is for humans tailing logs.
func emitJSONError(_ message: String) {
    // Hand-rolled JSON to keep the binary tiny + dependency-free.
    let escaped = message
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
    print("{\"error\":\"\(escaped)\"}")
}

/// Write a short message to stderr (no trailing newline if msg already has one).
func warn(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

// MARK: - Argument parsing

struct Args {
    var output: String
    var region: CGRect?  // nil = full main display
}

func parseArgs() -> Args? {
    var output: String?
    var region: CGRect?
    let argv = CommandLine.arguments
    var i = 1
    while i < argv.count {
        let a = argv[i]
        switch a {
        case "--output", "-o":
            i += 1
            if i >= argv.count { warn("--output requires a path"); return nil }
            output = argv[i]
        case "--region", "-r":
            i += 1
            if i >= argv.count { warn("--region requires x,y,w,h"); return nil }
            let parts = argv[i].split(separator: ",")
            if parts.count != 4 {
                warn("--region expects 4 comma-separated numbers (x,y,w,h)")
                return nil
            }
            guard
                let x = Double(parts[0]),
                let y = Double(parts[1]),
                let w = Double(parts[2]),
                let h = Double(parts[3]),
                w > 0, h > 0
            else {
                warn("--region values must be numeric, w and h must be > 0")
                return nil
            }
            region = CGRect(x: x, y: y, width: w, height: h)
        case "--help", "-h":
            print("Usage: screenshot-helper --output <path.png> [--region x,y,w,h]")
            exit(0)
        default:
            warn("Unknown argument: \(a)")
            return nil
        }
        i += 1
    }
    guard let out = output, !out.isEmpty else {
        warn("--output is required")
        return nil
    }
    return Args(output: out, region: region)
}

// MARK: - PNG writer

/// Encode a CGImage to PNG at the given file URL. Returns true on
/// success. We deliberately do NOT touch the image's pixel dimensions
/// or DPI; whatever the capture API gave us is what gets written.
func writePNG(_ image: CGImage, to url: URL) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(
        url as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        return false
    }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

// MARK: - Capture: ScreenCaptureKit (macOS 14+)

#if canImport(ScreenCaptureKit)

/// Capture via ScreenCaptureKit's `SCScreenshotManager`. Requires
/// macOS 14+. Throws on permission denied / no display / API failure;
/// caller maps the throw to an exit code.
@available(macOS 14.0, *)
func captureWithSCK(region: CGRect?) async throws -> CGImage {
    // Get the list of shareable displays. Throws .userDeclined if the
    // app doesn't have Screen Recording permission — we map that to
    // exit code 1 in main().
    let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: false
    )

    // Determine target display. If a region was supplied, find the
    // display whose frame contains the region's origin; otherwise
    // pick the main display (the one with origin 0,0 or NSScreen.main).
    let displays = content.displays
    guard !displays.isEmpty else {
        throw NSError(
            domain: "screenshot-helper",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "No displays available"]
        )
    }

    // SCDisplay.frame is in macOS display-space points. Pick the
    // display whose frame contains the region's center, falling back
    // to the first display if the region is off-screen.
    let target: SCDisplay
    let cropRect: CGRect?
    if let r = region {
        let cx = r.midX
        let cy = r.midY
        target = displays.first(where: { $0.frame.contains(CGPoint(x: cx, y: cy)) })
            ?? displays.first!
        // Convert region from global display-space to display-local
        // coordinates (SCK's contentRect is relative to the SCDisplay
        // frame's origin, with y also flipped — Cocoa uses
        // bottom-left origin, SCK's contentRect uses top-left.)
        //
        // Empirically: SCContentFilter accepts the SCDisplay and a
        // sourceRect in points relative to the display's origin
        // (top-left), with x increasing right and y increasing down.
        // macOS global screen space has the same x direction but y
        // is bottom-up. SCDisplay.frame in `excludingDesktopWindows`
        // uses Cocoa coordinates (origin bottom-left).
        let f = target.frame
        let localX = r.origin.x - f.origin.x
        // Flip y: distance from the TOP of the display.
        let localY = (f.origin.y + f.height) - (r.origin.y + r.height)
        cropRect = CGRect(x: localX, y: localY, width: r.width, height: r.height)
    } else {
        // Pick the display that NSScreen considers main, else first.
        let mainID = NSScreen.main?
            .deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        target = displays.first(where: { $0.displayID == mainID }) ?? displays.first!
        cropRect = nil
    }

    let filter = SCContentFilter(display: target, excludingWindows: [])

    let config = SCStreamConfiguration()
    // Match the legacy `/usr/sbin/screencapture` output: retina
    // displays produce 2x-pixel PNGs (4480×2520 on a 2240×1260 point
    // display). SCK's SCDisplay.width / .height empirically return
    // POINT dimensions on macOS 14/15 even though they're documented
    // as pixels, so we use NSScreen.backingScaleFactor as the
    // authoritative DPI source — it's been stable since 10.7.
    let nsScreen = NSScreen.screens.first(where: {
        let id = $0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
        return id == target.displayID
    }) ?? NSScreen.main
    let scale = Int(round(nsScreen?.backingScaleFactor ?? 1.0))
    let scaleFactor = max(1, scale)
    if let crop = cropRect {
        config.sourceRect = crop
        config.width = Int(crop.width) * scaleFactor
        config.height = Int(crop.height) * scaleFactor
    } else {
        config.width = target.width * scaleFactor
        config.height = target.height * scaleFactor
    }
    config.scalesToFit = false
    config.showsCursor = false
    config.capturesAudio = false
    // BGRA8 is the standard for CGImage interop.
    config.pixelFormat = kCVPixelFormatType_32BGRA

    let image = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: config
    )
    return image
}

#endif

// MARK: - Capture: CGWindowListCreateImage (macOS 12-13 fallback)

/// Capture via CoreGraphics. CGWindowListCreateImage takes a rect in
/// global display-space points (same coords as screencapture -R) and
/// returns a CGImage at native pixel resolution. Deprecated in macOS
/// 14 but still functional; we only fall here on 12-13.
func captureWithCG(region: CGRect?) -> CGImage? {
    let rect: CGRect
    if let r = region {
        rect = r
    } else {
        rect = .infinite  // .infinite = "all displays union"
    }
    // .bestResolution → native pixels (retina if applicable).
    // .nominalResolution would lock to 1x. We want parity with the
    // legacy screencapture path.
    let opts: CGWindowImageOption = [.bestResolution]
    return CGWindowListCreateImage(
        rect,
        .optionOnScreenOnly,
        kCGNullWindowID,
        opts
    )
}

// MARK: - Main

func main() -> Int32 {
    guard let args = parseArgs() else {
        emitJSONError("Invalid arguments")
        return 2
    }

    let outURL = URL(fileURLWithPath: args.output)
    // Make sure parent dir exists. We deliberately do NOT create
    // intermediate directories — if the caller passed a bad path
    // that's a programming error, not something to silently paper over.
    let parentDir = outURL.deletingLastPathComponent()
    var isDir: ObjCBool = false
    if !FileManager.default.fileExists(atPath: parentDir.path, isDirectory: &isDir) || !isDir.boolValue {
        emitJSONError("Output directory does not exist: \(parentDir.path)")
        warn("Output directory does not exist: \(parentDir.path)")
        return 2
    }

    // Try ScreenCaptureKit on macOS 14+, fall back to CG on older.
    var captured: CGImage?
    var permissionDenied = false
    var captureErrMsg = ""

    #if canImport(ScreenCaptureKit)
    if #available(macOS 14.0, *) {
        // Run the async capture synchronously — this is a one-shot
        // CLI, no event loop needed.
        let sema = DispatchSemaphore(value: 0)
        Task {
            do {
                let img = try await captureWithSCK(region: args.region)
                captured = img
            } catch {
                // SCK reports permission denial as a specific NSError
                // domain. Anything else is a generic capture failure.
                let ns = error as NSError
                if ns.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
                    || ns.localizedDescription.lowercased().contains("permission")
                    || ns.localizedDescription.lowercased().contains("declined")
                    || ns.code == -3801   // SCStreamErrorUserDeclined
                {
                    permissionDenied = true
                }
                captureErrMsg = ns.localizedDescription
            }
            sema.signal()
        }
        sema.wait()
    } else {
        captured = captureWithCG(region: args.region)
        if captured == nil {
            // CGWindowListCreateImage returns nil on permission
            // denial too. We can't tell apart "no displays" from
            // "user said no" on 12-13 without preflighting, but
            // the renderer falls back to /usr/sbin/screencapture
            // either way, so this is fine.
            captureErrMsg = "CGWindowListCreateImage returned nil"
        }
    }
    #else
    captured = captureWithCG(region: args.region)
    if captured == nil {
        captureErrMsg = "CGWindowListCreateImage returned nil"
    }
    #endif

    if permissionDenied {
        emitJSONError("Screen Recording permission denied")
        warn("Screen Recording permission denied — open System Settings → Privacy & Security → Screen Recording and grant ClippyAI.")
        return 1
    }
    guard let cgImage = captured else {
        emitJSONError(captureErrMsg.isEmpty ? "Capture failed" : captureErrMsg)
        warn("Capture failed: \(captureErrMsg)")
        return 3
    }

    if !writePNG(cgImage, to: outURL) {
        emitJSONError("Failed to write PNG to \(outURL.path)")
        warn("Failed to write PNG to \(outURL.path)")
        return 3
    }

    return 0
}

exit(main())
