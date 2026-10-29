/**
 * v0.22 — "What's new" card, shown once on the first launch after an update
 * to a new minor version. A fresh install shows nothing (the welcome flow
 * covers that); users upgrading from before v0.22 never stored a version, so
 * an existing profile stands in for "this is an upgrade".
 */
import { app } from 'electron';
import Store from 'electron-store';
import { createLogger } from './logger';

const log = createLogger('WhatsNew');

const NOTES: Record<string, string[]> = {
  '0.22': [
    "I tell you clearly how a task ended: done, stopped by you, or stuck.",
    "If I ever crash or freeze, I pick myself back up, and you can send a report in one click.",
    "Right-click me → **Report a problem** anytime. It goes straight to the team.",
  ],
};

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

export function whatsNewToShow(lastVersion: string | undefined, current: string, existingUser: boolean): string[] | null {
  if (!lastVersion && !existingUser) return null;           // fresh install
  if (lastVersion && minor(lastVersion) === minor(current)) return null; // same or patch
  return NOTES[minor(current)] ?? null;
}

const store = new Store<{ lastRunVersion?: string }>({ name: 'app-state' });
let pending: { version: string; notes: string[] } | null = null;

/** At launch: decide once, and remember this version. */
export function checkWhatsNew(existingUser: boolean): void {
  const current = app.getVersion();
  const notes = whatsNewToShow(store.get('lastRunVersion'), current, existingUser);
  store.set('lastRunVersion', current);
  if (notes) pending = { version: current, notes };
}

/** The renderer asks once it's ready; answers at most once per launch. */
export function takeWhatsNew(): { version: string; notes: string[] } | null {
  const p = pending;
  pending = null;
  if (p) log.info('WhatsNew.show', { version: p.version });
  return p;
}
