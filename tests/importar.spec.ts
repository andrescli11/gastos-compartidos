import { expect, test, type Page } from "@playwright/test";
import type { ImportJob, ImportRow } from "../src/server/import-contract";
const session = {
  role: "participant",
  participantId: "a",
  participants: [
    { id: "a", displayName: "Ana" },
    { id: "b", displayName: "Bruno" },
  ],
  csrfToken: "A".repeat(43),
};
const jobId = "10000000-0000-4000-8000-000000000001";
function draft(rows: ImportRow[], version = 1): ImportJob {
  return {
    id: jobId,
    version,
    state: "preview",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-08T00:00:00Z",
    sourceType: "manual",
    rows,
    results: [],
  };
}
async function fillRow(page: Page, index = 1) {
  await page
    .getByLabel(`Descripción gasto ${index}`, { exact: true })
    .fill(index === 1 ? "Cena" : "Taxi");
  await page
    .getByLabel(`Fecha gasto ${index}`, { exact: true })
    .fill("2026-01-02");
  await page
    .getByLabel(`Importe gasto ${index}`, { exact: true })
    .fill("10.01");
}
test("Agregar abre el modal y solo Confirmar registra gastos; cancelar conserva el formulario", async ({
  page,
}) => {
  let current = draft([]);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: r.request().url().includes("?id=")
          ? { job: current }
          : { jobs: [] },
      });
    const command = r.request().postDataJSON();
    commands.push(command);
    if (command.operation === "create") current = draft(command.rows);
    else if (command.operation === "save")
      current = draft(command.rows, current.version + 1);
    else if (command.operation === "confirm")
      current = {
        ...current,
        state: "persisted",
        version: current.version + 1,
        results: current.rows
          .filter((row) => row.selected)
          .map((row) => ({
            rowId: row.id,
            status: "persisted",
            expenseId: "20000000-0000-4000-8000-000000000001",
          })),
      };
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  for (const obsolete of [
    "Guardar borrador privado",
    "Recuperar borradores",
    "Descartar cambios locales y recargar borrador",
  ]) {
    await expect(page.getByText(obsolete, { exact: true })).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  const modal = page.getByRole("dialog", {
    name: "Confirmar gasto",
    exact: true,
  });
  await expect(modal).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "Confirmar gasto", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Descripción gasto 1", { exact: true }),
  ).toBeDisabled();
  await expect(modal).toContainText("Cena");
  await expect(modal).toContainText("10.01");
  expect(commands.map((c) => c.operation)).toEqual(["create"]);
  await modal.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Agregar", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByLabel("Descripción gasto 1", { exact: true }),
  ).toHaveValue("Cena");
  expect(commands.map((c) => c.operation)).toEqual(["create"]);
  expect(current.rows[0]).toMatchObject({
    payerId: "a",
    amountMinor: "1001",
    selected: true,
    splits: [
      { participantId: "a", amountMinor: "501" },
      { participantId: "b", amountMinor: "500" },
    ],
  });
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Confirmar",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Confirmo registrar estos gastos revisados.", {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(commands.map((c) => c.operation)).toEqual(["create", "save"]);
  await page
    .getByRole("button", {
      name: "Confirmar",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Gastos guardados." }),
  ).toBeVisible();
  expect(commands[2]).toEqual({
    operation: "confirm",
    id: jobId,
    expectedVersion: 2,
  });
  await expect(
    page.getByLabel("Pagado por gasto 1", { exact: true }),
  ).not.toBeVisible();
});
test("el reparto personalizado valida cada céntimo y descarta importes anteriores al volver al equitativo", async ({
  page,
}) => {
  let current = draft([]);
  const commands: { operation: string; rows?: ImportRow[] }[] = [];
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { jobs: [] } });
    const command = r.request().postDataJSON();
    commands.push(command);
    current = draft(
      command.rows,
      current.rows.length ? current.version + 1 : 1,
    );
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  const type = page.getByLabel("Tipo de reparto gasto 1", { exact: true });
  const ana = page.getByLabel("Parte de Ana gasto 1", { exact: true });
  const bruno = page.getByLabel("Parte de Bruno gasto 1", { exact: true });
  const review = page.getByRole("button", {
    name: "Agregar",
    exact: true,
  });
  await expect(type).toHaveValue("equal");
  await expect(ana).toHaveValue("5.01");
  await expect(bruno).toHaveValue("5.00");
  await expect(ana).toHaveAttribute("readonly", "");
  await type.selectOption("custom");
  await expect(ana).toBeEditable();
  await ana.fill("4.00");
  await bruno.fill("6.00");
  await expect(review).toBeDisabled();
  await bruno.fill("6.02");
  await expect(review).toBeDisabled();
  await bruno.fill("6.001");
  await expect(review).toBeDisabled();
  await bruno.fill("-6.01");
  await expect(review).toBeDisabled();
  expect(commands).toHaveLength(0);
  await bruno.fill("6.01");
  await expect(review).toBeEnabled();
  await review.click();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toBeVisible();
  expect(commands[0].rows?.[0]).toMatchObject({
    amountMinor: "1001",
    splits: [
      { participantId: "a", amountMinor: "400" },
      { participantId: "b", amountMinor: "601" },
    ],
  });
  await page
    .getByRole("dialog", { name: /^Confirmar gastos?$/ })
    .getByRole("button", { name: "Cancelar", exact: true })
    .click();
  await type.selectOption("equal");
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toHaveCount(0);
  await expect(ana).toHaveValue("5.01");
  await expect(bruno).toHaveValue("5.00");
  await expect(ana).toHaveAttribute("readonly", "");
  await type.selectOption("custom");
  await expect(ana).toHaveValue("5.01");
  await expect(bruno).toHaveValue("5.00");
  await review.click();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toBeVisible();
  expect(commands[1].rows?.[0].splits).toEqual([
    { participantId: "a", amountMinor: "501" },
    { participantId: "b", amountMinor: "500" },
  ]);
  expect(commands.map((command) => command.operation)).toEqual([
    "create",
    "save",
  ]);
});

