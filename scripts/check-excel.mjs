import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { parseXlsx, ExcelSourceError } from "../src/server/excel-source.ts";
import { csvCandidates } from "../src/domain/csv.ts";
const table = Array.from({ length: 256 }, (_, i) => {
  let v = i;
  for (let n = 0; n < 8; n++) v = (v >>> 1) ^ (v & 1 ? 0xedb88320 : 0);
  return v >>> 0;
});
function crc(bytes) {
  let v = 0xffffffff;
  for (const b of bytes) v = (v >>> 8) ^ table[(v ^ b) & 255];
  return (v ^ 0xffffffff) >>> 0;
}
function zip(entries, options = {}) {
  const local = [],
    central = [];
  let at = 0;
  for (const [name, text] of entries) {
    const bytes = Buffer.from(text),
      filename = Buffer.from(name),
      packed = options.deflate ? deflateRawSync(bytes) : bytes;
    const h = Buffer.alloc(30),
      c = Buffer.alloc(46),
      flags = options.flags || 0,
      method = options.deflate ? 8 : 0;
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(crc(bytes), 14);
    h.writeUInt32LE(packed.length, 18);
    h.writeUInt32LE(bytes.length, 22);
    h.writeUInt16LE(filename.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc(bytes), 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(bytes.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(at, 42);
    local.push(h, filename, packed);
    central.push(c, filename);
    at += h.length + filename.length + packed.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, cd, end]);
}
const inline = (ref, text) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const headers =
  inline("A1", "description") +
  inline("B1", "date") +
  inline("C1", "amount") +
  inline("D1", "currency");
function entries(
  cells = inline("A2", "Almuerzo &amp; café") +
    inline("B2", "2026-01-01") +
    '<c r="C2"><v>123456789012.34</v></c>' +
    inline("D2", "PEN"),
  extra = [],
) {
  return [
    [
      "[Content_Types].xml",
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ],
    [
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Gastos" r:id="rId1"/></sheets></workbook>',
    ],
    [
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData><row r="1">${headers}</row><row r="2">${cells}</row></sheetData></worksheet>`,
    ],
    ...extra,
  ];
}
let workbook = parseXlsx(zip(entries()));
assert.equal(workbook.sheets[0].name, "Gastos");
let preview = csvCandidates(workbook.sheets[0].table);
assert.equal(preview.candidates[0].amountMinor, "12345678901234");
assert.equal(preview.candidates[0].description, "Almuerzo & café");
assert.equal(preview.candidates[0].fields.amount.literal, "123456789012.34");
assert.equal(preview.candidates[0].sourceRow, 2);
workbook = parseXlsx(zip(entries(), { deflate: true }));
assert.equal(workbook.sheets[0].table.rows.length, 2);
const formulaCells =
  inline("A2", "Total") +
  inline("B2", "2026-01-01") +
  '<c r="C2"><f>SUM(A3:A4)</f><v>1.23E2</v></c>' +
  inline("D2", "USD");
preview = csvCandidates(parseXlsx(zip(entries(formulaCells))).sheets[0].table);
assert.equal(preview.candidates[0].amountMinor, "12300");
assert(preview.candidates[0].warnings.includes("FORMULA_LIKE_CONTENT"));
assert.equal(preview.candidates[0].fields.amount.literal, "=SUM(A3:A4)");
const noCache = formulaCells.replace("<v>1.23E2</v>", "");
preview = csvCandidates(parseXlsx(zip(entries(noCache))).sheets[0].table);
assert.equal(preview.candidates[0].amountMinor, null);
assert(preview.candidates[0].warnings.includes("INVALID_AMOUNT"));
const dateCells =
  inline("A2", "Hotel") +
  '<c r="B2" s="1"><v>46023</v></c><c r="C2"><v>100.01</v></c>' +
  inline("D2", "PEN");
preview = csvCandidates(
  parseXlsx(
    zip(
      entries(dateCells, [
        [
          "xl/styles.xml",
          '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        ],
      ]),
    ),
  ).sheets[0].table,
);
assert.equal(preview.candidates[0].date, "2026-01-01");
const shared = entries(
  inline("A2", "Hotel") +
    inline("B2", "2026-01-01") +
    '<c r="C2"><v>0.01</v></c><c r="D2" t="s"><v>0</v></c>',
  [
    [
      "xl/sharedStrings.xml",
      "<sst><si><r><t>P</t></r><r><t>EN</t></r></si></sst>",
    ],
  ],
);
assert.equal(
  csvCandidates(parseXlsx(zip(shared)).sheets[0].table).candidates[0].currency,
  "PEN",
);
const reject = (value) =>
  assert.throws(() => parseXlsx(value), ExcelSourceError);
reject(Buffer.from("not a workbook"));
reject(Buffer.alloc(15 * 1024 * 1024 + 1));
reject(zip(entries(), { flags: 1 }));
const hostile = [
  entries("", [["../outside.xml", "x"]]),
  entries("", [["xl/vbaProject.bin", "x"]]),
  entries("", [["xl/externalLinks/externalLink1.xml", "<x/>"]]),
  entries().map(([n, v]) => [
    n,
    n === "xl/workbook.xml"
      ? '<workbook><!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]><sheets/></workbook>'
      : v,
  ]),
  entries().map(([n, v]) => [
    n,
    n.endsWith("sheet1.xml")
      ? v.replace("</worksheet>", "<sheetProtection/></worksheet>")
      : v,
  ]),
  entries("", [
    [
      "xl/worksheets/_rels/sheet1.xml.rels",
      '<Relationships><Relationship Id="rId2" Target="https://example.invalid" TargetMode="External"/></Relationships>',
    ],
  ]),
  entries(inline("A2001", "too far")),
  entries(inline("CW2", "too wide")),
  entries(inline("A2", "&unknown;")),
  entries().map(([n, v]) => [
    n,
    n === "xl/workbook.xml"
      ? '<workbook><sheets><sheet name="x" r:id="rId1"/><sheet name="x" r:id="rId1"/></sheets></workbook>'
      : v,
  ]),
  entries("", [["XL/workbook.xml", "duplicate case"]]),
];
for (const e of hostile) reject(zip(e));
const corrupted = zip(entries());
corrupted[50] ^= 1;
reject(corrupted);
reject(
  zip(entries("", [["xl/bomb.xml", "x".repeat(200000)]]), { deflate: true }),
);
reject(zip(entries('<c r="A2"><v>1</v><v>2</v></c>')));
const duplicate = entries(inline("A2", "A") + inline("A2", "B"));
reject(zip(duplicate));
const falseDate = entries(dateCells.replace("46023", "60"), [
  [
    "xl/styles.xml",
    '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  ],
]);
reject(zip(falseDate));
// Degenerate markup must fail in linear scanning, not a quadratic regex search.
reject(zip(entries("", [["xl/styles.xml", "<".repeat(100000)]])));
reject(
  zip(
    entries("", [
      [
        "xl/styles.xml",
        "<x " +
          Array.from({ length: 101 }, (_, i) => `a${i}="x"`).join(" ") +
          "/>",
      ],
    ]),
  ),
);
reject(
  zip(entries("", [["xl/styles.xml", "<x>".repeat(65) + "</x>".repeat(65)]])),
);
console.log(
  "Excel exact lexical amounts, formulas, dates, shared strings and hostile ZIP/XML checks passed.",
);
