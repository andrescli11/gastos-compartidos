import assert from "node:assert/strict";
import {
  rememberPending,
  recoverPending,
  forgetPending,
} from "../src/domain/pending-operation.ts";
const map = new Map();
const storage = {
  getItem: (k) => map.get(k) ?? null,
  setItem: (k, v) => map.set(k, v),
  removeItem: (k) => map.delete(k),
};
const command = {
  operation: "create",
  payerId: "10000000-0000-4000-8000-000000000001",
  description: "PRIVATE fixture cena",
  spentOn: "2026-01-01",
  amountMinor: "100",
  currency: "PEN",
  splits: [
    {
      participantId: "10000000-0000-4000-8000-000000000001",
      amountMinor: "100",
    },
  ],
};
const value = { key: crypto.randomUUID(), command },
  csrf = "A".repeat(43);
assert.equal(await recoverPending(csrf, storage), null);
await rememberPending(value, csrf, storage);
assert.ok(![...map.values()][0].includes("PRIVATE"));
assert.ok(![...map.values()][0].includes(value.key));
assert.deepEqual(await recoverPending(csrf, storage), value);
assert.deepEqual(await recoverPending(csrf, storage), value);
assert.equal(await recoverPending("B".repeat(43), storage), null);
assert.equal(map.size, 0);
await rememberPending(value, csrf, storage);
const [key, saved] = [...map.entries()][0],
  envelope = JSON.parse(saved);
envelope.ciphertext = "A" + envelope.ciphertext.slice(1);
map.set(key, JSON.stringify(envelope));
assert.equal(await recoverPending(csrf, storage), null);
await rememberPending(value, csrf, storage);
forgetPending(storage);
assert.equal(map.size, 0);
await assert.rejects(
  rememberPending(value, csrf, {
    ...storage,
    setItem: () => {
      throw new Error("Storage disabled");
    },
  }),
);
console.log(
  "OK: operación pendiente recuperable con la misma clave, cifrada por sesión y rechazada al alterar datos o cambiar sesión.",
);

await rememberPending(
  {
    key: value.key,
    command: {
      operation: "register",
      senderId: "a",
      receiverId: "b",
      amountMinor: "1",
      currency: "PEN",
      expectedLedgerVersion: 0,
    },
  },
  csrf,
  storage,
  "payments",
);
assert.equal(await recoverPending(csrf, storage), null);
assert.equal(
  (await recoverPending(csrf, storage, "payments")).command.operation,
  "register",
);
forgetPending(storage, "payments");

const importPending = {
  key: crypto.randomUUID(),
  command: {
    operation: "confirm",
    id: crypto.randomUUID(),
    expectedVersion: 4,
  },
};
await rememberPending(importPending, csrf, storage, "imports");
assert.deepEqual(await recoverPending(csrf, storage, "imports"), importPending);
assert.equal(await recoverPending(csrf, storage, "payments"), null);
assert.equal(await recoverPending(csrf, storage), null);
assert.ok(
  ![...map.values()].some((value) => value.includes(importPending.command.id)),
);
forgetPending(storage, "imports");
assert.equal(await recoverPending(csrf, storage, "imports"), null);

const accessPending = {
  key: crypto.randomUUID(),
  command: { operation: "revoke", linkId: crypto.randomUUID() },
};
await rememberPending(accessPending, csrf, storage, "access");
assert.deepEqual(await recoverPending(csrf, storage, "access"), accessPending);
assert.equal(await recoverPending(csrf, storage, "imports"), null);
forgetPending(storage, "access");
