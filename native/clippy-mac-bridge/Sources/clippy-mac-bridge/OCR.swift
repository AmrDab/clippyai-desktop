// OCR.swift
//
// `clippy-mac-bridge ocr` + `ocr-screen` subcommands.
//
// Usage
// ─────
//   clippy-mac-bridge ocr --image /tmp/x.png [--languages en,ar] [--mode accurate|fast]
//     → {"fullText":"…","elements":[
//         {"text":"Send","x":312,"y":188,"width":48,"height":18,
//          "confidence":0.98,"line":2}, …
//       ]}
//
//   clippy-mac-bridge ocr-screen [--region x,y,w,h] [--languages en,ar] [--mode accurate|fast]
//     → same shape; captures + OCRs in-process (skips PNG round-trip).
//
// Implementation
// ──────────────
//   Vision.VNRecognizeTextRequest on a CGImage. Vision doesn't gate on
//   TCC — it works on already-captured pixels. Only the `ocr-screen`
//   form needs Screen Recording (for the capture step that feeds it).
//   `ocr --image foo.png` runs on any user PNG with no permission at all.
//
// Coordinate basis
// ────────────────
//   Vision's `boundingBox` is normalized (0..1) with BOTTOM-LEFT origin.
//   We convert to:
//     • pixel coords (multiply by image size, flip y) — internal scratch
//     • POINT coords (divide pixel by scale) — what we ship in the JSON
//
//   This matches the input subcommand's coord basis (`click --x --y`
//   takes points), so a typical agent loop becomes:
//     ocr-screen → pick element → click x,y    // all in points, no math
//
//   For `ocr --image foo.png` we don't know the source display scale,
//   so we default to scale=1 (i.e. the reported coords are image pixels,
//   which equal points only on non-retina). The TS wrapper can pass
//   `--scale 2` if it knows the image came from a retina capture; see
//   `effectiveScale()` below.
//
// Line grouping
// ─────────────
//   Vision returns observations in reading order but doesn't tag them
//   with a logical line index. We cluster observations whose centers
//   are within ~5pt of each other on the y-axis into the same line and
//   emit `"line":<index>` so the caller can render readable strings or
//   group buttons by toolbar row.

import Foundation
import CoreGraphics
import CoreImage
import Vision
import ImageIO

// MARK: - Recognized element

/// One text fragment recognized by Vision. Coords are in POINTS (image
/// coords / scale), origin TOP-LEFT (the convention every input + window
/// command in this binary uses).
struct OCRElement {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let confidence: Double
    let line: Int
}

extension OCRElement {
    fileprivate func toDict() -> [String: Any] {
        [
            "text": text,
            "x": Int(x.rounded()),
            "y": Int(y.rounded()),
            "width": Int(width.rounded()),
            "height": Int(height.rounded()),
            "confidence": Double((confidence * 100).rounded()) / 100,
            "line": line
        ]
    }
}

// MARK: - Core OCR (shared by both subcommands)

