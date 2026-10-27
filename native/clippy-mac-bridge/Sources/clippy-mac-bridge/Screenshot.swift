// Screenshot.swift
//
// `clippy-mac-bridge screenshot` subcommand.
//
// Usage
// ─────
//   clippy-mac-bridge screenshot --output /tmp/x.png [--region x,y,w,h] [--display 0]
//     → stdout: {"path":"/tmp/x.png","width":2240,"height":1260,"scale":2}
//
// Ports the dual-path capture logic from the standalone screenshot-helper
// binary (native/screenshot-helper/Sources/screenshot-helper/main.swift)
// into a subcommand of the unified bridge:
//
//   • macOS 14+ → ScreenCaptureKit.SCScreenshotManager
//   • macOS 12-13 → CGWindowListCreateImage (deprecated but functional)
//
// The standalone binary stays in the tree for now — screenshot-helper.ts
// already wires to it. Both coexist until the v0.21.0 fold-in. Internal
// logic is intentionally near-identical so both produce the same PNG
// pixels for the same coords (eyeball-diffable during migration QA).
//
// Coordinates are in macOS display-space POINTS. Retina displays produce
// PNGs with pixel dimensions ~2x the requested point dimensions; the
// reported `scale` field tells the TS wrapper the factor so it can
// downscale for cursor-vision or know the OCR coordinate basis.
//
// The capture function `captureScreenImage(region:)` is also exposed
// (internal scope) so OCR.swift's `ocr-screen` path can reuse it without
// shelling back out to the same binary.
//
// Exit codes match the binary-wide contract (see JSON.swift):
//   0 success, 1 permission denied, 2 invalid arguments, 3 capture failed

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif
import AppKit

// MARK: - Public capture entry (shared with OCR.swift)

/// Result of a capture operation. Used both by `runScreenshot()` to write
/// to disk and by `OCR.swift`'s `ocr-screen` to feed Vision directly.
struct CaptureResult {
    let image: CGImage
    /// Backing scale factor (1 on non-retina, 2 on retina). PNG pixel
    /// dimensions are ~`scale × point dimensions`.
    let scale: Int
    /// Image pixel dimensions.
    let pixelWidth: Int
    let pixelHeight: Int
    /// Origin display ID, useful for downstream coord arithmetic.
    let displayID: CGDirectDisplayID
}

/// Errors raised by the capture path. Caller maps to JSON error + exit code.
enum CaptureError: Error {
    case permissionDenied(String)
    case noDisplays
    case captureFailed(String)
}

/// Capture the screen (or a region of it). Picks SCK on macOS 14+,
/// falls back to CGWindowListCreateImage on 12-13.
///
/// `region` is in macOS global display-space POINTS (Cocoa coords,
/// bottom-left origin) — same units as `screencapture -R`.
///
/// `displayIndex` selects which display when no region is supplied
/// (region implicitly picks the display containing its center).
func captureScreenImage(region: CGRect?, displayIndex: Int = 0) throws -> CaptureResult {
    #if canImport(ScreenCaptureKit)
    if #available(macOS 14.0, *) {
        return try captureWithSCK(region: region, displayIndex: displayIndex)
    } else {
        return try captureWithCG(region: region)
    }
    #else
    return try captureWithCG(region: region)
    #endif
}

// MARK: - ScreenCaptureKit path (macOS 14+)

#if canImport(ScreenCaptureKit)
@available(macOS 14.0, *)
private func captureWithSCK(region: CGRect?, displayIndex: Int) throws -> CaptureResult {
    // Bridge the SCK async API into a sync call — we're a one-shot CLI,
    // no event loop, no callers depending on cooperative concurrency.
    let sema = DispatchSemaphore(value: 0)
    var result: CaptureResult?
    var capturedError: Error?

    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            let displays = content.displays
            guard !displays.isEmpty else {
                capturedError = CaptureError.noDisplays
                sema.signal()
                return
            }

            // Choose target display. Region-supplied → display containing
            // region center. Else → user-selected index (clamped) or main.
            let target: SCDisplay
            let cropRect: CGRect?
            if let r = region {
                let c = CGPoint(x: r.midX, y: r.midY)
                target = displays.first(where: { $0.frame.contains(c) }) ?? displays.first!
                // SCK's sourceRect is display-local with top-left origin.
                // Global Cocoa coords have bottom-left origin, so flip y.
                let f = target.frame
                let localX = r.origin.x - f.origin.x
                let localY = (f.origin.y + f.height) - (r.origin.y + r.height)
                cropRect = CGRect(x: localX, y: localY, width: r.width, height: r.height)
            } else if displayIndex > 0 && displayIndex < displays.count {
                target = displays[displayIndex]
                cropRect = nil
            } else {
                let mainID = NSScreen.main?
                    .deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
                target = displays.first(where: { $0.displayID == mainID }) ?? displays.first!
                cropRect = nil
            }

            // backingScaleFactor is the canonical retina factor since 10.7.
            // SCDisplay.width/.height return POINTS on 14/15 in our testing.
            let nsScreen = NSScreen.screens.first(where: {
                let id = $0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID
                return id == target.displayID
            }) ?? NSScreen.main
            let scale = max(1, Int(round(nsScreen?.backingScaleFactor ?? 1.0)))

            let filter = SCContentFilter(display: target, excludingWindows: [])
            let config = SCStreamConfiguration()
            if let crop = cropRect {
                config.sourceRect = crop
                config.width = Int(crop.width) * scale
                config.height = Int(crop.height) * scale
            } else {
                config.width = target.width * scale
                config.height = target.height * scale
            }
            config.scalesToFit = false
            config.showsCursor = false
            config.capturesAudio = false
            config.pixelFormat = kCVPixelFormatType_32BGRA

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
            result = CaptureResult(
                image: image,
                scale: scale,
                pixelWidth: image.width,
                pixelHeight: image.height,
                displayID: target.displayID
            )
        } catch {
            // SCK reports permission denial via several signals — be
            // generous in detection. SCStreamError.userDeclined is -3801.
            let ns = error as NSError
            let msg = ns.localizedDescription
            let lower = msg.lowercased()
            if ns.code == -3801
                || ns.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && ns.code == -3801
                || lower.contains("permission")
                || lower.contains("declined")
                || lower.contains("not allowed") {
                capturedError = CaptureError.permissionDenied(msg)
            } else {
                capturedError = CaptureError.captureFailed(msg)
            }
        }
        sema.signal()
    }
    sema.wait()

    if let err = capturedError { throw err }
    guard let r = result else {
        throw CaptureError.captureFailed("SCK returned no image and no error")
    }
    return r
}
#endif

