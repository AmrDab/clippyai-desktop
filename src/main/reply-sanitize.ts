// reply-sanitize.ts — strip leaked tool-call syntax from a model reply before
// it reaches the bubble / TTS.
//
// Weak models (especially deepseek-v4-flash on the tool-less Free path)
// sometimes TYPE a tool invocation as prose instead of emitting a structured
// tool_call. Live report 2026-06-12: the bubble said and TTS read
// "play_animation\nAnimation: Congratulate" verbatim. We pull out any
// animation the model named (so the sprite still performs) and remove the
// syntax from what the user sees.
//
// Pure, ZERO imports — the smoke layer-1 esbuild harness exercises the real
// source (same pattern as input-triggers / spatial-presence).

/** Sprite animations the renderer understands (mirrors play_animation's set). */
export const ANIMATION_NAMES = [
  'Wave', 'Thinking', 'Congratulate', 'Alert', 'GetAttention', 'Searching',
  'Writing', 'SendMail', 'GetArtsy', 'GetTechy', 'GetWizardy', 'Processing',
  'CheckingSomething', 'Explain', 'GestureUp', 'GestureDown', 'GestureLeft',
  'GestureRight', 'LookLeft', 'LookRight', 'LookUp', 'LookDown', 'GoodBye',
  'Greeting', 'IdleSnooze', 'EmptyTrash',
];
const ANIM_SET = new Set(ANIMATION_NAMES.map((a) => a.toLowerCase()));

export interface SanitizedReply {
  /** What the user should actually see/hear — tool syntax removed. */
  text: string;
  /** An animation the model named via leaked syntax, or null. */
  animation: string | null;
}

/**
 * Remove leaked `play_animation` / `Animation: X` tool syntax from `raw`.
 * Returns the cleaned text plus any animation name found (validated against
 * the known set, so a stray "Animation: foo" in real prose is left alone).
 */
export function sanitizeReply(raw: string): SanitizedReply {
  if (!raw) return { text: '', animation: null };
  let text = raw;
  let animation: string | null = null;

  const m =
    text.match(/play_animation\s*[\n:>-]*\s*(?:animation\s*[:=]\s*)?([A-Za-z]+)/i) ||
    text.match(/(?:^|\n)\s*Animation\s*[:=]\s*([A-Za-z]+)\s*(?:$|\n)/i);
  if (m && ANIM_SET.has(m[1].toLowerCase())) {
    animation = ANIMATION_NAMES.find((a) => a.toLowerCase() === m[1].toLowerCase()) ?? null;
  }

  text = text
    // "play_animation … <Name>" in any spacing/colon/arrow/newline shape
    .replace(/play_animation\s*[\n:>-]*\s*(?:animation\s*[:=]\s*)?[A-Za-z]+/gi, '')
    // a standalone "Animation: <Name>" line
    .replace(/(?:^|\n)\s*Animation\s*[:=]\s*[A-Za-z]+\s*(?=$|\n)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return { text, animation };
}
