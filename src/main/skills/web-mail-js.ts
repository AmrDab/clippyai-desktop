/**
 * web-mail-js.ts — the JavaScript the webmail send recipes evaluate in the
 * mail tab (gmail-web-send.ts, outlook-web-send.ts).
 *
 * Mail fields come from the model, and the model can be steered by a page or
 * a document. Every value therefore reaches the page as a JSON string literal
 * (never spliced into quoted source), and the body is written as text nodes
 * and <br> elements (never innerHTML), so no field can run script in the
 * signed-in mail tab (0.24.12 audit #9).
 */

export interface ComposeFields {
  to: string;
  subject: string;
  body: string;
  cc?: string;
}

/** Gmail's compose deep link (view=cm opens the compose window directly). */
export function gmailComposeUrl(f: ComposeFields): string {
  const cc = f.cc ? `&cc=${encodeURIComponent(f.cc)}` : '';
  return `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(f.to)}&su=${encodeURIComponent(f.subject)}&body=${encodeURIComponent(f.body)}${cc}`;
}

/** A JS string literal for `value`, safe inside evaluated source. */
export function jsString(value: string): string {
  // JSON.stringify leaves U+2028 / U+2029 raw; older engines end the line there.
  return JSON.stringify(String(value)).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
}

/** `location.href = "<url>"` with the URL as one string literal. */
export function navigateJs(url: string): string {
  return `location.href = ${jsString(url)}`;
}

/**
 * Statements that replace the contents of the element in variable `elVar`
 * with `body` as plain text, one <br> per line break.
 */
export function fillBodyJs(elVar: string, body: string): string {
  return `
        ${elVar}.textContent = '';
        ${jsString(body)}.split(/\\r?\\n/).forEach(function (line, i) {
          if (i) ${elVar}.appendChild(document.createElement('br'));
          ${elVar}.appendChild(document.createTextNode(line));
        });`;
}
