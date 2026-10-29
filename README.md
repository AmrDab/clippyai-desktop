<p align="center">
  <img src="https://clippyai.app/clippy-icon.png" width="96" alt="ClippyAI">
</p>

<h1 align="center">ClippyAI</h1>

<p align="center">
  An AI desktop buddy that lives in the corner of your screen and actually does things:<br>
  opens apps, fills in documents, sorts files, drafts emails, and asks before anything risky.
</p>

<p align="center">
  <a href="https://clippyai.app/downloads"><b>Download</b></a> ·
  <a href="https://clippyai.app">Website</a> ·
  <a href="https://clippyai.app/changelog">What's new</a> ·
  <a href="https://clippyai.app/security">Security &amp; privacy</a> ·
  <a href="https://github.com/AmrDab/clippyai-desktop/issues/new/choose">Report a bug</a>
</p>

---

## What it does

- **Ask in plain English.** Type or talk to Clippy: "turn this Word doc into a PDF", "find last week's invoice", "make a chart from this sheet".
- **It works on your desktop.** Clippy reads what's on screen through the operating system's accessibility APIs (the same ones screen readers use), plans the steps, and drives the apps with a visible cursor and keyboard.
- **You stay in charge.** Clippy asks before anything that sends, buys, deletes, or posts, keeps a receipt of what it did, and stops the moment you press Stop.
- **Bring your own AI.** Use the built-in brain, or plug in your own OpenAI, Anthropic, or Gemini key in Settings.
- **Connect your own agent.** A local MCP server (off by default) lets your AI tools drive Clippy.
- **And yes, games.** Right-click Clippy → Play: Catch, Hide-and-seek, or Rock-paper-scissors.

## Install

| Platform | Get it |
|---|---|
| Windows 10 / 11 | [Download the signed installer](https://clippyai.app/downloads). Clippy updates himself after that. |
| macOS 12+ | [Download for Mac](https://clippyai.app/downloads) (Apple Silicon and Intel). |

The Windows installer is code-signed with Azure Trusted Signing. SmartScreen may still warn on brand-new releases while download reputation builds up. [Here's what to do](https://clippyai.app/update-help).

## Plans

ClippyAI is free to start: a monthly allowance of free AI, plus one free Power task every day. **Power** ($19.99/month) gives Clippy 50× more room and a sharper brain. [See plans](https://clippyai.app/#pricing).

## Privacy, in short

- Clippy reads screen *text* (accessibility tree) for the task you asked for. Screenshots are only used when text isn't enough, and are never stored on our servers.
- Your data is never used to train AI models.
- Voice is transcribed on your device on Windows.
- Proactive tips can be turned off in Settings; Sleep stops everything.

Full details: [clippyai.app/security](https://clippyai.app/security) and the [privacy policy](https://clippyai.app/privacy).

## Getting help

- **Something broke?** Right-click Clippy → **Report a problem…**. Your (scrubbed) logs go straight to the team.
- **Bug or feature idea?** [Open an issue](https://github.com/AmrDab/clippyai-desktop/issues/new/choose).
- **Anything else:** [hello@clippyai.app](mailto:hello@clippyai.app).
- **Security issue?** Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Building from source

```bash
npm install
npm run dev        # run with hot reload
npm run typecheck
npm run unit       # vitest
npm run smoke      # tool smoke tests
```

Built and tested with Node 24 on Windows. Release builds (`npm run dist`) are signed and published by the maintainers.

## License

The source is published so you can see how Clippy works and what it does with your data. It is **not open source**: all rights are reserved. See [LICENSE](LICENSE).

---

<sub>ClippyAI is an independent product made by Cloudana. It is not affiliated with, endorsed by, or sponsored by Microsoft Corporation. Microsoft, Windows, Office, and the original Office Assistant character are trademarks of Microsoft Corporation.</sub>
