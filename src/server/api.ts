import { paymentConfirmationWarnings } from "../domain/payments.ts";
import { summarizePaymentLedger } from "../domain/payment-summary.ts";
import {
  paymentLedger,
  validatePaymentCommand,
  type PaymentRepository,
} from "./payment-repository.ts";
import { summarizeExpenses } from "../domain/summary.ts";
import {
  PersistenceError,
  validateExpenseCommand,
  type ExpenseRepository,
} from "./expense-repository.ts";
import type { AccessRepository } from "./access-repository.ts";
import {
  csrfToken,
  expiredSessionCookie,
  hashToken,
  ipQuotaHash,
  newToken,
  readSessionCookie,
  sessionCookie,
  validToken,
  verifyCsrf,
} from "./tokens.ts";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireOrigin,
} from "./http.ts";
type Access = Pick<
  AccessRepository,
  "quota" | "exchange" | "context" | "logout" | "revoke"
>;
type Expenses = Pick<ExpenseRepository, "list" | "mutate">;
export type ApiDependencies = {
  access: Access;
  expenses: Expenses;
  payments?: Pick<PaymentRepository, "context" | "mutate">;
  appUrl: string;
  rateSecret: string;
  vercel: boolean;
};
export type Action =
  | "exchange"
  | "context"
  | "logout"
  | "list"
  | "mutate"
  | "revoke"
  | "summary"
  | "payments"
  | "paymentMutate";
export function createApi(deps: ApiDependencies) {
  return async function handle(
    request: Request,
    action: Action,
  ): Promise<Response> {
    try {
      const mutation = [
        "exchange",
        "logout",
        "mutate",
        "revoke",
        "paymentMutate",
      ].includes(action);
      if (request.method !== (mutation ? "POST" : "GET"))
        throw new HttpError(405, "Método no permitido.");
      if (mutation) requireOrigin(request, deps.appUrl);
      else if (request.headers.get("sec-fetch-site") === "cross-site")
        throw new HttpError(403, "Solicitud no permitida.");
      const key = ipQuotaHash(request, deps.rateSecret, deps.vercel);
      const scope =
        action === "exchange" ? "exchange" : mutation ? "write" : "read";
      if (!(await deps.access.quota(key, scope)))
        throw new HttpError(
          429,
          "Demasiadas solicitudes. Inténtalo en un minuto.",
        );
      if (action === "exchange") {
        if (!(await deps.access.quota("0".repeat(64), "global_exchange")))
          throw new HttpError(
            429,
            "Demasiadas solicitudes. Inténtalo en un minuto.",
          );
        const body = await readJson(request, 256);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("token" in body) ||
          !validToken(body.token)
        )
          throw new PersistenceError("UNAUTHORIZED");
        const session = newToken();
        const result = await deps.access.exchange(body.token, session);
        return jsonResponse({ expiresAt: result.expiresAt }, 200, {
          "Set-Cookie": sessionCookie(session),
        });
      }
      const session = readSessionCookie(request);
      if (
        !(await deps.access.quota(
          hashToken(session),
          mutation ? "write" : "read",
        ))
      )
        throw new HttpError(
          429,
          "Demasiadas solicitudes. Inténtalo en un minuto.",
        );
      if (mutation) verifyCsrf(session, request.headers.get("x-csrf-token"));
      if (action === "context")
        return jsonResponse({
          ...(await deps.access.context(session)),
          csrfToken: csrfToken(session),
        });
      if (action === "list")
        return jsonResponse({ expenses: await deps.expenses.list(session) });
      if (action === "summary") {
        if (deps.payments) {
          const context = await deps.payments.context(session),
            full = summarizePaymentLedger(paymentLedger(context));
          return jsonResponse({
            summary: full.books,
            settlementMode: full.configuration.mode,
            includesPayments: true,
            originalExpenseTotals: full.originalExpenseTotals,
          });
        }
        const records = await deps.expenses.list(session);
        const summary = summarizeExpenses(
          records.map((e) => ({
            payerId: e.payerId,
            currency: e.currency,
            amountMinor: BigInt(e.amountMinor),
            splits: e.splits.map((s) => ({
              participantId: s.participantId,
              amountMinor: BigInt(s.amountMinor),
            })),
          })),
        );
        return jsonResponse({ summary });
      }
      if (action === "logout") {
        await deps.access.logout(session);
        return jsonResponse({ ok: true }, 200, {
          "Set-Cookie": expiredSessionCookie,
        });
      }
      if (action === "revoke") {
        const body = await readJson(request, 256);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("linkId" in body) ||
          typeof body.linkId !== "string"
        )
          throw new PersistenceError("INVALID_INPUT");
        await deps.access.revoke(session, body.linkId);
        return jsonResponse({ ok: true });
      }
      if (action === "payments") {
        if (!deps.payments) throw new PersistenceError("UNAVAILABLE");
        const context = await deps.payments.context(session),
          ledger = paymentLedger(context);
        const warnings = context.payments
          .filter((p) => p.state === "pending")
          .map((p) => ({
            paymentId: p.id,
            codes: paymentConfirmationWarnings(ledger, p.id),
          }));
        return jsonResponse({
          context,
          summary: summarizePaymentLedger(ledger),
          warnings,
        });
      }
      if (action === "paymentMutate") {
        if (!deps.payments) throw new PersistenceError("UNAVAILABLE");
        const command = await readJson(request);
        validatePaymentCommand(command);
        const key = request.headers.get("idempotency-key");
        if (!key) throw new PersistenceError("INVALID_INPUT");
        // Se vuelve a derivar el libro al confirmar. La función SQL bloquea el
        // viaje y exige la misma versión revisada; un reintento durable puede
        // devolver su resultado anterior incluso si el libro ya avanzó.
        if (command.operation === "confirm")
          paymentLedger(await deps.payments.context(session));
        return jsonResponse({
          context: await deps.payments.mutate(session, key, command),
        });
      }
      const body = await readJson(request);
      validateExpenseCommand(body);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (!idempotencyKey) throw new PersistenceError("INVALID_INPUT");
      const expense = await deps.expenses.mutate(session, idempotencyKey, body);
      return jsonResponse({ expense });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
