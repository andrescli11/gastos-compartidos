import { expect, test, type Page } from "@playwright/test";

const participant = {
  id: "10000000-0000-4000-8000-000000000001",
  displayName: "Fixture participante",
  role: "participant",
};
const administrator = {
  id: "10000000-0000-4000-8000-000000000002",
  displayName: "Administrador",
  role: "admin",
};
const publicUsers = [participant, administrator];
const sessionFor = (user: (typeof publicUsers)[number]) => ({
  role: user.role,
  participantId: user.role === "participant" ? participant.id : null,
  participants: [{ id: participant.id, displayName: participant.displayName }],
  csrfToken: "A".repeat(43),
});
async function mockDashboard(page: Page) {
  await page.route("**/api/expenses", (route) =>
    route.fulfill({ json: { expenses: [] } }),
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
  await page.route("**/api/access/pin/users", (route) =>
    route.fulfill({ json: { users: publicUsers } }),
  );
}
async function browserStorage(page: Page) {
  return page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
}

for (const user of publicUsers) {
  test(`el acceso por PIN conserva ceros iniciales para ${user.role}`, async ({
    page,
  }) => {
    await mockDashboard(page);
    let authenticated = false;
    const attempts: { id: string; pin: string }[] = [];
    await page.route("**/api/session", (route) =>
      authenticated
        ? route.fulfill({ json: sessionFor(user) })
        : route.fulfill({ status: 401, json: { error: "Acceso privado" } }),
    );
    await page.route("**/api/access/pin", (route) => {
      attempts.push(route.request().postDataJSON());
      authenticated = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Ingresa a las cuentas del viaje",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Usuario", { exact: true }).selectOption(user.id);
    const pin = page.getByLabel("PIN de acceso", { exact: true });
    await expect(pin).toHaveAttribute("type", "password");
    await expect(pin).toHaveAttribute("inputmode", "numeric");
    await pin.fill("007");
    expect(await browserStorage(page)).toEqual({ local: {}, session: {} });
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Ingresar gastos", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(attempts).toEqual([{ id: user.id, pin: "007" }]);
    await expect(
      page.getByRole("link", { name: "Administración", exact: true }),
    ).toHaveCount(user.role === "admin" ? 1 : 0);
    expect(JSON.stringify(await browserStorage(page))).not.toContain("007");
  });
}

test("el formulario no envía PIN incompletos ni caracteres ajenos a los tres dígitos", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.route("**/api/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  let posts = 0;
  await page.route("**/api/access/pin", (route) => {
    posts++;
    return route.fulfill({ status: 401, json: {} });
  });
  await page.goto("/");
  const submit = page.getByRole("button", { name: "Ingresar", exact: true });
  await expect(submit).toBeDisabled();
  await page
    .getByLabel("Usuario", { exact: true })
    .selectOption(participant.id);
  const pin = page.getByLabel("PIN de acceso", { exact: true });
  for (const invalid of ["", "0", "07", "0a7"]) {
    await pin.fill(invalid);
    await expect(submit).toBeDisabled();
    await pin.press("Enter");
    expect(posts).toBe(0);
  }
  await pin.fill("007");
  await expect(submit).toBeEnabled();
  expect(posts).toBe(0);
});

test("un PIN incorrecto se limpia y permite reintentar sin bloqueo ni almacenamiento", async ({
  page,
}) => {
  await mockDashboard(page);
  let authenticated = false;
  await page.route("**/api/session", (route) =>
    authenticated
      ? route.fulfill({ json: sessionFor(participant) })
      : route.fulfill({ status: 401, json: {} }),
  );
  let posts = 0;
  await page.route("**/api/access/pin", (route) => {
    posts++;
    authenticated = posts === 5;
    return route.fulfill(
      authenticated
        ? { json: { ok: true } }
        : { status: 401, json: { error: "Invalid credential" } },
    );
  });
  await page.goto("/");
  await page
    .getByLabel("Usuario", { exact: true })
    .selectOption(participant.id);
  const pin = page.getByLabel("PIN de acceso", { exact: true });
  const submit = page.getByRole("button", { name: "Ingresar", exact: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    await pin.fill("008");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("alert")).toHaveText(
      "Usuario o PIN incorrectos.",
    );
    await expect(pin).toHaveValue("");
    await expect(pin).toBeFocused();
    expect(posts).toBe(attempt + 1);
    expect(await browserStorage(page)).toEqual({ local: {}, session: {} });
  }
  await pin.fill("007");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.getByRole("link", { name: "Ingresar gastos", exact: true }),
  ).toBeVisible();
  expect(posts).toBe(5);
});

test("entrar sin fragmento muestra PIN y los enlaces privados conservan su intercambio", async ({
  page,
}) => {
  await mockDashboard(page);
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: sessionFor(participant) }),
  );
  await page.goto("/entrar");
  await expect(page.getByLabel("PIN de acceso", { exact: true })).toBeVisible();
  let exchanged = false;
  const syntheticToken = "T".repeat(43);
  await page.route("**/api/access/exchange", (route) => {
    exchanged = true;
    expect(route.request().postDataJSON()).toEqual({ token: syntheticToken });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/entrar#token=${syntheticToken}`);
  await expect(page).toHaveURL(/\/gastos$/);
  await expect(
    page.getByRole("link", { name: "Ingresar gastos", exact: true }),
  ).toBeVisible();
  expect(exchanged).toBe(true);
  expect(new URL(page.url()).hash).toBe("");
  expect(JSON.stringify(await browserStorage(page))).not.toContain(
    syntheticToken,
  );
});
