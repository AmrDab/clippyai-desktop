# Mac test report: mac/v0.24.2

Run of `docs/mac-test-plan.md` on 2026-11-13 (PST), starting from HEAD `1ef7bc9`.

| | |
|---|---|
| Machine | Apple M1, 16 GB, arm64 |
| macOS | 26.5 (25F71) |
| Toolchain | Xcode 26.5, Swift 6.3.2, Node 25.9.0, Electron 29.4.6 |
| Account | Free plan, and the month's free tokens ran out partway through the run |
| Fix commits | `cb11ca9` Mac fixes from the v0.24.2 hardware run<br>`7d3a8bf` Mac updates: idle install and refused-install recovery |

## Summary

- Build, typecheck and tests are green after the fixes: vitest 877 passed, 0 failed, 9 skipped; `npm test` 12/12 scripts, 126 checks, 0 failed.
- The app is signed with Developer ID and hardened runtime, but **not notarized**. Apple's notary service returned HTTP 403: "A required agreement is missing or has expired." Someone needs to accept the current agreement at developer.apple.com. Locally built copies aren't quarantined, so testing went ahead on the signed build.
- I fixed and pushed six Mac-only problems (see [Fixes](#fixes)):
  - The bridge's focused element without `--pid` is broken on macOS 26.5.
  - The idle update install never runs once the "ready" prompt has been seen.
  - A refused update leaves the app half-quit.
  - The tray icon is soft on Retina.
  - Two test-run problems.
- Some items are blocked:
  - The Free plan blocks clicking (item 2), the security check on Power/Max (11) and the action tools (12).
  - The account then ran out of free tokens, so no further chat turns were possible.
  - Toggling Screen Recording or Accessibility (1), the Speech Recognition prompt (4) and the onboarding email code (5) need a person at the Mac.

## Setup

| Step | Result |
|---|---|
| 1. Clone `mac/v0.24.2` at `1ef7bc9` | Fresh clone, no local work |
| 2. `npm ci` | OK (738 packages) |
| 3. `npm run build-native` | OK. All three Swift helpers built universal (x86_64 + arm64). The new `--pid` option in clippy-mac-bridge compiles. |
| 4a. `npm run typecheck` | 0 errors |
| 4b. `npx vitest run` | At `1ef7bc9`: 876 passed, **1 failed**, 9 skipped. After `cb11ca9`: 877 passed, 0 failed, 9 skipped. |
| 4c. `npm test` | 12/12 scripts, 126 checks, 0 failed (the PowerShell checks skip off Windows) |
| 5. `npm run dist:mac -- --publish never` | Signed (Developer ID, hardened runtime; all three helpers signed). **Notarization failed**: Apple returned HTTP 403, an agreement is missing or expired. I rebuilt without notarization; `spctl` says "Unnotarized Developer ID". Installed to /Applications. The earlier 0.20.0-alpha.22 install was moved to `~/Applications-backup/`. Nothing was published. |

Before the app could start, I had to stop a two-day-old orphaned dev instance (`npm exec electron .` in `~/projects/clippyai/clippyai-desktop-macconverge`, v0.21.1), because it held the single-instance lock on the same userData. It ignored SIGTERM for over 10 s and quit on an AppleScript `quit`.

## Hardware checklist

| # | Item | Result |
|---|---|---|
| 1 | Screen summary | **Pass** (Safari). Screen Recording off and Accessibility off: **not run** |
| 2 | Click Reload in Safari | **Blocked** by the Free plan. It targeted Safari correctly. |
| 3 | Bridge timing | **Pass** (numbers below) |
| 4 | Expanded chat | **Pass**, with notes |
| 5 | Onboarding | **Not run**. It needs an email code and would reset the activated licence. |
| 6 | Tray and shortcuts | **Pass after fix** (Retina tray icon) |
| 7 | Settings | **Pass** |
| 8 | Closing the bubble stops speech | **Pass** |
| 9 | Swift `--pid` | **Pass**. The path without `--pid` was **broken and is now fixed**. |
| 10 | Updates | a **pass**; b **failed, fixed and passing**; c **pass**; d **failed, fixed and passing** |
| 11 | Security check | **Blocked** by the Free plan in chat. The scanner itself was run directly: **pass**, with notes. |
| 12 | Checking actions worked | **Blocked**: Free plan, and the free tokens ran out |
| 13 | Guides | **Pass** at the logic level (packaged guide files, macOS). Not seen live, because chat was blocked. |

### 1. Screen summary

With Safari showing en.wikipedia.org/wiki/Paper_clip behind Clippy, and Clippy's chat focused:

```
Task.start {"screenQuestion":true,"screenSource":"ocr","hasScreenContext":true,"screenContextLen":1682,"activeProcessAtStart":"Safari"}
Clippy.say "Ha — you're reading the Wikipedia page on paper clips. ..."
```

It named the real app, not ClippyAI. On the first attempt it reported `activeProcessAtStart:"Messages"`, but that was caused by my test tool: it hides and then restores apps that haven't been granted, which pushed the Messages window to the top. `pickForegroundMacWindow` correctly took the topmost non-Clippy window.

The repeats with Screen Recording off and Accessibility off were **not run**. They mean changing privacy permissions in System Settings, which I won't do. Someone at the Mac needs to toggle them.

### 2. Clicking in another app

"click the Reload button in Safari" gave `activeProcessAtStart:"Safari"`. Clippy replied: "no hands on Free, so clicking is a Power trick. For now: hit Cmd+R". It targeted the right app and gave the right Mac key, but the click itself is blocked by the plan. Re-run this on a Power account.

### 3. Timing

The installed `/Applications/ClippyAI.app/Contents/Resources/clippy-mac-bridge`, with TextEdit in front (wall clock, including process start):

| Call | First run after install | Warm |
|---|---|---|
| `active-window` | **2862 ms** | 86–120 ms |
| `a11y-tree` (TextEdit, 45 nodes) | 96 ms | 87–140 ms |
| `ocr-screen` | 2005 ms | 1594–2376 ms |

The first run of a newly installed binary pays a one-time macOS assessment of about 2.8 s. `ocr-screen` stays around 2 s every time, which fits the 8 s budget `captureTurnContext` allows on macOS.

### 4. Expanded chat

- **Clippy stands below the panel: pass.** The panel spans y 414–1133 pt, with Clippy at the bottom right underneath.
- **Click-through: pass.** I moved a TextEdit window under the empty strip left of Clippy, inside his window bounds, and clicked there; TextEdit became frontmost. A click on the panel straight afterwards made ClippyAI frontmost again.
- **Red ring while listening: pass**, using ⌘⇧Space. A red ring and a level meter show around the input (log: `Voice.hotkey start` and `stop`).
  - Voice-to-text failed with "Speech Recognition permission not determined (dialog timed out)". That's the macOS Speech Recognition prompt, which nobody answered because I didn't touch it. Someone at the Mac needs to allow it.
  - Pressing the mic button through accessibility (AXPress) does not start voice; the hotkey does.
- **Blue ring while working: pass.** The status chip shows "Working · 3 s" with a blue ring.
- **Text-box effects: pass.** The input glows gold while focused and shows a blue progress sweep while working.
- **No traffic lights: pass.** The header has only Minimize, Pin, Clear conversation and Close.

Notes:
- When a reply arrives, the expanded panel drops back to the compact bubble, which has no X. To close mid-speech you have to expand again. This may be by design (adaptive bubble).
- macOS's "click wallpaper to reveal desktop" (Sonoma and later) sweeps Clippy away along with every other window. A floating companion might want to stay put; that would need `NSWindowCollectionBehaviorStationary`, which Electron doesn't expose directly.

### 5. Onboarding

**Not run.** This Mac is already activated. Running onboarding would mean clearing the licence and receiving a 6-digit code at the account email, which needs the account owner. Please run it once by hand, or on a test account.

### 6. Tray and shortcuts

- **Tray icon on Retina: fixed.** It was the 256 px app icon resized to a single 16 px bitmap, which the 2x menu bar upscaled into a soft cream square. `cb11ca9` adds a 32 px @2x representation on macOS, and it now renders sharply. The icon is still the full-colour app icon (cream paper behind the clip), not a monochrome template image like the rest of the menu bar; that's a design choice for you.
- **Mic tooltip: pass.** On Macs `bubble.ts` rewrites the hardcoded Windows label to `Click to speak (⌘⇧Space) · Esc cancels`.
- **⌘⇧Space: pass.** It toggles voice.
- **Summon hotkey: pass.** It's `Ctrl+Shift+C` (literally Control, on Mac too). One press logged `Brain.mode awake → sleep` and hid the window; a second press logged `sleep → awake` and showed it again.
- **Alt+G (writing assist):** did nothing here, because `writingAssistEnabled` is false in this profile. Not a bug.

### 7. Settings

- **Launch at login: pass** on the signed build. Off removed the ClippyAI login item (System Events list) and wrote `startup-settings.json` with `launchOnStartup:false`. On re-added it, pointing at `/Applications/ClippyAI.app`.
- **Telemetry toggle: pass.** Off wrote `optOut:true` to `userData/telemetry.json`; on wrote `optOut:false`.
- Side note: there's also a stale **"Electron" login item** pointing at `~/projects/clippyai/clippyai-desktop-macconverge/node_modules/electron/dist/Electron.app`. A dev run with launch-on-startup on registers the bare Electron binary. That applies on every platform, not just Mac. I left it alone.

### 8. Closing the bubble

**Pass.** Clippy speaks through the renderer's `speechSynthesis`, so I watched coreaudiod's power assertions:

```
18:46:40  Clippy.say (six-sentence answer)
18:46:46  audio-out BuiltInSpeakerDevice assertion present (6 s into speech)
18:46:51  after pressing the panel's X: no audio assertion
```

### 9. Swift `--pid` (TextEdit, pid shown as `<n>`)

| Command | TextEdit focused | Clippy's chat focused (frontmost ClippyAI, its AXTextArea focused) |
|---|---|---|
| `a11y-focused --pid <n>` | `role:AXTextArea, app:TextEdit, value:"hello clippy pid test"` | `role:AXTextArea, app:TextEdit, value:"pid test with clippy focused"` |
| `a11y-selected-text --pid <n>` | `hasSelection:true, length:21` | `hasSelection:false` (clean, no error) |
| `a11y-focused-set-value --value x --pid <n>` | `ok:true, strategy:value, previous:"hello clippy pid test"` | `ok:true, strategy:value`; Clippy stayed frontmost |

**Bug found and fixed.** Without `--pid`, all three commands failed on this Mac:

```
{"code":3,"error":"operation timed out (target may be stuck) (focused-element)"}
```

They fail in about 20 ms, so it isn't a real timeout. `AXUIElementCreateSystemWide()` returns `kAXErrorCannotComplete` (-25204) on macOS 26.5, even for `AXFocusedApplication`, while the frontmost app's own element works. This happens with and without the shell sandbox.

The callers that pass no pid are the writing watcher (`writing-watch.ts:178`), the Alt+G writing assist (`writing-assist.ts:80`), `type_text`'s read-back check (`tools.ts:798`) and applying a writing fix (`ipc.ts:639`). On such Macs they all got nothing.

`cb11ca9` makes `copyFocusedElement` fall back to the frontmost app's element when the system-wide call fails with cannotComplete or failure. That means the same thing, since system focus lives in the frontmost app. After the fix, `a11y-focused` and `a11y-selected-text` without `--pid` return TextEdit's field.

### 10. Updates

I staged versions on a local generic feed (`python3 -m http.server` on 127.0.0.1:8799) with three arm64 zips. Each has `-c.mac.publish.url` pointed at that server:

- **A** 0.24.2
- **B** 0.24.3, signed with Developer ID
- **C** 0.24.4, signed with the *Apple Development* certificate so that Squirrel.Mac's code-requirement check rejects it

Each version downloaded within about a second of the 10 s boot check.

**a) Quit with an update downloaded: pass.** Tray Quit logged "User quit with a downloaded update — installing silently". The process exited in under 1 s, `/Applications/ClippyAI.app` was 0.24.3 with a valid signature, and it didn't relaunch.

**b) Idle 10 minutes with the bubble closed: failed, then fixed and passing.**
- On `cb11ca9` it never installed. Clippy was asleep and HID idle reached 990 s with no updater activity.
- Through the main process's inspector (SIGUSR1), the renderer showed the bubble hidden but `#bubble-actions` still flagged visible, holding "Restart to update / Later". macOS always shows the "vX is ready!" prompt, and `hide()` (X, sleep, auto-hide) keeps `state` and the chips. So `isBusyForPrompt()` reported busy forever, and `isBusyElsewhere()` blocked the idle install. Windows never shows that prompt (it installs silently), which is why this only hits Macs.
- Unsticking just the chips made it install 16 s later, so they were the only blocker.
- `7d3a8bf` counts only a shown bubble. Re-run on the fixed build, with the same DOM state and no intervention:

