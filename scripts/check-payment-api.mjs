import assert from "node:assert/strict";
import {
  PaymentRepository,
  parsePaymentContext,
  validatePaymentCommand,
  paymentLedger,
} from "../src/server/payment-repository.ts";
import { createApi } from "../src/server/api.ts";
import { PersistenceError } from "../src/server/expense-repository.ts";
import { PaymentError } from "../src/domain/payments.ts";
import {
  newToken,
  hashToken,
  SESSION_COOKIE,
  csrfToken,
} from "../src/server/tokens.ts";
const a = "10000000-0000-4000-8000-000000000001",
  b = "10000000-0000-4000-8000-000000000002",
  link = "20000000-0000-4000-8000-000000000001",
  id = "30000000-0000-4000-8000-000000000001";
const token = newToken();
const expense = {
  id,
  payerId: a,
  description: "Fixture",
  spentOn: "2026-01-01",
  amountMinor: "100",
  currency: "PEN",
  source: "manual",
  state: "active",
  version: 1,
  splits: [{ participantId: b, amountMinor: "100" }],
};
const context = {
  actor: { id: link, role: "participant", participantId: b },
  ledgerVersion: 0,
  configuration: { mode: "separate" },
  configurationChosenBy: link,
  participants: [a, b],
  expenses: [expense],
  payments: [],
};
const cmd = {
  operation: "register",
  senderId: b,
  receiverId: a,
  amountMinor: "100",
  currency: "PEN",
  expectedLedgerVersion: 0,
};
let calls = 0;
const repo = new PaymentRepository({
  query: async (sql, values) => {
    calls++;
    assert.equal(values[0], hashToken(token));
    assert.ok(!sql.includes(token));
    if (sql.includes("mutate")) assert.deepEqual(JSON.parse(values[2]), cmd);
    return { rows: [{ result: context }] };
  },
});
assert.deepEqual(await repo.context(token), context);
assert.deepEqual(await repo.mutate(token, id, cmd), context);
for (const patch of [
  { amountMinor: 100 },
  { amountMinor: "100\n" },
  { amountMinor: "0" },
  { amountMinor: "1.01" },
  { currency: "EUR" },
  { receiverId: b },
  { expectedLedgerVersion: -1 },
  { actor: { role: "admin" } },
])
  await assert.rejects(
    repo.mutate(token, id, { ...cmd, ...patch }),
    (e) => e.code === "INVALID_INPUT",
  );
assert.equal(calls, 2);
for (const operation of ["confirm", "reject", "void"]) {
  const command = {
    operation,
    id,
    expectedPaymentVersion: 1,
    expectedLedgerVersion: 5,
    ...(operation === "confirm"
      ? { reviewedLedgerVersion: 5 }
      : operation === "void"
        ? { reason: "Private fixture" }
        : {}),
  };
  validatePaymentCommand(command);
}
for (const command of [
  {
    operation: "confirm",
    id,
    expectedPaymentVersion: 1,
    expectedLedgerVersion: 5,
    reviewedLedgerVersion: 4,
  },
  {
    operation: "configure",
    mode: "separate",
    rateNumerator: "1",
    expectedLedgerVersion: 0,
  },
  {
    operation: "void",
    id,
    expectedPaymentVersion: 1,
    expectedLedgerVersion: 0,
    reason: "",
  },
])
  assert.throws(() => validatePaymentCommand(command));
validatePaymentCommand({
  operation: "configure",
  mode: "consolidated",
  rateNumerator: "375",
  rateDenominator: "100",
  expectedLedgerVersion: 0,
});
assert.throws(() => parsePaymentContext({ ...context, payments: [{ id }] }));
assert.throws(() => parsePaymentContext({ ...context, ledgerVersion: "0" }));
assert.throws(() =>
  parsePaymentContext({
    ...context,
    expenses: [{ ...expense, amountMinor: 100 }],
  }),
);
const voided = {
  id,
  senderId: b,
  receiverId: a,
  amountMinor: "100",
  currency: "PEN",
  state: "voided",
  version: 3,
  createdBy: link,
  confirmedBy: link,
  rejectedBy: null,
  voidedBy: link,
  voidReason: null,
};
const redacted = parsePaymentContext({ ...context, payments: [voided] });
assert.equal(redacted.payments[0].voidReason, null);
assert.equal(
  paymentLedger(redacted).payments[0].voidReason,
  "[motivo reservado]",
);
assert.throws(() =>
  parsePaymentContext({
    ...context,
    payments: [{ ...voided, voidReason: "Private fixture" }],
  }),
);
for (const code of [
  "28000",
  "42501",
  "40001",
  "23514",
  "55000",
  "ECONNREFUSED",
]) {
  const broken = new PaymentRepository({
    query: async () => {
      throw {
        code,
        message: "configuration_locked",
        detail: "SENSITIVE fixture",
      };
    },
  });
  await assert.rejects(
    broken.context(token),
    (e) =>
      (e instanceof PersistenceError || e instanceof PaymentError) &&
      !e.message.includes("SENSITIVE") &&
      e.cause === undefined,
  );
}
let writes = 0,
  reads = 0;
