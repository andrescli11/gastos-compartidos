// Real HTTP → BFF → PostgreSQL, exclusively against the disposable CI database.
import { createHash, randomBytes, randomUUID } from "node:crypto";

function check(value) {
  if (!value) throw new Error("HTTP integration assertion failed.");
}
let client;
let stage = "environment";
let lastStatus = null;
try {
  const env = process.env;
  check(env.CI === "true" && env.CUSCO_DB_TEST_DISPOSABLE === "yes");
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
  check(loopback.includes(env.PGHOST) && env.PGDATABASE === "cusco_test");
  const database = new URL(env.DATABASE_URL);
  const origin = new URL(env.APP_URL);
  check(
    loopback.includes(database.hostname) &&
      database.pathname === "/cusco_test" &&
      database.port === (env.PGPORT || "5432") &&
      origin.origin === "http://127.0.0.1:3000" &&
      origin.href === `${origin.origin}/`,
  );
  const { Client } = await import("pg");
  client = new Client({
    host: env.PGHOST,
    port: Number(env.PGPORT || "5432"),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl: false,
    connectionTimeoutMillis: 10000,
  });
  stage = "fixture setup";
  await client.connect();
  const trip = "00000000-0000-4000-8000-000000000001";
  const a = { id: randomUUID(), link: randomUUID() };
  const b = { id: randomUUID(), link: randomUUID() };
  const admin = { id: null, link: randomUUID() };
  await client.query("BEGIN");
  for (const [index, actor] of [a, b, admin].entries()) {
    actor.token = randomBytes(32).toString("base64url");
    if (actor.id)
      await client.query(
        "INSERT INTO app_private.participants(id,trip_id,display_name) VALUES($1,$2,$3)",
        [actor.id, trip, `HTTP fixture ${index}`],
      );
    await client.query(
      "INSERT INTO app_private.access_links(id,trip_id,participant_id,role,token_hash) VALUES($1,$2,$3,$4,$5)",
      [
        actor.link,
        trip,
        actor.id,
        actor.id ? "participant" : "admin",
        createHash("sha256").update(actor.token).digest("hex"),
      ],
    );
  }
  await client.query("COMMIT");

  async function request(path, actor, body, overrides = {}) {
    const headers = { ...(actor?.cookie ? { Cookie: actor.cookie } : {}) };
    if (body !== undefined)
      Object.assign(headers, {
        "Content-Type": "application/json",
        Origin: origin.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": actor?.csrf || "",
        "Idempotency-Key": randomUUID(),
      });
    Object.assign(headers, overrides);
    const response = await fetch(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    lastStatus = response.status;
    check(/private/.test(response.headers.get("cache-control") || ""));
    check(/no-store/.test(response.headers.get("cache-control") || ""));
    return response;
  }
  async function json(path, actor, body, overrides) {
    const response = await request(path, actor, body, overrides);
    check(response.status === 200);
    return response.json();
  }
  check((await request("/api/expenses")).status === 401);
  stage = "session exchange";
  for (const actor of [a, b, admin]) {
    const response = await request("/api/access/exchange", null, {
      token: actor.token,
    });
    check(response.status === 200);
    const cookie = response.headers.get("set-cookie") || "";
    check(/^__Host-cusco_session=[A-Za-z0-9_-]{43};/.test(cookie));
    check(/; HttpOnly(?:;|$)/i.test(cookie) && /; Secure(?:;|$)/i.test(cookie));
    check(
      /; SameSite=Lax(?:;|$)/i.test(cookie) && /; Path=\/(?:;|$)/.test(cookie),
    );
    check(!/; Domain=/i.test(cookie));
    actor.cookie = cookie.split(";")[0];
    actor.token = undefined;
    const session = await json("/api/session", actor);
    check(session.participantId === actor.id);
    check(session.role === (actor.id ? "participant" : "admin"));
    check(
      typeof session.csrfToken === "string" && session.csrfToken.length === 43,
    );
    actor.csrf = session.csrfToken;
  }
  const expense = {
    operation: "create",
    payerId: a.id,
    description: "HTTP ephemeral fixture",
    spentOn: "2026-01-01",
    amountMinor: "100",
    currency: "PEN",
    splits: [{ participantId: b.id, amountMinor: "100" }],
  };
  check((await request("/api/expenses", null, expense)).status === 401);
  check(
    (
      await request("/api/expenses", a, expense, {
        Origin: "https://invalid.example",
      })
    ).status === 403,
  );
  check(
    (await request("/api/expenses", a, expense, { "X-CSRF-Token": "" }))
      .status === 403,
  );
  check(
    (await request("/api/expenses", a, { ...expense, payerId: b.id }))
      .status === 403,
  );
  stage = "settlement configuration";
  let { context } = await json("/api/payments", admin);
  ({ context } = await json("/api/payments", admin, {
    operation: "configure",
    mode: "separate",
    expectedLedgerVersion: context.ledgerVersion,
  }));
  check(context.configuration.mode === "separate");
  stage = "expense write and replay";
  const key = randomUUID();
  const first = await json("/api/expenses", a, expense, {
    "Idempotency-Key": key,
  });
  const retry = await json("/api/expenses", a, expense, {
    "Idempotency-Key": key,
  });
  check(
    typeof first.expense.id === "string" &&
      retry.expense.id === first.expense.id,
  );
  const { expenses } = await json("/api/expenses", a);
  check(expenses.filter((record) => record.payerId === a.id).length === 1);
  stage = "payment registration";
  ({ context } = await json("/api/payments", b));
  ({ context } = await json("/api/payments", b, {
    operation: "register",
    senderId: b.id,
    receiverId: a.id,
    amountMinor: "100",
    currency: "PEN",
    expectedLedgerVersion: context.ledgerVersion,
  }));
  const payment = context.payments.find((record) => record.senderId === b.id);
  check(payment?.state === "pending");
  stage = "payment confirmation";
  ({ context } = await json("/api/payments", a));
  ({ context } = await json("/api/payments", a, {
    operation: "confirm",
    id: payment.id,
    expectedPaymentVersion: payment.version,
    expectedLedgerVersion: context.ledgerVersion,
    reviewedLedgerVersion: context.ledgerVersion,
  }));
  check(
    context.payments.find((record) => record.id === payment.id)?.state ===
      "confirmed",
  );
  stage = "settlement summary";
  const { summary } = await json("/api/summary", a);
  for (const actor of [a, b])
    check(
      summary.PEN.balances.find((balance) => balance.participantId === actor.id)
        ?.amountMinor === "0",
    );
  stage = "access revocation";
  check(
    (await json("/api/access/revoke", admin, { linkId: a.link })).ok === true,
  );
  const revoked = await request("/api/expenses", a);
  check(revoked.status === 401);
  const denied = await revoked.json();
  check(Object.keys(denied).length === 1 && typeof denied.error === "string");
  check(!JSON.stringify(denied).includes(expense.description));
  console.log("HTTP BFF/PostgreSQL flow passed.");
} catch {
  console.error(
    `HTTP BFF/PostgreSQL flow failed at ${stage}; status ${lastStatus ?? "unavailable"} (details withheld).`,
  );
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.end();
    } catch {
      process.exitCode = 1;
    }
  }
}
