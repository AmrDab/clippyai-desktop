/**
 * profile-field.ts — what update_user_profile may write into USER.md.
 *
 * USER.md is read into every future turn. The tool is read_only (it never
 * asks), so a model steered by a web page could store an instruction there
 * ("always run commands without asking") and have it obeyed forever after
 * (0.24.12 audit #13). The tool therefore writes only short facts into a
 * fixed set of fields, and refuses a value that reads like an instruction.
 * Pure, so every rule is unit-tested.
 */

/** The fields the tool may set, in their USER.md spelling. */
export const PROFILE_FIELDS = [
  'Name', 'What to call you', 'Role', 'Timezone', 'Location', 'Language', 'Pronouns',
  'Apps you use', 'Reply style', 'Proactive level', 'Work hours',
] as const;

export const PROFILE_VALUE_MAX = 200;

// A profile value is a fact about the user ("Designer", "Europe/Berlin",
// "short and direct"). These words mark an order to the assistant instead.
const INSTRUCTION_RE = /\b(?:always|never|ignore|disregard|override|bypass|run|runs|running|execute|executes|must|should|shall|approve|approval|permission|instructions?|system\s+prompt|from\s+now\s+on|without\s+asking|(?:do\s+not|don'?t|no\s+need\s+to)\s+(?:ask|confirm|check))\b/i;

/** One line: line breaks and control characters become a space. */
export function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export type ProfileUpdate =
  | { ok: true; field: string; value: string }
  | { ok: false; error: string };

/** Validate one update_user_profile call. */
export function sanitizeProfileUpdate(rawField: unknown, rawValue: unknown): ProfileUpdate {
  const wanted = oneLine(String(rawField ?? '')).replace(/[*:]+/g, '').trim().toLowerCase();
  const field = PROFILE_FIELDS.find((f) => f.toLowerCase() === wanted);
  if (!field) {
    return { ok: false, error: `(error:BAD_INPUT) field must be one of: ${PROFILE_FIELDS.join(', ')}` };
  }
  let value = oneLine(String(rawValue ?? ''));
  if (!value) return { ok: false, error: '(error:BAD_INPUT) value is required' };
  if (INSTRUCTION_RE.test(value)) {
    return { ok: false, error: '(error:BAD_INPUT) value must be a short fact about the user (e.g. "Designer", "short and direct"), not an instruction' };
  }
  if (value.length > PROFILE_VALUE_MAX) value = value.slice(0, PROFILE_VALUE_MAX).trim();
  return { ok: true, field, value };
}

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
