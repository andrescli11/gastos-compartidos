import assert from "node:assert/strict";
import {
  createExcelTemplate,
  excelTemplateResponse,
  EXCEL_TEMPLATE_HEADERS,
} from "../src/server/excel-template.ts";
import { parseXlsx } from "../src/server/excel-source.ts";
import { csvCandidates } from "../src/domain/csv.ts";
const bytes = createExcelTemplate();
assert(bytes.length > 22 && bytes.length < 100000);
assert.deepEqual(
  bytes,
  createExcelTemplate(),
  "stable template without personal metadata",
);
const workbook = parseXlsx(bytes);
assert.deepEqual(
  workbook.sheets.map((s) => s.name),
  ["Gastos", "Instrucciones"],
);
assert.deepEqual(
  workbook.sheets[0].table.rows[0].cells.map((c) => c.text),
  EXCEL_TEMPLATE_HEADERS,
);
const preview = csvCandidates(workbook.sheets[0].table, {
  description: "descripción",
  date: "fecha",
  amount: "importe",
  currency: "moneda",
});
assert.equal(
  preview.candidates.length,
  0,
  "download must never contain example expenses",
);
assert.equal(preview.omittedEmptyRows.length, 20);
assert(
  workbook.sheets[1].table.rows.some((row) =>
    row.cells.some((cell) => cell.text.includes("AAAA-MM-DD")),
  ),
);
assert(
  workbook.sheets[1].table.rows.some((row) =>
    row.cells.some((cell) => cell.text.includes("PEN o USD")),
  ),
);
assert(
  bytes.includes(Buffer.from('numFmtId="49"')),
  "format text preserves raw monetary/date strings",
);
assert(!bytes.includes(Buffer.from("<f>")));
const response = excelTemplateResponse();
assert.equal(response.status, 200);
assert.equal(
  response.headers.get("content-type"),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
);
assert.equal(
  response.headers.get("content-disposition"),
  'attachment; filename="plantilla-gastos-cusco.xlsx"',
);
assert.equal(response.headers.get("cache-control"), "no-store");
assert.equal(response.headers.get("content-length"), String(bytes.length));
assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
console.log(
  "Generic Excel template has empty editable rows, exact text formats, Spanish instructions and safe download headers.",
);
