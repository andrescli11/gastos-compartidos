import { test, expect, type Page } from "@playwright/test";
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
    positions: [
      {
        expenseId: "expense-1",
        senderId: "a",
        receiverId: "b",
        currency: "PEN",
        amountMinor: "250",
        confirmedMinor: "0",
        pendingMinor: "0",
        remainingMinor: "250",
        description: "Cena",
        spentOn: "2026-01-01",
      },
      {
        expenseId: "expense-2",
        senderId: "a",
        receiverId: "b",
        currency: "PEN",
        amountMinor: "750",
        confirmedMinor: "0",
        pendingMinor: "0",
        remainingMinor: "750",
        description: "Taxi",
        spentOn: "2026-01-02",
      },
    ],
    reconciliationRequired: [],
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
async function prepareTotal(page: Page) {
  await page
    .getByRole("button", { name: "Saldar total PEN", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Revisa tu pago", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ya realicé el pago", exact: true })
    .click();
}
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
  await prepareTotal(page);
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
  await expect(page.getByRole("status")).toHaveText(
    "Pago registrado. Esperando confirmación del receptor.",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].body).toMatchObject({
    operation: "register",
    amountMinor: "1000",
    expenseIds: ["expense-1", "expense-2"],
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
  await expect(
    page.getByRole("heading", { name: "Liquidar saldos", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Actualizar libro", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Configuración de liquidación" }),
  ).toHaveCount(0);
  await prepareTotal(page);
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /^Actualiza el libro\.$/ }),
  ).toHaveText("Actualiza el libro.");
  await expect(
    page.getByRole("button", { name: "Saldar total PEN", exact: true }),
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
  await expect(page.getByRole("status")).toHaveText(
    "Recepción confirmada. Los saldos se actualizaron.",
  );
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
  await prepareTotal(page);
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Liquidar saldos", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Saldar total PEN", exact: true }),
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
  await prepareTotal(page);
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
    page.getByRole("button", { name: "Saldar total PEN", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("cusco.pending.payments.v1"),
    ),
  ).not.toBeNull();
});

test("una persona reúne el total y permite saldar un gasto sin cambiar de vista", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  const commands: Record<string, unknown>[] = [];
  let pending = false;
  await page.route("**/api/payments", (r) => {
    if (r.request().method() === "POST") {
      commands.push(r.request().postDataJSON());
      pending = true;
      return r.fulfill({ json: {} });
    }
    return r.fulfill({
      json: {
        ...snapshot,
        context: {
          ...snapshot.context,
          ledgerVersion: pending ? 2 : 1,
          positions: snapshot.context.positions.map((position, i) => ({
            ...position,
            pendingMinor: pending && i === 0 ? "250" : "0",
          })),
          payments: pending
            ? [
                {
                  id: "payment-1",
                  senderId: "a",
                  receiverId: "b",
                  amountMinor: "250",
                  currency: "PEN",
                  state: "pending",
                  version: 1,
                  createdBy: "actor",
                  confirmedBy: null,
                  rejectedBy: null,
                  voidedBy: null,
                  voidReason: null,
                  expenseAllocations: [
                    { expenseId: "expense-1", amountMinor: "250" },
                  ],
                },
              ]
            : [],
        },
      },
    });
  });
  await page.goto("/pagos");
  await expect(
    page.getByRole("heading", { name: "Bruno", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Por gasto", exact: true }),
  ).toHaveCount(0);
  await page.getByText("Ver gastos con Bruno", { exact: true }).click();
  const dinner = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Cena", exact: true }) })
    .last();
  await dinner
    .getByRole("button", { name: "Saldar este gasto", exact: true })
    .click();
  expect(commands).toHaveLength(0);
  await page
    .getByRole("button", { name: "Ya realicé el pago", exact: true })
    .click();
  expect(commands).toHaveLength(0);
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Pago registrado. Esperando confirmación del receptor.",
    }),
  ).toBeVisible();
  expect(commands[0]).toMatchObject({
    operation: "register",
    senderId: "a",
    receiverId: "b",
    currency: "PEN",
    amountMinor: "250",
    expenseIds: ["expense-1"],
    expectedLedgerVersion: 1,
  });
  await expect(
    page.getByText("Esperando confirmación", { exact: false }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Saldar total PEN", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Ya realicé el pago", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirmar operación", exact: true })
    .click();
  expect(commands[1]).toMatchObject({
    amountMinor: "750",
    expenseIds: ["expense-2"],
    expectedLedgerVersion: 2,
  });
});

test("un importe reservado no se puede pagar por segunda vez", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/payments", (r) =>
    r.fulfill({
      json: {
        ...snapshot,
        context: {
          ...snapshot.context,
          positions: snapshot.context.positions.map((position) => ({
            ...position,
            pendingMinor: position.remainingMinor,
          })),
        },
      },
    }),
  );
  await page.goto("/pagos");
  await expect(
    page.getByRole("button", { name: "Saldar total PEN", exact: true }),
  ).toBeDisabled();
  await page.getByText("Ver gastos con Bruno", { exact: true }).click();
  const buttons = page.getByRole("button", {
    name: "Saldar este gasto",
    exact: true,
  });
  await expect(buttons).toHaveCount(2);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
});

test("sin deudas muestra un cierre personal y el administrador puede elegir a quién consultar", async ({
  page,
}) => {
  let admin = false;
  await page.route("**/api/session", (r) =>
    r.fulfill({
      json: admin
        ? { ...session, role: "admin", participantId: null }
        : session,
    }),
  );
  await page.route("**/api/payments", (r) =>
    r.fulfill({
      json: { ...snapshot, context: { ...snapshot.context, positions: [] } },
    }),
  );
  await page.goto("/pagos");
  await expect(
    page.getByText("No tienes saldos pendientes de pago", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Participante para liquidar", { exact: true }),
  ).toHaveCount(0);
  admin = true;
  await page.reload();
  await expect(
    page.getByLabel("Participante para liquidar", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revisar configuración", exact: true }),
  ).toHaveCount(0);
});
