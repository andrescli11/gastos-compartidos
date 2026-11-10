import assert from "node:assert/strict";
import {
  hashPin,
  verifyPin,
  pinManagementSalt,
  validPinVerifier,
} from "../src/server/pin-crypto.ts";
import { createPinApi } from "../src/server/pin-api.ts";
import { hashToken, csrfToken } from "../src/server/tokens.ts";
const id = "f2000000-0000-4000-8000-000000000001";
const secret = "disposable-pin-pepper-for-contract-tests-0000000";
const session = "A".repeat(43);
const key = "f3000000-0000-4000-8000-000000000001";
const verifier = await hashPin("047", id, secret);
assert(validPinVerifier(verifier));
assert.notEqual(verifier, "047");
assert(await verifyPin("047", id, secret, verifier));
assert(!(await verifyPin("048", id, secret, verifier)));
assert(
  !(await verifyPin(
    "047",
    "f2000000-0000-4000-8000-000000000002",
    secret,
    verifier,
  )),
);
assert(!(await verifyPin("047", id, secret + "changed", verifier)));
assert.notEqual(
  await hashPin("047", id, secret),
  verifier,
  "random salt differs",
);
assert.equal(
  await hashPin(
    "047",
    id,
    secret,
    pinManagementSalt(secret, hashToken(session), key, id),
  ),
  await hashPin(
    "047",
    id,
    secret,
    pinManagementSalt(secret, hashToken(session), key, id),
  ),
  "admin retry uses same salted verifier for same key",
);
let exchanges = 0;
let role = "admin";
let managed;
const api = createPinApi({
  appUrl: "https://app.example",
  secret,
  access: {
    context: async () => ({ role, participantId: null, participants: [] }),
  },
  pins: {
    users: async () => [{ id, displayName: "Fixture", role: "participant" }],
    credential: async () => ({ verifier, version: 1, linkVersion: 1 }),
    exchange: async () => {
      exchanges++;
      return { expiresAt: "2099-01-01T00:00:00Z" };
    },
    managedUsers: async () => [],
    manage: async (_session, _key, command) => {
      managed = command;
      return { ok: true, ownSessionRevoked: true };
    },
  },
});
const post = (path, body, headers = {}) =>
  new Request(`https://app.example${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://app.example",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const login = () => post("/api/access/pin", { id, pin: "047" });
for (let i = 0; i < 25; i++)
  assert.equal(
    (await api(post("/api/access/pin", { id, pin: "048" }), "login")).status,
    401,
  );
assert.equal(
  exchanges,
  0,
  "failed PIN never creates a session and is not rate limited",
);
const success = await api(login(), "login");
assert.equal(success.status, 200);
assert.equal(exchanges, 1);
assert.match(
  success.headers.get("set-cookie"),
  /HttpOnly; Secure; SameSite=Lax/,
);
assert.match(success.headers.get("cache-control"), /no-store/);
assert.deepEqual(await success.json(), { ok: true });
assert.equal(
  (await api(post("/api/access/pin", { id, pin: 47 }), "login")).status,
  401,
);
assert.equal(
  (
    await api(
      post(
        "/api/access/pin",
        { id, pin: "047" },
        { Origin: "https://evil.example" },
      ),
      "login",
    )
  ).status,
  403,
);
assert.equal(
  (
    await api(
      post("/api/access/pin", { id, pin: "047", role: "admin" }),
      "login",
    )
  ).status,
  401,
);
const cookie = `${"__Host-cusco_session"}=${session}`;
const request = () =>
  post(
    "/api/access/pin/manage",
    { operation: "set", id, expectedVersion: 1, pin: "047" },
    {
      Cookie: cookie,
      "X-CSRF-Token": csrfToken(session),
      "Idempotency-Key": key,
    },
  );
const result = await api(request(), "manage");
assert.equal(result.status, 200);
assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
assert(!JSON.stringify(managed).includes('"pin"'));
assert(validPinVerifier(managed.verifier));
assert.equal(
  (
    await api(
      post(
        "/api/access/pin/manage",
        { operation: "set", id, expectedVersion: 1, pin: "047" },
        { Cookie: cookie, "Idempotency-Key": key },
      ),
      "manage",
    )
  ).status,
  403,
);
role = "participant";
assert.equal((await api(request(), "manage")).status, 403);
console.log(
  "OK: PIN salted scrypt/pepper, leading zero, no login attempt limits, secure cookie, Origin/CSRF and admin-only management.",
);