```
03:30:54  Brain.mode awake → sleep        (prompt "v0.24.3 is ready!" slept through)
03:41:30  PC idle with a downloaded update — installing silently {"version":"0.24.3"}
03:41:32  ClippyAI shutting down
03:41:40  ClippyAI starting {"version":"0.24.3"}
03:41:40  Brain.mode sleep → awake, awake → sleep   (resume: came back asleep)
03:41:40  Previous install attempt succeeded
```

**c) "Later" then Quit, and "Restart to update": pass.**
- **Later, then Quit:** "Later" logged `Update snoozed by user`. Tray Quit exited in under 1 s and left 0.24.2 in place, with no install and no relaunch.
- **Restart to update** (the bubble button): `Install.exec quitAndInstall`, shut down 3.5 s later, and `ClippyAI starting 0.24.3` about 9 s after the click.
- The tray's "Restart to update to vX" item is there too.

**d) Failed install: failed, then fixed and passing.**
- On `cb11ca9`, "Restart to update" to C made Squirrel refuse the bundle: "Code signature at URL … did not pass validation: code failed to satisfy specified code requirement(s)". The app stayed alive on 0.24.3 and the bubble showed "Auto-update to v0.24.4 isn't working on this machine. [Open download page] [Later]".
- But the macOS install path had already called `quitState.setQuitting()` and `cleanupTools()`, and never undid them. Closing Clippy afterwards **destroyed his window**: `BrowserWindow.getAllWindows().length` went to 0, leaving only the tray. The tools also stayed torn down until a manual restart.
- `7d3a8bf` undoes both when Squirrel errors, or if the app is still up after 120 s. If the user had asked to quit, it quits instead. Re-run:

```
03:29:20  Install.exec quitAndInstall (0.24.4)
03:29:24  Auto-update error … code failed to satisfy specified code requirement(s)
03:29:24  Install.notCompleted — staying up {"relaunch":true}
          bubble: "Auto-update to v0.24.4 isn't working on this machine. 📎" [Open download page] [Later]
03:29:40  close() → window hidden, not destroyed; "Window.close → sleep"
```

On the next boot the attempt counts as a failure ("Silent install failure detected … failureCount 1"), as designed.

Finally I reinstalled a normal build of `7d3a8bf` (feed `https://download.clippyai.app`) and cleared the updater state and cache. It logged "No update available" for 0.24.2.

### 11. Security check

Chat was blocked by the Free plan and then by the token limit, so I couldn't test the plan gate or "Mac, not PC" through the model. Instead I ran `runMacSecurityScan` directly from the source on this Mac, with all sections:

- 1.15 s run, `platform:"macOS"`, 36 items checked, 28 trusted.
- **`profiles list`**: `/usr/bin/profiles list` exits 0 without admin and prints "There are no configuration profiles installed for user …". The scanner reads it fine and reports no profile finding.
- **Permission dialogs:** none appeared. `osascript` for login items runs against System Events, which this Mac had already allowed. On a fresh Mac that call can bring up one Automation prompt; nothing else prompts.
- **Test LaunchAgent:** `~/Library/LaunchAgents/com.clippytest.tmpagent.plist`, pointing at `/tmp/clippytest-agent`, was flagged **high** with `unusual_location` and `target_missing`. The plist was then removed.
- **Secrets:** none in the output. The only command text quoted came from a third-party agent's `-c` launcher, which showed as `launcher_inline_command`, medium.
- **Notes:**
  - The scanner rates every **running process from a hidden folder as high**, and titles it "Unusual item that starts by itself". Here that hit a legitimate agent's bundled Python (`~/.hermes/tools/python-3.14.x/bin/python3`). On a developer Mac the same rule hits `~/.nvm`, `~/.pyenv`, `~/.cargo`, `~/.bun` and similar. Processes aren't auto-start items, so I'd suggest medium and a different title. I left the heuristics unchanged.
  - My standalone test wrote two `[Guides]` lines into the real `~/.clippyai/logs` file, because the logger writes under `os.homedir()` when run outside vitest. Harmless.