test("repartir entre permite elegir participantes o seleccionarlos a todos", async ({
  page,
}) => {
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) =>
    r.fulfill({ json: { jobs: [] } }),
  );
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page.getByLabel("Repartir entre gasto 1", { exact: true }).click();
  await page.getByLabel("Bruno en gasto 1", { exact: true }).uncheck();
  await expect(
    page.getByLabel("Parte de Ana gasto 1", { exact: true }),
  ).toHaveValue("10.01");
  await page.getByLabel("Seleccionar todos gasto 1", { exact: true }).check();
  await expect(
    page.getByLabel("Bruno en gasto 1", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByLabel("Parte de Ana gasto 1", { exact: true }),
  ).toHaveValue("5.01");
  await expect(
    page.getByLabel("Parte de Bruno gasto 1", { exact: true }),
  ).toHaveValue("5.00");
});
test("un mismo flujo permite añadir, quitar y confirmar dos gastos", async ({
  page,
}) => {
  let current = draft([]);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { jobs: [] } });
    const command = r.request().postDataJSON();
    commands.push(command);
    if (command.operation === "create") current = draft(command.rows);
    if (command.operation === "confirm")
      current = {
        ...current,
        state: "persisted",
        version: 2,
        results: current.rows.map((row, i) => ({
          rowId: row.id,
          status: "persisted",
          expenseId: `20000000-0000-4000-8000-00000000000${i + 1}`,
        })),
      };
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page
    .getByRole("button", { name: "Añadir otro gasto", exact: true })
    .click();
  await fillRow(page, 2);
  await page
    .getByRole("button", { name: "Quitar gasto 2", exact: true })
    .click();
  await expect(
    page.getByLabel("Descripción gasto 2", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Añadir otro gasto", exact: true })
    .click();
  await fillRow(page, 2);
  expect(commands).toHaveLength(0);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toBeVisible();
  expect(current.rows).toHaveLength(2);
  expect(current.rows.every((row) => row.selected && row.reviewed)).toBe(true);
  expect(commands.map((command) => command.operation)).toEqual(["create"]);
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Gastos guardados." }),
  ).toBeVisible();
  expect(commands[1]).toEqual({
    operation: "confirm",
    id: jobId,
    expectedVersion: 1,
  });
  expect(current.results).toHaveLength(2);
});
test("uncertain confirmation is recovered after reload with the same key and command", async ({
  page,
}) => {
  let current = draft([]);
  const attempts: { key: string; body: unknown }[] = [];
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({
        json: r.request().url().includes("?id=")
          ? { job: current }
          : { jobs: [current] },
      });
    const body = r.request().postDataJSON();
    if (body.operation === "create") current = draft(body.rows);
    else if (body.operation === "save")
      current = draft(body.rows, current.version + 1);
    else if (body.operation === "confirm") {
      attempts.push({ key: r.request().headers()["idempotency-key"], body });
      if (attempts.length === 1)
        return r.fulfill({ status: 503, json: { error: "Temporal" } });
      current = {
        ...current,
        state: "persisted",
        version: current.version + 1,
        results: current.rows.map((row) => ({
          rowId: row.id,
          status: "persisted",
          expenseId: "20000000-0000-4000-8000-000000000001",
        })),
      };
    }
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Confirmar",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Reintentar la misma confirmación",
      exact: true,
    }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("button", {
      name: "Reintentar la misma confirmación",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Gastos guardados." }),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});
test("una advertencia nueva del servidor exige revisión antes de confirmar", async ({
  page,
}) => {
  let current = draft([]);
  const operations: string[] = [];
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: { jobs: [] } });
    const command = r.request().postDataJSON();
    operations.push(command.operation);
    current =
      command.operation === "create"
        ? draft(
            command.rows.map((row: ImportRow) => ({
              ...row,
              warnings: ["NON_EXPENSE_MOVEMENT"],
              reviewed: false,
            })),
          )
        : draft(command.rows, current.version + 1);
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(
    page.getByLabel("He revisado gasto 1", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Agregar", exact: true }),
  ).toBeDisabled();
  expect(operations).toEqual(["create"]);
  await page.getByLabel("He revisado gasto 1", { exact: true }).check();
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: /^Confirmar gastos?$/ }),
  ).toBeVisible();
  expect(operations).toEqual(["create", "save"]);
});
test("editing a duplicate row invalidates review and the keep-both decision", async ({
  page,
}) => {
  const row: ImportRow = {
    id: "30000000-0000-4000-8000-000000000001",
    description: "Cena",
    spentOn: "2026-01-02",
    amountMinor: "1001",
    currency: "PEN",
    payerId: "a",
    splits: [{ participantId: "a", amountMinor: "1001" }],
    selected: true,
    reviewed: false,
    keepBoth: false,
    evidence: "Cena",
    sourceRow: 1,
    warnings: ["NON_EXPENSE_MOVEMENT"],
    duplicateExpenseIds: ["40000000-0000-4000-8000-000000000001"],
  };
  let current = draft([row]);
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) => {
    const command = r.request().postDataJSON();
    current = draft(
      command.rows.map((candidate: ImportRow) => ({
        ...candidate,
        reviewed: false,
        keepBoth: false,
        warnings: row.warnings,
        duplicateExpenseIds: row.duplicateExpenseIds,
      })),
      1,
    );
    return r.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Agregar", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Mantener ambos en gasto 1", { exact: true }).check();
  await page.getByLabel("He revisado gasto 1", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Agregar", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Descripción gasto 1", { exact: true })
    .fill("Cena corregida");
  await expect(
    page.getByLabel("Mantener ambos en gasto 1", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("He revisado gasto 1", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Agregar", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Pagado por gasto 1", { exact: true }),
  ).toBeDisabled();
});

