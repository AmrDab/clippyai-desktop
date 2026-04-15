# ClippyAI — Strategic Root-Cause Fix Plan
**Date:** 2026-04-14
**Scope:** Stop the whack-a-mole. Fix the architectural defects that keep generating symptoms.

---

## Executive summary

In the last ~2 weeks we've shipped 30+ commits, most of them fixing AI behavior issues: JSON leaking into the bubble, wrong dates, "I can't check" weather refusals, Clippy saying "On it!" but doing nothing, models ignoring identity rules. Each fix was a prose-level patch (`"NEVER output JSON"`, `"You ARE Clippy"`, `"today is X"`).

**All of these symptoms share two root causes:**

1. **We're string-parsing AI output** instead of using the provider's native structured-outputs / function-calling APIs. Every major model (Gemini, Claude, GPT) has a proper tool-use protocol. We're treating them as autocomplete engines and post-processing with regex.
2. **`/chat` and `/agent` are architecturally asymmetric.** `/agent` uses Gemini's `responseMimeType: 'application/json'` with a fallback chain — it's reasonably reliable. `/chat` has no structured output enforcement, no fallback, and injects identity as prose inside the user message — the model can (and does) override it.

The model isn't the problem. **The protocol is.** No model upgrade alone fixes this; fixing the protocol usage makes the current models (Gemini 2.5 Pro/Flash) work correctly.

---

## Diagnostic findings (from audit)

### Backend (`clippyai-api`)

| Finding | File:line | Impact |
|---|---|---|
| `/chat` has no `responseMimeType`, no fallback chain | `src/routes/chat.ts:99-121` | Model ignores "no JSON" rule under load; no recovery from 503 |
| Identity rules injected as prose in `fullMessage`, not `systemInstruction` | `src/routes/chat.ts:74-76` | Model's base RLHF can override ("I can't check weather") |
| Tools defined as **prose strings** in `/agent` SYSTEM_PROMPT, not as `Tool` / `functionDeclarations` | `src/routes/agent.ts:25-71` | Forces string-parsing; no runtime type safety |
| `repairJSON()` regex strip | `src/routes/agent.ts:153-162` | Band-aid for not using native function calling |
| `/chat` + `/agent` treat responses differently — divergent patterns | both files | Fixes in one don't propagate |

### Main process (`ClippyAI`)

| Finding | File:line | Impact |
|---|---|---|
| Triple-pass JSON-stripping regex (last pass: `/\{[\s\S]*?\}/g`) | `src/main/brain.ts:391-395` | Destroys natural prose containing braces |
| `isQuestionNotAction()` keyword heuristic | `src/main/brain.ts:267-298` | "Search for my files" wrongly classified as question |
| Hardcoded 10s PSBridge timeout, no retry, no degradation | `src/main/tools.ts:136` | Slow customer machines see hard failures |
| Screen scale detected once at startup — no DPI change listener | `src/main/tools.ts:150-167` | Wrong coords when user moves window between monitors |
| History sends last 10 of 50 | `src/main/brain.ts:166,344` | Long sessions lose coherence |
| `delegateToAgent()` action-null path silently exits | `src/main/brain.ts:477` | "Says On it but does nothing" — no user feedback |

### Distribution

| Finding | Impact |
|---|---|
| No code signing certificate | SmartScreen warnings, antivirus false positives, NSIS integrity errors |
| Custom `installer.nsh` caused "can't run on PC" | Removed, but root issue (unsigned exe) remains |
| Browser cache bugs on installer rollout | Fixed via filename rotation; not root-cause |

---

## The fix — by priority

### 🔴 P0 — Replace string-JSON with native function calling (THE big one)

**What:** Rewrite `/agent` and `/chat` to use Gemini's native `Tool` / `functionDeclarations` API. Stop asking the model to produce JSON in text.

**Current:**
```ts
// agent.ts — prose prompt:
SYSTEM_PROMPT = `Available tools:
- open_app(name): Open Windows app
...
Return ONLY valid JSON: {"action": "open_app", ...}`

// Then:
const raw = result.response.text();
const cleaned = repairJSON(raw);   // regex strip
const parsed = JSON.parse(cleaned); // can fail
```

