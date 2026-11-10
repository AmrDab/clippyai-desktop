/**
 * ui-busy.ts — the bubble renderer reports when the user is mid-conversation:
 * half-typed text, the chat panel open, or a prompt with buttons waiting for an
 * answer. Main reads it before interrupting (add-email offer, idle install).
 */
let bubbleBusy = false;

export function setBubbleBusy(v: boolean): void { bubbleBusy = v; }
export function isBubbleBusy(): boolean { return bubbleBusy; }
