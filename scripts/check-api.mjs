import assert from "node:assert/strict";
import { createApi } from "../src/server/api.ts";
import { PersistenceError } from "../src/server/expense-repository.ts";
import {
  csrfToken,
  hashToken,
  ipQuotaHash,
  newToken,
  readSessionCookie,
  SESSION_COOKIE,
  validToken,
} from "../src/server/tokens.ts";
import { AccessRepository } from "../src/server/access-repository.ts";
const appUrl = "https://cusco.example",
  secret = "s".repeat(64),
  session = newToken(),
  link = newToken(),
  uuid = "10000000-0000-4000-8000-000000000001";
const context = {
  role: "participant",
  participantId: uuid,
  participants: [{ id: uuid, displayName: "Fixture" }],
};
const expense = {
  id: uuid,
  payerId: uuid,
  description: "Fixture",
  spentOn: "2026-01-01",
  amountMinor: "100",
  currency: "PEN",
  source: "manual",
  state: "active",
  version: 1,
  splits: [{ participantId: uuid, amountMinor: "100" }],
};
let quotaCount = 0,
  mutations = 0,
  exchanges = 0;
let allowQuota = true,
  authorize = true;
const deps = {
  appUrl,
  rateSecret: secret,
  vercel: false,
  access: {
    quota: async () => {
      quotaCount++;
      return allowQuota;
    },
    exchange: async (raw, fresh) => {
      assert.equal(raw, link);
      assert.ok(validToken(fresh));
      assert.notEqual(raw, fresh);
      exchanges++;
      return { expiresAt: new Date(Date.now() + 28800000).toISOString() };
    },
    context: async (raw) => {
      assert.equal(raw, session);
      if (!authorize) throw new PersistenceError("UNAUTHORIZED");
      return context;
    },
    logout: async (raw) => assert.equal(raw, session),
    revoke: async () => {
      throw new PersistenceError("FORBIDDEN");
    },
  },
  expenses: {
    list: async (raw) => {
      assert.equal(raw, session);
      if (!authorize) throw new PersistenceError("UNAUTHORIZED");
      return [expense];
    },
    mutate: async () => {
      mutations++;
      return expense;
    },
  },
};
const handler = createApi(deps);
function request(path, method = "GET", body, extra = {}) {
  return new Request(appUrl + path, {
    method,
    headers: {
      Origin: appUrl,
      Cookie: `${SESSION_COOKIE}=${session}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(session),
      "Idempotency-Key": uuid,
      ...extra,
    },
    ...(body !== undefined
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  });
}
async function check(req, action, status) {
  const response = await handler(req, action);
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  return response;
}
const signed = await check(request("/api/session"), "context", 200);
assert.deepEqual(await signed.json(), {
  ...context,
  csrfToken: csrfToken(session),
});
const exchanged = await check(
  request("/api/access/exchange", "POST", { token: link }),
  "exchange",
  200,
);
assert.match(
  exchanged.headers.get("set-cookie"),
  /HttpOnly; Secure; SameSite=Lax/,
);
assert.match(exchanged.headers.get("set-cookie"), /Path=\//);
assert.ok(!JSON.stringify(await exchanged.json()).includes(link));
await check(
  request("/api/access/exchange", "POST", { token: link, role: "admin" }),
  "exchange",
  401,
);
assert.equal(exchanges, 1);
const before = quotaCount;
await check(
  request(
    "/api/access/exchange",
    "POST",
    { token: link },
    { Origin: "https://attacker.example" },
  ),
  "exchange",
  403,
);
assert.equal(quotaCount, before);
await check(
  request("/api/expenses", "POST", {}, { "X-CSRF-Token": "" }),
  "mutate",
  403,
);
assert.equal(mutations, 0);
await check(
  request("/api/expenses", "POST", {}, { "Sec-Fetch-Site": "cross-site" }),
  "mutate",
  403,
);
await check(new Request(appUrl + "/api/expenses"), "list", 401);
await check(
  request("/api/expenses", "GET", undefined, {
    "Sec-Fetch-Site": "cross-site",
  }),
  "list",
  403,
);
await check(
  request("/api/expenses", "POST", {
    operation: "create",
    payerId: uuid,
    description: "Fixture",
    spentOn: "2026-01-01",
    amountMinor: "100",
    currency: "PEN",
    splits: expense.splits,
  }),
  "mutate",
  200,
);
assert.equal(mutations, 1);
await check(
  request("/api/expenses", "POST", { operation: "create", role: "admin" }),
  "mutate",
  400,
);
await check(request("/api/expenses", "POST", "bad json"), "mutate", 400);
await check(
  request("/api/expenses", "POST", "{}", { "Content-Type": "text/plain" }),
  "mutate",
  415,
);
await check(request("/api/expenses", "POST", "x".repeat(66000)), "mutate", 413);
await check(
  request("/api/expenses", "POST", "{}", { "Content-Length": "66000" }),
  "mutate",
  413,
);
await check(
  request("/api/expenses", "POST", {}, { "Idempotency-Key": "" }),
  "mutate",
  400,
);
const totals = await (
  await check(request("/api/summary"), "summary", 200)
).json();
assert.equal(totals.summary.PEN.totalMinor, "100");
assert.deepEqual(totals.summary.PEN.transfers, []);
assert.equal(totals.summary.USD.totalMinor, "0");
await check(
  request("/api/access/revoke", "POST", { linkId: uuid }),
  "revoke",
  403,
);
allowQuota = false;
const limited = await check(request("/api/session"), "context", 429);
assert.equal(limited.headers.get("retry-after"), "60");
allowQuota = true;
authorize = false;
const revoked = await check(request("/api/expenses"), "list", 401);
assert.match(revoked.headers.get("set-cookie"), /Max-Age=0/);
authorize = true;
const loggedOut = await check(
  request("/api/access/logout", "POST"),
  "logout",
  200,
);
assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
assert.throws(() =>
  readSessionCookie(
    request("/", "GET", undefined, {
      Cookie: `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}`,
    }),
  ),
);
assert.equal(
  ipQuotaHash(
    request("/", "GET", undefined, { "X-Forwarded-For": "1.1.1.1" }),
    secret,
    false,
  ),
  ipQuotaHash(
    request("/", "GET", undefined, { "X-Forwarded-For": "2.2.2.2" }),
    secret,
    false,
  ),
);
assert.equal(hashToken(session).length, 64);
const down = createApi({ ...deps, rateSecret: "" });
assert.equal((await down(request("/"), "context")).status, 503);
const repo = new AccessRepository({
  query: async (sql, values) => {
    assert.ok(!sql.includes(session));
    if (sql.includes("context")) {
      assert.equal(values[0], hashToken(session));
      return { rows: [{ result: context }] };
    }
    return { rows: [{ result: true }] };
  },
});
assert.deepEqual(await repo.context(session), context);
assert.equal(await repo.quota("a".repeat(64), "read"), true);
const throttled = new AccessRepository({
  query: async () => {
    throw {
      code: "P0001",
      message: "rate_limited",
      detail: "sensitive fixture",
    };
  },
});
await assert.rejects(
  throttled.exchange(link, session),
  (e) => e.code === "RATE_LIMITED" && !e.message.includes("fixture"),
);
console.log(
  "OK: BFF autenticado, CSRF/origen, cookies seguras, cuotas, caché privada, límites de JSON, revocación y resumen exacto.",
);
