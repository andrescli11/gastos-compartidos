import { test, expect } from "@playwright/test";
const id = "10000000-0000-4000-8000-000000000001";
const csrf = "a".repeat(43);
const links = [
  {
    id,
    displayName: "Participante de prueba",
    role: "participant",
    version: 1,
    revoked: false,
    expired: false,
    own: false,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    displayName: "Administrador",
    role: "admin",
    version: 1,
    revoked: false,
    expired: false,
    own: true,
  },
];
test("revisa renovación y recupera misma clave tras respuesta incierta", async ({
  page,
}) => {
  let posts = 0;
  const keys: string[] = [];
  await page.route("**/api/access/links", async (route) => {
    const r = route.request();
    if (r.method() === "GET")
      return route.fulfill({ json: { links, csrfToken: csrf } });
    posts++;
    keys.push(r.headers()["idempotency-key"]);
    expect(r.headers()["x-csrf-token"]).toBe(csrf);
    expect(r.postDataJSON()).toEqual({
      operation: "rotate",
      id,
      expectedVersion: 1,
    });
    if (posts === 1) return route.abort("failed");
    return route.fulfill({
      json: {
        url: "https://example.invalid/entrar#token=synthetic-private-token",
      },
    });
  });
  await page.goto("/administrar");
  await expect(
    page.getByRole("button", { name: "Renovar enlace" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Renovar enlace" }).click();
  expect(posts).toBe(0);
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirmar cambio de acceso" })
    .click();
  await expect(
    page.getByRole("button", { name: "Reintentar la misma operación" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Reintentar la misma operación" }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Reintentar la misma operación" })
    .click();
  await expect(page.getByLabel("Enlace privado", { exact: true })).toHaveValue(
    "https://example.invalid/entrar#token=synthetic-private-token",
  );
  expect(posts).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  await page.getByRole("button", { name: "Ocultar enlace" }).click();
  await expect(page.getByLabel("Enlace privado", { exact: true })).toHaveCount(
    0,
  );
});
test("rechazo de servidor no muestra enlaces a participante", async ({
  page,
}) => {
  await page.route("**/api/access/links", (r) =>
    r.fulfill({ status: 403, json: { error: "Acceso denegado." } }),
  );
  await page.goto("/administrar");
  await expect(page.getByRole("alert")).toContainText(
    "Se requiere un enlace administrativo",
  );
  await expect(
    page.getByRole("button", { name: "Renovar enlace" }),
  ).toHaveCount(0);
});
