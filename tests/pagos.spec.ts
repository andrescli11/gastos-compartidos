import { test, expect } from "@playwright/test";
const session = {
  role: "participant",
  participantId: "a",
  participants: [
    { id: "a", displayName: "Ana" },
    { id: "b", displayName: "Bruno" },
  ],
  csrfToken: "A".repeat(43),
};
const book = {
  totalMinor: "1000",
  balances: [
    { participantId: "a", amountMinor: "-1000" },
    { participantId: "b", amountMinor: "1000" },
  ],
  transfers: [
    { senderId: "a", receiverId: "b", amountMinor: "1000", currency: "PEN" },
  ],
  minimumProven: true,
};
const snapshot = {
  context: {
    actor: { id: "actor", role: "participant", participantId: "a" },
    ledgerVersion: 1,
    configuration: { mode: "separate" },
    configurationChosenBy: "admin",
    participants: ["a", "b"],
    expenses: [],
    payments: [],
  },
  summary: {
    ledgerVersion: 1,
    configurationChosen: true,
    configuration: { mode: "separate" },
    originalExpenseTotals: { PEN: "1000", USD: "0" },
    pendingCount: 0,
    confirmedCount: 0,
    configurationLocked: false,
    closed: false,
    books: {
      PEN: book,
      USD: {
        totalMinor: "0",
        balances: [],
        transfers: [],
        minimumProven: true,
      },
    },
  },
  warnings: [],
};
test("requires review and retries an uncertain payment with the same key", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  const requests: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/payments", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: snapshot });
    requests.push({
      key: r.request().headers()["idempotency-key"],
      body: r.request().postDataJSON(),
    });
    return r.fulfill(
      requests.length === 1
        ? { status: 503, json: { error: "Temporal" } }
        : { json: { context: snapshot.context } },
    );
  });
  await page.goto("/pagos");
  await page.getByLabel("Receptor", { exact: true }).selectOption("b");
  await page.getByLabel("Importe", { exact: true }).fill("2.50");
  await page.getByRole("button", { name: "Revisar pago", exact: true }).click();
  expect(requests).toHaveLength(0);
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reintentar la misma operación" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(page.getByRole("status")).toHaveText("Operación registrada.");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body).toMatchObject({
    operation: "register",
    amountMinor: "250",
    senderId: "a",
    receiverId: "b",
    expectedLedgerVersion: 1,
  });
});
test("a known first conflict clears review and participant cannot configure", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/payments", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: snapshot })
      : r.fulfill({ status: 409, json: { error: "Actualiza el libro." } }),
  );
  await page.goto("/pagos");
  await expect(page.getByLabel("Receptor", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Configuración de liquidación" }),
  ).toHaveCount(0);
  await page.getByLabel("Receptor", { exact: true }).selectOption("b");
  await page.getByLabel("Importe", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Revisar pago", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /^Actualiza el libro\.$/ }),
  ).toHaveText("Actualiza el libro.");
  await expect(
    page.getByRole("button", { name: "Revisar pago", exact: true }),
  ).toBeEnabled();
});
test("receiver must acknowledge current-ledger warnings before confirmation", async ({
  page,
}) => {
  await page.route("**/api/session", (r) =>
    r.fulfill({ json: { ...session, participantId: "b" } }),
  );
  let posts = 0;
  const payment = {
    id: "payment-1",
    senderId: "a",
    receiverId: "b",
    amountMinor: "1200",
    currency: "PEN",
    state: "pending",
    version: 2,
    createdBy: "actor",
    confirmedBy: null,
    rejectedBy: null,
    voidedBy: null,
    voidReason: null,
  };
  await page.route("**/api/payments", (r) => {
    if (r.request().method() === "POST") {
      posts++;
      expect(r.request().postDataJSON()).toMatchObject({
        operation: "confirm",
        expectedPaymentVersion: 2,
        expectedLedgerVersion: 1,
        reviewedLedgerVersion: 1,
      });
      return r.fulfill({ json: {} });
    }
    return r.fulfill({
      json: {
        ...snapshot,
        context: { ...snapshot.context, payments: [payment] },
        warnings: [{ paymentId: "payment-1", codes: ["EXCEEDS_NET_DEBT"] }],
      },
    });
  });
  await page.goto("/pagos");
  await page.getByRole("button", { name: "Revisar confirmación" }).click();
  const confirm = page.getByRole("button", {
    name: "Confirmar operación",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  expect(posts).toBe(0);
  await expect(
    page.getByText("El pago supera la deuda neta del emisor.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await confirm.click();
  await expect(page.getByRole("status")).toHaveText("Operación registrada.");
  expect(posts).toBe(1);
});
test("a proven stale version resolves prior uncertainty and loads a fresh ledger", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  const keys: string[] = [];
  let gets = 0;
  await page.route("**/api/payments", (r) => {
    if (r.request().method() === "GET") {
      gets++;
      return r.fulfill({
        json: {
          ...snapshot,
          context: { ...snapshot.context, ledgerVersion: gets === 1 ? 1 : 2 },
        },
      });
    }
    keys.push(r.request().headers()["idempotency-key"]);
    return r.fulfill(
      keys.length === 1
        ? { status: 503, json: { error: "Temporal" } }
        : {
            status: 409,
            json: { error: "El libro cambió.", code: "STALE_VERSION" },
          },
    );
  });
  await page.goto("/pagos");
  await page.getByLabel("Receptor", { exact: true }).selectOption("b");
  await page.getByLabel("Importe", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Revisar pago", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Libro vigente · versión 2" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revisar pago", exact: true }),
  ).toBeEnabled();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("cusco.pending.payments.v1"),
    ),
  ).toBeNull();
});
test("a generic conflict cannot abandon an uncertain payment", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  let posts = 0;
  await page.route("**/api/payments", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: snapshot });
    posts++;
    return r.fulfill(
      posts === 1
        ? { status: 503, json: { error: "Temporal" } }
        : { status: 409, json: { error: "Conflicto" } },
    );
  });
  await page.goto("/pagos");
  await page.getByLabel("Receptor", { exact: true }).selectOption("b");
  await page.getByLabel("Importe", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Revisar pago", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(
    page.getByRole("button", { name: "Reintentar la misma operación" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Revisar pago", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("cusco.pending.payments.v1"),
    ),
  ).not.toBeNull();
});
