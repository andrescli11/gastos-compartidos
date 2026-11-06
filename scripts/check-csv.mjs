import assert from "node:assert/strict";
import {
  parseCsv,
  csvCandidates,
  CsvError,
  CSV_LIMITS,
} from "../src/domain/csv.ts";
function fails(fn, code) {
  assert.throws(
    fn,
    (error) =>
      error instanceof CsvError &&
      error.code === code &&
      !error.message.includes("PRIVATE"),
  );
}
const table = parseCsv(
  '\uFEFFdescription;date;amount;currency\r\n"Taxi; aeropuerto";2026-01-01;10,01;PEN\r\n"Cena ""especial""\r\nCusco";2026-01-02;20.00;USD\r\n',
  ";",
);
assert.equal(table.hadBom, true);
assert.equal(table.rows.length, 3);
assert.equal(table.rows[1].cells[0].literal, '"Taxi; aeropuerto"');
assert.equal(table.rows[1].cells[0].text, "Taxi; aeropuerto");
assert.equal(table.rows[2].cells[0].text, 'Cena "especial"\r\nCusco');
assert.equal(table.rows[2].cells[1].row, 4);
assert.equal(table.rows[2].cells[1].column, 8);
assert.equal(table.rows[2].cells[1].columnIndex, 2);
const preview = csvCandidates(table);
assert.equal(preview.candidates[0].amountMinor, "1001");
assert.equal(preview.candidates[1].currency, "USD");
assert.deepEqual(preview.candidates[0].warnings, ["REQUIRES_REVIEW"]);
assert.equal(preview.candidates[0].movementType, "unknown");
assert.equal(preview.schemaVersion, "csv-preview-v1");
assert.equal(
  csvCandidates(parseCsv("description,date,amount,currency\n", ",")).candidates
    .length,
  0,
);
assert.equal(csvCandidates(parseCsv("", ",")).candidates.length, 0);
assert.deepEqual(csvCandidates(parseCsv("\n\n", ",")).omittedEmptyRows, [1, 2]);
const ambiguous = csvCandidates(
  parseCsv(
    "description,date,amount,currency,extra\n=1+1,01/02/2026,-1,EUR,ignored",
    ",",
  ),
);
assert.equal(ambiguous.candidates[0].date, null);
assert.equal(ambiguous.candidates[0].amountMinor, null);
assert.equal(ambiguous.candidates[0].currency, null);
assert.ok(ambiguous.candidates[0].warnings.includes("FORMULA_LIKE_CONTENT"));
assert.deepEqual(ambiguous.omittedColumns, [5]);
for (const value of ["2026-02-30", "2025-02-29", "2026-1-01", "2026-01-01 "]) {
  const candidate = csvCandidates(
    parseCsv(`description,date,amount,currency\nx,${value},1,PEN`, ","),
  ).candidates[0];
  assert.equal(candidate.date, null);
}
assert.equal(
  csvCandidates(
    parseCsv("description,date,amount,currency\nx,2024-02-29,1,PEN", ","),
  ).candidates[0].date,
  "2024-02-29",
);
for (const value of ["0", "1e3", "1.001", " 1", "-1"]) {
  assert.equal(
    csvCandidates(
      parseCsv(
        `description;date;amount;currency\nx;2026-01-01;${value};PEN`,
        ";",
      ),
    ).candidates[0].amountMinor,
    null,
  );
}
const mapped = csvCandidates(
  parseCsv("detalle\tfecha\timporte\tmoneda\nx\t2026-01-01\t1\tPEN", "\t"),
  {
    description: "detalle",
    date: "fecha",
    amount: "importe",
    currency: "moneda",
  },
  { start: "2026-01-02", end: "2026-01-04" },
);
assert.ok(mapped.candidates[0].warnings.includes("OUTSIDE_TRIP_DATES"));
fails(() => parseCsv('PRIVATE"bad', ","), "INVALID_CSV");
fails(() => parseCsv('"PRIVATE" trailing', ","), "INVALID_CSV");
fails(() => parseCsv('"PRIVATE', ","), "INVALID_CSV");
fails(() => parseCsv("x\0PRIVATE", ","), "INVALID_CSV");
fails(() => parseCsv("x", "|"), "INVALID_OPTIONS");
fails(
  () => parseCsv("x".repeat(CSV_LIMITS.cellCharacters + 1), ","),
  "CELL_TOO_LARGE",
);
fails(
  () =>
    parseCsv(
      Array(CSV_LIMITS.columns + 1)
        .fill("x")
        .join(","),
      ",",
    ),
  "TOO_MANY_COLUMNS",
);
fails(() => parseCsv("x\n".repeat(CSV_LIMITS.rows + 1), ","), "TOO_MANY_ROWS");
fails(() => parseCsv("x".repeat(CSV_LIMITS.bytes + 1), ","), "FILE_TOO_LARGE");
fails(
  () => parseCsv("é".repeat(CSV_LIMITS.bytes / 2 + 1), ","),
  "FILE_TOO_LARGE",
);
fails(
  () =>
    csvCandidates(
      parseCsv(
        "description,date,amount,currency\nx,2026-01-01,1,PEN,PRIVATE",
        ",",
      ),
    ),
  "INVALID_CSV",
);
fails(
  () =>
    csvCandidates(parseCsv("description,date,amount,currency,amount\n", ",")),
  "INVALID_HEADER",
);
fails(
  () => csvCandidates(parseCsv("description,date,amount\n", ",")),
  "INVALID_HEADER",
);
fails(
  () =>
    csvCandidates(
      parseCsv(
        "description,date,amount,currency\n" +
          "x,2026-01-01,1,PEN\n".repeat(201),
        ",",
      ),
    ),
  "TOO_MANY_CANDIDATES",
);
assert.equal(parseCsv("a,b,", ",").rows[0].cells.length, 3);
assert.equal(parseCsv('""', ",").rows[0].cells[0].text, "");
assert.equal(parseCsv('"a""b"', ",").rows[0].cells[0].text, 'a"b');
console.log(
  "OK: CSV estricto, coordenadas físicas/literales, límites, candidatos revisables y casos adversariales sin persistencia.",
);
