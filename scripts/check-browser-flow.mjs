// Browser → Next → PostgreSQL. Never run against a remote or real database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
let browser;
let database;
let stage = "environment";
try {
  const env = process.env;
  assert(
    env.CI === "true" &&
      env.GITHUB_ACTIONS === "true" &&
      env.CUSCO_DB_TEST_DISPOSABLE === "yes",
  );
  assert(["127.0.0.1", "localhost", "::1", "[::1]"].includes(env.PGHOST));
  assert.equal(env.PGDATABASE, "cusco_test");
  assert.equal(env.APP_URL, "http://127.0.0.1:3000");
  const destination = new URL(env.DATABASE_URL);
  assert(
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(destination.hostname),
  );
  assert.equal(destination.pathname, "/cusco_test");
  assert.equal(destination.port, env.PGPORT || "5432");
  const { Client } = await import("pg");
  const { chromium } = await import("@playwright/test");
  database = new Client({
    host: env.PGHOST,
    port: Number(env.PGPORT || "5432"),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: false,
    connectionTimeoutMillis: 10000,
  });
  await database.connect();
  browser = await chromium.launch({ headless: true });
  const base = env.APP_URL;

  async function command(page, path, click) {
    const pending = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === "POST",
      { timeout: 20000 },
    );
    const [response] = await Promise.all([pending, click()]);
    assert.equal(response.status(), 200);
    return response.json();
  }
  async function enter(actor, viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${base}/entrar#token=${actor.token}`);
    await page.waitForURL(`${base}/gastos`);
    await page.getByRole("heading", { name: "Todo en orden." }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    const cookie = (await context.cookies()).find(
      (item) => item.name === "__Host-cusco_session",
    );
    assert(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax");
    return { context, page };
  }
  async function browserJson(page, path) {
    return page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("Browser request failed.");
      return response.json();
    }, path);
  }

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    stage = "fixtures";
    const suffix = randomUUID();
    const actors = [
      {
        id: randomUUID(),
        name: `Browser A ${suffix}`,
        token: randomBytes(32).toString("base64url"),
      },
      {
        id: randomUUID(),
        name: `Browser B ${suffix}`,
        token: randomBytes(32).toString("base64url"),
      },
      {
        id: null,
        name: "Browser admin",
        token: randomBytes(32).toString("base64url"),
      },
    ];
    const [a, b, admin] = actors;
    const trip = "00000000-0000-4000-8000-000000000001";
    await database.query("begin");
    for (const actor of actors) {
      if (actor.id)
        await database.query(
          "insert into app_private.participants(id,trip_id,display_name) values($1,$2,$3)",
          [actor.id, trip, actor.name],
        );
      await database.query(
        "insert into app_private.access_links(trip_id,participant_id,role,token_hash) values($1,$2,$3,$4)",
        [
          trip,
          actor.id,
          actor.id ? "participant" : "admin",
          createHash("sha256").update(actor.token).digest("hex"),
        ],
      );
    }
    await database.query("commit");

    stage = "administrator browser session";
    const adminBrowser = await enter(admin, viewport);
    await adminBrowser.page
      .getByRole("link", { name: "Pagos y cierre", exact: true })
      .click();
    await adminBrowser.page.getByLabel("Modo", { exact: true }).waitFor();
    assert.equal(
      await adminBrowser.page.getByLabel("Modo", { exact: true }).inputValue(),
      "separate",
    );
    const context = await browserJson(adminBrowser.page, "/api/payments");
    if (!context.context.configurationChosenBy) {
      // Existing CI fixtures may have already chosen the same configuration.
      const configuration = adminBrowser.page.getByRole("button", {
        name: "Revisar configuración",
        exact: true,
      });
      if (await configuration.isEnabled()) {
        await configuration.click();
        await command(adminBrowser.page, "/api/payments", () =>
          adminBrowser.page
            .getByRole("button", { name: "Confirmar operación", exact: true })
            .click(),
        );
      }
    }

    stage = "participant browser session";
    const aBrowser = await enter(a, viewport);
    await aBrowser.page
      .getByRole("link", { name: "Ingresar gastos", exact: true })
      .click();
    const description = `Browser expense ${suffix}`;
    await aBrowser.page
      .getByLabel("Descripción gasto 1", { exact: true })
      .fill(description);
    await aBrowser.page
      .getByLabel("Fecha gasto 1", { exact: true })
      .fill("2026-10-30");
    await aBrowser.page
      .getByLabel("Importe gasto 1", { exact: true })
      .fill("1.00");
    await aBrowser.page
      .getByLabel("Moneda gasto 1", { exact: true })
      .selectOption("PEN");
    const card = aBrowser.page.locator("article").filter({
      has: aBrowser.page.getByRole("heading", {
        name: "Gasto 1",
        exact: true,
      }),
    });
    const boxes = card.getByRole("checkbox");
    for (let i = 0; i < (await boxes.count()); i++)
      await boxes.nth(i).uncheck();
    await aBrowser.page
      .getByLabel(`${b.name} en gasto 1`, { exact: true })
      .check();
    stage = "expense review";
    const initialReview = await command(aBrowser.page, "/api/imports", () =>
      aBrowser.page
        .getByRole("button", { name: "Revisar gastos", exact: true })
        .click(),
    );
    if (initialReview.job.rows.some((row) => row.selected && !row.reviewed)) {
      // Server-discovered warnings require a fresh, explicit acknowledgement.
      assert.equal(
        (await browserJson(aBrowser.page, "/api/expenses")).expenses.filter(
          (expense) => expense.payerId === a.id,
        ).length,
        0,
      );
      const row = initialReview.job.rows[0];
      if (
        row.duplicateExpenseIds.length ||
        row.warnings.includes("DUPLICATE_IN_BATCH")
      ) {
        await aBrowser.page
          .getByLabel("Mantener ambos en gasto 1", { exact: true })
          .check();
      }
      await aBrowser.page
        .getByLabel("He revisado gasto 1", { exact: true })
        .check();
      const canReview = await aBrowser.page
        .getByRole("button", { name: "Revisar gastos", exact: true })
        .isEnabled();
      assert.equal(
        canReview,
        true,
        `Review blocked: warnings=${row.warnings.join(",")}; duplicates=${row.duplicateExpenseIds.length}`,
      );
      await command(aBrowser.page, "/api/imports", () =>
        aBrowser.page
          .getByRole("button", { name: "Revisar gastos", exact: true })
          .click(),
      );
    }
    await aBrowser.page
      .getByRole("heading", { name: "Confirma tus gastos", exact: true })
      .waitFor();
    assert.equal(
      (await browserJson(aBrowser.page, "/api/expenses")).expenses.filter(
        (expense) => expense.payerId === a.id,
      ).length,
      0,
    );
    await aBrowser.page
      .getByLabel("Confirmo registrar estos gastos revisados.", { exact: true })
      .check();
    stage = "expense confirmation";
    await command(aBrowser.page, "/api/imports", () =>
      aBrowser.page
        .getByRole("button", { name: "Confirmar gastos", exact: true })
        .click(),
    );
    await aBrowser.page
      .getByRole("status")
      .filter({ hasText: "Gastos guardados." })
      .waitFor();
    assert.equal(
      (await browserJson(aBrowser.page, "/api/expenses")).expenses.filter(
        (expense) => expense.payerId === a.id,
      ).length,
      1,
    );
    await aBrowser.page.goto(`${base}/gastos`);

    stage = "payment registration";
    const bBrowser = await enter(b, viewport);
    await bBrowser.page
      .getByRole("link", { name: "Pagos y cierre", exact: true })
      .click();
    await bBrowser.page
      .getByLabel("Receptor", { exact: true })
      .selectOption(a.id);
    await bBrowser.page.getByLabel("Importe", { exact: true }).fill("1.00");
    await bBrowser.page
      .getByRole("button", { name: "Revisar pago", exact: true })
      .click();
    const before = await browserJson(bBrowser.page, "/api/payments");
    assert.equal(
      before.context.payments.filter((payment) => payment.senderId === b.id)
        .length,
      0,
    );
    await command(bBrowser.page, "/api/payments", () =>
      bBrowser.page
        .getByRole("button", { name: "Confirmar operación", exact: true })
        .click(),
    );

    stage = "receiver confirmation";
    await aBrowser.page
      .getByRole("link", { name: "Pagos y cierre", exact: true })
      .click();
    const payment = aBrowser.page
      .locator("article.expense-card")
      .filter({ hasText: `${b.name} → ${a.name}` });
    await payment
      .getByRole("button", { name: "Revisar confirmación", exact: true })
      .click();
    const acknowledgement = aBrowser.page.getByRole("checkbox", {
      name: "He revisado las advertencias y los saldos vigentes.",
      exact: true,
    });
    if (await acknowledgement.count()) await acknowledgement.check();
    await command(aBrowser.page, "/api/payments", () =>
      aBrowser.page
        .getByRole("button", { name: "Confirmar operación", exact: true })
        .click(),
    );
    stage = "settled browser summary";
    const { summary } = await browserJson(aBrowser.page, "/api/summary");
    for (const actor of [a, b])
      assert.equal(
        summary.PEN.balances.find(
          (balance) => balance.participantId === actor.id,
        )?.amountMinor,
        "0",
      );
    const final = await browserJson(aBrowser.page, "/api/payments");
    assert.equal(
      final.context.payments.find((payment) => payment.senderId === b.id)
        ?.state,
      "confirmed",
    );

    stage = "administration browser";
    await adminBrowser.page.goto(`${base}/administrar`);
    await adminBrowser.page
      .getByRole("heading", { name: "Administrar accesos", exact: true })
      .waitFor();
    const links = await browserJson(adminBrowser.page, "/api/access/links");
    assert(links.links.some((link) => link.displayName === a.name));
    assert(links.links.some((link) => link.displayName === b.name));
    assert(!JSON.stringify(links).includes(a.token));
    stage = "Excel template download";
    await aBrowser.page.goto(`${base}/gastos/nuevo`);
    await aBrowser.page
      .getByText("¿Prefieres usar Excel?", { exact: true })
      .click();
    await aBrowser.page
      .getByRole("link", { name: "Descargar plantilla Excel", exact: true })
      .waitFor();
    const template = await aBrowser.page.request.get(
      `${base}/api/imports/template`,
    );
    assert.equal(template.status(), 200);
    assert.match(
      template.headers()["content-disposition"],
      /plantilla-gastos-cusco\.xlsx/,
    );
    const importedDescription = `Browser Excel ${suffix}`;
    const filled = spawnSync(
      "python3",
      [
        "-c",
        `
import io,sys,zipfile,xml.etree.ElementTree as E
ns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
E.register_namespace("",ns)
source=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
out=io.BytesIO()
with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED) as dest:
 for entry in source.infolist():
  data=source.read(entry.filename)
  if entry.filename=="xl/worksheets/sheet1.xml":
   root=E.fromstring(data)
   for col,text in zip("ABCD",[sys.argv[1],"2026-10-30",sys.argv[2],"PEN"]):
    cell=root.find(".//{%s}c[@r='%s2']"%(ns,col))
    cell.find("{%s}is/{%s}t"%(ns,ns)).text=text
   data=E.tostring(root,encoding="utf-8",xml_declaration=True)
  dest.writestr(entry.filename,data)
sys.stdout.buffer.write(out.getvalue())
`,
        importedDescription,
        viewport.width === 390 ? "1.04" : "1.03",
      ],
      { input: await template.body(), maxBuffer: 1024 * 1024 },
    );
    assert.equal(filled.status, 0);
    stage = "Excel source upload and review";
    const sourceReply = aBrowser.page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/imports/source" &&
        r.request().method() === "POST",
    );
    await aBrowser.page
      .getByLabel("Archivo CSV o Excel", { exact: true })
      .setInputFiles({
        name: "gastos.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: filled.stdout,
      });
    assert.equal((await sourceReply).status(), 200);
    await aBrowser.page
      .getByRole("button", { name: "Preparar hoja seleccionada", exact: true })
      .click();
    await aBrowser.page
      .getByLabel("Descripción gasto 1", { exact: true })
      .waitFor();
    assert.equal(
      await aBrowser.page
        .getByLabel("Descripción gasto 1", { exact: true })
        .inputValue(),
      importedDescription,
    );
    await aBrowser.page
      .getByLabel("Seleccionar gasto 1", { exact: true })
      .check();
    await command(aBrowser.page, "/api/imports", () =>
      aBrowser.page
        .getByRole("button", { name: "Guardar borrador privado", exact: true })
        .click(),
    );
    assert.equal(
      (await browserJson(aBrowser.page, "/api/expenses")).expenses.filter(
        (e) => e.description === importedDescription,
      ).length,
      0,
    );
    await aBrowser.page
      .getByLabel("He revisado gasto 1", { exact: true })
      .check();
    await command(aBrowser.page, "/api/imports", () =>
      aBrowser.page
        .getByRole("button", { name: "Revisar gastos", exact: true })
        .click(),
    );
    await aBrowser.page
      .getByLabel("Confirmo registrar estos gastos revisados.", { exact: true })
      .check();
    const confirmReply = aBrowser.page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/imports" &&
        r.request().method() === "POST",
    );
    await aBrowser.page
      .getByRole("button", {
        name: "Confirmar gastos",
        exact: true,
      })
      .click();
    const confirmation = await confirmReply;
    assert.equal(confirmation.status(), 200);
    const confirmed = await confirmation.json();
    assert.equal(
      confirmed.job.results.filter((r) => r.status === "persisted").length,
      1,
    );
    stage = "Excel confirmation idempotency";
    const confirmRequest = confirmation.request();
    const sessionData = await browserJson(aBrowser.page, "/api/session");
    const replayStatus = await aBrowser.page.evaluate(
      async (data) => {
        const r = await fetch("/api/imports", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": data.csrf,
            "Idempotency-Key": data.key,
          },
          body: data.body,
        });
        return r.status;
      },
      {
        csrf: sessionData.csrfToken,
        key: confirmRequest.headers()["idempotency-key"],
        body: confirmRequest.postData(),
      },
    );
    assert.equal(replayStatus, 200);
    assert.equal(
      (await browserJson(aBrowser.page, "/api/expenses")).expenses.filter(
        (e) => e.description === importedDescription,
      ).length,
      1,
    );

    for (const opened of [adminBrowser, aBrowser, bBrowser])
      await opened.context.close();
  }
  console.log(
    "Real browser/Next/PostgreSQL flow passed on desktop and mobile.",
  );
} catch {
  console.error(`Real browser flow failed at ${stage} (details withheld).`);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    process.exitCode = 1;
  }
  try {
    await database?.end();
  } catch {
    process.exitCode = 1;
  }
}
