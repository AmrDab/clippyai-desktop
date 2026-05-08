import path from 'path';
import { getOutputDir } from './output-dir';
import type { ToolResult } from '../../types/tool-result';

interface Block {
  type: 'heading' | 'paragraph' | 'list';
  content: string | string[];
}

/** Sanitize filename: strip path separators, add timestamp if no extension. */
function sanitizeFilename(raw: string): string {
  let name = raw.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!name) name = 'output';
  if (!name.endsWith('.docx')) name = `${name}_${Date.now()}.docx`;
  return name;
}

/**
 * Tier 1 — docx-from-blocks
 * Writes heading/paragraph/list blocks to a .docx file using the `docx` package.
 * Fails gracefully if docx is not available.
 */
export async function docxFromBlocks(params: Record<string, unknown>): Promise<ToolResult> {
  const rawFilename = String(params.filename || '');
  if (!rawFilename) return { text: '(error:INVALID_PARAMS) filename is required' };

  const blocks = params.blocks as Block[];
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { text: '(error:INVALID_PARAMS) blocks must be a non-empty array' };
  }
  const validTypes = new Set(['heading', 'paragraph', 'list']);
  for (const b of blocks) {
    if (!validTypes.has(b.type)) {
      return { text: `(error:INVALID_PARAMS) unknown block type: ${b.type}` };
    }
  }

  let docx: any;
  try {
    docx = await import('docx');
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) docx module unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

    const children: unknown[] = [];
    for (const block of blocks) {
      if (block.type === 'heading') {
        children.push(new Paragraph({
          text: String(block.content),
          heading: HeadingLevel.HEADING_1,
        }));
      } else if (block.type === 'paragraph') {
        children.push(new Paragraph({
          children: [new TextRun(String(block.content))],
        }));
      } else if (block.type === 'list') {
        const items = Array.isArray(block.content) ? block.content : [String(block.content)];
        for (const item of items) {
          children.push(new Paragraph({
            text: String(item),
            bullet: { level: 0 },
          }));
        }
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    const outDir = getOutputDir();
    const filename = sanitizeFilename(rawFilename);
    const outPath = path.join(outDir, filename);

    const fs = await import('fs');
    fs.writeFileSync(outPath, buffer);

    return { text: `Generated Word document: ${outPath}` };
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default docxFromBlocks;
