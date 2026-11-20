/**
 * Voice input: which microphone. Pure helpers over what
 * navigator.mediaDevices.enumerateDevices() returns, shared by the recorder
 * and Settings → Voice.
 */

/** Chromium lists the system default twice: once as itself and once as
 *  "Default - <name>" (on Windows also "Communications - <name>"). This is
 *  the device's own name. */
export function cleanMicLabel(label: string): string {
  return label.replace(/^(Default|Communications) - /, '').trim();
}
