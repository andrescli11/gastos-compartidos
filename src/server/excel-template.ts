/** Generic workbook: no participants, links, credentials or financial examples. */
import { createHash } from "node:crypto";
const CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const EXCEL_TEMPLATE_HEADERS = [
  "descripción",
  "fecha",
  "importe",
  "moneda",
] as const;
function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
/** Stored ZIP keeps the small template auditable and requires no third-party package. */
function archive(entries: readonly (readonly [string, string])[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path, "utf8"),
      bytes = Buffer.from(content, "utf8"),
      crc = crc32(bytes);
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    // Stable DOS date: 2026-01-01; no user metadata or current timestamps.
    header.writeUInt16LE(0x5c21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x5c21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const directories = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directories.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directories, end]);
}
const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function textCell(address: string, value: string, style = 1) {
  return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}
export function createExcelTemplate(): Buffer {
  const header = `<row r="1">${EXCEL_TEMPLATE_HEADERS.map((value, index) => textCell(`${"ABCD"[index]}1`, value, 2)).join("")}</row>`;
  const empty = Array.from(
    { length: 20 },
    (_, i) =>
      `<row r="${i + 2}">${[..."ABCD"].map((column) => textCell(`${column}${i + 2}`, "")).join("")}</row>`,
  ).join("");
  const instructions = [
    "Cómo completar la plantilla",
    "Completa una fila por gasto en la hoja Gastos. Puedes añadir más filas; máximo 200 candidatos por importación.",
    "descripción: escribe qué se pagó. No añadas números de cuenta, tarjeta, documentos ni otros datos innecesarios.",
    "fecha: usa AAAA-MM-DD. Las celdas están configuradas como texto para conservar lo escrito.",
    "importe: escribe un número positivo con punto decimal y hasta dos decimales, sin símbolos de moneda ni separador de miles. Conserva el formato Texto.",
    "moneda: escribe PEN o USD. No mezcles monedas ni conviertas importes durante la carga.",
    "El pagador y las personas beneficiarias se asignan en la revisión de la app; el archivo no necesita nombres del grupo.",
    "No uses fórmulas, macros, enlaces externos ni archivos protegidos. El límite de carga Excel es 4 MB.",
    "La carga no registra gastos: revisa cada fila, los repartos y los totales PEN/USD antes de confirmar.",
    "El archivo original se procesa temporalmente y se descarta; los borradores privados de revisión expiran a los 7 días. Puedes borrar tu copia local cuando ya no la necesites.",
  ];
  const rows = instructions
    .map(
      (value, i) =>
        `<row r="${i + 1}">${textCell(`A${i + 1}`, value, i === 0 ? 2 : 1)}</row>`,
    )
    .join("");
  const relationBase =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return archive([
    [
      "[Content_Types].xml",
      declaration +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      declaration +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationBase}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      declaration +
        `<workbook xmlns="${ns}" xmlns:r="${relationBase}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Gastos" sheetId="1" r:id="rId1"/><sheet name="Instrucciones" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      declaration +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationBase}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationBase}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${relationBase}/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      "xl/styles.xml",
      declaration +
        `<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ],
    [
      "xl/worksheets/sheet1.xml",
      declaration +
        `<worksheet xmlns="${ns}"><dimension ref="A1:D21"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="40" customWidth="1" style="1"/><col min="2" max="3" width="20" customWidth="1" style="1"/><col min="4" max="4" width="14" customWidth="1" style="1"/></cols><sheetData>${header}${empty}</sheetData><autoFilter ref="A1:D21"/></worksheet>`,
    ],
    [
      "xl/worksheets/sheet2.xml",
      declaration +
        `<worksheet xmlns="${ns}"><cols><col min="1" max="1" width="110" customWidth="1" style="1"/></cols><sheetData>${rows}</sheetData></worksheet>`,
    ],
  ]);
}
export function excelTemplateResponse(): Response {
  const bytes = createExcelTemplate();
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPE,
      "Content-Disposition":
        'attachment; filename="plantilla-gastos-cusco.xlsx"',
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ETag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    },
  });
}