**Target:**
```ts
const tools = [{
  functionDeclarations: [
    { name: 'open_app', description: 'Open a Windows app',
      parameters: { type: 'OBJECT', properties: { name: { type: 'STRING' }}, required: ['name'] }},
    { name: 'smart_click', description: '...', parameters: {...}},
    // ...
  ]
}];

const result = await model.generateContent({
  contents: history,
  tools,
  systemInstruction: IDENTITY,  // cached, unchanged across session
});

// No regex. No parsing. Native response:
for (const part of result.response.candidates[0].content.parts) {
  if (part.text) sendToBubble(part.text);
  if (part.functionCall) executeTools(part.functionCall);
}
```

**Why this fixes everything:**
- ❌ JSON in bubble → ✅ text and functionCall are separate fields
- ❌ Malformed JSON → ✅ SDK returns typed objects, not strings
- ❌ Regex-strip eats prose → ✅ no strip needed
- ❌ `repairJSON()` hacks → ✅ delete the function
- ❌ "On it but doesn't act" (action: null) → ✅ if no functionCall, Gemini intentionally said nothing to do — not a parse failure

**Effort:** ~2 days. Mostly deletion of parsing code.

---

### 🔴 P0 — Unify `/chat` and `/agent` into `/v1/turn`

**What:** One endpoint. One prompt strategy. One response shape. The model's native tool-calling decides whether it's a chat turn or an action turn.

```
POST /v1/turn
{
  message: "open paint",
  history: [...],
  screenshot?: "base64",
  screen_context?: "read_screen output",
  tool_results?: [...]   // for multi-turn tool loops
}

Response:
{
  text?: "On it!",               // show in bubble if present
  tool_calls?: [{name, args}],   // execute if present
  done: boolean                  // stop agent loop
}
```

Client:
```ts
let results = null;
while (true) {
  const r = await api.turn({ message, history, tool_results: results });
  if (r.text) bubble.say(r.text);
  if (!r.tool_calls?.length) break;
  results = await runTools(r.tool_calls);
  if (r.done) break;
}
```

**Effort:** ~1 day. Mostly consolidating two handlers into one.

---

### 🟠 P1 — System prompt as `systemInstruction`, not prose

Stop concatenating identity.md into the user message. Pass it once per session as `systemInstruction` (Gemini) or `system` (Claude). The SDK caches it; model treats it as non-negotiable.

Delete all the prose workarounds:
- `"NEVER say 'I can't check'"` ← not needed if system role enforces
- `"NEVER mention ChatGPT/Gemini"` ← identity is cached
- `"NEVER output JSON"` ← not needed if using native function calling

**Effort:** ~2 hours.

---

### 🟠 P1 — Add Anthropic Claude as fallback tier

Gemini's infrastructure has recurring 503 outages (customer-visible). The current fallback chain (2.5-flash → 2.0 → 1.5) keeps us on the same vendor, so infrastructure events take everything down.

**Add:** when Gemini chain exhausts, fail over to Anthropic Claude Haiku 4.5 via `@anthropic-ai/sdk`. Claude's `tools` API is the gold standard for reliability.

```ts
try {
  return await callGemini(tools, ...);
} catch (err) {
  if (isGeminiUnavailable(err)) {
    return await callClaude(tools, ...);  // same tool schemas translate 1:1
  }
  throw err;
}
```

Cost impact: negligible (fallback path only fires when Gemini is down). Claude Haiku 4.5 is ~$1/M tokens input, $5/M output.

**Effort:** ~1 day.

**Decision point for you:** do you want to add Claude as fallback? Or stay pure Gemini? My recommendation: add it. The reliability gain is large; cost is near-zero since it's only the fallback path.

---

### 🟠 P1 — Tiered tool timeouts with graceful degradation

Current: 10s hard timeout → hard failure. Customer sees nothing.

Target:
```
Tier 1: 3s  → fast path (most commands)
Tier 2: 8s  → retry with warning animation
Tier 3: 15s → last attempt, one-off PS (not bridge)
Fallback: "That's taking longer than usual — want me to try a different way?"
```

Also: on first launch, benchmark PSBridge startup. If >8s, flag the user's machine as "slow" in config and skip UIA for non-critical commands.

**Effort:** ~1 day.

---

### 🟡 P2 — DPI/monitor change listener

Subscribe to Electron's `screen.on('display-metrics-changed')` and recompute `screenScale`. One-time fix.

**Effort:** ~1 hour.

---

### 🟡 P2 — EV Code Signing Certificate

**Buy one.** DigiCert or Sectigo, ~$299/year.

Eliminates:
- SmartScreen "unknown publisher" warnings
- NSIS integrity check failures (triggered by antivirus modifying unsigned exes)
- "Windows protected your PC" prompts
- ~80% of customer install support tickets

