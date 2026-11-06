import "server-only";
import { accessRepository } from "./database";
import { HttpError, requireOrigin } from "./http";
import {
  hashToken,
  ipQuotaHash,
  readSessionCookie,
  verifyCsrf,
} from "./tokens";
/** Every import/source endpoint shares session, Origin, CSRF and durable quotas. */
export async function authorizeImport(request: Request, mutation: boolean) {
  if (mutation) requireOrigin(request, process.env.APP_URL ?? "");
  else if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "Solicitud no permitida.");
  const session = readSessionCookie(request);
  if (mutation) verifyCsrf(session, request.headers.get("x-csrf-token"));
  const access = accessRepository();
  const scope = mutation ? "write" : "read";
  const ip = ipQuotaHash(
    request,
    process.env.RATE_LIMIT_SECRET ?? "",
    process.env.VERCEL === "1",
  );
  if (
    !(await access.quota(ip, scope)) ||
    !(await access.quota(hashToken(session), scope))
  )
    throw new HttpError(429, "Demasiadas solicitudes. Inténtalo en un minuto.");
  const context = await access.context(session);
  return { session, context };
}
