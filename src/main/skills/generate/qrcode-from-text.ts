import path from 'path';
import { getOutputDir } from './output-dir';

interface ToolResult {
  text: string;
}

/**
 * Tier 1 — qrcode-from-text
 * Renders a QR code to PNG using the `qrcode` package.
 * Fails gracefully if qrcode is not available.
 */
export async function qrcodeFromText(params: Record<string, unknown>): Promise<ToolResult> {
  const text = String(params.text || '').trim();
  if (!text) {
    return { text: '(error:INVALID_PARAMS) text is required' };
  }

  const size = Math.min(Math.max(Number(params.size) || 300, 64), 2048);

  let QRCode: any;
  try {
    QRCode = (await import('qrcode')).default ?? (await import('qrcode'));
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) qrcode module unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const outDir = getOutputDir();
    const filename = `qrcode_${Date.now()}.png`;
    const outPath = path.join(outDir, filename);

    await QRCode.toFile(outPath, text, { width: size, type: 'png' });

    return { text: `Generated QR code: ${outPath}` };
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default qrcodeFromText;