This is the single highest-ROI action in the whole plan. Don't skip it.

**Action:** you purchase (needs your identity docs). I can set up the signing pipeline once the cert arrives.

---

### 🟢 P3 — Later (not this sprint)

- Replace PowerShell UIA with FFI-based Win32 UIA (`ffi-napi`) — 10-100x faster
- Add Tesseract.js OCR fallback when UIA is slow/blocked
- Add telemetry dashboard for tool success/failure rates
- Remove the `user.md` profile system or refactor (current regex parsing is fragile)

---

## Sprint plan

### Sprint 1 — Protocol rewrite (this week, ~3-4 days)
- [ ] 1.1 Define shared tool schema in `clippyai-api/src/lib/tools.ts` — single source of truth
- [ ] 1.2 Replace `/agent` prose tools with Gemini `functionDeclarations`
- [ ] 1.3 Rewrite `/agent` response handler to read `part.functionCall` (no regex)
- [ ] 1.4 Create unified `/v1/turn` endpoint; keep `/chat` + `/agent` alive as aliases for 1 release
- [ ] 1.5 Move identity to `systemInstruction`, strip prose rules from user message
- [ ] 1.6 Rewrite main process `brain.ts` to use `/v1/turn` + native response shape
- [ ] 1.7 Delete `repairJSON()`, delete triple-pass regex strip
- [ ] 1.8 Smoke test: 20 varied inputs (questions, actions, weather, dates, identity probes)

### Sprint 2 — Reliability (~2 days)
- [ ] 2.1 Anthropic Claude Haiku fallback (behind feature flag)
- [ ] 2.2 Tiered PSBridge timeouts + slow-machine detection
- [ ] 2.3 DPI/monitor change listener
- [ ] 2.4 Better "action: null" visible fallback ("I'm not sure what to do — can you rephrase?")

### Sprint 3 — Distribution (you purchase cert + I integrate)
- [ ] 3.1 Purchase EV code signing cert
- [ ] 3.2 Integrate signing into electron-builder pipeline
- [ ] 3.3 Verify clean install on fresh Windows VM (no SmartScreen)

---

## Verification criteria (definition of done)

Each of these must pass before release:

1. **Native function calling works end-to-end**
   - `curl /v1/turn -d '{"message":"open paint"}'` returns structured `tool_calls: [{name: "open_app", args: {name: "paint"}}]` — NOT text-embedded JSON
2. **Zero JSON in bubble across 100 test turns**
3. **Identity stable**: "Who made you?" → "Cloudana"; "What AI are you?" → "I'm Clippy"
4. **Weather works**: "Weather in Tokyo?" → plausible seasonal estimate, never "I can't check"
5. **Date works**: "What's today's date?" → today's actual date
6. **Tool loop works**: "Open Paint and draw a circle" → opens Paint, draws circle, reports done
7. **Fallback works**: Kill Gemini endpoint mid-turn → Claude takes over (if P1 item shipped)
8. **Slow machine works**: 2GB RAM VM with 5s PSBridge startup → Clippy still responds, uses degraded mode
9. **Signed installer**: no SmartScreen on clean Win11 install (if cert purchased)

---

## What this plan explicitly does NOT do

- Doesn't swap models (Gemini 2.5 Pro is fine — we're just using it wrong)
- Doesn't rewrite the Clippy character/animation system (works fine)
- Doesn't touch the Stripe / webhook / license layer (works fine)
- Doesn't replace the PS UIA bridge yet (P3 — high effort, low urgency)
- Doesn't add telemetry dashboards (P3)

**Scope discipline is the point.** The last 2 weeks of commits were the opposite of this — scattered, reactive, symptom-level. This plan commits to 3 changes (native function calling, unified endpoint, systemInstruction) that eliminate 80% of the recurring bugs.

---

## Open questions for you

1. **Anthropic Claude fallback?** Add it (~$1/mo extra) or stay pure-Gemini? *My recommendation: add it.*
2. **EV cert purchase?** Ready to spend $299/yr? *My recommendation: yes, highest-ROI fix.*
3. **Sprint priority?** Start Sprint 1 immediately (protocol rewrite) or tackle a specific customer bug first?
4. **Backwards compat?** Keep `/chat` + `/agent` alive for 1 release, or cut straight to `/v1/turn`? *My recommendation: keep for 1 release for rollback safety.*

---

## Review section (fill in as work progresses)

_TBD — will log what actually shipped + what surprised us._