test("template download and Spanish tabular headers never auto-save", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) => {
    if (r.request().method() !== "GET") writes++;
    return r.fulfill({ json: { jobs: [] } });
  });
  await page.goto("/gastos/nuevo");
  await page.getByText("¿Prefieres usar Excel?", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Descargar plantilla Excel", exact: true }),
  ).toHaveAttribute("href", "/api/imports/template");
  await page
    .getByLabel("Pegar tabla con encabezados")
    .fill("descripción\tfecha\timporte\tmoneda\nCena\t2026-10-30\t12.01\tPEN");
  await page
    .getByRole("button", { name: "Preparar datos pegados", exact: true })
    .click();
  await expect(
    page.getByLabel("Descripción gasto 1", { exact: true }),
  ).toHaveValue("Cena");
  await expect(page.getByLabel("Importe gasto 1", { exact: true })).toHaveValue(
    "12.01",
  );
  await expect(
    page.getByLabel("He revisado gasto 1", { exact: true }),
  ).not.toBeChecked();
  expect(writes).toBe(0);
});

test("cancelar el registro cancela el snapshot preparado y vuelve al dashboard", async ({
  page,
}) => {
  let current = draft([]);
  const commands: string[] = [];
  let listReads = 0;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/imports**", (route) => {
    if (route.request().method() === "GET") {
      listReads++;
      return route.fulfill({ json: { jobs: [] } });
    }
    const command = route.request().postDataJSON();
    commands.push(command.operation);
    current =
      command.operation === "create"
        ? draft(command.rows)
        : { ...current, state: "cancelled", version: current.version + 1 };
    return route.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Confirmar gasto", exact: true })
    .getByRole("button", { name: "Cancelar", exact: true })
    .click();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page).toHaveURL("/");
  expect(commands).toEqual(["create", "cancel"]);
  expect(listReads).toBe(0);
});

