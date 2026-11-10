import { expect, test, type Page } from "@playwright/test";
const csrf = "A".repeat(43);
const participant = {
  id: "10000000-0000-4000-8000-000000000001",
  displayName: "Ana",
  role: "participant",
  version: 2,
  pinEnabled: true,
  hasPin: true,
  own: false,
};
const administrator = {
  ...participant,
  id: "10000000-0000-4000-8000-000000000002",
  displayName: "Administrador",
  role: "admin",
  own: true,
};
function snapshot() {
  return { users: [participant, administrator], csrfToken: csrf };
}
async function prepare(page: Page, pin = "007") {
  await page.getByLabel("Nuevo PIN", { exact: true }).fill(pin);
  await page.getByRole("button", { name: "Revisar PIN", exact: true }).click();
}
test("gestión de PIN deniega usuarios sin permiso administrativo", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "POST") writes++;
    return route.fulfill({ status: 403, json: { error: "No permitido" } });
  });
  await page.goto("/administrar/pines");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Solo el administrador puede gestionar los PIN.",
  );
  await expect(page.getByLabel("Nuevo PIN", { exact: true })).toHaveCount(0);
  expect(writes).toBe(0);
});
test("requiere revisión, conserva ceros iniciales y no persiste PIN en el navegador", async ({
  page,
}) => {
  const commands: unknown[] = [];
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    commands.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
    expect(route.request().headers()["idempotency-key"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    return route.fulfill({ json: { ok: true, ownSessionRevoked: false } });
  });
  await page.goto("/administrar/pines");
  await prepare(page, "007");
  expect(commands).toHaveLength(0);
  await expect(
    page.getByRole("region", { name: "Revisión de PIN", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Nuevo PIN", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Confirmar PIN", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("PIN actualizado.");
  expect(commands).toEqual([
    { operation: "set", id: participant.id, expectedVersion: 2, pin: "007" },
  ]);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});
test("un PIN incompleto o no numérico no produce escrituras", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "POST") writes++;
    return route.fulfill({ json: snapshot() });
  });
  await page.goto("/administrar/pines");
  await prepare(page, "07");
  await expect(
    page.getByRole("region", { name: "Revisión de PIN", exact: true }),
  ).toHaveCount(0);
  await prepare(page, "abc");
  await expect(
    page.getByRole("region", { name: "Revisión de PIN", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(0);
});
test("una respuesta incierta conserva clave y payload solo en memoria", async ({
  page,
}) => {
  const attempts: { key: string | undefined; command: unknown }[] = [];
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    attempts.push({
      key: route.request().headers()["idempotency-key"],
      command: route.request().postDataJSON(),
    });
    return attempts.length === 1
      ? route.fulfill({ status: 503, json: { error: "No disponible" } })
      : route.fulfill({ json: { ok: true, ownSessionRevoked: false } });
  });
  await page.goto("/administrar/pines");
  await prepare(page);
  await page
    .getByRole("button", { name: "Confirmar PIN", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Cancelar", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Nuevo PIN", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Usuario", { exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  await page
    .getByRole("button", { name: "Reintentar la misma operación", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("PIN actualizado.");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]);
});
test("cambiar el PIN propio avisa que cerrará la sesión y exige reconocimiento", async ({
  page,
}) => {
  let writes = 0;
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    writes++;
    return route.fulfill({ status: 401, json: { error: "Sesión terminada" } });
  });
  await page.goto("/administrar/pines");
  await page
    .getByLabel("Usuario", { exact: true })
    .selectOption(administrator.id);
  await prepare(page, "000");
  await expect(
    page.getByText("Este cambio cerrará tu sesión actual.", { exact: false }),
  ).toBeVisible();
  const confirm = page.getByRole("button", {
    name: "Confirmar PIN",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  expect(writes).toBe(0);
  await page
    .getByLabel("Entiendo que este cambio cerrará mi sesión.", { exact: true })
    .check();
  await confirm.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "entra con el nuevo PIN o con tu enlace administrativo",
  );
  await expect(page.getByLabel("Nuevo PIN", { exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
});
test("desactivar el PIN requiere confirmación y no envía un código", async ({
  page,
}) => {
  const commands: unknown[] = [];
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: snapshot() });
    commands.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, ownSessionRevoked: false } });
  });
  await page.goto("/administrar/pines");
  await page
    .getByRole("button", { name: "Desactivar PIN", exact: true })
    .click();
  expect(commands).toHaveLength(0);
  await expect(
    page.getByText("El enlace privado seguirá disponible.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirmar desactivación", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("PIN desactivado.");
  expect(commands).toEqual([
    { operation: "disable", id: participant.id, expectedVersion: 2 },
  ]);
});
test("un conflicto conocido descarta la revisión y carga la versión actual", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/access/pin/manage", (route) => {
    if (route.request().method() === "GET") {
      reads++;
      return route.fulfill({ json: snapshot() });
    }
    return route.fulfill({ status: 409, json: { code: "STALE_VERSION" } });
  });
  await page.goto("/administrar/pines");
  await prepare(page);
  await page
    .getByRole("button", { name: "Confirmar PIN", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Revisión de PIN", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "El acceso cambió",
  );
  await expect(page.getByLabel("Nuevo PIN", { exact: true })).toHaveValue("");
  expect(reads).toBe(2);
});
test("un cambio propio confirmado vuelve a la pantalla de acceso", async ({
  page,
}) => {
  await page.route("**/api/access/pin/manage", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: snapshot() })
      : route.fulfill({ json: { ok: true, ownSessionRevoked: true } }),
  );
  await page.goto("/administrar/pines");
  await page
    .getByLabel("Usuario", { exact: true })
    .selectOption(administrator.id);
  await prepare(page, "004");
  await page
    .getByLabel("Entiendo que este cambio cerrará mi sesión.", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Confirmar PIN", exact: true })
    .click();
  await expect(page).toHaveURL("/");
});
