/**
 * Builds small real PDF files for parser tests, without a PDF library: one page, Helvetica, and
 * each table cell drawn as its own text object at its own position on the row's baseline. This
 * is how LibreOffice and Word export tables, and why pdf-parse's default renderer runs the cells
 * of a row together ("Ahmad Ali4012345670599123456Gaza").
 */

/** A string for a PDF literal: backslashes and parentheses escaped. Latin-1 text only. */
function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, ch => `\\${ch}`)})`;
}

export interface PdfTable {
  /** Rows of cells; each row is drawn on its own line. */
  rows: string[][];
  /** Left edge of each column, in points. */
  columns: number[];
  /** Font size in points (default 10). */
  fontSize?: number;
  /** Text drawn above the table, one paragraph per line (default none). */
  lines?: string[];
}

/** A one-page PDF with the given lines of text and then the table. */
export function tablePdf({ rows, columns, fontSize = 10, lines = [] }: PdfTable): Buffer {
  const ops: string[] = [];
  let y = 760;
  for (const line of lines) {
    ops.push(`BT /F1 ${fontSize} Tf 50 ${y} Td ${pdfString(line)} Tj ET`);
    y -= fontSize * 2;
  }
  for (const row of rows) {
    row.forEach((cell, i) => ops.push(`BT /F1 ${fontSize} Tf ${columns[i]} ${y} Td ${pdfString(cell)} Tj ET`));
    y -= fontSize * 2;
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A beneficiary table like a distribution annex: names, ID numbers, phone numbers and locations. */
export const BENEFICIARY_TABLE: PdfTable = {
  lines: ['Annex 2: Distribution list, Hebron governorate (target: 1,200 households by 2027)'],
  columns: [50, 160, 260, 380],
  rows: [
    ['Name', 'ID number', 'Phone', 'Location'],
    ['Ahmad Ali', '401234567', '0599123456', 'Gaza'],
    ['Sara Omar', '402345678', '059 912 3457', 'Khan Younis'],
    ['Huda Saleh', '403456789', '+970 59 912 3458', 'Hebron'],
  ],
};
