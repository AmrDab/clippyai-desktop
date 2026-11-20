import { describe, it, expect } from 'vitest';
import { cleanMicLabel, listMics, resolveMic } from '../src/renderer/mic-select';

describe('cleanMicLabel', () => {
  it("strips Chromium's default and communications prefixes", () => {
    expect(cleanMicLabel('Default - Microphone (HP USB-C Dock Audio Headset)')).toBe('Microphone (HP USB-C Dock Audio Headset)');
    expect(cleanMicLabel('Communications - Microphone Array (Intel Smart Sound Technology)')).toBe('Microphone Array (Intel Smart Sound Technology)');
  });
  it('leaves a plain name alone', () => {
    expect(cleanMicLabel('MacBook Pro Microphone (Built-in)')).toBe('MacBook Pro Microphone (Built-in)');
    expect(cleanMicLabel('')).toBe('');
  });
});

const dock = { kind: 'audioinput' as const, deviceId: 'id-dock', label: 'Microphone (HP USB-C Dock Audio Headset)' };
const array = { kind: 'audioinput' as const, deviceId: 'id-array', label: 'Microphone Array (Intel Smart Sound Technology)' };
const devices = [
  { kind: 'audioinput' as const, deviceId: 'default', label: 'Default - Microphone (HP USB-C Dock Audio Headset)' },
  { kind: 'audioinput' as const, deviceId: 'communications', label: 'Communications - Microphone (HP USB-C Dock Audio Headset)' },
  dock,
  array,
  { kind: 'audiooutput' as const, deviceId: 'id-spk', label: 'Speakers' },
  { kind: 'videoinput' as const, deviceId: 'id-cam', label: 'Camera' },
];

describe('listMics — what the Microphone dropdown offers', () => {
  it('lists each real microphone once, without the default/communications aliases', () => {
    expect(listMics(devices)).toEqual([
      { deviceId: 'id-dock', label: dock.label },
      { deviceId: 'id-array', label: array.label },
    ]);
  });
  it('skips the id-less placeholder returned before microphone access', () => {
    expect(listMics([{ kind: 'audioinput', deviceId: '', label: '' }])).toEqual([]);
  });
});

describe('resolveMic — the saved microphone among those plugged in', () => {
  const mics = listMics(devices);
  it('Automatic (no saved id) resolves to nothing', () => {
    expect(resolveMic(null, mics)).toBeNull();
    expect(resolveMic({ deviceId: '', label: '' }, mics)).toBeNull();
    expect(resolveMic({ deviceId: '', label: array.label }, mics)).toBeNull();
  });
  it('finds the saved microphone by id', () => {
    expect(resolveMic({ deviceId: 'id-array', label: 'renamed since' }, mics)?.deviceId).toBe('id-array');
  });
  it('re-matches by name when the id changed', () => {
    expect(resolveMic({ deviceId: 'old-id', label: array.label }, mics)).toEqual({ deviceId: 'id-array', label: array.label });
  });
  it('is null when the microphone is gone, so the recorder falls back to Automatic', () => {
    expect(resolveMic({ deviceId: 'old-id', label: 'USB Headset' }, mics)).toBeNull();
    expect(resolveMic({ deviceId: 'old-id', label: '' }, mics)).toBeNull();
    expect(resolveMic({ deviceId: 'id-array', label: array.label }, [])).toBeNull();
  });
});
