import assert from "node:assert/strict";
import { parseCsv, csvCandidates } from "../src/domain/csv.ts";
import { equalSplit } from "../src/domain/money.ts";
import {
  createImport,
  editImportItem,
  acknowledgeImportItem,
  confirmImport,
  applyImportResults,
} from "../src/domain/import-workflow.ts";
const preview = csvCandidates(
  parseCsv(
    "description;date;amount;currency\nTaxi fixture;2026-01-01;1,01;PEN\nCena fixture;2026-01-02;2.00;USD",
    ";",
  ),
);
const actor = { role: "participant", participantId: "a" },
  now = 1000000;
const candidates = preview.candidates.map((row, index) => ({
  id: `item-${index}`,
  source: { fileId: "file-fixture", row: row.sourceRow },
  fields: {
    description: row.description,
    spentOn: row.date,
    amountMinor: row.amountMinor === null ? null : BigInt(row.amountMinor),
    currency: row.currency,
    payerId: "a",
    movement: "unknown",
    splits: [],
  },
  warnings: [],
  duplicateExpenseIds: [],
}));
let job = createImport(
  { id: "job-fixture", ownerId: "a", participants: ["a", "b"], candidates },
  actor,
  now,
);
assert.equal(job.manifest, null);
assert.ok(job.items.every((i) => i.expenseId === null));
for (const item of job.items) {
  const reviewed = {
    ...item.fields,
    movement: "expense",
    splits: equalSplit(item.fields.amountMinor, ["a", "b"]),
  };
  job = editImportItem(job, actor, item.id, reviewed, true, job.version, now);
  job = acknowledgeImportItem(
    job,
    actor,
    item.id,
    ["NON_EXPENSE_MOVEMENT"],
    false,
    job.version,
    now,
  );
}
job = confirmImport(job, actor, "first", job.version, now);
assert.equal(job.manifest.totals.PEN, 101n);
assert.equal(job.manifest.totals.USD, 200n);
assert.deepEqual(job.manifest.commands[0].expense.splits, [
  { participantId: "a", amountMinor: 51n },
  { participantId: "b", amountMinor: 50n },
]);
assert.equal(job.manifest.commands[0].source.row, 2);
assert.equal(job.manifest.commands[1].source.row, 3);
job = applyImportResults(
  job,
  "first",
  job.version,
  [
    { itemId: "item-0", status: "persisted", expenseId: "expense-0" },
    { itemId: "item-1", status: "failed", code: "TRANSIENT" },
  ],
  now,
);
job = confirmImport(job, actor, "retry", job.version, now);
assert.deepEqual(
  job.manifest.commands.map((c) => c.itemId),
  ["item-1"],
);
job = applyImportResults(
  job,
  "retry",
  job.version,
  [{ itemId: "item-1", status: "persisted", expenseId: "expense-1" }],
  now,
);
assert.equal(job.phase, "persisted");
assert.equal(job.receipts.length, 2);
console.log(
  "OK: CSV → revisión explícita → manifest PEN/USD → resultado parcial → reintento solo de fila fallida; prueba de dominio sin escrituras reales.",
);
