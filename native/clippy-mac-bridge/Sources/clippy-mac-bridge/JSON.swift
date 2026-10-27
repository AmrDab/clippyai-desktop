// JSON.swift
//
// Shared JSON output helpers for clippy-mac-bridge subcommands.
//
// Contract: every subcommand writes exactly one JSON object to stdout,
// no trailing newline soup, no shutter to stderr. Errors go to stdout
// as `{"error":"…","code":<int>}` so the TS wrapper has a single parse
// path regardless of exit code. Exit codes still carry meaning for
// shell composition + bash test harnesses:
//
//   0 — success
//   1 — permission denied (TCC: Screen Recording / Accessibility / Automation)
//   2 — invalid arguments (caller bug)
//   3 — operation failed (target gone, API failure, write failure)
//
// All subcommands import this module.

import Foundation

/// Emit a JSON object to stdout. No newline. Exits with the given code.
func emit(_ payload: [String: Any], exitCode: Int32 = 0) -> Never {
    do {
        // sortedKeys gives deterministic output — easier to diff in tests and
        // log replay. prettyPrinted would inflate every line; we keep it tight.
        let data = try JSONSerialization.data(
            withJSONObject: payload,
            options: [.sortedKeys, .fragmentsAllowed]
        )
        FileHandle.standardOutput.write(data)
    } catch {
        // Fallback if the dict contained unencodable values — shouldn't happen
        // because callers stick to NSDictionary-compatible types, but if a Swift
        // bridge produces a NaN or similar, ship a structured error rather than
        // an empty stdout that the TS side will choke on.
        let fallback = "{\"error\":\"json-encode-failed: \(error.localizedDescription)\",\"code\":3}"
        FileHandle.standardOutput.write(fallback.data(using: .utf8) ?? Data())
        exit(3)
    }
    exit(exitCode)
}

/// Convenience: emit a structured error and exit.
///   code=1 → permission denied (TCC)
///   code=2 → caller arg error
///   code=3 → operation failed
func emitError(_ message: String, code: Int32 = 3, extra: [String: Any] = [:]) -> Never {
    var payload: [String: Any] = ["error": message, "code": Int(code)]
    for (k, v) in extra { payload[k] = v }
    emit(payload, exitCode: code)
}

/// Read an arg flag from CommandLine.arguments. Returns nil if not present.
///   argValue(name: "--pid")  // → "12345" if `--pid 12345` was passed
///   argValue(name: "--pid", short: "-p")
func argValue(name: String, short: String? = nil, args: [String] = Array(CommandLine.arguments.dropFirst(2))) -> String? {
    // dropFirst(2) skips argv[0] (binary path) and argv[1] (subcommand).
    var i = 0
    while i < args.count {
        if args[i] == name || (short != nil && args[i] == short!) {
            if i + 1 < args.count { return args[i + 1] }
        }
        i += 1
    }
    return nil
}

/// Boolean flag: present → true, absent → default. Also accepts `--name false`.
func argBool(name: String, default defaultValue: Bool = false, args: [String] = Array(CommandLine.arguments.dropFirst(2))) -> Bool {
    var i = 0
    while i < args.count {
        if args[i] == name {
            // Look at next arg — if it's `true`/`false`, use it; else flag-style true.
            if i + 1 < args.count {
                let next = args[i + 1].lowercased()
                if next == "true" || next == "1" { return true }
                if next == "false" || next == "0" { return false }
            }
            return true
        }
        i += 1
    }
    return defaultValue
}

/// Parse a comma-separated number list. Returns nil on parse failure.
///   parseInts("100,200,800,600") → [100, 200, 800, 600]
func parseInts(_ s: String?) -> [Int]? {
    guard let s = s else { return nil }
    let parts = s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
    var out: [Int] = []
    for p in parts {
        guard let n = Int(p) else { return nil }
        out.append(n)
    }
    return out
}

/// Parse a comma-separated double list.
func parseDoubles(_ s: String?) -> [Double]? {
    guard let s = s else { return nil }
    let parts = s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
    var out: [Double] = []
    for p in parts {
        guard let d = Double(p) else { return nil }
        out.append(d)
    }
    return out
}
