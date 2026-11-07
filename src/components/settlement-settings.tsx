"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  PaymentCommand,
  PaymentContext,
} from "@/server/payment-repository";
import type { summarizePaymentLedger } from "@/domain/payment-summary";
import { parseExchangeRate } from "@/domain/settlement";
import {
  forgetPending,
  recoverPending,
  rememberPending,
  type PendingOperation,
} from "@/domain/pending-operation";

type Session = { role: "admin" | "participant"; csrfToken: string };
type Snapshot = {
  context: PaymentContext;
  summary: ReturnType<typeof summarizePaymentLedger>;
};
type ConfigureCommand = Extract<PaymentCommand, { operation: "configure" }>;
class SettingsError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super("No se pudo completar la operación.");
  }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok)
    throw new SettingsError(
      response.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  return body as T;
}
function decimalRate(configuration: PaymentContext["configuration"]) {
  if (configuration.mode !== "consolidated") return "";
  const numerator = BigInt(configuration.rate.numerator);
  const denominator = BigInt(configuration.rate.denominator);
  const whole = numerator / denominator;
  let remainder = numerator % denominator;
  let decimals = "";
  while (remainder && decimals.length < 8) {
    remainder *= 10n;
    decimals += (remainder / denominator).toString();
    remainder %= denominator;
  }
  return remainder ? "" : `${whole}${decimals ? "." + decimals : ""}`;
}
export default function SettlementSettings() {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("separate");
  const [rate, setRate] = useState("");
  const [review, setReview] =
    useState<PendingOperation<ConfigureCommand> | null>(null);
  const [foreignPending, setForeignPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async (recover = true) => {
    try {
      const [actor, data] = await Promise.all([
        request<Session>("/api/session"),
        request<Snapshot>("/api/payments"),
      ]);
      if (actor.role !== "admin" || data.context.actor.role !== "admin")
        throw new SettingsError(403);
      setSession(actor);
      setSnapshot(data);
      setMode(data.context.configuration.mode);
      setRate(decimalRate(data.context.configuration));
      const pending = recover
        ? await recoverPending<PaymentCommand>(
            actor.csrfToken,
            sessionStorage,
            "payments",
          )
        : null;
      if (pending?.command.operation === "configure") {
        setReview(pending as PendingOperation<ConfigureCommand>);
        setUncertain(true);
      } else setForeignPending(!!pending);
    } catch (cause) {
      setSession(null);
      setSnapshot(null);
      setError(
        cause instanceof SettingsError && cause.status === 403
          ? "Solo el administrador puede configurar la liquidación."
          : cause instanceof SettingsError && cause.status === 401
            ? "La sesión terminó. Vuelve a entrar con tu enlace privado."
            : "No se pudo cargar la configuración. Recarga la página para intentarlo de nuevo.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!review && !saving) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [review, saving]);
  function guardNavigation(event: { preventDefault(): void }) {
    if (review || saving) {
      event.preventDefault();
      setError(
        "Termina la revisión o comprueba la operación pendiente antes de salir.",
      );
    }
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    if (
      !snapshot ||
      review ||
      saving ||
      foreignPending ||
      (snapshot.summary.configurationLocked &&
        snapshot.summary.configurationChosen)
    )
      return;
    setError("");
    setMessage("");
    try {
      const command: ConfigureCommand =
        mode === "separate"
          ? {
              operation: "configure",
              mode: "separate",
              expectedLedgerVersion: snapshot.context.ledgerVersion,
            }
          : ((): ConfigureCommand => {
              const parsed = parseExchangeRate(rate);
              return {
                operation: "configure",
                mode: "consolidated",
                rateNumerator: parsed.numerator.toString(),
                rateDenominator: parsed.denominator.toString(),
                expectedLedgerVersion: snapshot.context.ledgerVersion,
              };
            })();
      setReview({ key: crypto.randomUUID(), command });
    } catch {
      setError(
        "Introduce un tipo de cambio positivo con hasta ocho decimales.",
      );
    }
  }
  async function submit() {
    if (!session || !snapshot || !review || saving || session.role !== "admin")
      return;
    const wasUncertain = uncertain;
    let sent = false,
      committed = false;
    setSaving(true);
    setError("");
    try {
      await rememberPending(
        review,
        session.csrfToken,
        sessionStorage,
        "payments",
      );
      sent = true;
      await request("/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": review.key,
          "X-CSRF-Token": session.csrfToken,
        },
        body: JSON.stringify(review.command),
      });
      committed = true;
      try {
        forgetPending(sessionStorage, "payments");
      } catch {}
      setReview(null);
      setUncertain(false);
      setMessage("Configuración de liquidación guardada.");
      await load(false);
    } catch (cause) {
      if (cause instanceof SettingsError && cause.status === 401) {
        try {
          forgetPending(sessionStorage, "payments");
        } catch {}
        setReview(null);
        setUncertain(false);
        setSession(null);
        setSnapshot(null);
        setError("La sesión terminó. Vuelve a entrar con tu enlace privado.");
      } else if (
        cause instanceof SettingsError &&
        cause.status === 409 &&
        cause.code === "STALE_VERSION"
      ) {
        try {
          forgetPending(sessionStorage, "payments");
        } catch {}
        setReview(null);
        setUncertain(false);
        await load(false);
        setError(
          "Los saldos cambiaron. Revisa la configuración actual antes de confirmar de nuevo.",
        );
      } else if (
        !committed &&
        sent &&
        (wasUncertain ||
          !(cause instanceof SettingsError) ||
          cause.status >= 500)
      ) {
        setUncertain(true);
        setError(
          "No se pudo comprobar el resultado. Reintenta la misma configuración para evitar duplicados.",
        );
      } else {
        if (!wasUncertain) {
          try {
            forgetPending(sessionStorage, "payments");
          } catch {}
          setReview(null);
        }
        setError(
          "No se pudo guardar la configuración. Comprueba los pagos pendientes y los permisos antes de intentarlo de nuevo.",
        );
      }
    } finally {
      setSaving(false);
    }
  }
  const blocked = saving || !!review || foreignPending;
  return (
    <main>
      <header className="payment-header">
        <Link href="/administrar" onNavigate={guardNavigation}>
          ← Administración
        </Link>
        <h1>Configuración de liquidación</h1>
        <Link href="/pagos" onNavigate={guardNavigation}>
          Liquidar saldos
        </Link>
      </header>
      {loading ? <p role="status">Cargando configuración…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="notice">
          {message}
        </p>
      ) : null}
      {!loading && session && snapshot ? (
        <>
          <p>
            Elige cómo se saldarán los gastos del viaje. Esta configuración se
            aplica a todos los participantes.
          </p>
          {snapshot.summary.configurationLocked ? (
            <p className="notice">
              La configuración está bloqueada mientras existan pagos pendientes
              o confirmados. Resuelve los pendientes y anula los confirmados
              antes de cambiar el modo o el tipo de cambio.
            </p>
          ) : null}
          {foreignPending ? (
            <p className="notice">
              Hay un pago pendiente de comprobar.{" "}
              <Link href="/pagos">Compruébalo en Liquidar saldos</Link> antes de
              cambiar la configuración.
            </p>
          ) : null}
          <form className="editor expense-fields" onSubmit={prepare}>
            <fieldset disabled={blocked}>
              <label htmlFor="settlement-mode">Modo</label>
              <select
                disabled={snapshot.summary.configurationLocked}
                id="settlement-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="separate">Monedas separadas</option>
                <option value="consolidated">Consolidar en PEN</option>
              </select>
              {mode === "consolidated" ? (
                <>
                  <label htmlFor="settlement-rate">PEN por USD</label>
                  <input
                    disabled={snapshot.summary.configurationLocked}
                    id="settlement-rate"
                    inputMode="decimal"
                    required
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                  />
                  <p>
                    Los gastos en USD se convierten a PEN con esta tasa,
                    conservando el reparto al céntimo. Los gastos originales no
                    se modifican.
                  </p>
                </>
              ) : (
                <p>Los saldos en PEN y USD se liquidan por separado.</p>
              )}
              <button
                type="submit"
                disabled={
                  snapshot.summary.configurationLocked &&
                  snapshot.summary.configurationChosen
                }
              >
                Revisar configuración
              </button>
            </fieldset>
          </form>
          {review ? (
            <section
              className="confirmation"
              aria-label="Revisión de configuración"
            >
              <h2>
                {uncertain
                  ? "Configuración pendiente de comprobar"
                  : "Revisa antes de confirmar"}
              </h2>
              <p>
                {review.command.mode === "separate"
                  ? "Monedas separadas"
                  : `Consolidar en PEN · PEN por USD: ${review.command.rateNumerator}/${review.command.rateDenominator}`}
              </p>
              <p>Versión revisada: {review.command.expectedLedgerVersion}.</p>
              <button disabled={saving} onClick={() => void submit()}>
                {saving
                  ? "Guardando…"
                  : uncertain
                    ? "Reintentar la misma operación"
                    : "Confirmar configuración"}
              </button>
              {!uncertain ? (
                <button disabled={saving} onClick={() => setReview(null)}>
                  Cancelar
                </button>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
