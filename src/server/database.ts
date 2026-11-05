import "server-only";
import { Pool } from "pg";
import {
  ExpenseRepository,
  PersistenceError,
  type SqlExecutor,
} from "./expense-repository";
import { PaymentRepository } from "./payment-repository";
import { AccessRepository } from "./access-repository";
let pool: Pool | undefined;
/** Solo servidor. Login dedicado con membresía cusco_bff, nunca postgres/service_role. */
export function sqlExecutor(): SqlExecutor {
  if (!pool) {
    let url: URL;
    try {
      url = new URL(process.env.DATABASE_URL ?? "");
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.username ||
        !url.password ||
        !url.pathname.slice(1)
      )
        throw new Error();
    } catch {
      throw new PersistenceError("UNAVAILABLE");
    }
    const localTest =
      (process.env.NODE_ENV === "test" ||
        (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")) &&
      process.env.CUSCO_DB_TEST_DISPOSABLE === "yes" &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    // Se descomponen los campos: parámetros sslmode de la URL no pueden desactivar TLS.
    const port = url.port ? Number(url.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new PersistenceError("UNAVAILABLE");
    try {
      pool = new Pool({
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        ssl: localTest
          ? false
          : {
              rejectUnauthorized: true,
              ...(process.env.DATABASE_CA_CERT
                ? { ca: process.env.DATABASE_CA_CERT }
                : {}),
            },
        max: 3,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        statement_timeout: 10000,
        query_timeout: 12000,
        application_name: "cusco-bff",
      });
      // El pool puede emitir errores asíncronos con datos del driver. No se registran.
      pool.on("error", () => {});
    } catch {
      throw new PersistenceError("UNAVAILABLE");
    }
  }
  const activePool = pool;
  const database: SqlExecutor = {
    query: async (text, values) => {
      const client = await activePool.connect();
      let discard = false;
      try {
        await client.query("begin");
        // Rol fijo, sin interpolación. Cada llamada usa una conexión reservada.
        await client.query("set local role cusco_bff");
        const result = await client.query<{ result: unknown }>(text, [
          ...values,
        ]);
        await client.query("commit");
        return { rows: result.rows };
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
  };
  return database;
}

export function expenseRepository() {
  return new ExpenseRepository(sqlExecutor());
}
export function accessRepository() {
  return new AccessRepository(sqlExecutor());
}

export function paymentRepository() {
  return new PaymentRepository(sqlExecutor());
}
