import { describe, it, expect } from 'vitest';
import { PermissionFlow, type PermSnapshot } from '../src/renderer/permission-flow';

const ungranted: PermSnapshot = { accessibility: false, screenRecording: false, automationAnyBrowser: false };
const allGranted: PermSnapshot = { accessibility: true, screenRecording: true, automationAnyBrowser: true };

describe('PermissionFlow', () => {
  it('starts on accessibility in INTRO with an Explain animation', () => {
    const f = new PermissionFlow(['accessibility', 'screenRecording', 'automation']);
    const s = f.start(ungranted);
    expect(s.kind).toBe('accessibility');
    expect(s.status).toBe('intro');
    expect(s.animation).toBe('Explain');
    expect(s.done).toBe(false);
  });

  it('open() moves to opened with GestureRight animation', () => {
    const f = new PermissionFlow(['accessibility']);
    f.start(ungranted);
    const s = f.open();
    expect(s.status).toBe('opened');
    expect(s.animation).toBe('GestureRight');
  });

  it('first ungranted onSnapshot after open() transitions to waiting + Searching', () => {
    const f = new PermissionFlow(['accessibility']);
    f.start(ungranted);
    f.open();
    const s = f.onSnapshot(ungranted);
    expect(s.status).toBe('waiting');
    expect(s.animation).toBe('Searching');
  });

  it('auto-advances + Congratulates when the current permission flips granted', () => {
    const f = new PermissionFlow(['accessibility', 'screenRecording']);
    f.start(ungranted); f.open();
    const s = f.onSnapshot({ accessibility: true, screenRecording: false, automationAnyBrowser: false });
    expect(s.justGranted).toBe(true);
    expect(s.animation).toBe('Congratulate');
    const next = f.advance();
    expect(next.kind).toBe('screenRecording');
    expect(next.status).toBe('intro');
  });

  it('grant can come from opened state (no prior ungranted poll)', () => {
    const f = new PermissionFlow(['accessibility']);
    f.start(ungranted); f.open();
    const s = f.onSnapshot({ accessibility: true, screenRecording: false, automationAnyBrowser: false });
    expect(s.justGranted).toBe(true);
    expect(s.animation).toBe('Congratulate');
  });

  it('skip() advances without granting', () => {
    const f = new PermissionFlow(['accessibility', 'screenRecording']);
    f.start(ungranted);
    const s = f.skip();
    expect(s.kind).toBe('screenRecording');
  });

  it('skip() on the last permission marks done', () => {
    const f = new PermissionFlow(['accessibility']);
    f.start(ungranted);
    const s = f.skip();
    expect(s.done).toBe(true);
  });

  it('onSnapshot called before open() (status intro) does NOT mutate state', () => {
    const f = new PermissionFlow(['accessibility']);
    f.start(ungranted);
    // status is 'intro' — guard should prevent mutation
    const s = f.onSnapshot({ accessibility: true, screenRecording: false, automationAnyBrowser: false });
    expect(s.status).toBe('intro');
    expect(s.justGranted).toBe(false);
    expect(s.kind).toBe('accessibility');
  });

  it('all-granted snapshot on start() → current().done === true', () => {
    const f = new PermissionFlow(['accessibility', 'screenRecording']);
    const s = f.start(allGranted);
    expect(s.done).toBe(true);
  });

  it('auto-skips an already-granted permission on start', () => {
    const f = new PermissionFlow(['accessibility', 'screenRecording']);
    const s = f.start({ accessibility: true, screenRecording: false, automationAnyBrowser: false });
    expect(s.kind).toBe('screenRecording'); // accessibility already on → skipped
  });

  it('drops automation when no browser was selected', () => {
    const f = new PermissionFlow(['accessibility', 'automation'], { hasBrowser: false });
    f.start({ accessibility: true, screenRecording: false, automationAnyBrowser: false });
    expect(f.current().done).toBe(true); // accessibility granted, automation dropped → done
  });

  it('flags screenRecording as needing relaunch on grant', () => {
    const f = new PermissionFlow(['screenRecording']);
    f.start(ungranted); f.open();
    const s = f.onSnapshot({ accessibility: false, screenRecording: true, automationAnyBrowser: false });
    expect(s.needsRelaunch).toBe(true);
  });
});
