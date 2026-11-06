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
test("batch draft is private and creates expenses only after explicit version confirmation", async ({
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
  await page
    .getByRole("button", { name: "Guardar borrador privado", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Borrador privado guardado" }),
  ).toBeVisible();
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
  await page
    .getByRole("button", { name: "Revisar gastos", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Confirma tus gastos", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Confirmar gastos",
      exact: true,
    }),
  ).toBeDisabled();
  expect(commands.map((c) => c.operation)).toEqual(["create", "save"]);
  await page
    .getByLabel("Confirmo registrar estos gastos revisados.", { exact: true })
    .check();
  await page
    .getByRole("button", {
      name: "Confirmar gastos",
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
    page.getByLabel("Pagador gasto 1", { exact: true }),
  ).not.toBeVisible();
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
  await page
    .getByRole("button", { name: "Revisar gastos", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Confirma tus gastos", exact: true }),
  ).toBeVisible();
  expect(current.rows).toHaveLength(2);
  expect(current.rows.every((row) => row.selected && row.reviewed)).toBe(true);
  expect(commands.map((command) => command.operation)).toEqual(["create"]);
  await page
    .getByLabel("Confirmo registrar estos gastos revisados.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Confirmar gastos", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Revisar gastos", exact: true })
    .click();
  await page
    .getByLabel("Confirmo registrar estos gastos revisados.", { exact: true })
    .check();
  await page
    .getByRole("button", {
      name: "Confirmar gastos",
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
  await page
    .getByRole("button", { name: "Revisar gastos", exact: true })
    .click();
  await expect(
    page.getByLabel("He revisado gasto 1", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Confirma tus gastos", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Revisar gastos", exact: true }),
  ).toBeDisabled();
  expect(operations).toEqual(["create"]);
  await page.getByLabel("He revisado gasto 1", { exact: true }).check();
  await page
    .getByRole("button", { name: "Revisar gastos", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Confirma tus gastos", exact: true }),
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
  const current = draft([row]);
  await page.route("**/api/session", (r) => r.fulfill({ json: session }));
  await page.route("**/api/imports**", (r) =>
    r.fulfill({
      json: r.request().url().includes("?id=")
        ? { job: current }
        : { jobs: [current] },
    }),
  );
  await page.goto("/gastos/nuevo");
  await page.getByText("Recuperar borradores", { exact: true }).click();
  await page.getByRole("button", { name: /Abrir manual/ }).click();
  await expect(
    page.getByRole("button", { name: "Revisar gastos", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Mantener ambos en gasto 1", { exact: true }).check();
  await page.getByLabel("He revisado gasto 1", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Revisar gastos", exact: true }),
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
    page.getByRole("button", { name: "Revisar gastos", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Pagador gasto 1", { exact: true }),
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