### 12. Checking actions worked

**Blocked.** "open Calculator" got: "I'm tapped out on free tokens. Power gives me 50x the room." Excel and Outlook aren't installed on this Mac either. Re-run on a Power account: `focus_window` (Excel/Outlook), `open_app` (an app that isn't running), and `type_text` into TextEdit (verified), a password field (unverified) and with Clippy in front (refused).

Related: `type_text`'s read-back on macOS uses `a11yFocused()` without a pid (`tools.ts:798`). Before `cb11ca9`, that call failed on this Mac (see item 9), so read-back would have come back empty here.

### 13. Guides

I ran `getGuidePrompt` from the source on darwin against `assets/guides`, which are packaged as `Resources/clawdcursor-guides`:

| App | Window title | Guide | Keys after `macifyKeys` |
|---|---|---|---|
| Google Chrome | "Inbox (3) - Gmail" | gmail | Cmd |
| Safari | "Funny cats - YouTube" | youtube | Cmd |
| Safari | "Apple" | none (correct) | n/a |
| Slack | n/a | slack (matched by file name; the guide has no `processNames`) | Cmd, no Ctrl/Alt left |
| Discord | n/a | Discord | Cmd, Option |
| Figma | n/a | Figma | Cmd, Option |
| Microsoft Excel / Microsoft Outlook | n/a | Excel / outlook (Mac aliases) | Cmd, Option |

