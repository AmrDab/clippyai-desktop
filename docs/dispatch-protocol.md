# Clippy Dispatch — protocol

A phone sends tasks to Clippy on the user's PC. Ported from Blob's phone relay
(C:\Users\amr_d\clawdcursor-talk: relay/src/room.ts, src/pair.ts, src/pair-crypto.ts).
Owner choices (2026-11-23): every plan incl. Free; ONE phone per PC; the link stays
paired until the user removes it; a phone task wakes Clippy, and the phone has an On/Off switch.

## Parts
- Relay: clippyai-api Worker, Durable Object `DispatchRoom` (SQLite), one DO per room.
- Phone page: https://clippyai.app/dispatch/ (static, clippyai-web), built from `dispatch-phone/` in the client repo.
- Desktop: `src/main/dispatch.ts` in the client.
- Shared crypto: `src/shared/dispatch-crypto.ts` (WebCrypto only; used by the desktop and bundled into the phone page).

## Pairing
1. Desktop makes `room` (16 random bytes, base64url, 22 chars), `secret` (32 bytes, 43 chars), `pc` (16 bytes, 22 chars).
   `auth` = HKDF(secret, info "clippy-dispatch auth") as base64url (43 chars). `pcHash` = sha256(pc) hex.
2. Desktop registers the room: `POST https://api.clippyai.app/v1/dispatch/rooms`
   headers `Authorization: Bearer <licenseKey>`, body `{room, auth, pcHash}`.
   Server checks the license key is valid (any plan), rate-limits 20 rooms/day per license, and the DO stores
   `{auth, pcHash, created}`. 201 `{ok:true}`. Only registered rooms accept sockets.
   Registering a new room for a license does NOT touch older rooms; the desktop unpairs its old room itself.
3. QR = `https://clippyai.app/dispatch/#r=<room>&k=<secret>`. The fragment is never sent to any server.
   The phone page KEEPS the fragment in the address bar (iPhone "Add to Home Screen" saves the current URL) and
   also stores it in localStorage (`clippy-dispatch-link`) as a fallback.
4. Phone device id: 22 random chars in localStorage `clippy-dispatch-device`.

## Sockets
`wss://api.clippyai.app/v1/dispatch/room/<room>?role=pc&auth=<auth>&pc=<pc>`
`wss://api.clippyai.app/v1/dispatch/room/<room>?role=phone&auth=<auth>&dev=<deviceId>`
- room/pc/dev must match `^[A-Za-z0-9_-]{22}$`, auth `^[A-Za-z0-9_-]{43}$`; must be a WebSocket upgrade.
- role=phone requires `Origin` https://clippyai.app or https://www.clippyai.app (local dev: an env allowlist).
  role=pc: Node has no Origin; it proves itself with sha256(pc) == pcHash.
- Admission: unknown room → close 4404. auth mismatch → 4403. First phone's `dev` is stored; a different dev → 4409.
  A reconnect by the same side replaces its old socket (old one gets `{t:'replaced'}` then close 4001).
  Clients must ignore close events from a socket that is no longer their current one.
- Relay text frames: `{t:'peer', on:boolean}` (sent to each side when the other joins/leaves and on connect),
  `{t:'unpaired'}` / `{t:'expired'}` / `{t:'replaced'}` right before a close.
- Client text frame: `{t:'unpair'}` from either side → room wiped, tombstone `{gone: sha256(auth)}` kept, both closed 4000.
- Every binary frame is forwarded to the other side unread. Max 64 KB/frame (else close 1009);
  40 frames / 10 s per socket (else close 4008).
- Close codes: 4000 unpaired, 4001 replaced by a newer socket of the same side (just reconnect; NOT the end of the pairing), 4008 rate limit, 4403 bad auth, 4404 gone/unknown, 4409 another phone owns it.
- Expiry (DO alarm): a room no phone ever joined dies 10 min after registration. A paired room never expires
  from idle; it is only cleaned up after 365 days with no connection from either side.
- The relay stores no message content; storage = `{auth, pcHash, created, paired, seen, phone}`.

## Encryption (inside binary frames)
- On `{t:'peer', on:true}` each side sends hello: byte 0x00, 16-byte nonce, 32-byte HMAC-SHA256(authKey, role|nonce).
- After both hellos, per-connection keys: HKDF(secret, salt = pcNonce|phoneNonce, info "pc->phone" / "phone->pc") → AES-256-GCM.
- Data frame: byte 0x01, 12-byte IV, ciphertext of JSON `{...msg, n}`; `n` strictly increases per direction (replays dropped).

## Messages (JSON inside data frames)
Phone → PC:
- `{type:'req', id, text}` — a task (text ≤ 4096 chars). Clippy comes online first.
- `{type:'power', on:boolean}` — On/Off switch: on = wake + show Clippy; off = put him to sleep.
- `{type:'reply', id, yes:boolean}` — answer to an `ask` (approval card).
- `{type:'stop'}` — stop the running task (same as clicking Clippy).
PC → Phone:
- `{type:'status', state:'asleep'|'ready'|'working', text?}` — sent on connect and on every change.
- `{type:'answer', text, id?}` — Clippy's reply to a task.
- `{type:'ask', id, question, choices:['Approve','Deny']}` — an approval card is waiting; re-sent when the phone reconnects.
- `{type:'ask-done', id}` — the card was answered (on either side) or timed out.
