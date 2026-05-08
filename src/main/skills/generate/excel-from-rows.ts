import path from 'path';
import { getOutputDir, sanitizeFilename } from './output-dir';
import type { ToolResult } from '../../types/tool-result';

interface Sheet {
  name: string;
  rows: unknown[][];
}

/**
 * Tier 1 — excel-from-rows
 * Writes one or more sheets of row data to an .xlsx file using exceljs.
 * Fails gracefully if exceljs is not available.
 */
export async function excelFromRows(params: Record<string, unknown>): Promise<ToolResult> {
  const rawFilename = String(params.filename || '');
  if (!rawFilename) return { text: '(error:INVALID_PARAMS) filename is required' };

  const sheets = params.sheets as Sheet[];
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return { text: '(error:INVALID_PARAMS) sheets must be a non-empty array' };
  }
  for (const s of sheets) {
    if (!s.name || !Array.isArray(s.rows)) {
      return { text: '(error:INVALID_PARAMS) each sheet needs name and rows array' };
    }
  }

  let ExcelJS: any;
  try {
    ExcelJS = await import('exceljs');
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) exceljs module unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  try {
    const workbook = new ExcelJS.Workbook();
    for (const sheet of sheets) {
      const ws = workbook.addWorksheet(sheet.name);
      for (const row of sheet.rows) {
        ws.addRow(row);
      }
    }

    const outDir = getOutputDir();
    const filename = sanitizeFilename(rawFilename, '.xlsx');
    const outPath = path.join(outDir, filename);

    await workbook.xlsx.writeFile(outPath);
    return { text: `Generated Excel file: ${outPath}` };
  } catch (e) {
    return { text: `(error:GENERATION_FAILED) ${e instanceof Error ? e.message : String(e)}` };
  }
}

export default excelFromRows;
