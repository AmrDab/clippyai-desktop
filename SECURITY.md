# Security policy

ClippyAI can read your screen and control your desktop, so we take security reports seriously.

## Reporting a vulnerability

**Please don't open a public GitHub issue for security problems.**

Email **hello@clippyai.app** with the subject line `SECURITY`, or use GitHub's
[private vulnerability reporting](https://github.com/AmrDab/clippyai-desktop/security/advisories/new).
Include:

- what you found and where (file, endpoint, or app screen)
- steps to reproduce, or a proof of concept
- the ClippyAI version (right-click Clippy → Settings → About) and your OS

We'll acknowledge your report within 3 business days and keep you updated until it's fixed.
Please give us a reasonable window to ship a fix before disclosing publicly. We're happy to credit you in the release notes.

## Supported versions

Only the latest release gets security fixes. Clippy updates himself, so most users are on it within a day or two.

## In scope

- The ClippyAI desktop app (this repository)
- The ClippyAI API (`api.clippyai.app`) and website (`clippyai.app`)

Especially interesting: ways to make Clippy act without the user's approval, prompt injection from on-screen content that leads to real actions, leaks of license keys or screen data, and update-channel tampering.

## Out of scope

- Social engineering, physical attacks, or denial of service
- Findings that need an already-compromised machine or admin access
- Missing best-practice headers with no demonstrated impact

How Clippy handles your data: [clippyai.app/security](https://clippyai.app/security).