// MARK: - CoreGraphics path (macOS 12-13 fallback)

/// CGWindowListCreateImage takes a rect in global display-space POINTS
/// and returns a CGImage at native pixel resolution. Deprecated on 14+,
/// kept here as our Monterey/Ventura safety net. CG returns nil on both
/// "permission denied" and "no displays" without distinguishing — the
/// caller maps nil to captureFailed and downstream code can preflight
/// via `permissions` to disambiguate.
private func captureWithCG(region: CGRect?) throws -> CaptureResult {
    let rect = region ?? .infinite
    let opts: CGWindowImageOption = [.bestResolution]
    guard let image = CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, opts) else {
        throw CaptureError.captureFailed("CGWindowListCreateImage returned nil")
    }
    // Derive scale from main NSScreen. CG doesn't report it on this path.
    let scale = max(1, Int(round(NSScreen.main?.backingScaleFactor ?? 1.0)))
    let displayID = (NSScreen.main?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) ?? CGMainDisplayID()
    return CaptureResult(
        image: image,
        scale: scale,
        pixelWidth: image.width,
        pixelHeight: image.height,
        displayID: displayID
    )
}

// MARK: - PNG writer

/// Encode a CGImage to PNG. Returns true on success. We never touch the
/// image's pixel dimensions or DPI — whatever the capture API gave us is
/// what gets written, so the PNG round-trips losslessly.
func writeCGImageAsPNG(_ image: CGImage, to url: URL) -> Bool {
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

// MARK: - Subcommand entry

func runScreenshot() -> Never {
    guard let output = argValue(name: "--output", short: "-o") else {
        emitError("--output is required (path to PNG)", code: 2)
    }
    let regionStr = argValue(name: "--region", short: "-r")
    let displayStr = argValue(name: "--display")

    // Parse region (x,y,w,h) — same syntax as screenshot-helper.
    var region: CGRect?
    if let s = regionStr {
        guard let nums = parseDoubles(s), nums.count == 4, nums[2] > 0, nums[3] > 0 else {
            emitError("--region expects x,y,w,h with positive w,h", code: 2)
        }
        region = CGRect(x: nums[0], y: nums[1], width: nums[2], height: nums[3])
    }

    // Parse display index (default 0 = main).
    var displayIndex = 0
    if let s = displayStr {
        guard let n = Int(s), n >= 0 else {
            emitError("--display expects a non-negative integer", code: 2)
        }
        displayIndex = n
    }

    let outURL = URL(fileURLWithPath: output)
    // Don't auto-mkdir — bad path is a caller bug worth surfacing loudly.
    let parentDir = outURL.deletingLastPathComponent()
    var isDir: ObjCBool = false
    if !FileManager.default.fileExists(atPath: parentDir.path, isDirectory: &isDir) || !isDir.boolValue {
        emitError("output directory does not exist: \(parentDir.path)", code: 2)
    }

    let captured: CaptureResult
    do {
        captured = try captureScreenImage(region: region, displayIndex: displayIndex)
    } catch CaptureError.permissionDenied(let msg) {
        emitError("Screen Recording permission denied: \(msg)", code: 1, extra: [
            "permission": "screenRecording"
        ])
    } catch CaptureError.noDisplays {
        emitError("no displays available", code: 3)
    } catch CaptureError.captureFailed(let msg) {
        emitError("capture failed: \(msg)", code: 3)
    } catch {
        emitError("capture failed: \(error.localizedDescription)", code: 3)
    }

    if !writeCGImageAsPNG(captured.image, to: outURL) {
        emitError("failed to write PNG to \(outURL.path)", code: 3)
    }

    // Report dimensions in POINTS (what callers ask in), and the scale so
    // they can recover pixel dimensions if needed. Matches the spec shape.
    let pointWidth = captured.pixelWidth / max(1, captured.scale)
    let pointHeight = captured.pixelHeight / max(1, captured.scale)
    emit([
        "path": outURL.path,
        "width": pointWidth,
        "height": pointHeight,
        "scale": captured.scale,
        "pixelWidth": captured.pixelWidth,
        "pixelHeight": captured.pixelHeight
    ])
}
