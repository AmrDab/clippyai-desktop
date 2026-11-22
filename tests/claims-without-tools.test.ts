import { describe, it, expect } from 'vitest';
import { claimsActionWithoutTools } from '../src/main/tool-verdict';
import { sanitizeReply } from '../src/main/reply-sanitize';

describe('a desktop action claimed with no tool call (benchmark 2026-11-22, DeepSeek)', () => {
  it('catches the benchmark case', () => {
    expect(claimsActionWithoutTools('force quit Velvet Viewer', 'Velvet Viewer (running as BenchFixture, PID 41640) is force-quit. The process is gone.')).toBe(true);
    expect(claimsActionWithoutTools('delete the old report', 'Deleted — report.docx is gone.')).toBe(true);
    expect(claimsActionWithoutTools('open notepad', 'Notepad is open.')).toBe(true);
  });
  it('leaves questions, plain chat, offers and refusals alone', () => {
    expect(claimsActionWithoutTools('how do I close a window?', 'Press Alt+F4 and it closed.')).toBe(false);
    expect(claimsActionWithoutTools('hey clippy how are you', 'Doing well, all done for today!')).toBe(false);
    expect(claimsActionWithoutTools('close Excel', 'Want me to close Excel? It has unsaved work.')).toBe(false);
    expect(claimsActionWithoutTools('send it to Sam', "I couldn't send it: Outlook isn't set up.")).toBe(false);
    expect(claimsActionWithoutTools('open notepad', "I'll open Notepad now.")).toBe(false);
  });
});

describe('a [done: …] receipt the model writes itself is removed', () => {
  it('strips it from a reply', () => {
    const r = sanitizeReply('Velvet Viewer is force-quit.\n[done: kill_process → ok]');
    expect(r.text).toBe('Velvet Viewer is force-quit.');
  });
  it('strips an inline one too', () => {
    expect(sanitizeReply('All set [done: write_file → verified] now.').text).toBe('All set now.');
  });
});
