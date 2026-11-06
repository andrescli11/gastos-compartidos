import { expect, test } from "@playwright/test";
const a = "10000000-0000-4000-8000-000000000001",
  b = "10000000-0000-4000-8000-000000000002",
  id = "30000000-0000-4000-8000-000000000001";
const context = {
  role: "participant",
  participantId: a,
  csrfToken: "A".repeat(43),
  participants: [
    { id: a, displayName: "Fixture A" },
    { id: b, displayName: "Fixture B" },
  ],
};
const expense = {
  id,
  payerId: a,
  description: "Cena fixture",
  spentOn: "2026-01-01",
  amountMinor: "1000",
  currency: "PEN",
  source: "manual",
  state: "active",
  version: 1,
  splits: [
    { participantId: a, amountMinor: "500" },
    { participantId: b, amountMinor: "500" },
  ],
};
async function mockSession(page: import("@playwright/test").Page) {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: context }),
  );
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        summary: {
          PEN: {
            totalMinor: "0",
            balances: [],
            transfers: [],
            minimumProven: true,
          },
          USD: {
            totalMinor: "0",
            balances: [],
            transfers: [],
            minimumProven: true,
          },
        },
      },
    }),
  );
}
test("revisión obligatoria, guardado explícito y búsqueda", async ({
  page,
}) => {
  await mockSession(page);
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { expenses: [] } });
    writes++;
    expect(route.request().headers()["x-csrf-token"]).toBe("A".repeat(43));
    expect(route.request().postDataJSON().amountMinor).toBe("1000");
    return route.fulfill({ json: { expense } });
  });
  await page.goto("/gastos/nuevo/individual");
  await expect(
    page.getByText("El viaje todavía no tiene gastos. Registra el primero."),
  ).toBeVisible();
  await page.getByLabel("Descripción", { exact: true }).fill("Cena fixture");
  await page.getByLabel("Importe", { exact: true }).fill("10.00");
  await page.getByLabel("Fixture A", { exact: true }).check();
  await page.getByLabel("Fixture B", { exact: true }).check();
  await page.getByRole("button", { name: "Revisar antes de guardar" }).click();
  expect(writes).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Confirmar gasto" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.getByLabel("Buscar", { exact: true }).fill("sin coincidencia");
  await expect(
    page.getByText("No hay gastos con estos filtros."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("un resultado incierto mantiene la clave incluso tras un 429", async ({
  page,
}) => {
  await mockSession(page);
  const keys: string[] = [];
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { expenses: [] } });
    keys.push(route.request().headers()["idempotency-key"]);
    writes++;
    if (writes === 1)
      return route.fulfill({ status: 503, json: { error: "No disponible" } });
    if (writes === 2)
      return route.fulfill({ status: 429, json: { error: "Límite" } });
    return route.fulfill({ json: { expense } });
  });
  await page.goto("/gastos/nuevo/individual");
  await page.getByLabel("Descripción", { exact: true }).fill("Cena fixture");
  await page.getByLabel("Importe", { exact: true }).fill("10.00");
  await page.getByLabel("Fixture A", { exact: true }).check();
  await page.getByLabel("Fixture B", { exact: true }).check();
  await page.getByRole("button", { name: "Revisar antes de guardar" }).click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Volver", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(page.getByText("Límite", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Volver", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cena fixture" }),
  ).toBeVisible();
  expect(new Set(keys).size).toBe(1);
});
test("enlace borra fragmento antes del canje y no redirige si es inválido", async ({
  page,
}) => {
  const token = "A".repeat(43);
  await page.route("**/api/access/exchange", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    expect(route.request().postDataJSON()).toEqual({ token });
    await route.fulfill({ status: 401, json: { error: "Enlace no válido" } });
  });
  await page.goto("/entrar#token=" + token);
  await expect(page.getByRole("status")).toContainText(
    "El enlace no es válido",
  );
  expect(new URL(page.url()).hash).toBe("");
});
test("recarga recupera la clave pendiente sin guardar automáticamente", async ({
  page,
}) => {
  await mockSession(page);
  const keys: string[] = [];
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { expenses: [] } });
    writes++;
    keys.push(route.request().headers()["idempotency-key"]);
    return writes === 1
      ? route.fulfill({ status: 503, json: { error: "No disponible" } })
      : route.fulfill({ json: { expense } });
  });
  // Token CSRF sintético con longitud real para el diario cifrado.
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { ...context, csrfToken: "A".repeat(43) } }),
  );
  await page.goto("/gastos/nuevo/individual");
  await page.getByLabel("Descripción", { exact: true }).fill("Cena fixture");
  await page.getByLabel("Importe", { exact: true }).fill("10.00");
  await page.getByLabel("Fixture A", { exact: true }).check();
  await page.getByLabel("Fixture B", { exact: true }).check();
  await page.getByRole("button", { name: "Revisar antes de guardar" }).click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Reintentar la misma operación" }),
  ).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByText("Se recuperó una operación pendiente.", { exact: false }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cena fixture" }),
  ).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
});
test("un primer rechazo inequívoco no deja una operación incierta recuperable", async ({
  page,
}) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { expenses: [] } })
      : route.fulfill({
          status: 400,
          json: { error: "Revisa los datos del gasto." },
        }),
  );
  await page.goto("/gastos/nuevo/individual");
  await page.getByLabel("Descripción", { exact: true }).fill("Cena fixture");
  await page.getByLabel("Importe", { exact: true }).fill("10.00");
  await page.getByLabel("Fixture A", { exact: true }).check();
  await page.getByRole("button", { name: "Revisar antes de guardar" }).click();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByText("Revisa los datos del gasto.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("cusco.pending.v1")),
  ).toBeNull();
  await expect(
    page.getByRole("button", { name: "Volver", exact: true }),
  ).toBeEnabled();
});