test("un resultado parcial permite corregir y confirmar únicamente el gasto fallido", async ({
  page,
}) => {
  let current = draft([]);
  const confirmations: { operation: string; expectedVersion: number }[] = [];
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/imports**", (route) => {
    const command = route.request().postDataJSON();
    if (command.operation === "create") current = draft(command.rows);
    else if (command.operation === "save")
      current = {
        ...current,
        version: current.version + 1,
        rows: command.rows,
      };
    else if (command.operation === "confirm") {
      confirmations.push(command);
      current =
        confirmations.length === 1
          ? {
              ...current,
              version: current.version + 1,
              rows: current.rows.map((row, index) =>
                index === 0
                  ? { ...row, selected: false, reviewed: false }
                  : row,
              ),
              results: [
                {
                  rowId: current.rows[0].id,
                  status: "persisted",
                  expenseId: "20000000-0000-4000-8000-000000000001",
                },
                {
                  rowId: current.rows[1].id,
                  status: "failed",
                  code: "CONFLICT",
                },
              ],
            }
          : {
              ...current,
              version: current.version + 1,
              state: "persisted",
              results: current.rows.map((row, index) => ({
                rowId: row.id,
                status: "persisted",
                expenseId: `20000000-0000-4000-8000-00000000000${index + 1}`,
              })),
            };
    }
    return route.fulfill({ json: { job: current } });
  });
  await page.goto("/gastos/nuevo");
  await fillRow(page);
  await page
    .getByRole("button", { name: "Añadir otro gasto", exact: true })
    .click();
  await fillRow(page, 2);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Confirmar gastos", exact: true })
    .getByRole("button", { name: "Confirmar", exact: true })
    .click();
  await page
    .getByLabel("Descripción gasto 2", { exact: true })
    .fill("Taxi corregido");
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  const modal = page.getByRole("dialog", {
    name: "Confirmar gasto",
    exact: true,
  });
  await expect(modal).toContainText("Taxi corregido");
  await expect(modal).not.toContainText("Cena");
  await modal.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Gastos guardados." }),
  ).toBeVisible();
  expect(confirmations.map((command) => command.expectedVersion)).toEqual([
    1, 3,
  ]);
  expect(
    current.results.filter((result) => result.status === "persisted"),
  ).toHaveLength(2);
});
