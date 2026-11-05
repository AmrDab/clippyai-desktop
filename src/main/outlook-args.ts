/**
 * outlook-args.ts — argv for the Windows Outlook send scripts (v0.24, plan §3.6).
 *
 * Subject and body always travel base64-encoded UTF-8 (-subjectB64 /
 * -bodyB64). Passed raw, a multi-line body was cut at the first newline by
 * the command-line tokenizer and em-dashes / emoji were mangled by the OEM
 * code page. All three send scripts (com-outlook-send-email.ps1,
 * olk-send-email-uia.ps1, olk-send-email-direct.ps1) decode these params.
 */

export interface OutlookSendInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  attachments?: string;
}

export const toB64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/**
 * @param withAttachments false for the new-Outlook (olk) paths — mailto: and
 *   the direct compose window cannot carry attachments.
 */
export function outlookSendArgs(input: OutlookSendInput, withAttachments: boolean): string[] {
  const args = ['-to', input.to, '-subjectB64', toB64(input.subject), '-bodyB64', toB64(input.body)];
  if (input.cc) args.push('-cc', input.cc);
  if (withAttachments && input.attachments) args.push('-attachments', input.attachments);
  return args;
}
