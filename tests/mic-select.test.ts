import { describe, it, expect } from 'vitest';
import { cleanMicLabel } from '../src/renderer/mic-select';

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
