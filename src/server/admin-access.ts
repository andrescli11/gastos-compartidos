import "server-only";
import { createHmac } from "node:crypto";
import { sqlExecutor } from "./database";
import { AccessRepository } from "./access-repository";
import { PersistenceError } from "./expense-repository";
import {
  csrfToken,
  hashToken,
  ipQuotaHash,
  readSessionCookie,
  verifyCsrf,
} from "./tokens";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireOrigin,
} from "./http";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function adminAccess(request: Request) {
  try {
    const mutation = request.method === "POST";
    if (!mutation && request.method !== "GET")
      throw new HttpError(405, "Método no permitido.");
    const secret = process.env.RATE_LIMIT_SECRET ?? "";
    if (mutation) requireOrigin(request, process.env.APP_URL ?? "");
    else if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new PersistenceError("FORBIDDEN");
    const db = sqlExecutor(),
      access = new AccessRepository(db);
    if (
      !(await access.quota(
        ipQuotaHash(request, secret, process.env.VERCEL === "1"),
        mutation ? "write" : "read",
      ))
    )
      throw new PersistenceError("RATE_LIMITED");
    const session = readSessionCookie(request);
    if (!(await access.quota(hashToken(session), mutation ? "write" : "read")))
      throw new PersistenceError("RATE_LIMITED");
    const context = await access.context(session);
    if (context.role !== "admin") throw new PersistenceError("FORBIDDEN");
    if (!mutation) {
      const r = await db.query(
        "select app_api.list_access_links($1::text) as result",
        [hashToken(session)],
      );
      return jsonResponse({
        links: r.rows[0]?.result,
        csrfToken: csrfToken(session),
      });
    }
    verifyCsrf(session, request.headers.get("x-csrf-token"));
    const body = await readJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new PersistenceError("INVALID_INPUT");
    const v = body as Record<string, unknown>;
    if (typeof v.id !== "string" || !uuid.test(v.id))
      throw new PersistenceError("INVALID_INPUT");
    if (v.operation === "revoke" && Object.keys(v).length === 2) {
      const links = await db.query(
        "select app_api.list_access_links($1::text) as result",
        [hashToken(session)],
      );
      const target = (
        links.rows[0]?.result as { id: string; own: boolean }[]
      ).find((l) => l.id === v.id);
      if (!target || target.own) throw new PersistenceError("FORBIDDEN");
      await access.revoke(session, v.id);
      return jsonResponse({ ok: true });
    }
    const key = request.headers.get("idempotency-key");
    if (
      v.operation !== "rotate" ||
      Object.keys(v).length !== 3 ||
      !Number.isSafeInteger(v.expectedVersion) ||
      Number(v.expectedVersion) < 1 ||
      Number(v.expectedVersion) > 2147483647 ||
      !key ||
      !uuid.test(key)
    )
      throw new PersistenceError("INVALID_INPUT");
    const token = createHmac("sha256", secret)
      .update(`cusco-link-rotation-v1\0${hashToken(session)}\0${key}\0${v.id}`)
      .digest("base64url");
    const r = await db.query(
      "select app_api.rotate_access_link($1::text,$2::uuid,$3::uuid,$4::integer,$5::text) as result",
      [hashToken(session), key, v.id, v.expectedVersion, hashToken(token)],
    );
    return jsonResponse({
      link: r.rows[0]?.result,
      url: `${new URL(process.env.APP_URL ?? "").origin}/entrar#token=${token}`,
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "42501")
      return errorResponse(new PersistenceError("FORBIDDEN"));
    if (code === "28000")
      return errorResponse(new PersistenceError("UNAUTHORIZED"));
    if (code === "40001")
      return errorResponse(new PersistenceError("CONFLICT"));
    return errorResponse(error);
  }
}
