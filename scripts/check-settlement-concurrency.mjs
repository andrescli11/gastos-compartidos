import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
if (
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CUSCO_DB_TEST_DISPOSABLE !== "yes" ||
  process.env.PGDATABASE !== "cusco_test" ||
  !["127.0.0.1", "localhost", "::1", "[::1]"].includes(process.env.PGHOST ?? "")
)
  throw new Error("Only the disposable loopback CI database is accepted.");
const run = (statement) =>
  new Promise((resolve) => {
    const process = spawn(
      "psql",
      ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    process.stdout.on("data", (chunk) => (output += chunk));
    process.stderr.resume();
    process.on("error", () => resolve({ ok: false, output: "" }));
    process.on("close", (code) =>
      resolve({ ok: code === 0, output: output.trim() }),
    );
  });
const trip = "00000000-0000-4000-8000-000000000001";
const a = randomUUID(),
  b = randomUUID();
const actorA = randomUUID(),
  actorB = randomUUID(),
  admin = randomUUID();
const hashA = randomBytes(32).toString("hex"),
  hashB = randomBytes(32).toString("hex"),
  hashAdmin = randomBytes(32).toString("hex");
const json = (value) =>
  "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
const invoke = (hash, key, command) =>
  `begin;set local role cusco_bff;select app_api.mutate_payment('${hash}','${key}',${json(command)});commit;`;
const snapshot = async () => {
  const result = await run(
    `begin;set local role cusco_bff;select app_api.payment_context('${hashAdmin}');commit;`,
  );
  assert.ok(result.ok, "read disposable settlement snapshot");
  return JSON.parse(result.output);
};
assert.ok(
  (
    await run(`begin;
insert into app_private.participants(id,trip_id,display_name) values('${a}','${trip}','Allocation concurrency A'),('${b}','${trip}','Allocation concurrency B');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values('${actorA}','${trip}','${a}','participant','${randomBytes(32).toString("hex")}'),('${actorB}','${trip}','${b}','participant','${randomBytes(32).toString("hex")}'),('${admin}','${trip}',null,'admin','${randomBytes(32).toString("hex")}');
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values('${trip}','${actorA}','${hashA}',1,now()+interval '1 hour'),('${trip}','${actorB}','${hashB}',1,now()+interval '1 hour'),('${trip}','${admin}','${hashAdmin}',1,now()+interval '1 hour');commit;`)
  ).ok,
  "setup isolated allocation concurrency actors",
);
const expenseResult = await run(
  `begin;set local role cusco_bff;select app_api.mutate_expense('${hashAdmin}','${randomUUID()}',${json({ operation: "create", payerId: b, description: "Concurrent attributed expense", spentOn: "2026-01-02", amountMinor: "100", currency: "PEN", splits: [{ participantId: a, amountMinor: "100" }] })});commit;`,
);
assert.ok(expenseResult.ok, "create disposable debt source");
const expense = JSON.parse(expenseResult.output);
let state = await snapshot();
const command = {
  operation: "register",
  senderId: a,
  receiverId: b,
  amountMinor: "100",
  currency: "PEN",
  expectedLedgerVersion: state.ledgerVersion,
  expenseIds: [expense.id],
};
const keys = [randomUUID(), randomUUID()];
const results = await Promise.all(
  keys.map((key) => run(invoke(hashA, key, command))),
);
assert.equal(
  results.filter((result) => result.ok).length,
  1,
  "two distinct commands cannot reserve the same expense share",
);
const winner = results.findIndex((result) => result.ok);
const original = results[winner].output;
state = await snapshot();
const payments = state.payments.filter(
  (payment) => payment.senderId === a && payment.receiverId === b,
);
assert.equal(payments.length, 1);
const payment = payments[0];
assert.deepEqual(payment.expenseAllocations, [
  { expenseId: expense.id, amountMinor: "100" },
]);
assert.equal(
  state.positions.find((position) => position.expenseId === expense.id)
    .pendingMinor,
  "100",
);
const confirmation = {
  operation: "confirm",
  id: payment.id,
  expectedPaymentVersion: 1,
  expectedLedgerVersion: state.ledgerVersion,
  reviewedLedgerVersion: state.ledgerVersion,
};
assert.ok(
  (await run(invoke(hashB, randomUUID(), confirmation))).ok,
  "receiver confirms reserved debt",
);
const replays = await Promise.all([
  run(invoke(hashA, keys[winner], command)),
  run(invoke(hashA, keys[winner], command)),
]);
assert.ok(replays.every((result) => result.ok));
assert.ok(
  replays.every((result) => result.output === original),
  "durable retries preserve original result even after confirmation advanced the ledger",
);
state = await snapshot();
assert.equal(
  state.payments.filter(
    (candidate) => candidate.senderId === a && candidate.receiverId === b,
  ).length,
  1,
);
assert.equal(
  state.positions.find((position) => position.expenseId === expense.id)
    .remainingMinor,
  "0",
);
assert.equal(
  (
    await run(
      `select count(*) from app_private.payment_audit_events where entity_id='${payment.id}' and action='payment.register'`,
    )
  ).output,
  "1",
);
assert.equal(
  (
    await run(
      `select count(*) from app_private.payment_audit_events where entity_id='${payment.id}' and action='payment.confirm'`,
    )
  ).output,
  "1",
);
// Restore the fixture's financial effect so the subsequent HTTP/rollback smoke
// can choose its own configuration without any outstanding fixture payment.
assert.ok(
  (
    await run(
      invoke(hashAdmin, randomUUID(), {
        operation: "void",
        id: payment.id,
        expectedPaymentVersion: 2,
        expectedLedgerVersion: state.ledgerVersion,
        reason: "Disposable concurrency fixture completed",
      }),
    )
  ).ok,
);
console.log(
  "OK: PostgreSQL simultaneous attributed registrations reserve once, with durable retries and one confirmation audit.",
);