const handler = createApi({
  appUrl: "https://cusco.example",
  rateSecret: "s".repeat(64),
  vercel: false,
  access: {
    quota: async () => true,
    context: async () => {},
    exchange: async () => {},
    logout: async () => {},
    revoke: async () => {},
  },
  expenses: { list: async () => [], mutate: async () => {} },
  payments: {
    context: async () => {
      reads++;
      return context;
    },
    mutate: async () => {
      writes++;
      return context;
    },
  },
});
function request(method = "GET", body = undefined, headers = {}) {
  return new Request("https://cusco.example/api/payments", {
    method,
    headers: {
      Origin: "https://cusco.example",
      Cookie: `${SESSION_COOKIE}=${token}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(token),
      "Idempotency-Key": id,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const read = await handler(request(), "payments");
assert.equal(read.status, 200);
assert.match(read.headers.get("cache-control"), /private, no-store/);
const data = await read.json();
assert.equal(data.summary.books.PEN.totalMinor, "100");
assert.equal(data.summary.books.PEN.transfers[0].amountMinor, "100");
assert.equal(
  (await handler(request("POST", cmd), "paymentMutate")).status,
  200,
);
assert.equal(writes, 1);
assert.equal(
  (await handler(request("POST", cmd, { "X-CSRF-Token": "" }), "paymentMutate"))
    .status,
  403,
);
assert.equal(writes, 1);
assert.equal(
  (
    await handler(
      request("POST", {
        operation: "confirm",
        id,
        expectedPaymentVersion: 1,
        expectedLedgerVersion: 0,
        reviewedLedgerVersion: 0,
      }),
      "paymentMutate",
    )
  ).status,
  200,
);
assert.equal(reads, 2);
context.payments.push({
  ...voided,
  state: "confirmed",
  version: 2,
  voidedBy: null,
});
const settled = await (await handler(request(), "summary")).json();
assert.equal(settled.includesPayments, true);
assert.equal(settled.summary.PEN.transfers.length, 0);
assert.equal(settled.summary.PEN.totalMinor, "100");
const stale = new PaymentRepository({
  query: async () => {
    throw {
      code: "40001",
      message: "ledger_version_conflict",
      detail: "PRIVATE",
    };
  },
});
await assert.rejects(stale.context(token), (e) => e.code === "STALE_VERSION");
// Receiver-originated receipts require explicit attribution and cannot carry
// forged actor/state metadata. Authorization is enforced in the SQL transaction.
const receive = { ...cmd, operation: "receive", expenseIds: [id] };
validatePaymentCommand(receive);
for (const patch of [
  { expenseIds: undefined },
  { expenseIds: [] },
  { expenseIds: [id, id] },
  { state: "confirmed" },
  { createdBy: link },
  { confirmedBy: link },
  { amountMinor: "0" },
  { expectedLedgerVersion: -1 },
]) {
  assert.throws(
    () => validatePaymentCommand({ ...receive, ...patch }),
    (e) => e.code === "INVALID_INPUT",
  );
}
// Expense-attributed registration never trusts browser allocation amounts.
validatePaymentCommand({ ...cmd, expenseIds: [id] });
for (const expenseIds of [
  [],
  [id, id],
  [id, id.toUpperCase()],
  ["invalid"],
  Array(201).fill(id),
  null,
]) {
  assert.throws(
    () => validatePaymentCommand({ ...cmd, expenseIds }),
    (e) => e.code === "INVALID_INPUT",
  );
}
assert.throws(
  () =>
    validatePaymentCommand({
      ...cmd,
      expenseIds: [id],
      expenseAllocations: [{ expenseId: id, amountMinor: "100" }],
    }),
  (e) => e.code === "INVALID_INPUT",
);
const position = {
  expenseId: id,
  senderId: b,
  receiverId: a,
  currency: "PEN",
  amountMinor: "100",
  confirmedMinor: "40",
  pendingMinor: "20",
  remainingMinor: "60",
  description: "Fixture",
  spentOn: "2026-01-01",
};
const attributedContext = {
  ...context,
  payments: [],
  positions: [position],
  reconciliationRequired: [],
};
assert.deepEqual(parsePaymentContext(attributedContext).positions, [position]);
for (const positions of [
  [{ ...position, remainingMinor: "61" }],
  [{ ...position, pendingMinor: "-1" }],
  [{ ...position, senderId: a }],
  [position, position],
  [{ ...position, expenseId: link }],
]) {
  assert.throws(
    () => parsePaymentContext({ ...attributedContext, positions }),
    (e) => e.code === "UNAVAILABLE",
  );
}
const stalePosition = new PaymentRepository({
  query: async () => {
    throw { code: "40001", message: "payment_positions_conflict" };
  },
});
await assert.rejects(
  stalePosition.context(token),
  (e) => e.code === "STALE_VERSION",
);
console.log(
  "OK: pagos API/SQL parametrizados, contratos monetarios, versiones revisadas, motivo privado, CSRF y resumen con saldo vigente.",
);