/// Run Vision text recognition on a CGImage. Returns elements in
/// reading order, grouped into lines.
///
/// `scale` divides Vision's pixel-space coords down to point-space so
/// the output is directly usable by `click --x --y`. For `ocr-screen`
/// we pass the captured display's backingScaleFactor; for `ocr --image`
/// we default to 1 (caller can override with `--scale`).
///
/// `languages` is a hint — when nil, Vision auto-detects. Otherwise
/// we set `recognitionLanguages` explicitly. Auto-detect is fine for
/// most cases but breaks badly on mixed Arabic/English UI (Vision
/// guesses one and ignores the other), so the TS layer should pass
/// `--languages en,ar` when the user's locale is Arabic.
func recognizeText(
    in image: CGImage,
    scale: Int,
    languages: [String]?,
    mode: VNRequestTextRecognitionLevel
) throws -> (elements: [OCRElement], fullText: String) {
    let pixelW = Double(image.width)
    let pixelH = Double(image.height)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = mode
    request.usesLanguageCorrection = true
    if let langs = languages, !langs.isEmpty {
        request.recognitionLanguages = langs
        // When languages are explicit, disable auto-detect — it sometimes
        // overrides the user-supplied list on macOS 14+.
        if #available(macOS 13.0, *) {
            request.automaticallyDetectsLanguage = false
        }
    } else if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    guard let observations = request.results else {
        return ([], "")
    }

    let scaleD = Double(max(1, scale))

    // First pass: convert each observation into a pre-line OCRElement
    // (with line=0 as placeholder), keeping the centerY for line clustering.
    struct PreElement {
        let text: String
        let x: Double
        let y: Double
        let w: Double
        let h: Double
        let confidence: Double
        let centerY: Double
    }
    var pre: [PreElement] = []
    pre.reserveCapacity(observations.count)
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let text = top.string
        if text.isEmpty { continue }
        let bbox = obs.boundingBox

        // Vision: normalized, bottom-left origin → pixels, top-left origin.
        let pxX = bbox.origin.x * pixelW
        let pxW = bbox.size.width * pixelW
        let pxH = bbox.size.height * pixelH
        // y_top_px = imageH - (bbox.y * imageH + bbox.h * imageH)
        let pxY = pixelH - (bbox.origin.y * pixelH + bbox.size.height * pixelH)

        // Convert pixels → points by dividing by backing scale.
        let ptX = pxX / scaleD
        let ptY = pxY / scaleD
        let ptW = pxW / scaleD
        let ptH = pxH / scaleD
        let centerY = ptY + ptH / 2

        pre.append(PreElement(
            text: text,
            x: ptX, y: ptY, w: ptW, h: ptH,
            confidence: Double(top.confidence),
            centerY: centerY
        ))
    }

    // Sort by centerY, then by x (left-to-right within a line). This
    // gives us reading order even when Vision shuffles observations.
    pre.sort { (a, b) in
        if abs(a.centerY - b.centerY) > 5 { return a.centerY < b.centerY }
        return a.x < b.x
    }

    // Line clustering: walk in y-order, bump the line counter whenever
    // the next element's centerY exceeds the current line's centerY by
    // more than the line-height tolerance. ~5pt was empirically right
    // for 12-16pt UI text on retina; tighter merges adjacent toolbar
    // rows, looser splits wrapped paragraph lines.
    let lineTolerance: Double = 5.0
    var elements: [OCRElement] = []
    elements.reserveCapacity(pre.count)
    var currentLine = 0
    var currentLineCenterY: Double? = nil
    for p in pre {
        if let lc = currentLineCenterY, abs(p.centerY - lc) > lineTolerance {
            currentLine += 1
            currentLineCenterY = p.centerY
        } else if currentLineCenterY == nil {
            currentLineCenterY = p.centerY
        }
        // Slight drift: update the running line center toward the new
        // element's centerY (running mean would over-smooth across many
        // short fragments). Keep it sticky to the first element of the line.
        elements.append(OCRElement(
            text: p.text,
            x: p.x, y: p.y,
            width: p.w, height: p.h,
            confidence: p.confidence,
            line: currentLine
        ))
    }

    // fullText: join by line, fragments within a line joined by space.
    // Useful for the LLM to ingest the screen as one string.
    var lineMap: [Int: [String]] = [:]
    for e in elements {
        lineMap[e.line, default: []].append(e.text)
    }
    let sortedLines = lineMap.keys.sorted()
    let fullText = sortedLines.map { lineMap[$0]!.joined(separator: " ") }
        .joined(separator: "\n")

    return (elements, fullText)
}

// MARK: - Image loading

/// Load a PNG/JPEG from disk into a CGImage. CIImage is the easy path —
/// it handles every UTI that ImageIO supports + EXIF orientation.
private func loadCGImage(from url: URL) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        // Fall back to CIImage in case the file has an unusual UTI.
        guard let ci = CIImage(contentsOf: url) else { return nil }
        let ctx = CIContext()
        return ctx.createCGImage(ci, from: ci.extent)
    }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// MARK: - Mode parsing

