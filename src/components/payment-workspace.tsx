"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  PaymentCommand,
  PaymentContext,
} from "../server/payment-repository";
import type { summarizePaymentLedger } from "../domain/payment-summary";
import type { ConfirmationWarning } from "../domain/payments";
import { formatMoney, parseMoney, type Currency } from "../domain/money";
import { parseExchangeRate } from "../domain/settlement";
import {
  rememberPending,
  recoverPending,
  forgetPending,
  type PendingOperation,
} from "../domain/pending-operation";
type Session = {
  role: "participant" | "admin";
  participantId: string | null;
  participants: { id: string; displayName: string }[];
  csrfToken: string;
};
type Snapshot = {
  context: PaymentContext;
  summary: ReturnType<typeof summarizePaymentLedger>;
  warnings: { paymentId: string; codes: ConfirmationWarning[] }[];
};
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof data.error === "string"
        ? data.error
        : "No se pudo completar la operación.",
      typeof data.code === "string" ? data.code : undefined,
    );
  return data as T;
}
const warningText: Record<ConfirmationWarning, string> = {
  SENDER_HAS_NO_NET_DEBT: "El emisor no tiene deuda neta.",
  RECEIVER_HAS_NO_NET_CREDIT: "El receptor no tiene crédito neto.",
  EXCEEDS_NET_DEBT: "El pago supera la deuda neta del emisor.",
  EXCEEDS_NET_CREDIT: "El pago supera el crédito neto del receptor.",
};
const states = {
  pending: "Pendiente",
  confirmed: "Confirmado",
  rejected: "Rechazado",
  voided: "Anulado",
};
export default function PaymentWorkspace() {
  const [session, setSession] = useState<Session | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [sender, setSender] = useState(""),
    [receiver, setReceiver] = useState(""),
    [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState<Currency>("PEN"),
    [mode, setMode] = useState("separate"),
    [rate, setRate] = useState(""),
    [reasons, setReasons] = useState<Record<string, string>>({});
  const [review, setReview] = useState<PendingOperation<PaymentCommand> | null>(
      null,
    ),
    [uncertain, setUncertain] = useState(false),
    [saving, setSaving] = useState(false),
    [ack, setAck] = useState(false),
    [message, setMessage] = useState("");
  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      setSession(null);
      setSnapshot(null);
      setReview(null);
      setUncertain(false);
      try {
        forgetPending(sessionStorage, "payments");
      } catch {}
      setError("La sesión terminó. Vuelve a entrar con tu enlace privado.");
    } else
      setError(
        cause instanceof ApiError
          ? cause.message
          : "No se pudo conectar. Inténtalo de nuevo.",
      );
  }, []);
  const load = useCallback(async () => {
    try {
      const [s, data] = await Promise.all([
        api<Session>("/api/session"),
        api<Snapshot>("/api/payments"),
      ]);
      const pending = await recoverPending<PaymentCommand>(
        s.csrfToken,
        sessionStorage,
        "payments",
      );
      setSession(s);
      setSnapshot(data);
      setSender(s.participantId ?? s.participants[0]?.id ?? "");
      setMode(data.context.configuration.mode);
      if (data.context.configuration.mode === "consolidated")
        setCurrency("PEN");
      if (pending) {
        setReview(pending);
        setUncertain(true);
      }
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }, [fail]);
  function reload() {
    setLoading(true);
    setSnapshot(null);
    setError("");
    void load();
  }
  useEffect(() => {
    void load();
  }, [load]); // Session and ledger are always loaded together.
  useEffect(() => {
    if (!saving && !uncertain) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saving, uncertain]);
  const name = (id: string) =>
    session?.participants.find((p) => p.id === id)?.displayName ?? id;
  const money = (value: string, c: Currency) => formatMoney(BigInt(value), c);
  const blocked = !!review || saving;
  function prepare(command: PaymentCommand) {
    if (blocked) return;
    setError("");
    setMessage("");
    setAck(false);
    setReview({ key: crypto.randomUUID(), command });
  }
  async function submit() {
    if (!session || !review || saving) return;
    const wasUncertain = uncertain;
    setSaving(true);
    setError("");
    let sent = false,
      committed = false;
    try {
      await rememberPending(
        review,
        session.csrfToken,
        sessionStorage,
        "payments",
      );
      sent = true;
      await api("/api/payments", {
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
      } catch {
        /* The server confirmed success; storage cleanup cannot make the result uncertain. */
      }
      setReview(null);
      setUncertain(false);
      setSnapshot(null);
      setAmount("");
      setMessage("Operación registrada.");
      const fresh = await api<Snapshot>("/api/payments");
      setSnapshot(fresh);
      setMode(fresh.context.configuration.mode);
      if (fresh.context.configuration.mode === "consolidated")
        setCurrency("PEN");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        fail(e);
      } else if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.code === "STALE_VERSION"
      ) {
        try {
          forgetPending(sessionStorage, "payments");
        } catch {}
        setReview(null);
        setUncertain(false);
        setSnapshot(null);
        setAck(false);
        setMessage(
          "El libro cambió. Revisa los saldos actuales antes de preparar otra operación.",
        );
        setLoading(true);
        await load();
      } else if (
        !committed &&
        sent &&
        (wasUncertain || !(e instanceof ApiError) || e.status >= 500)
      ) {
        setUncertain(true);
        setError(
          "El resultado es incierto. Reintenta esta misma operación para comprobarlo sin duplicarla.",
        );
      } else {
        if (!wasUncertain) {
          try {
            forgetPending(sessionStorage, "payments");
          } catch {}
          setReview(null);
        }
        fail(e);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return (
      <main>
        <p role="status">Cargando pagos…</p>
      </main>
    );
  if (!session || !snapshot)
    return (
      <main>
        <h1>Pagos del viaje</h1>
        <p role="alert">{error || "No se pudo actualizar el libro."}</p>
        <button onClick={reload}>Volver a cargar</button>
        <p>
          <Link href="/entrar">Acceso privado</Link>
        </p>
      </main>
    );
  const { context, summary } = snapshot;
  const admin = session.role === "admin";
  const command = review?.command;
  const reviewedId = command && "id" in command ? command.id : null;
  const reviewPayment = context.payments.find((p) => p.id === reviewedId);
  const warnings =
    command?.operation === "confirm"
      ? (snapshot.warnings.find((w) => w.paymentId === reviewedId)?.codes ?? [])
      : [];
  return (
    <main>
      <header className="payment-header">
        <Link
          href="/gastos"
          onNavigate={(event) => {
            if (
              (saving || uncertain) &&
              !window.confirm(
                "Hay una operación pendiente de comprobar. ¿Quieres salir de pagos?",
              )
            )
              event.preventDefault();
          }}
        >
          ← Gastos
        </Link>
        <h1>Pagos y cierre</h1>
        <button disabled={blocked} onClick={reload}>
          Actualizar libro
        </button>
        <p>
          Solo registra transferencias realizadas fuera de la aplicación. Esta
          aplicación no envía dinero.
        </p>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="preview">
        <h2>Libro vigente · versión {context.ledgerVersion}</h2>
        <p>
          Totales originales: {money(summary.originalExpenseTotals.PEN, "PEN")}{" "}
          y {money(summary.originalExpenseTotals.USD, "USD")}.
        </p>
        <p>
          Liquidación:{" "}
          {context.configuration.mode === "separate"
            ? "monedas separadas"
            : `consolidada en PEN · tasa ${context.configuration.rate.numerator}/${context.configuration.rate.denominator} PEN por USD`}
          .
        </p>
        <p>
          {summary.configurationChosen
            ? "Configuración elegida por administración."
            : "Falta la elección administrativa antes de confirmar pagos."}{" "}
          {summary.configurationLocked
            ? "Configuración bloqueada por pagos pendientes o confirmados."
            : ""}
        </p>
        <p>
          {summary.closed
            ? "Cuentas saldadas."
            : "Quedan saldos o pagos pendientes."}
        </p>
        {(["PEN", "USD"] as const).map((c) => (
          <div key={c}>
            <h3>{c}</h3>
            {summary.books[c].balances.map((b) => (
              <p key={b.participantId}>
                {name(b.participantId)}: {money(b.amountMinor, c)}
              </p>
            ))}
            <h4>Transferencias propuestas</h4>
            {summary.books[c].transfers.length ? (
              summary.books[c].transfers.map((t, i) => (
                <p key={i}>
                  {name(t.senderId)} → {name(t.receiverId)}:{" "}
                  {money(t.amountMinor, c)}
                </p>
              ))
            ) : (
              <p>Sin transferencias propuestas.</p>
            )}
          </div>
        ))}
      </section>
      {admin && (
        <form
          className="editor expense-fields"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              if (mode === "separate")
                prepare({
                  operation: "configure",
                  mode: "separate",
                  expectedLedgerVersion: context.ledgerVersion,
                });
              else {
                const r = parseExchangeRate(rate);
                prepare({
                  operation: "configure",
                  mode: "consolidated",
                  rateNumerator: r.numerator.toString(),
                  rateDenominator: r.denominator.toString(),
                  expectedLedgerVersion: context.ledgerVersion,
                });
              }
            } catch {
              setError("Introduce una tasa positiva válida.");
            }
          }}
        >
          <h2>Configuración de liquidación</h2>
          <label>
            Modo
            <select
              disabled={blocked || summary.configurationLocked}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="separate">Monedas separadas</option>
              <option value="consolidated">Consolidar en PEN</option>
            </select>
          </label>
          {mode === "consolidated" && (
            <label>
              PEN por USD
              <input
                disabled={blocked || summary.configurationLocked}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                inputMode="decimal"
                required
              />
            </label>
          )}
          <button
            disabled={
              blocked ||
              (summary.configurationLocked && summary.configurationChosen)
            }
          >
            Revisar configuración
          </button>
        </form>
      )}
      <form
        className="editor expense-fields"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            if (!sender || !receiver || sender === receiver) throw new Error();
            prepare({
              operation: "register",
              senderId: admin ? sender : session.participantId!,
              receiverId: receiver,
              amountMinor: parseMoney(amount).toString(),
              currency,
              expectedLedgerVersion: context.ledgerVersion,
            });
          } catch {
            setError(
              "Revisa emisor, receptor e importe positivo con hasta dos decimales.",
            );
          }
        }}
      >
        <h2>Registrar pago externo</h2>
        <label>
          Emisor
          <select
            disabled={blocked || !admin}
            value={sender}
            onChange={(e) => setSender(e.target.value)}
          >
            {session.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Receptor
          <select
            disabled={blocked}
            value={receiver}
            onChange={(e) => setReceiver(e.target.value)}
            required
          >
            <option value="">Selecciona receptor</option>
            {session.participants
              .filter((p) => p.id !== sender)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </label>
        <label>
          Importe
          <input
            disabled={blocked}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
          />
        </label>
        <label>
          Moneda
          <select
            disabled={blocked}
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            <option>PEN</option>
            {context.configuration.mode === "separate" && <option>USD</option>}
          </select>
        </label>
        <p>
          Puede ser un pago parcial. El receptor debe confirmarlo para que
          afecte los saldos.
        </p>
        <button disabled={blocked}>Revisar pago</button>
      </form>
      <section>
        <h2>Pagos registrados</h2>
        {context.payments.length === 0 && <p>Aún no hay pagos.</p>}
        {context.payments.map((p) => (
          <article className="expense-card" key={p.id}>
            <h3>
              {name(p.senderId)} → {name(p.receiverId)} ·{" "}
              {money(p.amountMinor, p.currency)}
            </h3>
            <p>
              {states[p.state]} · versión {p.version}
            </p>
            {p.state === "voided" && (
              <p>Motivo: {p.voidReason ?? "Reservado a administración"}</p>
            )}
            {p.state === "pending" &&
              (admin || session.participantId === p.receiverId) && (
                <div className="actions">
                  <button
                    disabled={blocked || !summary.configurationChosen}
                    onClick={() =>
                      prepare({
                        operation: "confirm",
                        id: p.id,
                        expectedPaymentVersion: p.version,
                        expectedLedgerVersion: context.ledgerVersion,
                        reviewedLedgerVersion: context.ledgerVersion,
                      })
                    }
                  >
                    Revisar confirmación
                  </button>
                  <button
                    disabled={blocked}
                    onClick={() =>
                      prepare({
                        operation: "reject",
                        id: p.id,
                        expectedPaymentVersion: p.version,
                        expectedLedgerVersion: context.ledgerVersion,
                      })
                    }
                  >
                    Revisar rechazo
                  </button>
                </div>
              )}
            {admin && p.state === "confirmed" && (
              <div>
                <label>
                  Motivo de anulación
                  <input
                    maxLength={500}
                    disabled={blocked}
                    value={reasons[p.id] ?? ""}
                    onChange={(e) =>
                      setReasons({ ...reasons, [p.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  disabled={blocked || !reasons[p.id]?.trim()}
                  onClick={() =>
                    prepare({
                      operation: "void",
                      id: p.id,
                      expectedPaymentVersion: p.version,
                      expectedLedgerVersion: context.ledgerVersion,
                      reason: reasons[p.id].trim(),
                    })
                  }
                >
                  Revisar anulación
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      {review && (
        <section className="confirmation" aria-label="Revisión de operación">
          <h2>
            {uncertain
              ? "Operación con resultado incierto"
              : "Revisa antes de confirmar"}
          </h2>
          <p>
            Operación:{" "}
            {
              {
                register: "registrar pago externo",
                confirm: "confirmar recepción",
                reject: "rechazar pago",
                void: "anular pago",
                configure: "elegir configuración",
              }[review.command.operation]
            }
            .
          </p>
          {review.command.operation === "register" && (
            <p>
              {name(review.command.senderId)} →{" "}
              {name(review.command.receiverId)}:{" "}
              {money(review.command.amountMinor, review.command.currency)}
            </p>
          )}
          {reviewPayment && (
            <p>
              {name(reviewPayment.senderId)} → {name(reviewPayment.receiverId)}:{" "}
              {money(reviewPayment.amountMinor, reviewPayment.currency)}
            </p>
          )}
          {review.command.operation === "void" && (
            <p>Motivo: {review.command.reason}</p>
          )}
          {review.command.operation === "configure" && (
            <p>
              {review.command.mode === "separate"
                ? "Monedas separadas"
                : `Consolidar en PEN · tasa ${review.command.rateNumerator}/${review.command.rateDenominator}`}
            </p>
          )}
          <p>
            Versión revisada del libro: {review.command.expectedLedgerVersion}.
          </p>
          {warnings.map((w) => (
            <p key={w} role="alert">
              {warningText[w]}
            </p>
          ))}
          {warnings.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              He revisado las advertencias y los saldos vigentes.
            </label>
          )}
          <div className="actions">
            <button
              disabled={saving || (warnings.length > 0 && !ack)}
              onClick={() => void submit()}
            >
              {saving
                ? "Guardando…"
                : uncertain
                  ? "Reintentar la misma operación"
                  : "Confirmar operación"}
            </button>
            {!uncertain && (
              <button disabled={saving} onClick={() => setReview(null)}>
                Cancelar
              </button>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
