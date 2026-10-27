/**
 * writing-card.ts — renderer for the ⌥G writing-assist card.
 *
 * Receives the correction payload from main via window.clippy.onWritingAssistData,
 * renders the corrected + original text, and wires Apply / Dismiss to the
 * preload bridge. Window.clippy types live in src/preload/api.d.ts.
 */

interface WritingAssistData {
  original: string;
  corrected: string;
  count: number;
  app: string;
}

const titleEl = document.getElementById('title') as HTMLElement;
const subappEl = document.getElementById('subapp') as HTMLElement;
const correctedEl = document.getElementById('corrected') as HTMLElement;
const originalEl = document.getElementById('original') as HTMLElement;
const applyBtn = document.getElementById('apply') as HTMLButtonElement;
const dismissBtn = document.getElementById('dismiss') as HTMLButtonElement;

let corrected = '';

function render(data: WritingAssistData): void {
  corrected = data.corrected;
  titleEl.textContent =
    data.count > 0
      ? `Clippy fixed ${data.count} thing${data.count === 1 ? '' : 's'}`
      : 'Suggested edit';
  subappEl.textContent = data.app ? `in ${data.app}` : '';
  correctedEl.textContent = data.corrected;
  originalEl.textContent = data.original;
  applyBtn.disabled = false;
}

window.clippy.onWritingAssistData?.((data: WritingAssistData) => render(data));

applyBtn.addEventListener('click', async () => {
  applyBtn.disabled = true;
  try {
    await window.clippy.writingApply?.(corrected);
  } catch (err) {
    window.clippy.log?.('ERROR', 'WritingCard', 'apply failed', { err: String(err) });
  } finally {
    window.clippy.writingDismiss?.();
  }
});

dismissBtn.addEventListener('click', () => {
  window.clippy.writingDismiss?.();
});

// Esc dismisses too — matches the rest of the app's keyboard affordances.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.clippy.writingDismiss?.();
});