private func parseMode(_ s: String?) -> VNRequestTextRecognitionLevel? {
    guard let s = s?.lowercased() else { return .accurate }
    switch s {
    case "fast": return .fast
    case "accurate": return .accurate
    default: return nil
    }
}

private func parseLanguages(_ s: String?) -> [String]? {
    guard let s = s else { return nil }
    let parts = s.split(separator: ",").map {
        String($0).trimmingCharacters(in: .whitespaces)
    }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts
}

// MARK: - `ocr` subcommand

func runOCR() -> Never {
    guard let imagePath = argValue(name: "--image", short: "-i") else {
        emitError("--image is required (path to PNG/JPEG)", code: 2)
    }
    let langs = parseLanguages(argValue(name: "--languages"))
    guard let mode = parseMode(argValue(name: "--mode")) else {
        emitError("--mode must be 'fast' or 'accurate'", code: 2)
    }
    // Optional explicit scale override — caller passes 2 when they know
    // the PNG came from a retina capture and they want point coords back.
    var scale = 1
    if let s = argValue(name: "--scale"), let n = Int(s), n >= 1 {
        scale = n
    }

    let url = URL(fileURLWithPath: imagePath)
    guard FileManager.default.fileExists(atPath: url.path) else {
        emitError("image file not found: \(url.path)", code: 2)
    }
    guard let image = loadCGImage(from: url) else {
        emitError("failed to decode image: \(url.path)", code: 3)
    }

    do {
        let (elements, fullText) = try recognizeText(
            in: image,
            scale: scale,
            languages: langs,
            mode: mode
        )
        emit([
            "fullText": fullText,
            "elements": elements.map { $0.toDict() },
            "imageWidth": image.width,
            "imageHeight": image.height,
            "scale": scale
        ])
    } catch {
        emitError("Vision recognition failed: \(error.localizedDescription)", code: 3)
    }
}

// MARK: - `ocr-screen` subcommand

func runOCRScreen() -> Never {
    let regionStr = argValue(name: "--region", short: "-r")
    let langs = parseLanguages(argValue(name: "--languages"))
    guard let mode = parseMode(argValue(name: "--mode")) else {
        emitError("--mode must be 'fast' or 'accurate'", code: 2)
    }
    var displayIndex = 0
    if let s = argValue(name: "--display"), let n = Int(s), n >= 0 {
        displayIndex = n
    }

    var region: CGRect?
    if let s = regionStr {
        guard let nums = parseDoubles(s), nums.count == 4, nums[2] > 0, nums[3] > 0 else {
            emitError("--region expects x,y,w,h with positive w,h", code: 2)
        }
        region = CGRect(x: nums[0], y: nums[1], width: nums[2], height: nums[3])
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

    do {
        let (elements, fullText) = try recognizeText(
            in: captured.image,
            scale: captured.scale,
            languages: langs,
            mode: mode
        )
        // For ocr-screen, the elements' x/y are display-local points
        // (relative to the captured region's origin). If the caller
        // passed a region, they typically want absolute coords back —
        // offset by the region origin so the resulting (x,y) can be
        // passed straight to `click --x --y`.
        let offsetX = region?.origin.x ?? 0
        let offsetY = region?.origin.y ?? 0
        let absElements: [[String: Any]] = elements.map { e in
            var d = e.toDict()
            if let cur = d["x"] as? Int { d["x"] = cur + Int(offsetX.rounded()) }
            if let cur = d["y"] as? Int { d["y"] = cur + Int(offsetY.rounded()) }
            return d
        }
        emit([
            "fullText": fullText,
            "elements": absElements,
            "imageWidth": captured.pixelWidth,
            "imageHeight": captured.pixelHeight,
            "scale": captured.scale,
            "regionOrigin": ["x": Int(offsetX.rounded()), "y": Int(offsetY.rounded())]
        ])
    } catch {
        emitError("Vision recognition failed: \(error.localizedDescription)", code: 3)
    }
}
