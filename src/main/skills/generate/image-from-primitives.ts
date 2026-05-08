import path from 'path';
import { getOutputDir } from './output-dir';

interface ToolResult {
  text: string;
  image?: { data: string; mimeType: string };
}

interface Primitive {
  shape: 'line' | 'circle' | 'rect' | 'text';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  radius?: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
  stroke?: string;
  fontSize?: number;
}

/**
 * Tier 1 — image-from-primitives
 * Renders shapes/text to a PNG using node-canvas (native module).
 * Fails gracefully if canvas is not available.
 */
export async function imageFromPrimitives(params: Record<string, unknown>): Promise<ToolResult> {
  const width = Number(params.width) || 0;
  const height = Number(params.height) || 0;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    return { text: '(error:INVALID_PARAMS) width and height must be 1–4096' };
  }

  const rawPrimitives = params.primitives;
  if (!Array.isArray(rawPrimitives)) {
    return { text: '(error:INVALID_PARAMS) primitives must be an array' };
  }

  const primitives = rawPrimitives as Primitive[];
  const validShapes = new Set(['line', 'circle', 'rect', 'text']);
  for (const p of primitives) {
    if (!validShapes.has(p.shape)) {
      return { text: `(error:INVALID_PARAMS) unknown shape: ${p.shape}` };
    }
  }

  let canvas: any;
  try {
    // Dynamic import so a missing/broken canvas build doesn't crash app launch
    const mod = await import('canvas');
    canvas = mod;
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) canvas module unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const { createCanvas } = canvas;
    const cnv = createCanvas(width, height);
    const ctx = cnv.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    for (const p of primitives) {
      const strokeColor = p.stroke || p.color || '#000000';
      const fillColor = p.color || '#000000';
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = fillColor;
      ctx.lineWidth = 2;

      if (p.shape === 'line') {
        ctx.beginPath();
        ctx.moveTo(Number(p.x1) || 0, Number(p.y1) || 0);
        ctx.lineTo(Number(p.x2) || 0, Number(p.y2) || 0);
        ctx.stroke();
      } else if (p.shape === 'circle') {
        const r = Number(p.radius) || 10;
        ctx.beginPath();
        ctx.arc(Number(p.x) || 0, Number(p.y) || 0, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.shape === 'rect') {
        ctx.strokeRect(Number(p.x) || 0, Number(p.y) || 0, Number(p.width) || 10, Number(p.height) || 10);
      } else if (p.shape === 'text') {
        const fontSize = Number(p.fontSize) || 14;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.fillText(String(p.text || ''), Number(p.x) || 0, Number(p.y) || 0);
      }
    }

    const outDir = getOutputDir();
    const filename = `image_${Date.now()}.png`;
    const outPath = path.join(outDir, filename);

    const buffer = cnv.toBuffer('image/png');
    const fs = await import('fs');
    fs.writeFileSync(outPath, buffer);

    return { text: `Generated image: ${outPath}` };
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default imageFromPrimitives;
