import { app } from 'electron';
import { pickLang, type Lang } from './i18n';

let cached: Lang | null = null;

/** UI language for first-run surfaces: Windows display-language list (most preferred first), else the app locale. */
export function uiLang(): Lang {
  if (cached) return cached;
  let list: string[] = [];
  try { list = app.getPreferredSystemLanguages(); } catch { /* older runtime */ }
  if (!list.length) list = [app.getLocale()];
  cached = pickLang(list);
  return cached;
}