I didn't see this live, because chat was blocked.

## Fixes

Both commits are pushed to `mac/v0.24.2` only (no tags, nothing on main). After them: vitest 877 passed, 0 failed; `npm test` 12/12.

`7d3a8bf`:

5. **Idle install blocked by a slept-through prompt.** `bubble.isBusyForPrompt()` now counts only a shown bubble. See item 10b.
6. **A refused install left the app half-quit.** The macOS "Restart to update" path now undoes the quit flag and the tool cleanup when Squirrel errors. See item 10d.

`cb11ca9`:

1. **Bridge, focused element without `--pid`.** Falls back to the frontmost app when the system-wide AX element fails (macOS 26.5). See item 9.
2. **Tray icon on Retina.** Adds an @2x representation. See item 6.
3. **vitest on Mac after `dist:mac`.** Excludes `vendor/` and `release/`. The Mac vendor step clones whisper.cpp into `vendor/whisper/_src`, whose `examples/addon.node/__test__/whisper.spec.js` vitest picked up, failing the run with "Cannot find module '../../../build/Release/addon.node'".
4. **`tests/win-host.test.ts`.** Uses a separator-agnostic assertion. On a POSIX host `path.join` gives `C:\s/get-foreground-window.ps1`, and that was the one vitest failure at `1ef7bc9`. The product code is win32-only and unchanged.

## Other observations (not fixed)

- **Electron fuses.** The packaged app ships with `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` **enabled**, and `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` disabled (`npx @electron/fuses read`). As a result, `kill -USR1 <pid>` opens a Node inspector on 127.0.0.1:9229 inside a signed app that holds Accessibility and Screen Recording permissions; I used exactly that to diagnose 10b. It's worth flipping these fuses in `after-pack.js` for release builds.
- A normal `osascript … to quit` didn't stop ClippyAI when the app had no windows left (during the pre-fix 10d state). `pkill` did.
- Proactive tips can replace the "Auto-update isn't working" prompt within about 30 s (seen at 03:24:43 → 03:25:12).

## Needs a person or another account

- Accept the Apple Developer agreement, then re-run `dist:mac` to notarize.
- Item 1: repeat with Screen Recording off, then with Accessibility off.
- Item 4: allow ClippyAI in Speech Recognition, then retry voice-to-text.
- Item 5: onboarding with a real email code.
- Items 2, 11 (through chat) and 12: re-run on Power and on Max.

