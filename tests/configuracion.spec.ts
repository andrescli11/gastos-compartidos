import { expect, test, type Page } from "@playwright/test";
const csrf = "A".repeat(43);
function snapshot(locked = false, chosen = true) {
  return {
    context: {
      actor: { id: "admin", role: "admin", participantId: null },
      ledgerVersion: 7,
      configuration: { mode: "separate" },
      configurationChosenBy: chosen ? "admin" : null,
      participants: [],
      expenses: [],
      payments: [],
    },
    summary: {
      configurationLocked: locked,
      configurationChosen: chosen,
      pendingCount: locked ? 1 : 0,
      confirmedCount: 0,
    },
  };
}
async function admin(page: Page) {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { role: "admin", csrfToken: csrf } }),
  );
}
test("solo el administrador puede abrir la configuración", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { role: "participant", csrfToken: csrf } }),
  );
  await page.route("**/api/payments", (route) => {
    if (route.request().method() === "POST") writes++;
    return route.fulfill({
      json: {
        ...snapshot(),
        context: {
          ...snapshot().context,
          actor: { role: "participant", participantId: "a" },
        },
      },
    });
  });
  await page.goto("/administrar/liquidacion");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Solo el administrador puede configurar la liquidación.",
  );
  await expect(page.getByLabel("Modo", { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});
test("revisa la tasa exacta y solo guarda después de confirmar", async ({
  page,
}) => {
  const commands: unknown[] = [];
  await admin(page);
  await page.route("**/api/payments", (route) => {
    if (route.request().method() === "POST") {
      commands.push(route.request().postDataJSON());
      expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
      expect(route.request().headers()["idempotency-key"]).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/administrar/liquidacion");
  await page.getByLabel("Modo", { exact: true }).selectOption("consolidated");
  await page.getByLabel("PEN por USD", { exact: true }).fill("3.75");
  await page
    .getByRole("button", { name: "Revisar configuración", exact: true })
    .click();
  expect(commands).toHaveLength(0);
  await expect(
    page.getByRole("region", { name: "Revisión de configuración" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirmar configuración", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Configuración de liquidación guardada.",
  );
  expect(commands).toEqual([
    {
      operation: "configure",
      mode: "consolidated",
      rateNumerator: "375",
      rateDenominator: "100",
      expectedLedgerVersion: 7,
    },
  ]);
});
test("pagos pendientes bloquean cambiar una configuración ya elegida", async ({
  page,
}) => {
  await admin(page);
  await page.route("**/api/payments", (route) =>
    route.fulfill({ json: snapshot(true) }),
  );
  await page.goto("/administrar/liquidacion");
  await expect(page.getByLabel("Modo", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Revisar configuración", exact: true }),
  ).toBeDisabled();
});
test("permite confirmar la elección inicial del modo vigente sin cambiarlo con pendientes", async ({
  page,
}) => {
  await admin(page);
  await page.route("**/api/payments", (route) =>
    route.fulfill({ json: snapshot(true, false) }),
  );
  await page.goto("/administrar/liquidacion");
  await expect(page.getByLabel("Modo", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Revisar configuración", exact: true }),
  ).toBeEnabled();
});
test("reintenta configuración incierta con la misma clave y carga recuperada", async ({
  page,
}) => {
  const attempts: { key: string | undefined; command: unknown }[] = [];
  await admin(page);
  await page.route("**/api/payments", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      command: route.request().postDataJSON(),
    });
    return attempts.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: "synthetic-secret-never-render" },
        })
      : route.fulfill({ json: snapshot() });
  });
  await page.goto("/administrar/liquidacion");
  await page
    .getByRole("button", { name: "Revisar configuración", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirmar configuración", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Reintentar la misma operación",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("synthetic-secret-never-render")).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page
    .getByRole("button", { name: "Reintentar la misma operación", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Configuración de liquidación guardada.",
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});
test("un conflicto de versión exige revisar el libro actualizado", async ({
  page,
}) => {
  let writes = 0;
  await admin(page);
  await page.route("**/api/payments", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    writes++;
    return route.fulfill({ status: 409, json: { code: "STALE_VERSION" } });
  });
  await page.goto("/administrar/liquidacion");
  await page
    .getByRole("button", { name: "Revisar configuración", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirmar configuración", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Los saldos cambiaron",
  );
  await expect(
    page.getByRole("button", { name: "Confirmar configuración", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
});
