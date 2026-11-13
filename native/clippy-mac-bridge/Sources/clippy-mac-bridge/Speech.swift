// Speech.swift
//
// `clippy-mac-bridge transcribe` — on-device speech-to-text via Apple's
// Speech framework. This is what makes macOS voice input FREE and LOCAL:
// through v0.20.x the bundled whisper-cli was a Windows-only binary, so Mac
// voice input silently required a paid OpenAI key (cloud audio upload).
//
// Usage
// ─────
//   clippy-mac-bridge transcribe --audio /tmp/x.wav
//        [--locale en-US] [--context "ClippyAI,Outlook,Slack"]
//        [--allow-network false]
//     → {"text":"open my inbox","confidence":0.93,"onDevice":true}
//
//   The WAV comes from the renderer's recorder (16 kHz mono 16-bit PCM,
//   ≤30 s) — SFSpeechURLRecognitionRequest reads the file directly.
//
// Privacy contract
// ────────────────
//   • requiresOnDeviceRecognition defaults ON. If the locale's on-device
//     model isn't installed/supported we FAIL (code 3) rather than silently
//     uploading audio — unless the caller explicitly passes
//     --allow-network true (then Apple's server-side dictation may be used;
//     still never a third-party).
//   • TCC: Speech Recognition (NSSpeechRecognitionUsageDescription) — the
//     first call triggers the OS consent dialog attributed to ClippyAI.
//     Denied → {"error":…,"code":1} per the bridge-wide convention.
//
// SpeechAnalyzer (macOS 26) upgrade path: same subcommand, same JSON shape —
// swap the engine behind `runTranscribe()` when the deployment floor allows
// `if #available(macOS 26, *)` to pay off. SFSpeechRecognizer is reliable
// for buffer requests up to ~1 minute, which comfortably covers the
// renderer's 30 s cap.

import Foundation
import Speech

func runTranscribe() {
    guard let audioPath = argValue(name: "--audio") else {
        emitError("--audio <path.wav> is required", code: 2)
    }
    guard FileManager.default.fileExists(atPath: audioPath) else {
        emitError("audio file not found: \(audioPath)", code: 2)
    }
    let localeId = argValue(name: "--locale") ?? "en-US"
    let allowNetwork = (argValue(name: "--allow-network") ?? "false").lowercased() == "true"
    let contextual: [String] = (argValue(name: "--context") ?? "")
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }

    // ── TCC: Speech Recognition consent ──────────────────────────────
    // requestAuthorization is async; block the CLI on a semaphore. On the
    // very first run this pops the OS dialog (attributed to the parent
    // ClippyAI app since the bridge is a bundled child process).
    let authSema = DispatchSemaphore(value: 0)
    var authStatus = SFSpeechRecognizer.authorizationStatus()
    if authStatus == .notDetermined {
        SFSpeechRecognizer.requestAuthorization { status in
            authStatus = status
            authSema.signal()
        }
        _ = authSema.wait(timeout: .now() + 30)
    }
    switch authStatus {
    case .authorized:
        break
    case .denied, .restricted:
        emitError(
            "Speech Recognition permission denied — enable ClippyAI in System Settings → Privacy & Security → Speech Recognition",
            code: 1
        )
    default:
        emitError("Speech Recognition permission not determined (dialog timed out)", code: 1)
    }

    // ── Recognizer setup ─────────────────────────────────────────────
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
        emitError("no speech recognizer for locale \(localeId)", code: 3)
    }
    guard recognizer.isAvailable else {
        emitError("speech recognizer unavailable (locale \(localeId)) — try again in a moment", code: 3)
    }

    let onDeviceSupported = recognizer.supportsOnDeviceRecognition
    if !onDeviceSupported && !allowNetwork {
        emitError(
            "on-device speech model not available for \(localeId); pass --allow-network true to permit Apple server-side dictation",
            code: 3,
            extra: ["onDeviceSupported": false]
        )
    }

    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: audioPath))
    request.shouldReportPartialResults = false
    request.taskHint = .dictation
    request.requiresOnDeviceRecognition = onDeviceSupported // local whenever possible
    if !contextual.isEmpty {
        // Vocabulary bias — proper nouns the user's setup makes likely
        // ("ClippyAI", "Outlook") so they don't transcribe as word salad.
        request.contextualStrings = contextual
    }

    // ── Recognize ────────────────────────────────────────────────────
    let sema = DispatchSemaphore(value: 0)
    var finalText: String?
    var avgConfidence: Double = 0
    var failure: String?

    let task = recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            // A cancelled/failed task after a final result is benign; only
            // record the failure if we never got text.
            if finalText == nil { failure = error.localizedDescription }
            sema.signal()
            return
        }
        guard let result = result else { return }
        if result.isFinal {
            finalText = result.bestTranscription.formattedString
            let segs = result.bestTranscription.segments
            if !segs.isEmpty {
                avgConfidence = segs.reduce(0.0) { $0 + Double($1.confidence) } / Double(segs.count)
            }
            sema.signal()
        }
    }

    // 60 s ceiling — double the renderer's 30 s recording cap; on-device
    // recognition of 30 s audio typically lands well under 5 s.
    if sema.wait(timeout: .now() + 60) == .timedOut {
        task.cancel()
        emitError("transcription timed out after 60s", code: 3)
    }

    if let failure = failure {
        emitError("transcription failed: \(failure)", code: 3)
    }
    let text = (finalText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    emit([
        "text": text,
        "confidence": (avgConfidence * 100).rounded() / 100,
        "onDevice": onDeviceSupported,
    ])
}
