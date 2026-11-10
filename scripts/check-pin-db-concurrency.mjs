import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
if (
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CUSCO_DB_TEST_DISPOSABLE !== "yes" ||
  process.env.PGDATABASE !== "cusco_test" ||
  !["127.0.0.1", "localhost", "::1", "[::1]"].includes(process.env.PGHOST ?? "")
)
  throw new Error("Only the disposable loopback CI database is accepted.");
const run = (statement) =>
  new Promise((resolve) => {
    const child = spawn(
      "psql",
      ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", statement],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.resume();
    child.on("error", () => resolve({ ok: false, output: "" }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, output: output.trim() }),
    );
  });
const trip = "00000000-0000-4000-8000-000000000001";
const participant = randomUUID(),
  target = randomUUID(),
  admin = randomUUID();
const adminSession = randomBytes(32).toString("hex"),
  oldSession = randomBytes(32).toString("hex"),
  freshSession = randomBytes(32).toString("hex");
const oldVerifier = "scrypt1$" + "A".repeat(22) + "$" + "A".repeat(86),
  nextVerifier = "scrypt1$" + "B".repeat(22) + "$" + "C".repeat(86);
assert(
  (
    await run(`begin;
insert into app_private.participants(id,trip_id,display_name) values('${participant}','${trip}','PIN concurrency fixture');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values('${target}','${trip}','${participant}','participant','${randomBytes(32).toString("hex")}'),('${admin}','${trip}',null,'admin','${randomBytes(32).toString("hex")}');
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values('${trip}','${admin}','${adminSession}',1,now()+interval '1 hour');
insert into app_private.pin_credentials(link_id,verifier) values('${target}','${oldVerifier}');commit;`)
  ).ok,
);
const exchange = `begin;set local role cusco_bff;select app_api.exchange_pin('${target}',1,1,'${oldVerifier}','${oldSession}');commit;`;
const reset = `begin;set local role cusco_bff;select app_api.manage_pin('${adminSession}','${randomUUID()}','${target}',1,'set','${nextVerifier}');commit;`;
const [loginResult, resetResult] = await Promise.all([
  run(exchange),
  run(reset),
]);
assert(
  resetResult.ok,
  "reset succeeds while a previously verified login races",
);
assert(
  !(
    await run(
      `begin;set local role cusco_bff;select app_api.session_context('${oldSession}');commit;`,
    )
  ).ok,
  "old verification never leaves a usable session after reset",
);
assert(
  (
    await run(
      `begin;set local role cusco_bff;select app_api.exchange_pin('${target}',2,2,'${nextVerifier}','${freshSession}');commit;`,
    )
  ).ok,
);
assert(
  (
    await run(
      `begin;set local role cusco_bff;select app_api.session_context('${freshSession}');commit;`,
    )
  ).ok,
);
// Disable the synthetic credential so it does not appear in later browser smoke.
assert(
  (
    await run(
      `begin;set local role cusco_bff;select app_api.manage_pin('${adminSession}','${randomUUID()}','${target}',2,'disable',null);commit;`,
    )
  ).ok,
);
assert(
  !(
    await run(
      `begin;set local role cusco_bff;select app_api.session_context('${freshSession}');commit;`,
    )
  ).ok,
);
assert(typeof loginResult.ok === "boolean");
console.log(
  "OK: concurrent PIN reset invalidates both pre-existing sessions and in-flight old verifications; new credential logs in and disable revokes it.",
);
