import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger, serializeErr } from './logger';

const log = createLogger('STT');

/**
 * v0.17.0 — Local speech-to-text via bundled whisper.cpp.
 *
 * Why bundled, not cloud:
 *   The user explicitly accepted the installer-size cost (+~60 MB) in
 *   exchange for 100% offline transcription. No audio leaves the
 *   machine. This matches ClippyAI's overall stance (visible actions,
 *   no training-on-your-data, optional screenshot only) — and the cloud
 *   alternative (Whisper API / Google STT via Web Speech) would have
 *   meant disclosing a third-party audio pipeline in the privacy policy.
 *
 * What's bundled:
 *   - whisper-cli.exe + 4 DLLs (whisper.dll, ggml*.dll) — total ~2.3 MB
 *   - ggml-base.en-q5_1.bin — quantized 5-bit base.en model — ~57 MB
 *   - Total installer delta: ~60 MB
 *
 * Why q5_1 base.en vs full base.en or tiny.en:
 *   - tiny.en (75 MB unquantized): 12% WER on LibriSpeech, too lossy.
 *   - base.en full (142 MB): 5% WER but bigger than tiny+full combined.
 *   - base.en-q5_1 (57 MB): ~5.3% WER, near-identical to full base, half
 *     the size. Best tradeoff for shipping inside a desktop app.
 *
 * Audio pipeline:
 *   Renderer (src/renderer/recorder.ts) → getUserMedia → AudioWorklet
 *   captures raw Float32 → encoded as 16-bit PCM WAV @ 16 kHz mono →
 *   sent over IPC as a Uint8Array. Main process writes WAV to a temp
 *   file → spawns whisper-cli with the bundled model → reads stdout →
 *   returns transcript. Temp WAV is unlinked on completion.
 *
 *   Whisper expects 16 kHz mono 16-bit PCM. We resample/downmix in the
 *   renderer so this module can stay simple (write file, spawn, parse).
 */

interface TranscribeOptions {
  /** Max wait time before killing the whisper-cli process. */
  timeoutMs?: number;
  /** Optional initial-prompt to bias the recognizer toward known vocab. */
  initialPrompt?: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
  elapsedMs?: number;
}

/** Resolve the directory containing whisper-cli.exe + DLLs + models/. */
function whisperDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'whisper');
  }
  return path.join(__dirname, '..', '..', 'vendor', 'whisper', 'bin');
}

function modelPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'whisper', 'models', 'ggml-base.en-q5_1.bin');
  }
  return path.join(__dirname, '..', '..', 'vendor', 'whisper', 'models', 'ggml-base.en-q5_1.bin');
}

/** Quick check that the whisper binary + model exist. Lets the renderer
 *  show a clean "voice unavailable" state instead of failing on first
 *  use if the bundle didn't install correctly. */
export function isSttReady(): { ready: boolean; reason?: string } {
  const cli = path.join(whisperDir(), 'whisper-cli.exe');
  const model = modelPath();
  if (!fs.existsSync(cli)) return { ready: false, reason: `whisper-cli.exe not found at ${cli}` };
  if (!fs.existsSync(model)) return { ready: false, reason: `model not found at ${model}` };
  return { ready: true };
}

/**
 * Transcribe a WAV buffer. The buffer MUST be 16 kHz, mono, 16-bit PCM —
 * the renderer's WAV encoder enforces that. We don't re-validate here
 * because whisper-cli will just fail-fast if the format is wrong, which
 * the caller can surface to the user.
 */
export async function transcribeWav(
  wavBuffer: Uint8Array | Buffer,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const ready = isSttReady();
  if (!ready.ready) return { ok: false, error: ready.reason };

  const start = Date.now();
  const tmpFile = path.join(os.tmpdir(), `clippy-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    fs.writeFileSync(tmpFile, wavBuffer);
    const cliPath = path.join(whisperDir(), 'whisper-cli.exe');
    const args = [
      '-m', modelPath(),
      '-f', tmpFile,
      '-nt',            // no timestamps in output — we just want the text
      '-l', 'en',
      '-t', '4',        // 4 threads — desktop apps shouldn't peg every core
      '--no-prints',    // suppress whisper's diagnostic banner
    ];
    if (opts.initialPrompt) {
      // initial-prompt bias the recognizer toward known vocab (e.g.
      // "ClippyAI Outlook Excel Slack" so it doesn't transcribe
      // those as "click bee eye out look excel slack").
      args.push('--prompt', opts.initialPrompt);
    }

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const result = await runCli(cliPath, args, timeoutMs);
    const elapsedMs = Date.now() - start;

    if (!result.ok) {
      log.warn('STT.transcribe failed', { error: result.error, elapsedMs });
      return { ok: false, error: result.error, elapsedMs };
    }

    // whisper-cli with -nt prints the transcript line-by-line to stdout,
    // one line per segment. Join with spaces, trim, and collapse internal
    // whitespace. Empty output = silent audio, treated as { ok: true, text: '' }.
    const text = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    log.info('STT.transcribe', { chars: text.length, elapsedMs, preview: text.slice(0, 60) });
    return { ok: true, text, elapsedMs };
  } catch (err) {
    log.error('STT.transcribe threw', serializeErr(err));
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Always clean up the temp WAV — voice clips are PII.
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/** Spawn whisper-cli, collect stdout, enforce timeout. Returns the raw
 *  stdout on ok=true or an error message on ok=false. The CWD is set to
 *  whisperDir() so the DLLs sitting next to whisper-cli.exe load
 *  correctly — without this Windows fails with code 0xc0000135 (DLL
 *  not found) because the process working dir is wherever Electron
 *  launched from. */
function runCli(cli: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cli, args, { cwd: whisperDir(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settled = true;
      resolve({ ok: false, stdout, error: `whisper-cli timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, stdout, error: `whisper-cli spawn error: ${err.message}` });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, stdout });
      } else {
        resolve({ ok: false, stdout, error: `whisper-cli exit code ${code}: ${stderr.trim().slice(0, 200)}` });
      }
    });
  });
}
