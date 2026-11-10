import type { AccessRepository } from "./access-repository.ts";
import { PersistenceError } from "./expense-repository.ts";
import {
  hashPin,
  pinManagementSalt,
  validPin,
  verifyPin,
} from "./pin-crypto.ts";
import { PinRepository, pinUserId } from "./pin-repository.ts";
import {
  csrfToken,
  expiredSessionCookie,
  hashToken,
  newToken,
  readSessionCookie,
  sessionCookie,
  verifyCsrf,
} from "./tokens.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireOrigin,
} from "./http.ts";
type Dependencies = {
  pins: Pick<
    PinRepository,
    "users" | "credential" | "exchange" | "managedUsers" | "manage"
  >;
  access: Pick<AccessRepository, "context">;
  appUrl: string;
  secret: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
/** Public PIN login intentionally has no quota, failed-attempt counter, or lockout. */
export function createPinApi(deps: Dependencies) {
  return async function handle(
    request: Request,
    action: "users" | "login" | "manage",
  ) {
    try {
      const mutation =
        action === "login" ||
        (action === "manage" && request.method === "POST");
      if (request.method !== (mutation ? "POST" : "GET"))
        throw new HttpError(405, "Método no permitido.");
      if (mutation) requireOrigin(request, deps.appUrl);
      else if (request.headers.get("sec-fetch-site") === "cross-site")
        throw new PersistenceError("FORBIDDEN");
      if (action === "users")
        return jsonResponse({ users: await deps.pins.users() });
      if (action === "login") {
        const body = await readJson(request, 256);
        if (
          !object(body) ||
          Object.keys(body).length !== 2 ||
          !pinUserId(body.id) ||
          !validPin(body.pin)
        )
          return jsonResponse({ error: "Usuario o PIN no válido." }, 401, {
            "Set-Cookie": expiredSessionCookie,
          });
        const credential = await deps.pins.credential(body.id);
        if (
          !(await verifyPin(
            body.pin,
            body.id,
            deps.secret,
            credential?.verifier,
          )) ||
          !credential
        )
          return jsonResponse({ error: "Usuario o PIN no válido." }, 401, {
            "Set-Cookie": expiredSessionCookie,
          });
        const session = newToken();
        try {
          await deps.pins.exchange(body.id, credential, session);
        } catch (e) {
          if (e instanceof PersistenceError && e.code === "UNAUTHORIZED")
            return jsonResponse({ error: "Usuario o PIN no válido." }, 401, {
              "Set-Cookie": expiredSessionCookie,
            });
          throw e;
        }
        return jsonResponse({ ok: true }, 200, {
          "Set-Cookie": sessionCookie(session),
        });
      }
      const session = readSessionCookie(request);
      const context = await deps.access.context(session);
      if (context.role !== "admin") throw new PersistenceError("FORBIDDEN");
      if (!mutation)
        return jsonResponse({
          users: await deps.pins.managedUsers(session),
          csrfToken: csrfToken(session),
        });
      verifyCsrf(session, request.headers.get("x-csrf-token"));
      const body = await readJson(request, 512);
      const key = request.headers.get("idempotency-key");
      if (
        !object(body) ||
        !pinUserId(body.id) ||
        !pinUserId(key) ||
        !Number.isSafeInteger(body.expectedVersion) ||
        Number(body.expectedVersion) < 0 ||
        Number(body.expectedVersion) >= 2147483647 ||
        !["set", "disable"].includes(String(body.operation)) ||
        Object.keys(body).some(
          (k) => !["operation", "id", "expectedVersion", "pin"].includes(k),
        )
      )
        throw new PersistenceError("INVALID_INPUT");
      let verifier: string | null = null;
      if (body.operation === "set") {
        if (!validPin(body.pin)) throw new PersistenceError("INVALID_INPUT");
        verifier = await hashPin(
          body.pin,
          body.id,
          deps.secret,
          pinManagementSalt(deps.secret, hashToken(session), key, body.id),
        );
      } else if (body.pin !== undefined)
        throw new PersistenceError("INVALID_INPUT");
      const result = await deps.pins.manage(session, key, {
        operation: body.operation as "set" | "disable",
        id: body.id,
        expectedVersion: Number(body.expectedVersion),
        verifier,
      });
      return jsonResponse(
        result,
        200,
        result.ownSessionRevoked ? { "Set-Cookie": expiredSessionCookie } : {},
      );
    } catch (e) {
      return errorResponse(e);
    }
  };
}
