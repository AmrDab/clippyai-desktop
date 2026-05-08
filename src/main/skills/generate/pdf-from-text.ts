import path from 'path';
import { getOutputDir } from './output-dir';

interface ToolResult {
  text: string;
}

/** Sanitize filename: strip path separators, add timestamp if no extension. */
function sanitizeFilename(raw: string): string {
  let name = raw.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!name) name = 'output';
  if (!name.endsWith('.pdf')) name = `${name}_${Date.now()}.pdf`;
  return name;
}

/**
 * Tier 1 — pdf-from-text
 * Writes plain text content to a PDF file using pdf-lib.
 * Word-wraps at page width. Fails gracefully if pdf-lib is not available.
 */
export async function pdfFromText(params: Record<string, unknown>): Promise<ToolResult> {
  const rawFilename = String(params.filename || '');
  if (!rawFilename) return { text: '(error:INVALID_PARAMS) filename is required' };

  const content = String(params.content || '');
  if (!content.trim()) return { text: '(error:INVALID_PARAMS) content is required' };

  const fontSize = Math.min(Math.max(Number(params.fontSize) || 12, 6), 72);

  let pdfLib: any;
  try {
    pdfLib = await import('pdf-lib');
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) pdf-lib module unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const { PDFDocument, StandardFonts, rgb } = pdfLib;

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const margin = 50;
    const pageWidth = 595;  // A4 width in points
    const pageHeight = 842; // A4 height in points
    const maxWidth = pageWidth - margin * 2;
    const lineHeight = fontSize * 1.4;

    // Wrap lines
    const lines: string[] = [];
    for (const rawLine of content.split('\n')) {
      if (!rawLine.trim()) { lines.push(''); continue; }
      let current = '';
      for (const word of rawLine.split(' ')) {
        const candidate = current ? `${current} ${word}` : word;
        const textWidth = font.widthOfTextAtSize(candidate, fontSize);
        if (textWidth > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);
    }

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    for (const line of lines) {
      if (y - lineHeight < margin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      if (line) {
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) });
      }
      y -= lineHeight;
    }

    const pdfBytes = await pdfDoc.save();

    const outDir = getOutputDir();
    const filename = sanitizeFilename(rawFilename);
    const outPath = path.join(outDir, filename);

    const fs = await import('fs');
    fs.writeFileSync(outPath, pdfBytes);

    return { text: `Generated PDF: ${outPath}` };
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default pdfFromText;
