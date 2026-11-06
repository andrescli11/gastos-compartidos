"use client";
import Link from "next/link";
import {
  rememberPending,
  recoverPending,
  forgetPending,
} from "@/domain/pending-operation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  equalSplit,
  formatMoney,
  parseMoney,
  validateCustomSplit,
  type Currency,
  type Split,
} from "@/domain/money";
import type { CurrencySummary } from "@/domain/summary";
import type {
  ExpenseCommand,
  ExpenseRecord,
} from "@/server/expense-repository";
import type { SessionContext } from "@/server/access-repository";
type Context = SessionContext & { csrfToken: string };
type SummaryResponse = {
  summary: Record<Currency, CurrencySummary>;
  settlementMode?: "separate" | "consolidated";
};
class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : "No se pudo completar la operación.",
      response.status,
      data.code,
    );
  return data as T;
}
const decimal = (value: string) => {
  const n = BigInt(value);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, "0")}`;
};
export default function ExpenseWorkspace({
  entry = false,
}: {
  entry?: boolean;
}) {
  const [context, setContext] = useState<Context | null>(null),
    [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [summary, setSummary] = useState<Record<
    Currency,
    CurrencySummary
  > | null>(null);
  const [loading, setLoading] = useState(true),
    [message, setMessage] = useState(""),
    [fatal, setFatal] = useState("");
  const [description, setDescription] = useState(""),
    [date, setDate] = useState(""),
    [amount, setAmount] = useState(""),
    [currency, setCurrency] = useState<Currency>("PEN");
  const [payer, setPayer] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [custom, setCustom] = useState(false),
    [parts, setParts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<ExpenseRecord | null>(null),
    [review, setReview] = useState<ExpenseCommand | null>(null),
    [saving, setSaving] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [keepDuplicate, setKeepDuplicate] = useState(false);
  const [search, setSearch] = useState(""),
    [filterPayer, setFilterPayer] = useState(""),
    [filterDate, setFilterDate] = useState("");
  const operationKey = useRef<string | null>(null);
  const abortRef = useRef(false);
  const showForm = entry || !!editing || !!review;
  const hasDraft =
    showForm && (!!description || !!amount || selected.length > 0 || !!editing);
  function guardNavigation(event: { preventDefault(): void }) {
    if (saving || uncertain || review) {
      event.preventDefault();
      setMessage(
        "Termina la revisión o comprueba la operación pendiente antes de salir.",
      );
    } else if (
      hasDraft &&
      !window.confirm("Hay un gasto sin guardar. ¿Quieres descartarlo y salir?")
    ) {
      event.preventDefault();
    }
  }
  useEffect(() => {
    if (editing) document.getElementById("expense-description")?.focus();
  }, [editing]);
  function invalidate(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setContext(null);
      setExpenses([]);
      setSummary(null);
      setReview(null);
      setFatal(error.message);
      return;
    }
    setMessage(error instanceof Error ? error.message : "No se pudo conectar.");
  }
  useEffect(() => {
    abortRef.current = false;
    void api<Context>("/api/session")
      .then(async (ctx) => {
        const [data, pending] = await Promise.all([
          api<{ expenses: ExpenseRecord[] }>("/api/expenses"),
          recoverPending(ctx.csrfToken, window.sessionStorage),
        ]);
        if (abortRef.current) return;
        setContext(ctx);
        setExpenses(data.expenses);
        setPayer(ctx.participantId ?? ctx.participants[0]?.id ?? "");
        setDate(new Date().toISOString().slice(0, 10));
        if (pending) {
          operationKey.current = pending.key;
          setReview(pending.command);
          setUncertain(true);
          setMessage(
            "Se recuperó una operación pendiente. Reintenta la misma clave para confirmar su resultado sin duplicar.",
          );
          if (pending.command.operation !== "void") {
            const command = pending.command;
            setDescription(command.description);
            setDate(command.spentOn);
            setCurrency(command.currency);
            setPayer(command.payerId);
            setAmount(decimal(command.amountMinor));
            setSelected(command.splits.map((s) => s.participantId));
            setCustom(true);
            setParts(
              Object.fromEntries(
                command.splits.map((s) => [
                  s.participantId,
                  decimal(s.amountMinor),
                ]),
              ),
            );
          }
        }
        return api<SummaryResponse>("/api/summary").then((data) => {
          if (!abortRef.current) {
            setSummary(data.summary);
          }
        });
      })
      .catch((error) => {
        if (!abortRef.current) {
          setContext(null);
          setExpenses([]);
          setFatal(
            error instanceof Error ? error.message : "No se pudo conectar.",
          );
        }
      })
      .finally(() => {
        if (!abortRef.current) setLoading(false);
      });
    return () => {
      abortRef.current = true;
    };
  }, []);
  useEffect(() => {
    if (!uncertain && !saving && !hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uncertain, saving, hasDraft]);
  const names = new Map(
    context?.participants.map((p) => [p.id, p.displayName]) ?? [],
  );
  const name = (id: string) => names.get(id) ?? "Participante";
  let splits: Split[] = [];
  let splitError = "";
  try {
    const total = parseMoney(amount);
    splits = custom
      ? validateCustomSplit(
          total,
          selected.map((id) => ({
            participantId: id,
            amountMinor: parseMoney(parts[id] ?? ""),
          })),
        )
      : equalSplit(total, selected);
  } catch (error) {
    splitError = error instanceof Error ? error.message : "Revisa el reparto.";
  }
  function resetForm() {
    setEditing(null);
    setDescription("");
    setAmount("");
    setSelected([]);
    setParts({});
    setCustom(false);
    setReview(null);
    setUncertain(false);
    operationKey.current = null;
    setPayer(context?.participantId ?? context?.participants[0]?.id ?? "");
  }
  function prepare(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setKeepDuplicate(false);
    if (splitError || !description.trim() || !date || !payer) {
      setMessage(splitError || "Completa todos los campos.");
      return;
    }
    const fields = {
      payerId: payer,
      description: description.trim(),
      spentOn: date,
      amountMinor: parseMoney(amount).toString(),
      currency,
      splits: splits.map((s) => ({
        ...s,
        amountMinor: s.amountMinor.toString(),
      })),
    };
    setReview(
      editing
        ? {
            operation: "update",
            id: editing.id,
            expectedVersion: editing.version,
            ...fields,
          }
        : { operation: "create", ...fields },
    );
    operationKey.current = crypto.randomUUID();
  }
  function edit(expense: ExpenseRecord) {
    if (review) return;
    setEditing(expense);
    setDescription(expense.description);
    setDate(expense.spentOn);
    setCurrency(expense.currency);
    setPayer(expense.payerId);
    setAmount(decimal(expense.amountMinor));
    setSelected(expense.splits.map((s) => s.participantId));
    setCustom(true);
    setParts(
      Object.fromEntries(
        expense.splits.map((s) => [s.participantId, decimal(s.amountMinor)]),
      ),
    );
    setMessage("");
    document.getElementById("expense-description")?.focus();
  }
  async function save() {
    if (!review || !context || saving || !operationKey.current) return;
    setSaving(true);
    setMessage("");
    let attempted = false;
    try {
      await rememberPending(
        { key: operationKey.current, command: review },
        context.csrfToken,
        window.sessionStorage,
      );
      attempted = true;
      const result = await api<{ expense: ExpenseRecord }>("/api/expenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": context.csrfToken,
          "Idempotency-Key": operationKey.current,
        },
        body: JSON.stringify(review),
      });
      setExpenses((current) =>
        result.expense.state === "voided"
          ? current.filter((e) => e.id !== result.expense.id)
          : [
              result.expense,
              ...current.filter((e) => e.id !== result.expense.id),
            ],
      );
      try {
        forgetPending(window.sessionStorage);
      } catch {}
      setSummary(null);
      resetForm();
      setMessage("Gasto guardado.");
      try {
        const data = await api<SummaryResponse>("/api/summary");
        setSummary(data.summary);
      } catch (error) {
        invalidate(error);
      }
    } catch (error) {
      if (!attempted) {
        setMessage(
          "No se pudo preparar la recuperación privada. No se envió esta solicitud.",
        );
      } else if (!(error instanceof ApiError) || error.status >= 500) {
        setUncertain(true);
        setMessage(
          "No se confirmó el resultado. Reintenta la misma operación para evitar duplicados.",
        );
      } else {
        if (!uncertain || error.code === "STALE_VERSION") {
          try {
            forgetPending(window.sessionStorage);
          } catch {}
          if (error.code === "STALE_VERSION") {
            setUncertain(false);
            setReview(null);
            setEditing(null);
            operationKey.current = null;
            try {
              const latest = await api<{ expenses: ExpenseRecord[] }>(
                "/api/expenses",
              );
              setExpenses(latest.expenses);
            } catch {}
          }
        }
        invalidate(error);
      }
    } finally {
      setSaving(false);
    }
  }
  async function logout() {
    if (!context || saving || uncertain) return;
    if (
      hasDraft &&
      !window.confirm(
        "Hay un gasto sin guardar. ¿Quieres descartarlo y cerrar sesión?",
      )
    )
      return;
    try {
      await api("/api/access/logout", {
        method: "POST",
        headers: { "X-CSRF-Token": context.csrfToken },
      });
      window.location.replace("/");
    } catch (error) {
      invalidate(error);
    }
  }
  const normalized = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("es")
      .replace(/\s+/g, " ");
  const duplicates =
    review && review.operation !== "void"
      ? expenses.filter(
          (e) =>
            e.id !== ("id" in review ? review.id : null) &&
            e.spentOn === review.spentOn &&
            e.currency === review.currency &&
            e.amountMinor === review.amountMinor &&
            normalized(e.description) === normalized(review.description),
        )
      : [];
  const filtered = expenses.filter(
    (e) =>
      (!search ||
        e.description
          .toLocaleLowerCase("es")
          .includes(search.toLocaleLowerCase("es"))) &&
      (!filterPayer || e.payerId === filterPayer) &&
      (!filterDate || e.spentOn === filterDate),
  );
  if (loading)
    return (
      <main>
        <h1>Gastos del viaje</h1>
        <p role="status">Cargando tu sesión…</p>
      </main>
    );
  if (fatal || !context)
    return (
      <main>
        <h1>Acceso privado</h1>
        <p role="alert">{fatal || "Abre tu enlace privado para entrar."}</p>
        <p>
          Abre tu enlace privado para consultar el dashboard e ingresar gastos.
        </p>
        <Link href="/simulador">Probar el simulador de reparto</Link>
      </main>
    );
  const canManage = (e: ExpenseRecord) =>
    context.role === "admin" || e.payerId === context.participantId;
  const expenseSource = (e: ExpenseRecord) =>
    ({
      manual: "Manual",
      bulk: "Registro masivo",
      csv: "CSV",
      excel: "Excel",
      image: "Imagen",
    })[e.source];
  const expenseParts = (e: ExpenseRecord) => (
    <details>
      <summary>Ver reparto</summary>
      <ul>
        {e.splits.map((s) => (
          <li key={s.participantId}>
            <span>{name(s.participantId)}</span>
            <strong>{formatMoney(BigInt(s.amountMinor), e.currency)}</strong>
          </li>
        ))}
      </ul>
    </details>
  );
  const expenseActions = (e: ExpenseRecord) =>
    canManage(e) ? (
      <div className="actions">
        <button disabled={!!review} onClick={() => edit(e)}>
          Editar
        </button>
        <button
          disabled={!!review}
          onClick={() => {
            setReview({
              operation: "void",
              id: e.id,
              expectedVersion: e.version,
            });
            operationKey.current = crypto.randomUUID();
            setMessage("");
          }}
        >
          Anular
        </button>
      </div>
    ) : null;

  return (
    <main>
      <header className="home-header">
        <div className="home-topbar">
          <Link
            className="home-logo"
            href="/"
            aria-label="Inicio"
            onNavigate={guardNavigation}
          >
            <span aria-hidden="true">Logo</span>
          </Link>
          <div className="home-account">
            <span
              className="home-account-name"
              title={
                context.role === "admin"
                  ? "Administrador"
                  : name(context.participantId ?? "")
              }
            >
              {context.role === "admin"
                ? "Administrador"
                : name(context.participantId ?? "")}
            </span>
            {context.role === "admin" ? (
              <Link
                className="home-icon"
                href="/administrar"
                aria-label="Administración"
                title="Administración"
                onNavigate={guardNavigation}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="m9.5 3-.6 2.1-1.7 1L5 5.6 2.5 10l1.6 1.5v2L2.5 15 5 19.4l2.2-.5 1.7 1 .6 2.1h5l.6-2.1 1.7-1 2.2.5 2.5-4.4-1.6-1.5v-2L21.5 10 19 5.6l-2.2.5-1.7-1L14.5 3z" />
                  <circle cx="12" cy="12.5" r="3" />
                </svg>
              </Link>
            ) : null}
            <button
              className="home-icon"
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
              disabled={saving || uncertain || !!review}
              onClick={() => void logout()}
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M12 3v9M6.3 5.8a8.5 8.5 0 1 0 11.4 0" />
              </svg>
            </button>
          </div>
        </div>
        <div className="home-heading">
          <h1>Adiós Yacolino</h1>
          <nav className="home-primary-actions" aria-label="Acciones del viaje">
            <Link
              className="primary-link"
              href="/gastos/nuevo"
              onNavigate={guardNavigation}
            >
              Ingresar gastos
            </Link>
            <Link
              className="home-secondary-link"
              href="/pagos"
              onNavigate={guardNavigation}
            >
              Liquidar saldos
            </Link>
          </nav>
        </div>
      </header>
      <p role="status" className={message ? "notice" : "home-feedback"}>
        {message}
      </p>
      {summary && !entry ? (
        <section
          className="summary-grid home-kpis"
          aria-label="Resumen por moneda"
        >
          {(["PEN", "USD"] as const).map((c) => (
            <div className="summary-card" key={c}>
              <p className="eyebrow">TOTAL {c}</p>
              <strong>{formatMoney(BigInt(summary[c].totalMinor), c)}</strong>
              {context.participantId ? (
                <p>
                  Tu saldo:{" "}
                  {formatMoney(
                    BigInt(
                      summary[c].balances.find(
                        (b) => b.participantId === context.participantId,
                      )?.amountMinor ?? "0",
                    ),
                    c,
                  )}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {showForm ? (
        <section className="workspace" aria-labelledby="form-title">
          <div className="editor">
            <h2 id="form-title">
              {editing ? "Editar gasto" : "Registrar un gasto"}
            </h2>
            <form onSubmit={prepare}>
              <fieldset
                disabled={!!review || saving}
                className="expense-fields"
              >
                <label htmlFor="expense-description">Descripción</label>
                <input
                  id="expense-description"
                  value={description}
                  maxLength={240}
                  required
                  onChange={(e) => setDescription(e.target.value)}
                />
                <label htmlFor="expense-date">Fecha</label>
                <input
                  id="expense-date"
                  type="date"
                  min="2000-01-01"
                  max="2100-12-31"
                  value={date}
                  required
                  onChange={(e) => setDate(e.target.value)}
                />
                <label htmlFor="expense-amount">Importe</label>
                <input
                  id="expense-amount"
                  inputMode="decimal"
                  value={amount}
                  maxLength={15}
                  required
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={!!amount && !!splitError}
                  aria-describedby="expense-split-error"
                />
                <label htmlFor="expense-currency">Moneda</label>
                <select
                  id="expense-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                >
                  <option value="PEN">PEN · Soles</option>
                  <option value="USD">USD · Dólares</option>
                </select>
                <label htmlFor="expense-payer">Pagador</label>
                <select
                  id="expense-payer"
                  value={payer}
                  disabled={context.role !== "admin"}
                  onChange={(e) => setPayer(e.target.value)}
                >
                  {context.participants.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
                <fieldset>
                  <legend>Beneficiarios</legend>
                  {context.participants.map((p) => (
                    <div className="person" key={p.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.includes(p.id)}
                          onChange={(e) =>
                            setSelected((current) =>
                              e.target.checked
                                ? [...current, p.id]
                                : current.filter((id) => id !== p.id),
                            )
                          }
                        />{" "}
                        {p.displayName}
                      </label>
                      {custom && selected.includes(p.id) ? (
                        <input
                          aria-label={`Parte de ${p.displayName}`}
                          className="custom-amount"
                          inputMode="decimal"
                          value={parts[p.id] ?? ""}
                          onChange={(e) =>
                            setParts((current) => ({
                              ...current,
                              [p.id]: e.target.value,
                            }))
                          }
                        />
                      ) : null}
                    </div>
                  ))}
                </fieldset>
                <label className="person">
                  <span>Importes personalizados</span>
                  <input
                    type="checkbox"
                    checked={custom}
                    onChange={(e) => setCustom(e.target.checked)}
                  />
                </label>
              </fieldset>
              <button
                type="submit"
                disabled={!!review || !!splitError || saving}
              >
                Revisar antes de guardar
              </button>
              {editing && !review ? (
                <button type="button" onClick={resetForm}>
                  Cancelar edición
                </button>
              ) : null}
            </form>
          </div>
          <div className="preview">
            <h2>Reparto exacto</h2>
            {review?.operation === "void" ? (
              <p>
                Se anulará el gasto «
                {expenses.find((e) => e.id === review.id)?.description}». Su
                historial se conserva.
              </p>
            ) : (
              <div aria-live="polite">
                {splitError ? (
                  <p id="expense-split-error">{splitError}</p>
                ) : (
                  <ul>
                    {splits.map((s) => (
                      <li key={s.participantId}>
                        <span>{name(s.participantId)}</span>
                        <strong>{formatMoney(s.amountMinor, currency)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {review ? (
              <div className="confirmation">
                <h3>
                  Confirmar{" "}
                  {review.operation === "void"
                    ? "anulación"
                    : review.operation === "update"
                      ? "cambios"
                      : "gasto"}
                </h3>
                <p>Solo esta confirmación modifica las cuentas del viaje.</p>
                {duplicates.length && !uncertain ? (
                  <label className="person">
                    <span>
                      Hay {duplicates.length} gasto(s) con la misma fecha,
                      importe, moneda y descripción. He revisado la coincidencia
                      y quiero conservar ambos.
                    </span>
                    <input
                      type="checkbox"
                      checked={keepDuplicate}
                      onChange={(e) => setKeepDuplicate(e.target.checked)}
                    />
                  </label>
                ) : null}
                <button
                  onClick={() => void save()}
                  disabled={
                    saving ||
                    (!uncertain && duplicates.length > 0 && !keepDuplicate)
                  }
                >
                  {saving
                    ? "Guardando…"
                    : uncertain
                      ? "Reintentar la misma operación"
                      : "Confirmar"}
                </button>
                <button
                  onClick={() => {
                    setReview(null);
                    operationKey.current = null;
                    try {
                      forgetPending(window.sessionStorage);
                    } catch {}
                  }}
                  disabled={saving || uncertain}
                >
                  Volver
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <section
        className="settlement home-movements"
        aria-labelledby="list-title"
      >
        <h2 id="list-title">Gastos registrados</h2>
        <details className="home-filter-panel">
          <summary aria-label="Buscar y filtrar">
            Buscar y filtrar
            {search || filterPayer || filterDate ? (
              <span className="home-filter-count">
                Filtros activos:{" "}
                {[search, filterPayer, filterDate].filter(Boolean).length}
              </span>
            ) : null}
          </summary>
          <div className="filters">
            <label>
              Buscar
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              Pagador
              <select
                aria-label="Pagador"
                value={filterPayer}
                onChange={(e) => setFilterPayer(e.target.value)}
              >
                <option value="">Todos</option>
                {context.participants.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Fecha
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
              />
            </label>
          </div>
        </details>
        {!expenses.length ? (
          <p>El viaje todavía no tiene gastos. Registra el primero.</p>
        ) : !filtered.length ? (
          <p>No hay gastos con estos filtros.</p>
        ) : (
          <>
            <div
              className="expense-table-wrap"
              role="region"
              aria-label="Tabla de gastos"
              tabIndex={0}
            >
              <table className="expense-table">
                <thead>
                  <tr>
                    <th scope="col">Descripción</th>
                    <th scope="col">Fecha</th>
                    <th scope="col">Pagador</th>
                    <th scope="col" className="expense-money">
                      Importe
                    </th>
                    <th scope="col">Origen</th>
                    <th scope="col">Reparto</th>
                    <th scope="col">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id}>
                      <th scope="row">
                        <h3>{e.description}</h3>
                      </th>
                      <td className="expense-date">{e.spentOn}</td>
                      <td>{name(e.payerId)}</td>
                      <td className="expense-money">
                        <strong>
                          {formatMoney(BigInt(e.amountMinor), e.currency)}
                        </strong>
                      </td>
                      <td>{expenseSource(e)}</td>
                      <td>{expenseParts(e)}</td>
                      <td>{expenseActions(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="expense-mobile">
              {filtered.map((e) => (
                <article className="expense-card" key={e.id}>
                  <div>
                    <h3>{e.description}</h3>
                    <p>
                      {e.spentOn} · Pagó {name(e.payerId)} · Origen:{" "}
                      {
                        {
                          manual: "manual",
                          bulk: "registro masivo",
                          csv: "CSV",
                          excel: "Excel",
                          image: "imagen",
                        }[e.source]
                      }
                    </p>
                    <strong>
                      {formatMoney(BigInt(e.amountMinor), e.currency)}
                    </strong>
                  </div>
                  {expenseParts(e)}
                  {expenseActions(e)}
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      <footer>CUSCO · CUENTAS CLARAS</footer>
    </main>
  );
}
