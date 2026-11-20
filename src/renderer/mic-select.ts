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

export interface Mic {
  deviceId: string;
  label: string;
}

/** The saved choice. deviceId '' means Automatic. */
export type MicPref = Mic;

/** The real microphones: audio inputs without Chromium's "default" and
 *  "communications" aliases, and without the id-less placeholder it returns
 *  before microphone access is granted. */
export function listMics(devices: Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): Mic[] {
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

/** The saved microphone among those plugged in now: by id, else by name
 *  (ids change, names do not). null = Automatic, or the microphone is gone. */
export function resolveMic(pref: MicPref | null | undefined, mics: Mic[]): Mic | null {
  if (!pref?.deviceId) return null;
  return mics.find((m) => m.deviceId === pref.deviceId)
    ?? (pref.label ? mics.find((m) => m.label === pref.label) : undefined)
    ?? null;
}

/** Automatic mode, default microphone dead: the microphones worth trying
 *  instead, in system order. The dead one is left out by name, because the
 *  default is listed a second time under its own id. */
export function otherMics(mics: Mic[], deadLabel: string): Mic[] {
  return deadLabel ? mics.filter((m) => m.label !== deadLabel) : mics;
}
