"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import PaymentModal from "./payment-modal";
import type {
  PaymentCommand,
  PaymentContext,
} from "../server/payment-repository";
import type { summarizePaymentLedger } from "../domain/payment-summary";
import type { ConfirmationWarning } from "../domain/payments";
import { formatMoney, type Currency } from "../domain/money";
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
type Position = {
  expenseId: string;
  senderId: string;
  receiverId: string;
  currency: Currency;
  amountMinor: string;
  confirmedMinor: string;
  pendingMinor: string;
  remainingMinor: string;
  description: string;
  spentOn: string;
};
function available(position: Position) {
  const value = BigInt(position.remainingMinor) - BigInt(position.pendingMinor);
  return value > 0n ? value : 0n;
}
function sumPositions(
  positions: Position[],
  kind: "remainingMinor" | "pendingMinor" | "available",
) {
  return positions.reduce(
    (sum, p) => sum + (kind === "available" ? available(p) : BigInt(p[kind])),
    0n,
  );
}
export default function PaymentWorkspace() {
  const modalReturnFocus = useRef<HTMLElement | null>(null);
  const [session, setSession] = useState<Session | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [sender, setSender] = useState("");
  const [paymentDraft, setPaymentDraft] = useState<Extract<
    PaymentCommand,
    { operation: "register" | "receive" }
  > | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
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
  const load = useCallback(
    () =>
      Promise.all([
        api<Session>("/api/session"),
        api<Snapshot>("/api/payments"),
      ])
        .then(async ([s, data]) => {
          const pending = await recoverPending<PaymentCommand>(
            s.csrfToken,
            sessionStorage,
            "payments",
          );
          setSession(s);
          setSnapshot(data);
          setSender(s.participantId ?? s.participants[0]?.id ?? "");
          if (pending) {
            setReview(pending);
            setUncertain(true);
          }
        })
        .catch(fail)
        .finally(() => setLoading(false)),
    [fail],
  );
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
    if (!saving && !uncertain && !review && !paymentDraft) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saving, uncertain, review, paymentDraft]);
  const name = (id: string) =>
    session?.participants.find((p) => p.id === id)?.displayName ?? id;
  const money = (value: string, c: Currency) => formatMoney(BigInt(value), c);
  const blocked = !!review || saving;
  function prepare(command: PaymentCommand) {
    if (blocked) return;
    if (!paymentDraft)
      modalReturnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
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
      setPaymentDraft(null);
      setMessage(
        review.command.operation === "register"
          ? "Pago registrado. Esperando confirmación del receptor."
          : review.command.operation === "receive"
            ? "Recepción registrada. Los saldos se actualizaron."
            : review.command.operation === "confirm"
              ? "Recepción confirmada. Los saldos se actualizaron."
              : "Operación registrada.",
      );
      const fresh = await api<Snapshot>("/api/payments");
      setSnapshot(fresh);
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
        setPaymentDraft(null);
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
  const positions = context.positions ?? [];
  const currentSender = admin ? sender : (session.participantId ?? "");
  const outgoing = positions.filter(
    (p) => p.senderId === currentSender && BigInt(p.remainingMinor) > 0n,
  );
  const receivers = session.participants.filter((p) =>
    outgoing.some((position) => position.receiverId === p.id),
  );
  const reconciliations = context.reconciliationRequired ?? [];
  const reconciliation = reconciliations.some(
    (p) => p.senderId === currentSender || p.receiverId === currentSender,
  );
  const canChoose =
    !blocked && !paymentDraft && summary.configurationChosen && !reconciliation;
  const relatedPayments = context.payments.filter(
    (p) =>
      admin || p.senderId === currentSender || p.receiverId === currentSender,
  );
  const incoming = positions.filter(
    (p) => p.receiverId === currentSender && BigInt(p.remainingMinor) > 0n,
  );
  function choosePayment(selected: Position[], received = false) {
    if (!canChoose || !selected.length) return;
    const first = selected[0];
    const payable = selected.filter((p) => available(p) > 0n);
    if (payable.length > 200) {
      setError(
        "Este pago reúne más de 200 gastos. Despliega el detalle y salda los gastos individualmente.",
      );
      return;
    }
    const total = sumPositions(payable, "available");
    if (
      total <= 0n ||
      payable.some(
        (p) =>
          p.senderId !== (received ? first.senderId : currentSender) ||
          p.receiverId !== (received ? currentSender : first.receiverId) ||
          p.currency !== first.currency,
      )
    )
      return;
    setError("");
    setMessage("");
    modalReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPaymentDraft({
      operation: received ? "receive" : "register",
      senderId: received ? first.senderId : currentSender,
      receiverId: received ? currentSender : first.receiverId,
      currency: first.currency,
      amountMinor: total.toString(),
      expenseIds: payable.map((p) => p.expenseId),
      expectedLedgerVersion: context.ledgerVersion,
    });
  }
  return (
    <main>
      <header className="payment-header settlement-page-header">
        <Link
          href="/"
          onNavigate={(event) => {
            if (saving || uncertain) {
              event.preventDefault();
              return;
            }
            if (
              (review || paymentDraft) &&
              !window.confirm(
                "Hay un pago sin confirmar. ¿Quieres descartarlo y volver al inicio?",
              )
            )
              event.preventDefault();
          }}
        >
          ← Volver al inicio
        </Link>
        <h1>Liquidar saldos</h1>
        <p>
          Realiza la transferencia fuera del app y registra el pago. El receptor
          confirmará que lo recibió.
        </p>
      </header>
      {error && !paymentDraft && !review && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!summary.configurationChosen ? (
        <aside className="notice" role="status">
          El administrador debe elegir el modo de liquidación antes de registrar
          pagos.
          {admin ? (
            <>
              {" "}
              <Link href="/administrar/liquidacion">
                Configurar liquidación
              </Link>
            </>
          ) : null}
        </aside>
      ) : null}
      {admin ? (
        <label className="settlement-participant">
          Participante para liquidar
          <select
            aria-label="Participante para liquidar"
            value={currentSender}
            disabled={blocked || !!paymentDraft}
            onChange={(e) => setSender(e.target.value)}
          >
            {session.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <section
        className="settlement-debts"
        aria-labelledby="settlement-debts-heading"
      >
        <h2 id="settlement-debts-heading">
          {admin
            ? `Saldos de ${name(currentSender)}`
            : "Tus saldos pendientes de pago"}
        </h2>
        <p className="hint">
          Partes pendientes de los gastos de cada persona. Los importes en
          espera de confirmación ya están reservados.
        </p>
        {context.positions === undefined ? (
          <p role="alert">
            No se pudo cargar el detalle de las deudas. Vuelve a abrir esta
            página antes de pagar.
          </p>
        ) : reconciliation ? (
          <p role="alert" className="notice">
            Hay pagos anteriores que requieren conciliación administrativa. Por
            seguridad, no registres otro pago hasta que se revisen.
          </p>
        ) : null}
        {context.positions !== undefined &&
        !receivers.length &&
        !reconciliation ? (
          <p>No tienes saldos pendientes de pago.</p>
        ) : null}
        {receivers.map((person) => {
          const personPositions = outgoing.filter(
            (p) => p.receiverId === person.id,
          );
          return (
            <article
              className="settlement-person-card"
              key={person.id}
              aria-label={`Deudas con ${person.displayName}`}
            >
              <p className="eyebrow">LE DEBES A</p>
              <h3>{person.displayName}</h3>
              <div className="settlement-person-totals">
                {(["PEN", "USD"] as const).map((currency) => {
                  const shares = personPositions.filter(
                    (p) => p.currency === currency,
                  );
                  if (!shares.length) return null;
                  const pending = sumPositions(shares, "pendingMinor");
                  const free = sumPositions(shares, "available");
                  return (
                    <div key={currency}>
                      <strong>
                        {money(
                          sumPositions(shares, "remainingMinor").toString(),
                          currency,
                        )}
                      </strong>
                      {pending > 0n ? (
                        <p>
                          Esperando confirmación:{" "}
                          {money(pending.toString(), currency)}
                        </p>
                      ) : null}
                      <button
                        disabled={!canChoose || free === 0n}
                        onClick={() => choosePayment(shares)}
                      >
                        Saldar total {currency}
                      </button>
                      {pending > 0n && free > 0n ? (
                        <p className="hint">
                          Disponible para saldar:{" "}
                          {money(free.toString(), currency)}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <details className="settlement-expense-details">
                <summary aria-label={`Ver gastos con ${person.displayName}`}>
                  Ver gastos con {person.displayName}
                </summary>
                {personPositions.map((position) => (
                  <article
                    className="settlement-expense"
                    key={position.expenseId}
                  >
                    <div>
                      <h4>{position.description}</h4>
                      <p>
                        {position.spentOn} · Pendiente:{" "}
                        {money(position.remainingMinor, position.currency)}
                      </p>
                      {BigInt(position.pendingMinor) > 0n ? (
                        <p>
                          Esperando confirmación:{" "}
                          {money(position.pendingMinor, position.currency)}
                        </p>
                      ) : null}
                    </div>
                    <button
                      disabled={!canChoose || available(position) === 0n}
                      onClick={() => choosePayment([position])}
                    >
                      Saldar este gasto
                    </button>
                  </article>
                ))}
              </details>
            </article>
          );
        })}
      </section>
      {incoming.length ? (
        <section
          className="settlement-receivables"
          aria-labelledby="settlement-receivables-title"
        >
          <h2 id="settlement-receivables-title">Pendiente de cobrar</h2>
          <p className="hint">
            Registra solo dinero que ya recibiste. Si el deudor registró un
            pago, confirma su recepción en ese mismo pago.
          </p>
          {session.participants
            .filter((person) =>
              incoming.some((position) => position.senderId === person.id),
            )
            .map((person) => {
              const debts = incoming.filter(
                (position) => position.senderId === person.id,
              );
              const pendingPayments = context.payments.filter(
                (payment) =>
                  payment.senderId === person.id &&
                  payment.receiverId === currentSender &&
                  payment.state === "pending",
              );
              return (
                <article
                  className="settlement-person-card"
                  key={person.id}
                  aria-label={`Cobros de ${person.displayName}`}
                >
                  <p className="eyebrow">TE DEBE</p>
                  <h3>{person.displayName}</h3>
                  <div className="settlement-person-totals">
                    {(["PEN", "USD"] as const).map((currency) => {
                      const shares = debts.filter(
                        (position) => position.currency === currency,
                      );
                      if (!shares.length) return null;
                      const reserved = sumPositions(shares, "pendingMinor");
                      const free = sumPositions(shares, "available");
                      return (
                        <div key={currency}>
                          <strong>
                            {money(
                              sumPositions(shares, "remainingMinor").toString(),
                              currency,
                            )}
                          </strong>
                          {reserved > 0n ? (
                            <p>
                              Pago pendiente de recepción:{" "}
                              {money(reserved.toString(), currency)}
                            </p>
                          ) : null}
                          {reserved > 0n && free > 0n ? (
                            <p>
                              Disponible para registrar como recibido:{" "}
                              {money(free.toString(), currency)}
                            </p>
                          ) : null}
                          <button
                            disabled={!canChoose || free === 0n}
                            onClick={() => choosePayment(shares, true)}
                          >
                            Marcar total recibido {currency}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {pendingPayments.length ? (
                    <div className="settlement-pending-receipts">
                      <h4>Pagos por confirmar</h4>
                      {pendingPayments.map((payment) => (
                        <div key={payment.id}>
                          <span>
                            {money(payment.amountMinor, payment.currency)}
                          </span>
                          <button
                            disabled={
                              blocked ||
                              !!paymentDraft ||
                              !summary.configurationChosen
                            }
                            onClick={() =>
                              prepare({
                                operation: "confirm",
                                id: payment.id,
                                expectedPaymentVersion: payment.version,
                                expectedLedgerVersion: context.ledgerVersion,
                                reviewedLedgerVersion: context.ledgerVersion,
                              })
                            }
                          >
                            Confirmar recepción pendiente
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <details className="settlement-expense-details">
                    <summary
                      aria-label={`Ver gastos que debe ${person.displayName}`}
                    >
                      Ver gastos que debe {person.displayName}
                    </summary>
                    {debts.map((position) => (
                      <article
                        className="settlement-expense"
                        key={position.expenseId}
                      >
                        <div>
                          <h4>{position.description}</h4>
                          <p>
                            {position.spentOn} · Pendiente:{" "}
                            {money(position.remainingMinor, position.currency)}
                          </p>
                          {BigInt(position.pendingMinor) > 0n ? (
                            <p>
                              Pago pendiente de recepción:{" "}
                              {money(position.pendingMinor, position.currency)}
                            </p>
                          ) : null}
                          {BigInt(position.pendingMinor) > 0n &&
                          available(position) > 0n ? (
                            <p>
                              Disponible para registrar:{" "}
                              {money(
                                available(position).toString(),
                                position.currency,
                              )}
                            </p>
                          ) : null}
                        </div>
                        <button
                          disabled={!canChoose || available(position) === 0n}
                          onClick={() => choosePayment([position], true)}
                        >
                          Marcar gasto recibido
                        </button>
                      </article>
                    ))}
                  </details>
                </article>
              );
            })}
        </section>
      ) : null}
      <section>
        <h2>Pagos registrados</h2>
        {relatedPayments.length === 0 && <p>Aún no hay pagos.</p>}
        {relatedPayments.map((p) => (
          <article className="expense-card" key={p.id}>
            <h3>
              {name(p.senderId)} → {name(p.receiverId)} ·{" "}
              {money(p.amountMinor, p.currency)}
            </h3>
            <p>
              {p.state === "pending"
                ? p.senderId === currentSender
                  ? "Esperando confirmación"
                  : "Por confirmar recepción"
                : states[p.state]}
            </p>
            {p.state === "voided" && (
              <p>Motivo: {p.voidReason ?? "Reservado a administración"}</p>
            )}
            {p.state === "pending" &&
              (admin || session.participantId === p.receiverId) && (
                <div className="actions">
                  <button
                    disabled={
                      blocked || !!paymentDraft || !summary.configurationChosen
                    }
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
                    disabled={blocked || !!paymentDraft}
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
                    disabled={blocked || !!paymentDraft}
                    value={reasons[p.id] ?? ""}
                    onChange={(e) =>
                      setReasons({ ...reasons, [p.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  disabled={blocked || !!paymentDraft || !reasons[p.id]?.trim()}
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
      <PaymentModal
        open={!!paymentDraft || !!review}
        locked={saving || uncertain}
        returnFocusRef={modalReturnFocus}
        step={paymentDraft ? "draft" : uncertain ? "uncertain" : "review"}
        onCancel={() => {
          if (saving || uncertain) return;
          setPaymentDraft(null);
          setReview(null);
          setAck(false);
        }}
      >
        {paymentDraft ? (
          <section
            className="settlement-payment-draft"
            id="settlement-payment-review"
            aria-labelledby="payment-modal-title"
          >
            <h2 id="payment-modal-title" tabIndex={-1}>
              {paymentDraft.operation === "receive"
                ? "Revisa el cobro"
                : "Revisa tu pago"}
            </h2>
            <p>
              De {name(paymentDraft.senderId)} para{" "}
              {name(paymentDraft.receiverId)}
            </p>
            <strong>
              {money(paymentDraft.amountMinor, paymentDraft.currency)}
            </strong>
            <p>
              Se aplicará a {paymentDraft.expenseIds?.length ?? 0} gasto(s). El
              importe y el destinatario corresponden a las deudas seleccionadas.
            </p>
            <p>
              {paymentDraft.operation === "receive"
                ? "Continúa solo si ya recibiste este dinero. Al confirmar, se saldarán las partes indicadas y quedará registrada tu confirmación de recepción."
                : "Haz la transferencia por fuera del app. Continúa solo cuando la hayas realizado."}
            </p>
            <div className="actions">
              <button
                disabled={blocked}
                onClick={() => {
                  prepare(paymentDraft);
                  setPaymentDraft(null);
                }}
              >
                {paymentDraft.operation === "receive"
                  ? "Ya recibí el pago"
                  : "Ya realicé el pago"}
              </button>
              <button disabled={saving} onClick={() => setPaymentDraft(null)}>
                Cancelar
              </button>
            </div>
          </section>
        ) : null}
        {review && (
          <section
            className="confirmation"
            id="payment-confirmation"
            aria-label="Revisión de operación"
          >
            <h2 id="payment-modal-title" tabIndex={-1}>
              {uncertain
                ? "Operación con resultado incierto"
                : "Revisa antes de confirmar"}
            </h2>
            <p>
              Operación:{" "}
              {
                {
                  register: "registrar pago externo",
                  receive: "registrar dinero recibido",
                  confirm: "confirmar recepción",
                  reject: "rechazar pago",
                  void: "anular pago",
                  configure: "elegir configuración",
                }[review.command.operation]
              }
              .
            </p>
            {(review.command.operation === "register" ||
              review.command.operation === "receive") && (
              <p>
                {name(review.command.senderId)} →{" "}
                {name(review.command.receiverId)}:{" "}
                {money(review.command.amountMinor, review.command.currency)}
              </p>
            )}
            {reviewPayment && (
              <p>
                {name(reviewPayment.senderId)} →{" "}
                {name(reviewPayment.receiverId)}:{" "}
                {money(reviewPayment.amountMinor, reviewPayment.currency)}
              </p>
            )}
            {review.command.operation === "void" && (
              <p>Motivo: {review.command.reason}</p>
            )}
            {review.command.operation === "configure" ? (
              <p>
                Completa esta operación en{" "}
                <Link href="/administrar/liquidacion">
                  Configuración de liquidación
                </Link>
                .
              </p>
            ) : null}
            <p>
              Versión revisada del libro: {review.command.expectedLedgerVersion}
              .
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
                disabled={
                  saving ||
                  review.command.operation === "configure" ||
                  (warnings.length > 0 && !ack)
                }
                onClick={() => void submit()}
              >
                {saving
                  ? "Guardando…"
                  : uncertain
                    ? "Reintentar la misma operación"
                    : review.command.operation === "receive"
                      ? "Confirmar recepción"
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
        {error && (paymentDraft || review) ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </PaymentModal>
    </main>
  );
}
