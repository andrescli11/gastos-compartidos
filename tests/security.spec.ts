import { expect, test } from "@playwright/test";

test("fresh CSP nonce allows hydration and blocks inline event handlers", async ({
  page,
  request,
}) => {
  const first = await request.get("/");
  const second = await request.get("/");
  const policy = first.headers()["content-security-policy"];
  const nextPolicy = second.headers()["content-security-policy"];
  expect(policy).toContain("script-src-attr 'none'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain(
    "'unsafe-inline'",
  );
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(nextPolicy).not.toContain(`'nonce-${nonce}'`);
  const html = await first.text();
  expect(html).toContain(`nonce="${nonce}"`);

  await page.goto("/simulador");
  await page.getByLabel("Importe total").fill("99.00");
  await expect(
    page.locator(".preview").getByText("S/ 33.00", { exact: true }),
  ).toHaveCount(3);
  const inlineExecuted = await page.evaluate(async () => {
    const button = document.createElement("button");
    button.setAttribute(
      "onclick",
      "document.body.dataset.inlineExecuted='yes'",
    );
    document.body.append(button);
    button.click();
    button.remove();
    return document.body.dataset.inlineExecuted;
  });
  expect(inlineExecuted).toBeUndefined();
});

test("private pages and anonymous APIs do not permit shared caches", async ({
  request,
}) => {
  for (const path of [
    "/",
    "/gastos/nuevo",
    "/gastos/nuevo/individual",
    "/gastos/nuevo/lote",
    "/entrar",
    "/gastos",
    "/pagos",
    "/importar",
    "/api/session",
  ]) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["cache-control"]).toContain("private");
    expect(headers["x-robots-tag"]).toContain("noindex");
  }
});