test("dashboard reúne los métodos y conserva la consulta sin formulario", async ({
  page,
}) => {
  await mockSession(page);
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({ json: { expenses: [expense] } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Resumen por moneda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cena fixture" }),
  ).toBeVisible();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page
    .getByRole("link", { name: "Ingresar gastos", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "¿Cómo quieres ingresarlos?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /02 \/ REGISTRO MASIVO/ }),
  ).toHaveAttribute("href", "/gastos/nuevo/lote#manual-rows");
  await expect(
    page.getByRole("link", { name: /03 \/ ARCHIVO/ }),
  ).toHaveAttribute("href", "/gastos/nuevo/lote#prepare-data");
  await page.getByRole("link", { name: /01 \/ INDIVIDUAL/ }).click();
  await expect(page.getByLabel("Descripción", { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("dashboard permite editar y anular con revisión explícita", async ({
  page,
}) => {
  await mockSession(page);
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { expenses: [expense] } });
    writes++;
    expect(route.request().postDataJSON().operation).toBe("void");
    return route.fulfill({
      json: { expense: { ...expense, state: "voided" } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveValue(
    expense.description,
  );
  await expect(page.getByLabel("Descripción", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Cancelar edición" }).click();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Anular", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Confirmar anulación" }),
  ).toBeVisible();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByText("Gasto guardado.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cena fixture" })).toHaveCount(
    0,
  );
  expect(writes).toBe(1);
});

test("cambiar de método protege el gasto sin guardar", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [] } }),
  );
  await page.goto("/gastos/nuevo/individual");
  await page.getByLabel("Descripción", { exact: true }).fill("Borrador local");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "Cambiar método de ingreso" }).click();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveValue(
    "Borrador local",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "Cambiar método de ingreso" }).click();
  await expect(
    page.getByRole("heading", { name: "¿Cómo quieres ingresarlos?" }),
  ).toBeVisible();
});

test("lote y archivo comparten la revisión y el enlace anterior sigue funcionando", async ({
  page,
}) => {
  await mockSession(page);
  await page.route("**/api/imports", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.goto("/gastos/nuevo");
  await page.getByRole("link", { name: /02 \/ REGISTRO MASIVO/ }).click();
  await expect(
    page.getByRole("button", { name: "Añadir fila manual" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Cambiar método de ingreso" }).click();
  await page.getByRole("link", { name: /03 \/ ARCHIVO/ }).click();
  await expect(page.getByLabel("Archivo CSV o Excel")).toBeVisible();
  await page.goto("/importar");
  await expect(page).toHaveURL(/\/gastos\/nuevo\/lote$/);
  await expect(
    page.getByRole("heading", { name: "Borradores y resultados privados" }),
  ).toBeVisible();
});

test("tabla en escritorio y tarjetas en móvil conservan reparto y acciones", async ({
  page,
  isMobile,
}) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [expense] } }),
  );
  await page.goto("/gastos");
  const table = page.locator(".expense-table-wrap");
  const cards = page.locator(".expense-mobile");
  if (isMobile) {
    await expect(cards.locator("article")).toBeVisible();
    await expect(table).not.toBeVisible();
  } else {
    await expect(table).toBeVisible();
    await expect(cards).not.toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText([
      "Descripción",
      "Fecha",
      "Pagador",
      "Importe",
      "Origen",
      "Reparto",
      "Acciones",
    ]);
    await expect(table.getByRole("rowheader")).toHaveText("Cena fixture");
  }
  const visible = isMobile ? cards : table;
  await visible.getByText("Ver reparto", { exact: true }).click();
  await expect(visible.getByText("Fixture B", { exact: true })).toBeVisible();
  await visible.getByRole("button", { name: "Editar", exact: true }).click();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveValue(
    "Cena fixture",
  );
  await page
    .getByRole("button", { name: "Cancelar edición", exact: true })
    .click();
  await expect(page.getByLabel("Descripción", { exact: true })).toHaveCount(0);
});
