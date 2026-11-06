// Production browser verification: session/read/template parsing only, never financial writes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
let browser;
let stage = "configuration";
try {
  const base = process.env.APP_URL;
  assert.equal(process.env.CUSCO_LIVE_READONLY, "yes");
  assert.equal(base, "https://gastos-compartidos-preview.vercel.app");
  assert(/^[A-Za-z0-9_-]{43}$/.test(process.env.CUSCO_ACCESS_TOKEN ?? ""));
  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    stage = "anonymous isolation";
    const anonymous = await context.request.get(base + "/api/session");
    assert.equal(anonymous.status(), 401);
    assert.match(anonymous.headers()["cache-control"], /private.*no-store/);
    stage = "private browser session";
    await page.goto(base + "/entrar#token=" + process.env.CUSCO_ACCESS_TOKEN);
    await page.waitForURL(base + "/gastos");
    await page
      .getByRole("heading", { name: "Todo en orden.", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).hash, "");
    const session = await page.evaluate(async () => {
      const r = await fetch("/api/session", { cache: "no-store" });
      if (!r.ok) throw Error();
      return r.json();
    });
    assert.equal(session.role, "admin");
    assert.equal(session.participants.length, 7);
    stage = "persistent payments and summary";
    await page
      .getByRole("link", { name: "Pagos y cierre", exact: true })
      .click();
    await page.getByLabel("Receptor", { exact: true }).waitFor();
    const sums = await page.evaluate(async () => {
      const r = await fetch("/api/summary", { cache: "no-store" });
      if (!r.ok) throw Error();
      const d = await r.json();
      return ["PEN", "USD"].every(
        (c) =>
          d.summary[c].balances.reduce(
            (n, b) => n + BigInt(b.amountMinor),
            0n,
          ) === 0n,
      );
    });
    assert(sums);
    stage = "private import screen and downloaded template";
    await page.goto(base + "/importar");
    await page
      .getByRole("heading", { name: "Gastos por lote.", exact: true })
      .waitFor();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("link", { name: "Descargar plantilla Excel", exact: true })
        .click(),
    ]);
    assert.equal(download.suggestedFilename(), "plantilla-gastos-cusco.xlsx");
    const filename = await download.path();
    assert(filename);
    stage = "Excel source parsing without persistence";
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/imports/source" &&
        r.request().method() === "POST",
    );
    await page
      .getByLabel("Archivo CSV o Excel", { exact: true })
      .setInputFiles({
        name: download.suggestedFilename(),
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: await readFile(filename),
      });
    const parsed = await response;
    assert.equal(parsed.status(), 200);
    const data = await parsed.json();
    assert(data.sheets.some((s) => s.name === "Gastos"));
    stage = "administration and CSP";
    const navigation = await page.goto(base + "/administrar");
    assert.match(navigation.headers()["content-security-policy"], /'nonce-/);
    assert(
      !navigation
        .headers()
        ["content-security-policy"].includes("'unsafe-eval'"),
    );
    await page
      .getByRole("heading", { name: "Administrar accesos", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Renovar enlace", exact: true })
      .first()
      .waitFor();
    const nonce = await page
      .locator("script[nonce]")
      .first()
      .evaluate((el) => el.nonce);
    assert(nonce.length >= 22);
    stage = "logout only this verification session";
    const status = await page.evaluate(
      async (csrf) =>
        (
          await fetch("/api/access/logout", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
            },
            body: "{}",
          })
        ).status,
      session.csrfToken,
    );
    assert.equal(status, 200);
    const denied = await context.request.get(base + "/api/session");
    assert.equal(denied.status(), 401);
    await context.close();
  }
  console.log(
    "Live HTTPS browser verification passed on desktop and mobile; no financial writes.",
  );
} catch {
  console.error(
    `Live browser verification failed at ${stage}; details withheld.`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
