import { describe, expect, it } from "vitest";
import { ImportRepository, validateImportCommand } from "./import-repository";
import { PersistenceError } from "./expense-repository";
import type { ImportRow } from "./import-contract";
const id = "a1000000-0000-4000-8000-000000000001";
const row: ImportRow = {
  id,
  description: "",
  spentOn: "",
  amountMinor: "",
  currency: "",
  payerId: "",
  splits: [],
  selected: false,
  reviewed: false,
  keepBoth: false,
  evidence: "limited literal",
  sourceRow: 1,
  warnings: [],
  duplicateExpenseIds: [],
};
const token = "A".repeat(43);
describe("private persisted import boundary", () => {
  it("accepts incomplete private drafts but rejects excessive input and identities", () => {
    expect(
      validateImportCommand({
        operation: "create",
        sourceType: "manual",
        rows: [row],
      }).operation,
    ).toBe("create");
    expect(() =>
      validateImportCommand({
        operation: "create",
        sourceType: "manual",
        rows: [row],
        ownerId: id,
      }),
    ).toThrow(PersistenceError);
    expect(() =>
      validateImportCommand({
        operation: "create",
        sourceType: "manual",
        rows: Array(201).fill(row),
      }),
    ).toThrow(PersistenceError);
    expect(() =>
      validateImportCommand({
        operation: "confirm",
        id,
        expectedVersion: 1,
        rows: [row],
      }),
    ).toThrow(PersistenceError);
  });
  it("uses parameterized SQL and rejects malformed persisted data", async () => {
    let query = "";
    let values: readonly unknown[] = [];
    const repo = new ImportRepository({
      query: async (q, v) => {
        query = q;
        values = v;
        return {
          rows: [
            {
              result: {
                job: {
                  id,
                  version: 1,
                  state: "preview",
                  sourceType: "manual",
                  createdAt: "2026-01-01T00:00:00Z",
                  expiresAt: "2026-01-08T00:00:00Z",
                  rows: [row],
                  results: [],
                },
              },
            },
          ],
        };
      },
    });
    const result = await repo.mutate(token, id, {
      operation: "create",
      sourceType: "manual",
      rows: [row],
    });
    expect(query).toContain("$3::jsonb");
    expect(values[0]).not.toBe(token);
    expect(result.job.rows[0].evidence).toBe("limited literal");
    const bad = new ImportRepository({
      query: async () => ({ rows: [{ result: { job: { id } } }] }),
    });
    await expect(bad.list(token, id)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
  it("does not retain database messages or connection data in public errors", async () => {
    const repo = new ImportRepository({
      query: async () => {
        throw Object.assign(new Error("private driver detail"), {
          code: "ECONNRESET",
        });
      },
    });
    await expect(repo.list(token)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "No se pudo completar la operación.",
    });
  });
});
