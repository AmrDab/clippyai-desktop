/**
 * 0.24.15 settings audit: wiring checks on source that can't be unit-run
 * (Electron main IPC, the bubble + Settings renderers).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PROVIDER_PRESETS } from '../src/main/byok/presets';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const ipc = read('main/ipc.ts');

describe('settings audit wiring', () => {
  it('"Try a tip now" reports disabled when Proactive Mode is off, before forcing a check', () => {
    const fn = read('main/brain.ts').match(/async fireProactiveTipManually\(\)[\s\S]*?await this\.proactiveCheck\(true\)/)![0];
    expect(fn).toMatch(/if \(!settingsStore\.get\('proactiveEnabled'\)\) return \{ ok: false, reason: 'disabled' \}/);
    expect(read('renderer/settings.ts')).toContain("reason === 'disabled'");
  });

  it('every Settings link host is allowed (https only), including each own-model key page', () => {
    const block = ipc.match(/const SETTINGS_LINK_HOSTS = \[([\s\S]*?)\];/)![1];
    const hosts = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const wanted = new Set(['platform.openai.com', 'clawhub.ai']);
    for (const p of PROVIDER_PRESETS) if (p.keyUrl) wanted.add(new URL(p.keyUrl).hostname);
    expect([...wanted].sort()).toEqual([...hosts].sort());
    expect(ipc).toContain("parsed.protocol === 'https:' && SETTINGS_LINK_HOSTS.includes(parsed.hostname)");
  });

  it('0 is kept for volume and follow offsets (no `|| default`)', () => {
    expect(ipc).not.toMatch(/Number\(settings\.speechVolume\) \|\|/);
    expect(ipc).not.toMatch(/Number\(settings\.followOffsetX\) \|\|/);
    expect(ipc).not.toMatch(/Number\(settings\.followOffsetY\) \|\|/);
    expect(read('renderer/settings.ts')).toContain('(config.proactiveCooldownMs as number) ?? 600000');
  });

  it('saved follow offsets/easing are applied at boot', () => {
    expect(read('main/index.ts')).toMatch(/fm\.setOptions\(\{\s*offsetX: brainSettingsStore\.get\('followOffsetX'\),\s*offsetY: brainSettingsStore\.get\('followOffsetY'\),\s*easing: brainSettingsStore\.get\('followEasing'\),/);
  });

  it('"Don\'t suggest this again" from the right-click menu refreshes the cache', () => {
    const at = ipc.indexOf('label: "🚫 Don\'t suggest this again"');
    expect(at).toBeGreaterThan(-1);
    const menu = ipc.slice(at, at + 800);
    expect(menu).toContain('brain.rebuildSuggestionCaches();');
  });

  it('Settings proactive toggle rebuilds the tray menu', () => {
    const block = ipc.match(/if \(settings\.proactiveEnabled !== undefined\) \{[\s\S]*?\n {4}\}/)![0];
    expect(block).toContain('refreshTrayTooltip();');
  });

  it('waking restores the saved TTS setting instead of forcing it on', () => {
    const main = read('renderer/main.ts');
    expect(main).not.toContain('tts.setEnabled(true)');
    expect(main).toContain('tts.setEnabled(ttsWanted)');
  });

  it('the debounced save merges pending keys', () => {
    const fn = read('renderer/settings.ts').match(/function debounceSave[\s\S]*?\n\}/)![0];
    expect(fn).toContain('Object.assign(pendingSave, settings)');
  });

  it('Settings drops the false/dead copy and the dead wake-word toggle', () => {
    const html = read('renderer/settings.html');
    const energy = html.match(/id="clippy-energy-group"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)![0];
    expect(energy).not.toMatch(/cooldown/i);
    expect(html).not.toContain('clippyai.app/voices');
    expect(html).not.toContain('setting-wake-word');
  });
});
