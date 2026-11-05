import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  ExpenseRepository,
  PersistenceError,
  validateExpenseCommand,
} from "../src/server/expense-repository.ts";
const payerId = "10000000-0000-4000-8000-000000000001",
  key = "30000000-0000-4000-8000-000000000001";
const token = randomBytes(32).toString("base64url");
const command = {
  operation: "create",
  payerId,
  description: "x'); DROP TABLE expenses; --",
  spentOn: "2026-01-01",
  amountMinor: "99999999999999",
  currency: "PEN",
  splits: [{ participantId: payerId, amountMinor: "99999999999999" }],
};
const saved = {
  id: key,
  payerId,
  description: command.description,
  spentOn: command.spentOn,
  amountMinor: command.amountMinor,
  currency: "PEN",
  source: "manual",
  state: "active",
  version: 1,
  splits: command.splits,
};
let calls = 0;
const repo = new ExpenseRepository({
  query: async (sql, values) => {
    calls++;
    assert.ok(!sql.includes(command.description));
    assert.ok(!sql.includes(token));
    assert.equal(values[0], createHash("sha256").update(token).digest("hex"));
    if (sql.includes("mutate_expense")) {
      assert.equal(values[1], key);
      assert.deepEqual(JSON.parse(values[2]), command);
      return { rows: [{ result: saved }] };
    }
    return { rows: [{ result: [saved] }] };
  },
});
assert.deepEqual(await repo.mutate(token, key, command), saved);
assert.deepEqual(await repo.list(token), [saved]);
for (const override of [
  {
    amountMinor: "99999999999999\n",
    splits: [{ participantId: payerId, amountMinor: "99999999999999\n" }],
  },
  { amountMinor: 99999999999999 },
  { amountMinor: "1.01" },
  { amountMinor: "1\n" },
  { amountMinor: "0" },
  { amountMinor: "100000000000000" },
  { spentOn: "2026-02-30" },
  { spentOn: "2024-02-29\n" },
  { role: "admin" },
  { payerId: "not-uuid" },
  { currency: "EUR" },
  { description: 42 },
  { splits: [] },
  { splits: [{ participantId: payerId, amountMinor: "1" }] },
  {
    splits: [
      { participantId: payerId, amountMinor: "1" },
      { participantId: payerId.toUpperCase(), amountMinor: "99999999999998" },
    ],
  },
]) {
  await assert.rejects(
    repo.mutate(token, key, { ...command, ...override }),
    (e) => e instanceof PersistenceError && e.code === "INVALID_INPUT",
  );
}
assert.equal(calls, 2, "invalid input must not reach SQL");
for (const invalid of ["", "a".repeat(43), "x".repeat(44), token + "\n"])
  await assert.rejects(repo.list(invalid), (e) => e.code === "UNAUTHORIZED");
validateExpenseCommand({
  ...command,
  operation: "update",
  id: key,
  expectedVersion: 1,
});
validateExpenseCommand({ operation: "void", id: key, expectedVersion: 1 });
assert.throws(() =>
  validateExpenseCommand({ operation: "void", id: key, expectedVersion: "1" }),
);
assert.throws(() =>
  validateExpenseCommand({ ...command, operation: "create", id: key }),
);
for (const [driverCode, expected] of [
  ["28000", "UNAUTHORIZED"],
  ["42501", "FORBIDDEN"],
  ["23505", "CONFLICT"],
  ["40001", "CONFLICT"],
  ["23514", "INVALID_INPUT"],
  ["ECONNREFUSED", "UNAVAILABLE"],
]) {
  const failing = new ExpenseRepository({
    query: async () => {
      throw {
        code: driverCode,
        message: "SECRET fixture",
        detail: "PRIVATE fixture",
        query: "sensitive SQL",
      };
    },
  });
  await assert.rejects(failing.list(token), (error) => {
    assert.equal(error.code, expected);
    assert.ok(!JSON.stringify(error).includes("fixture"));
    assert.ok(!error.message.includes("SECRET"));
    assert.equal(error.cause, undefined);
    return true;
  });
}
for (const result of [
  null,
  {},
  [saved],
  { ...saved, amountMinor: 99999999999999 },
  { ...saved, splits: [] },
]) {
  const failing = new ExpenseRepository({
    query: async () => ({ rows: [{ result }] }),
  });
  await assert.rejects(
    failing.mutate(token, key, command),
    (e) => e.code === "UNAVAILABLE",
  );
}
console.log(
  "OK: adaptador parametrizado, dinero como strings, validación de entrada/salida y errores sin datos sensibles.",
);
