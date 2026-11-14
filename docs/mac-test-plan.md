# Mac test run: mac/v0.24.2 (HEAD 56603ed)

Run this on the Mac. Send progress after the build and unit tests, and a full report at the end. If messaging fails, write the report to docs/mac-test-report.md on this branch and push it.

## Setup
1. `git fetch origin && git switch mac/v0.24.2 && git reset --hard origin/mac/v0.24.2`. If you have local work on that branch, push it first instead of resetting.
2. `npm ci`
3. `npm run build-native`. This compiles the new Swift `--pid` option in clippy-mac-bridge for the first time.
4. `npm run typecheck`, then `npx vitest run`, then `npm test`.
5. Build the signed and notarized app (`npm run dist:mac` or the repo's equivalent) and install it. Don't publish anything.

## Hardware checklist
Report pass or fail for each, with log lines. Redact emails, keys and names.

1. **Screen summary.** With Safari, Notes or Mail behind Clippy, ask "summarise what's on my screen".
   - From `Task.start`, report `screenSource`, `screenContextLen` and `activeProcessAtStart`. They must name the real app, not ClippyAI.
   - Repeat once with Screen Recording off and once with Accessibility off.
2. **Clicking in another app.** Ask "click the Reload button in Safari". It must act on Safari, not on Clippy.
3. **Timing.** Time the bridge calls `active-window`, `a11y-tree` and `ocr-screen`, including the first run after install.
4. **Expanded chat.**
   - Clippy stands below the panel.
   - Clicks on the empty strip beside him reach the app underneath, and the panel is clickable again afterwards.
   - A red ring shows while he listens and a blue ring while he works.
   - The text-box effects show.
   - There are no traffic lights.
5. **Onboarding.** Email, then the 6-digit code, then persona, then permissions, then Try it.
6. **Tray and shortcuts.** The tray icon looks right on Retina, the mic tooltip shows ⌘⇧Space, and the summon hotkey works.
7. **Settings.** The telemetry toggle works, and launch at login works on the signed build.
8. **Closing the bubble.** Closing it with the X stops speech mid-sentence.
9. **Swift `--pid`.** Against TextEdit, run each of these once with Clippy's chat focused and once with TextEdit focused:
   - `a11y-focused --pid <n>`
   - `a11y-selected-text --pid <n>`
   - `a11y-focused-set-value --value x --pid <n>`
10. **Updates.** Stage two signed versions on a local generic feed. If you can't, say so.
    - a) Quit with an update downloaded: it swaps without relaunching, and Quit doesn't hang.
    - b) After 10 minutes idle with the bubble closed, it relaunches on the new version and keeps its sleep/awake state.
    - c) "Later" then Quit, and "Restart to update", both still work.
    - d) A failed install falls back to the prompt.
11. **Security check.** Ask "is anything suspicious on my Mac?" on Power and on Max.
    - It respects the plan gate and says "Mac", not "PC".
    - It doesn't set off a storm of permission dialogs.
    - Report how `profiles list` behaves.
    - Add a test LaunchAgent in ~/Library/LaunchAgents that points at /tmp. Confirm it's flagged high, then remove it.
    - No secrets appear in the output.
12. **Checking actions worked.**
    - `focus_window` on Excel or Outlook.
    - `open_app` for an app that isn't running.
    - `type_text` into TextEdit (expect verified), into a password field (expect unverified), and with Clippy in front (expect refusal).
13. **Guides.** A Gmail tab and a YouTube tab in Chrome or Safari show the guide block. The Slack, Discord and Figma guides show Cmd and Option keys.

## Afterwards
Fix Mac-only bugs on mac/v0.24.2 and push them to that branch only, not main and no tags.

Then reply via SendMessage to "Clippy virtual machine architecture" with:
- the machine, macOS version and architecture;
- the test counts;
- the pass/fail list;
- your commit SHAs.
