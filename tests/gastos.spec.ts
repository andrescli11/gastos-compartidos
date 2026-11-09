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
test("el encabezado reúne identidad y acciones accesibles según el rol", async ({
  page,
  isMobile,
}) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [] } }),
  );
  for (const role of ["participant", "admin"] as const) {
    await page.route("**/api/session", (route) =>
      route.fulfill({
        json: { ...context, role, participantId: role === "admin" ? null : a },
      }),
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Adiós Yacolino", exact: true }),
    ).toBeVisible();
    const header = page.locator("header");
    await expect(
      header.getByRole("link", { name: "Inicio", exact: true }),
    ).toHaveAttribute("href", "/");
    await expect(
      header.getByRole("button", { name: "Cerrar sesión", exact: true }),
    ).toBeVisible();
    const administration = header.getByRole("link", {
      name: "Administración",
      exact: true,
    });
    if (role === "admin") {
      await expect(administration).toBeVisible();
      await expect(administration).toHaveAttribute("href", "/administrar");
    } else {
      await expect(administration).toHaveCount(0);
      await expect(
        header.getByText("Fixture A", { exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("link", { name: "Ingresar gastos", exact: true }),
    ).toHaveAttribute("href", "/gastos/nuevo");
    await expect(
      page.getByRole("link", { name: "Liquidar saldos", exact: true }),
    ).toHaveAttribute("href", "/pagos");
    await expect(
      page.getByRole("link", { name: "Pagos y cierre", exact: true }),
    ).toHaveCount(0);
    const cards = page
      .getByRole("region", { name: "Resumen por moneda", exact: true })
      .locator(".summary-card");
    if (role === "admin") {
      await expect(
        page.getByRole("region", { name: "Resumen por moneda", exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(cards).toHaveCount(2);
      if (isMobile) {
        const first = await cards.nth(0).boundingBox();
        const second = await cards.nth(1).boundingBox();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
        expect(second!.x).toBeGreaterThan(first!.x);
      }
    }
    await expect(
      page.getByRole("region", { name: "Totales del viaje", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.unroute("**/api/session");
  }
});

test("los filtros del home usan una fecha exacta y permiten restaurar todos los gastos", async ({
  page,
}) => {
  await mockSession(page);
  const second = {
    ...expense,
    id: "30000000-0000-4000-8000-000000000002",
    description: "Taxi fixture",
    spentOn: "2026-01-02",
  };
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [expense, second] } }),
  );
  await page.goto("/");
  const filterToggle = page.getByLabel("Buscar y filtrar", { exact: true });
  await expect(page.getByLabel("Buscar", { exact: true })).not.toBeVisible();
  await filterToggle.click();
  await expect(page.getByLabel("Buscar", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Pagador", { exact: true })).toBeVisible();
  const date = page.getByLabel("Fecha", { exact: true });
  await expect(date).toBeVisible();
  for (const obsolete of ["Moneda", "Desde", "Hasta"])
    await expect(page.getByLabel(obsolete, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Taxi fixture", exact: true }),
  ).toBeVisible();
  await date.fill("2026-01-02");
  await expect(filterToggle).toContainText("Filtros activos: 1");
  await filterToggle.click();
  await expect(date).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Taxi fixture", exact: true }),
  ).toBeVisible();
  await filterToggle.click();
  await expect(date).toHaveValue("2026-01-02");
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Taxi fixture", exact: true }),
  ).toBeVisible();
  await date.fill("2026-01-03");
  await expect(
    page.getByText("No hay gastos con estos filtros.", { exact: true }),
  ).toBeVisible();
  await date.fill("");
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Taxi fixture", exact: true }),
  ).toBeVisible();
});

test("edición revisada, guardado explícito y búsqueda", async ({ page }) => {
  await mockSession(page);
  let writes = 0;
  const updated = { ...expense, description: "Cena corregida", version: 2 };
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { expenses: [writes ? updated : expense] },
      });
    writes++;
    expect(route.request().headers()["x-csrf-token"]).toBe(context.csrfToken);
    expect(route.request().postDataJSON()).toMatchObject({
      operation: "update",
      amountMinor: "1000",
      expectedVersion: 1,
    });
    return route.fulfill({ json: { expense: updated } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await page.getByLabel("Descripción", { exact: true }).fill("Cena corregida");
  await page.getByRole("button", { name: "Revisar antes de guardar" }).click();
  expect(writes).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Confirmar cambios" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(
    page.getByText("Gasto guardado.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cena corregida", exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page.getByLabel("Buscar y filtrar", { exact: true }).click();
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
test("edición incierta mantiene la clave incluso tras un 429", async ({
  page,
}) => {
  await mockSession(page);
  const keys: string[] = [];
  let writes = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { expenses: [expense] } });
    keys.push(route.request().headers()["idempotency-key"]);
    expect(route.request().postDataJSON().operation).toBe("update");
    writes++;
    if (writes === 1)
      return route.fulfill({ status: 503, json: { error: "No disponible" } });
    if (writes === 2)
      return route.fulfill({ status: 429, json: { error: "Límite" } });
    return route.fulfill({ json: { expense: { ...expense, version: 2 } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
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
    page.getByText("Gasto guardado.", { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(3);
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
      return route.fulfill({ json: { expenses: [expense] } });
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
  await page.goto("/");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
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
    page.getByText("Gasto guardado.", { exact: true }),
  ).toBeVisible();
  expect(keys[0]).toBe(keys[1]);
});
test("un primer rechazo inequívoco no deja una operación incierta recuperable", async ({
  page,
}) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { expenses: [expense] } })
      : route.fulfill({
          status: 400,
          json: { error: "Revisa los datos del gasto." },
        }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Editar", exact: true }).click();
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

test("home lleva directamente al gasto inicial y no muestra la lista total en el ingreso", async ({
  page,
}) => {
  await mockSession(page);
  let financialWrites = 0;
  await page.route("**/api/expenses", (route) => {
    if (route.request().method() !== "GET") financialWrites++;
    return route.fulfill({ json: { expenses: [expense] } });
  });
  await page.route("**/api/imports", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "Resumen por moneda" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Ingresar gastos", exact: true })
    .click();
  await expect(page).toHaveURL(/\/gastos\/nuevo$/);
  await expect(
    page.getByRole("heading", { name: "Ingresar gastos", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Descripción gasto 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Gastos registrados", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Añadir otro gasto", exact: true }),
  ).toBeVisible();
  expect(financialWrites).toBe(0);
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
  await expect(
    page.getByRole("heading", { name: "Cena fixture", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
});

test("salir del ingreso protege los gastos sin guardar", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/imports", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.goto("/gastos/nuevo");
  await page
    .getByLabel("Descripción gasto 1", { exact: true })
    .fill("Borrador local");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("link", { name: "Volver al dashboard", exact: true })
    .click();
  await expect(
    page.getByLabel("Descripción gasto 1", { exact: true }),
  ).toHaveValue("Borrador local");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("link", { name: "Volver al dashboard", exact: true })
    .click();
  await expect(page).toHaveURL("/");
});

test("enlaces anteriores llevan al ingreso unificado", async ({ page }) => {
  await mockSession(page);
  await page.route("**/api/imports", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  for (const path of [
    "/gastos/nuevo/individual",
    "/gastos/nuevo/lote",
    "/importar",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/gastos\/nuevo$/);
    await expect(
      page.getByLabel("Descripción gasto 1", { exact: true }),
    ).toBeVisible();
  }
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

test("los KPI personales distinguen cobros y deudas sin signos negativos y muestran cero explícito", async ({
  page,
}) => {
  await mockSession(page);
  let personal = { PEN: "1234", USD: "-5678" };
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [expense] } }),
  );
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        summary: {
          PEN: {
            totalMinor: "99999",
            balances: [
              { participantId: a, amountMinor: personal.PEN },
              {
                participantId: b,
                amountMinor: (-BigInt(personal.PEN)).toString(),
              },
            ],
            transfers: [],
            minimumProven: true,
          },
          USD: {
            totalMinor: "88888",
            balances: [
              { participantId: a, amountMinor: personal.USD },
              {
                participantId: b,
                amountMinor: (-BigInt(personal.USD)).toString(),
              },
            ],
            transfers: [],
            minimumProven: true,
          },
        },
      },
    }),
  );
  await page.goto("/");
  const cards = page
    .getByRole("region", { name: "Resumen por moneda", exact: true })
    .locator(".summary-card");
  await expect(cards.nth(0)).toContainText("Te deben");
  await expect(cards.nth(0).locator("strong")).toHaveText("S/ 12.34");
  await expect(cards.nth(1)).toContainText("Debes");
  await expect(cards.nth(1).locator("strong")).toHaveText("US$ 56.78");
  await expect(cards.nth(1)).not.toContainText("-US$");
  personal = { PEN: "0", USD: "0" };
  await page.reload();
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all())
    await expect(card).toContainText("Sin saldo pendiente");
  await expect(cards.nth(0).locator("strong")).toHaveText("S/ 0.00");
  await expect(cards.nth(1).locator("strong")).toHaveText("US$ 0.00");
});

test("los totales del viaje quedan debajo de movimientos y no cambian al filtrar", async ({
  page,
}) => {
  await mockSession(page);
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [expense] } }),
  );
  await page.route("**/api/summary", (route) =>
    route.fulfill({
      json: {
        settlementMode: "consolidated",
        originalExpenseTotals: { PEN: "27000", USD: "66100" },
        summary: {
          PEN: {
            totalMinor: "999999",
            balances: [
              { participantId: a, amountMinor: "17000" },
              { participantId: b, amountMinor: "-17000" },
            ],
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
  await page.goto("/");
  const movements = page.getByRole("region", {
    name: "Gastos registrados",
    exact: true,
  });
  const totals = page.getByRole("region", {
    name: "Totales del viaje",
    exact: true,
  });
  await expect(totals).toContainText("S/ 270.00");
  await expect(totals).toContainText("US$ 661.00");
  const movementBox = await movements.boundingBox();
  const totalBox = await totals.boundingBox();
  expect(movementBox).not.toBeNull();
  expect(totalBox).not.toBeNull();
  expect(totalBox!.y).toBeGreaterThanOrEqual(
    movementBox!.y + movementBox!.height,
  );
  await expect(page.getByLabel("Buscar", { exact: true })).not.toBeVisible();
  await page.getByLabel("Buscar y filtrar", { exact: true }).click();
  await page.getByLabel("Buscar", { exact: true }).fill("sin coincidencia");
  await expect(
    page.getByText("No hay gastos con estos filtros.", { exact: true }),
  ).toBeVisible();
  await expect(totals).toContainText("S/ 270.00");
  await expect(totals).toContainText("US$ 661.00");
});
