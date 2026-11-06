"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  csvCandidates,
  parseCsv,
  CSV_LIMITS,
  type CsvHeaderMap,
  type CsvSeparator,
  type CsvTable,
} from "@/domain/csv";
import {
  equalSplit,
  formatMoney,
  parseMoney,
  validateCustomSplit,
  type Currency,
} from "@/domain/money";
import {
  forgetPending,
  recoverPending,
  rememberPending,
  type PendingOperation,
} from "@/domain/pending-operation";
import type { ImportJob, ImportRow } from "@/server/import-contract";

type Session = {
  role: "participant" | "admin";
  participantId: string | null;
  participants: { id: string; displayName: string }[];
  csrfToken: string;
};
type ConfirmCommand = {
  operation: "confirm";
  id: string;
  expectedVersion: number;
};
type EditableRow = ImportRow & {
  amountText: string;
  beneficiaries: string[];
  custom: boolean;
  customAmounts: Record<string, string>;
};
type Sheet = { id: string; name: string; table: CsvTable; warnings?: string[] };
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
    signal: AbortSignal.timeout(30000),
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
function decimal(minor: string) {
  if (!/^\d+$/.test(minor)) return "";
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
function partMoney(minor: string | undefined, currency: ImportRow["currency"]) {
  return currency && minor && /^[0-9]{1,20}$/.test(minor)
    ? formatMoney(BigInt(minor), currency)
    : "—";
}
function editable(row: ImportRow): EditableRow {
  let custom = false;
  try {
    const equal = equalSplit(
      BigInt(row.amountMinor),
      row.splits.map((s) => s.participantId),
    );
    custom = equal.some(
      (s) =>
        row.splits.find((v) => v.participantId === s.participantId)
          ?.amountMinor !== s.amountMinor.toString(),
    );
  } catch {
    custom = row.splits.length > 0;
  }
  return {
    ...row,
    amountText: decimal(row.amountMinor),
    beneficiaries: row.splits.map((s) => s.participantId),
    custom,
    customAmounts: Object.fromEntries(
      row.splits.map((s) => [s.participantId, decimal(s.amountMinor)]),
    ),
  };
}
function payload(row: EditableRow): ImportRow {
  return {
    id: row.id,
    description: row.description,
    spentOn: row.spentOn,
    amountMinor: row.amountMinor,
    currency: row.currency,
    payerId: row.payerId,
    splits: row.splits,
    selected: row.selected,
    reviewed: row.reviewed,
    keepBoth: row.keepBoth,
    evidence: row.evidence,
    sourceRow: row.sourceRow,
    ...(row.sourceSheet ? { sourceSheet: row.sourceSheet } : {}),
    warnings: row.warnings,
    duplicateExpenseIds: row.duplicateExpenseIds,
  };
}

function rowErrors(row: EditableRow, session: Session): string[] {
  const errors: string[] = [];
  if (!row.description.trim() || row.description.length > 240)
    errors.push("Falta una descripción de hasta 240 caracteres.");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(row.spentOn) ||
    row.spentOn < "2000-01-01" ||
    row.spentOn > "2100-12-31" ||
    !Number.isFinite(Date.parse(row.spentOn + "T00:00:00Z")) ||
    new Date(row.spentOn + "T00:00:00Z").toISOString().slice(0, 10) !==
      row.spentOn
  )
    errors.push("Revisa la fecha real en formato AAAA-MM-DD.");
  if (!["PEN", "USD"].includes(row.currency))
    errors.push("Selecciona PEN o USD.");
  if (!session.participants.some((p) => p.id === row.payerId))
    errors.push("Selecciona el pagador.");
  try {
    const amount = parseMoney(row.amountText);
    validateCustomSplit(
      amount,
      row.splits.map((s) => ({
        participantId: s.participantId,
        amountMinor: BigInt(s.amountMinor),
      })),
    );
    if (
      row.splits.some(
        (s) => !session.participants.some((p) => p.id === s.participantId),
      )
    )
      throw new Error();
  } catch {
    errors.push(
      "Revisa el importe y las partes: deben ser positivas y sumar el total al céntimo.",
    );
  }
  return errors;
}
const warningText: Record<string, string> = {
  FORMULA_LIKE_CONTENT:
    "Hay contenido parecido a una fórmula; no se ha ejecutado.",
  OUTSIDE_TRIP_DATES: "La fecha está fuera de las fechas del viaje.",
  NON_EXPENSE_MOVEMENT:
    "El origen no identifica inequívocamente un gasto. Confirma su naturaleza.",
  INCONSISTENT_TOTALS: "El origen presenta totales inconsistentes.",
  REQUIRES_REVIEW: "Requiere revisión humana.",
  TRIP_DATES_NOT_CONFIGURED:
    "Las fechas del viaje no están configuradas: revisa la fecha manualmente.",
  TRIP_DATES_UNKNOWN:
    "Las fechas del viaje no están configuradas: revisa la fecha manualmente.",
  DUPLICATE_IN_BATCH:
    "Otra fila seleccionada de este lote tiene la misma fecha, importe y moneda.",
};
function manualExpense(session: Session, sourceRow = 1): EditableRow {
  const row = editable({
    id: crypto.randomUUID(),
    description: "",
    spentOn: "",
    amountMinor: "",
    currency: "PEN",
    payerId: session.participantId ?? session.participants[0]?.id ?? "",
    splits: [],
    selected: true,
    reviewed: false,
    keepBoth: false,
    evidence: "Entrada manual",
    sourceRow,
    warnings: [],
    duplicateExpenseIds: [],
  });
  row.beneficiaries = session.participants.map((p) => p.id);
  return row;
}
function needsAcknowledgement(row: EditableRow, sourceType: string) {
  return (
    sourceType !== "manual" ||
    row.warnings.length > 0 ||
    row.duplicateExpenseIds.length > 0
  );
}
export default function ImportWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [sourceType, setSourceType] = useState<"manual" | "csv" | "excel">(
    "manual",
  );
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [review, setReview] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] =
    useState<PendingOperation<ConfirmCommand> | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [paste, setPaste] = useState("");
  const [separator, setSeparator] = useState<CsvSeparator>(";");
  const [headers, setHeaders] = useState<CsvHeaderMap>({
    description: "description",
    date: "date",
    amount: "amount",
    currency: "currency",
  });
  const [sheets, setSheets] = useState<Sheet[]>([]),
    [sheetId, setSheetId] = useState("");
  const [excelOpen, setExcelOpen] = useState(false);
  const [sourceNote, setSourceNote] = useState("");
  const [sourceWarnings, setSourceWarnings] = useState<string[]>([]);
  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      setSession(null);
      setRows([]);
      setJobs([]);
      setJob(null);
      setPending(null);
      setUncertain(false);
      try {
        forgetPending(sessionStorage, "imports");
      } catch {}
      setError("La sesión terminó. Vuelve a entrar con tu enlace privado.");
    } else
      setError(
        cause instanceof ApiError
          ? cause.message
          : "No se pudo conectar. Inténtalo de nuevo.",
      );
  }, []);
  const acceptJob = useCallback((value: ImportJob) => {
    setJob(value);
    setRows(value.rows.map(editable));
    setSourceType(value.sourceType);
    setDirty(false);
    setJobs((current) => [value, ...current.filter((j) => j.id !== value.id)]);
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Session>("/api/session"),
      api<{ jobs: ImportJob[] }>("/api/imports"),
    ])
      .then(async ([s, data]) => {
        const saved = await recoverPending<ConfirmCommand>(
          s.csrfToken,
          sessionStorage,
          "imports",
        );
        if (!active) return;
        setSession(s);
        setJobs(data.jobs);
        if (saved) {
          setPending(saved);
          setUncertain(true);
          const response = await api<{ job: ImportJob }>(
            "/api/imports?id=" + encodeURIComponent(saved.command.id),
          );
          if (active) acceptJob(response.job);
        } else setRows([manualExpense(s)]);
      })
      .catch(fail)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [acceptJob, fail]);
  useEffect(() => {
    if (!dirty && !busy && !uncertain) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, busy, uncertain]);
  useEffect(() => {
    if (loading || !session) return;
    const id = window.location.hash.slice(1);
    if (id === "manual-rows" || id === "prepare-data") {
      const section = document.getElementById(id);
      if (section instanceof HTMLDetailsElement) section.open = true;
      section?.scrollIntoView();
    }
  }, [loading, session]);
  const locked = busy || uncertain || (!!job && job.state !== "preview");
  const completed = new Set(
    job?.results.filter((r) => r.status === "persisted").map((r) => r.rowId) ??
      [],
  );
  const selected = rows.filter((r) => r.selected && !completed.has(r.id));
  const invalid = session
    ? selected.some(
        (r) =>
          rowErrors(r, session).length ||
          (needsAcknowledgement(r, sourceType) && !r.reviewed) ||
          ((r.duplicateExpenseIds.length > 0 ||
            r.warnings.includes("DUPLICATE_IN_BATCH")) &&
            !r.keepBoth),
      )
    : true;
  const totals = { PEN: 0n, USD: 0n };
  for (const row of selected)
    if (
      (row.currency === "PEN" || row.currency === "USD") &&
      /^\d+$/.test(row.amountMinor)
    )
      totals[row.currency] += BigInt(row.amountMinor);
  function reset() {
    setJob(null);
    setRows(session ? [manualExpense(session)] : []);
    setDirty(false);
    setReview(false);
    setConfirmed(false);
    setSourceType("manual");
    setPaste("");
    setSheetId("");
    setError("");
    setMessage("");
    setSourceNote("");
    setSourceWarnings([]);
    setSheets([]);
  }
  function change(id: string, values: Partial<EditableRow>, financial = true) {
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              ...values,
              ...(financial ? { reviewed: false, keepBoth: false } : {}),
            }
          : row,
      ),
    );
    setDirty(true);
    setReview(false);
    setConfirmed(false);
    setError("");
    setMessage("");
  }
  function equalParts(
    row: EditableRow,
    ids: string[],
    amountText = row.amountText,
  ) {
    try {
      return equalSplit(parseMoney(amountText), ids).map((s) => ({
        participantId: s.participantId,
        amountMinor: s.amountMinor.toString(),
      }));
    } catch {
      return [];
    }
  }
  function addRow() {
    if (!session || rows.length >= 200) return;
    const value = manualExpense(
      session,
      Math.max(0, ...rows.map((r) => r.sourceRow)) + 1,
    );
    setRows((current) => [...current, value]);
    requestAnimationFrame(() =>
      document.getElementById(`description-${value.id}`)?.focus(),
    );
    setDirty(true);
    setReview(false);
    setConfirmed(false);
  }
  function applyTable(table: CsvTable, type: "csv" | "excel", sheet?: string) {
    if (!session) return;
    const first = table.rows[0]?.cells.map((cell) =>
      cell.text.trim().toLowerCase(),
    );
    const templateHeaders =
      first?.length === 4 &&
      first.join("|") === "descripción|fecha|importe|moneda";
    const mapping: CsvHeaderMap = templateHeaders
      ? {
          description: "descripción",
          date: "fecha",
          amount: "importe",
          currency: "moneda",
        }
      : headers;
    if (templateHeaders) setHeaders(mapping);
    const preview = csvCandidates(table, mapping);
    const ids = session.participants.map((p) => p.id);
    const next = preview.candidates.map((candidate) => {
      const amount = candidate.amountMinor ?? "";
      let splits: ImportRow["splits"] = [];
      try {
        splits = equalSplit(BigInt(amount), ids).map((s) => ({
          participantId: s.participantId,
          amountMinor: s.amountMinor.toString(),
        }));
      } catch {}
      const value = editable({
        id: crypto.randomUUID(),
        description: candidate.description ?? "",
        spentOn: candidate.date ?? "",
        amountMinor: amount,
        currency: candidate.currency ?? "",
        payerId: session.participantId ?? session.participants[0]?.id ?? "",
        splits,
        selected: false,
        reviewed: false,
        keepBoth: false,
        evidence: Object.entries(candidate.fields)
          .map(
            ([key, cell]) =>
              `${key}: ${cell.literal} (fila ${cell.row}, columna ${cell.columnIndex})`,
          )
          .join("\n")
          .slice(0, 2000),
        sourceRow: candidate.sourceRow,
        ...(sheet ? { sourceSheet: sheet } : {}),
        warnings: candidate.warnings,
        duplicateExpenseIds: [],
      });
      value.beneficiaries = ids;
      if (!amount) value.amountText = candidate.fields.amount.text;
      return value;
    });
    setRows(next);
    setSourceType(type);
    setDirty(true);
    setReview(false);
    setConfirmed(false);
    setSourceNote(
      `${next.length} candidatos; ${preview.omittedEmptyRows.length} filas vacías omitidas. ${preview.omittedColumns.length ? `Columnas no utilizadas: ${preview.omittedColumns.join(", ")}.` : "Todas las columnas se utilizaron."}`,
    );
    setError("");
  }
  async function openFile(file: File) {
    setBusy(true);
    setError("");
    try {
      if (file.size > CSV_LIMITS.bytes)
        throw new ApiError(400, "El archivo supera el límite de 15 MB.");
      if (/\.csv$/i.test(file.name)) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        applyTable(parseCsv(text, separator), "csv");
        setSourceWarnings([]);
        setSheets([]);
      } else if (/\.xlsx$/i.test(file.name)) {
        if (file.size > 4 * 1024 * 1024)
          throw new ApiError(
            400,
            "Excel admite hasta 4 MB en esta carga. Para un libro mayor, guarda la hoja como CSV UTF-8 y cárgala aquí (hasta 15 MB).",
          );
        const result = await api<{ sheets: Sheet[]; warnings?: string[] }>(
          "/api/imports/source",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "X-CSRF-Token": session?.csrfToken ?? "",
            },
            body: file,
          },
        );
        setSheets(result.sheets);
        setSourceWarnings([
          ...(result.warnings ?? []),
          ...result.sheets.flatMap((sheet) =>
            (sheet.warnings ?? []).map(
              (warning) => `${sheet.name}: ${warning}`,
            ),
          ),
        ]);
        setSheetId(result.sheets[0]?.id ?? "");
        setSourceNote(
          "Selecciona una hoja y confirma el mapeo antes de preparar candidatos. El original se procesa y se descarta; no se adjunta a los gastos.",
        );
      } else
        throw new ApiError(
          400,
          "Selecciona CSV UTF-8 o Excel .xlsx. No se admiten macros ni imágenes.",
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "No se pudo leer el archivo.",
      );
    } finally {
      setBusy(false);
    }
  }
  function requestHeaders(key: string) {
    return {
      "Content-Type": "application/json",
      "X-CSRF-Token": session?.csrfToken ?? "",
      "Idempotency-Key": key,
    };
  }
  async function save(forReview = false) {
    if (!session) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const command = job
        ? {
            operation: "save",
            id: job.id,
            expectedVersion: job.version,
            rows: rows.map((row) => {
              const value = payload(row);
              return forReview &&
                sourceType === "manual" &&
                !needsAcknowledgement(row, sourceType) &&
                row.selected
                ? { ...value, reviewed: true }
                : value;
            }),
          }
        : {
            operation: "create",
            sourceType,
            rows: rows.map((row) => {
              const value = payload(row);
              return forReview &&
                sourceType === "manual" &&
                !needsAcknowledgement(row, sourceType) &&
                row.selected
                ? { ...value, reviewed: true }
                : value;
            }),
          };
      const response = await api<{ job: ImportJob }>("/api/imports", {
        method: "POST",
        headers: requestHeaders(crypto.randomUUID()),
        body: JSON.stringify(command),
      });
      acceptJob(response.job);
      if (forReview) {
        const ready = response.job.rows.filter(
          (r) =>
            r.selected &&
            !response.job.results.some(
              (result) =>
                result.rowId === r.id && result.status === "persisted",
            ),
        );
        if (
          !ready.length ||
          ready.some(
            (r) =>
              rowErrors(editable(r), session).length ||
              !r.reviewed ||
              ((r.duplicateExpenseIds.length > 0 ||
                r.warnings.includes("DUPLICATE_IN_BATCH")) &&
                !r.keepBoth),
          )
        ) {
          setError(
            "El borrador se guardó. Revisa los campos, advertencias y duplicados indicados antes de confirmar.",
          );
        } else {
          setReview(true);
          setConfirmed(false);
        }
      } else
        setMessage(
          "Borrador privado guardado. Todavía no se han creado gastos.",
        );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function refreshJobs() {
    setBusy(true);
    setError("");
    try {
      setJobs((await api<{ jobs: ImportJob[] }>("/api/imports")).jobs);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function openJob(id: string) {
    setBusy(true);
    setError("");
    setReview(false);
    setConfirmed(false);
    try {
      acceptJob(
        (
          await api<{ job: ImportJob }>(
            "/api/imports?id=" + encodeURIComponent(id),
          )
        ).job,
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function confirm(retry = false) {
    if (!session || (!retry && (!job || !confirmed))) return;
    const operation = retry
      ? pending
      : job
        ? {
            key: crypto.randomUUID(),
            command: {
              operation: "confirm" as const,
              id: job.id,
              expectedVersion: job.version,
            },
          }
        : null;
    if (!operation) return;
    setBusy(true);
    setError("");
    const wasUncertain = uncertain;
    try {
      await rememberPending(
        operation,
        session.csrfToken,
        sessionStorage,
        "imports",
      );
      setPending(operation);
      const response = await api<{ job: ImportJob }>("/api/imports", {
        method: "POST",
        headers: requestHeaders(operation.key),
        body: JSON.stringify(operation.command),
      });
      acceptJob(response.job);
      forgetPending(sessionStorage, "imports");
      setPending(null);
      setUncertain(false);
      setReview(false);
      setConfirmed(false);
      const failed = response.job.results.filter(
        (r) => r.status === "failed",
      ).length;
      setMessage(
        failed
          ? `Resultado parcial: ${failed} filas requieren corrección. Las filas guardadas no se volverán a importar.`
          : "Gastos guardados. Ya puedes verlos en el dashboard.",
      );
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 429 &&
        (!wasUncertain || cause.code === "STALE_VERSION")
      ) {
        forgetPending(sessionStorage, "imports");
        setPending(null);
        setUncertain(false);
        setReview(false);
        setConfirmed(false);
      } else setUncertain(true);
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!job) {
      reset();
      return;
    }
    setBusy(true);
    setError("");
    try {
      acceptJob(
        (
          await api<{ job: ImportJob }>("/api/imports", {
            method: "POST",
            headers: requestHeaders(crypto.randomUUID()),
            body: JSON.stringify({
              operation: "cancel",
              id: job.id,
              expectedVersion: job.version,
            }),
          })
        ).job,
      );
      setMessage(
        "Importación cancelada. Los gastos ya guardados conservan su historial.",
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <Link
          className="brand"
          href="/"
          onNavigate={(event) => {
            if (
              busy ||
              uncertain ||
              (dirty &&
                !window.confirm(
                  "Hay cambios sin guardar. ¿Quieres descartarlos y volver al dashboard?",
                ))
            )
              event.preventDefault();
          }}
        >
          C / <span>Cusco</span>
        </Link>
        <Link
          className="badge"
          href="/"
          onNavigate={(event) => {
            if (
              busy ||
              uncertain ||
              (dirty &&
                !window.confirm(
                  "Hay cambios sin guardar. ¿Quieres descartarlos y volver al dashboard?",
                ))
            )
              event.preventDefault();
          }}
        >
          Volver al dashboard
        </Link>
      </header>
      <section className="intro">
        <p className="eyebrow">CUENTAS DEL VIAJE</p>
        <h1>Ingresar gastos</h1>
        <p>
          Registra un gasto y confírmalo, o añade más con el botón +. Revisarás
          el reparto antes de guardar.
        </p>
      </section>
      {loading ? <p role="status">Cargando importaciones privadas…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {job?.state === "persisted" ? (
        <p>
          <Link className="primary-link" href="/">
            Ver gastos en el dashboard
          </Link>
        </p>
      ) : null}
      {!loading && !session ? (
        <p>Abre tu enlace privado para registrar gastos.</p>
      ) : null}
      {session ? (
        <>
          {uncertain ? (
            <section className="notice">
              <h2>Confirmación pendiente de comprobar</h2>
              <p>
                La conexión se interrumpió. No crees otro lote: reintenta
                exactamente la misma confirmación para recuperar su resultado
                sin duplicar gastos.
              </p>
              <button disabled={busy} onClick={() => void confirm(true)}>
                Reintentar la misma confirmación
              </button>
            </section>
          ) : null}
          <section className="settlement" id="manual-rows">
            <h2>Tus gastos</h2>
            {job ? (
              <p className="hint">
                Caducidad: {new Date(job.expiresAt).toLocaleString("es-PE")}
              </p>
            ) : null}
            <fieldset disabled={locked} style={{ minWidth: 0 }}>
              {rows.map((row, index) => (
                <article
                  className="expense-card entry-expense-card"
                  key={row.id}
                >
                  <h3>
                    Gasto {index + 1}
                    {completed.has(row.id) ? " · Guardada" : ""}
                  </h3>
                  {!completed.has(row.id) ? (
                    <>
                      <div className="entry-card-heading-actions">
                        {sourceType !== "manual" ? (
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Seleccionar gasto ${index + 1}`}
                              checked={row.selected}
                              onChange={(e) =>
                                change(
                                  row.id,
                                  { selected: e.target.checked },
                                  false,
                                )
                              }
                            />{" "}
                            Incluir este gasto
                          </label>
                        ) : null}
                        <button
                          type="button"
                          disabled={rows.length === 1}
                          aria-label={`Quitar gasto ${index + 1}`}
                          onClick={() => {
                            setRows((current) =>
                              current.filter((r) => r.id !== row.id),
                            );
                            setDirty(true);
                            setReview(false);
                            setConfirmed(false);
                          }}
                        >
                          Quitar gasto
                        </button>
                      </div>
                      <div className="entry-expense-fields">
                        <label htmlFor={`description-${row.id}`}>
                          Descripción
                          <input
                            id={`description-${row.id}`}
                            aria-label={`Descripción gasto ${index + 1}`}
                            maxLength={240}
                            value={row.description}
                            onChange={(e) =>
                              change(row.id, { description: e.target.value })
                            }
                          />
                        </label>
                        <label htmlFor={`date-${row.id}`}>
                          Fecha
                          <input
                            id={`date-${row.id}`}
                            aria-label={`Fecha gasto ${index + 1}`}
                            type="date"
                            min="2000-01-01"
                            max="2100-12-31"
                            value={row.spentOn}
                            onChange={(e) =>
                              change(row.id, { spentOn: e.target.value })
                            }
                          />
                        </label>
                        <label htmlFor={`amount-${row.id}`}>
                          Importe
                          <input
                            id={`amount-${row.id}`}
                            aria-label={`Importe gasto ${index + 1}`}
                            inputMode="decimal"
                            value={row.amountText}
                            onChange={(e) => {
                              const text = e.target.value;
                              let minor = "";
                              try {
                                minor = parseMoney(text).toString();
                              } catch {}
                              change(row.id, {
                                amountText: text,
                                amountMinor: minor,
                                ...(!row.custom
                                  ? {
                                      splits: equalParts(
                                        row,
                                        row.beneficiaries,
                                        text,
                                      ),
                                    }
                                  : {}),
                              });
                            }}
                          />
                        </label>
                        <label htmlFor={`currency-${row.id}`}>
                          Moneda
                          <select
                            id={`currency-${row.id}`}
                            aria-label={`Moneda gasto ${index + 1}`}
                            value={row.currency}
                            onChange={(e) =>
                              change(row.id, {
                                currency: e.target.value as Currency,
                              })
                            }
                          >
                            <option value="">Seleccionar</option>
                            <option>PEN</option>
                            <option>USD</option>
                          </select>
                        </label>
                      </div>
                    </>
                  ) : (
                    <p>
                      {row.description} · {row.spentOn} ·{" "}
                      {partMoney(row.amountMinor, row.currency)}
                    </p>
                  )}
                  {sourceType !== "manual" ? (
                    <details>
                      <summary>Origen y evidencia de gasto {index + 1}</summary>
                      <p>
                        {row.sourceSheet ? `Hoja ${row.sourceSheet} · ` : ""}
                        Fila de origen {row.sourceRow}
                      </p>
                      <pre className="literal">{row.evidence}</pre>
                    </details>
                  ) : null}
                  {!completed.has(row.id) ? (
                    <>
                      <div className="filters">
                        <label htmlFor={`payer-${row.id}`}>
                          Pagador gasto {index + 1}
                        </label>
                        <select
                          id={`payer-${row.id}`}
                          disabled={session.role !== "admin"}
                          value={row.payerId}
                          onChange={(e) =>
                            change(row.id, { payerId: e.target.value })
                          }
                        >
                          {session.participants.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.displayName}
                            </option>
                          ))}
                        </select>
                        <label className="person">
                          <span>Reparto personalizado gasto {index + 1}</span>
                          <input
                            type="checkbox"
                            checked={row.custom}
                            onChange={(e) =>
                              change(row.id, {
                                custom: e.target.checked,
                                ...(!e.target.checked
                                  ? {
                                      splits: equalParts(
                                        row,
                                        row.beneficiaries,
                                      ),
                                    }
                                  : {}),
                              })
                            }
                          />
                        </label>
                      </div>
                      <fieldset>
                        <legend>Beneficiarios gasto {index + 1}</legend>
                        {session.participants.map((person) => (
                          <div className="person" key={person.id}>
                            <label>
                              <input
                                type="checkbox"
                                aria-label={`${person.displayName} en gasto ${index + 1}`}
                                checked={row.beneficiaries.includes(person.id)}
                                onChange={(e) => {
                                  const ids = e.target.checked
                                    ? [...row.beneficiaries, person.id]
                                    : row.beneficiaries.filter(
                                        (id) => id !== person.id,
                                      );
                                  change(row.id, {
                                    beneficiaries: ids,
                                    splits: row.custom
                                      ? row.splits.filter((s) =>
                                          ids.includes(s.participantId),
                                        )
                                      : equalParts(row, ids),
                                  });
                                }}
                              />
                              {person.displayName}
                            </label>
                            {row.custom &&
                            row.beneficiaries.includes(person.id) ? (
                              <input
                                className="custom-amount"
                                aria-label={`Parte de ${person.displayName} gasto ${index + 1}`}
                                inputMode="decimal"
                                value={
                                  row.customAmounts[person.id] ??
                                  decimal(
                                    row.splits.find(
                                      (s) => s.participantId === person.id,
                                    )?.amountMinor ?? "",
                                  )
                                }
                                onChange={(e) => {
                                  let amountMinor = "";
                                  try {
                                    amountMinor = parseMoney(
                                      e.target.value,
                                    ).toString();
                                  } catch {}
                                  change(row.id, {
                                    customAmounts: {
                                      ...row.customAmounts,
                                      [person.id]: e.target.value,
                                    },
                                    splits: [
                                      ...row.splits.filter(
                                        (s) => s.participantId !== person.id,
                                      ),
                                      { participantId: person.id, amountMinor },
                                    ],
                                  });
                                }}
                              />
                            ) : (
                              <span>
                                {partMoney(
                                  row.splits.find(
                                    (s) => s.participantId === person.id,
                                  )?.amountMinor,
                                  row.currency,
                                )}
                              </span>
                            )}
                          </div>
                        ))}
                      </fieldset>
                      {(row.description || row.amountText || row.spentOn) &&
                      rowErrors(row, session).length ? (
                        <ul className="error">
                          {rowErrors(row, session).map((text) => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      ) : null}
                      {row.warnings.length ? (
                        <ul>
                          {row.warnings.map((code) => (
                            <li key={code}>{warningText[code] ?? code}</li>
                          ))}
                        </ul>
                      ) : null}
                      {row.duplicateExpenseIds.length ||
                      row.warnings.includes("DUPLICATE_IN_BATCH") ? (
                        <div className="notice">
                          <p>
                            Hay posibles duplicados por fecha, importe y moneda:{" "}
                            {row.duplicateExpenseIds.length} gastos existentes
                            {row.warnings.includes("DUPLICATE_IN_BATCH")
                              ? " y otras filas de este lote"
                              : ""}
                            . Revisa las coincidencias antes de conservar ambos.
                          </p>
                          <label>
                            <input
                              type="checkbox"
                              checked={row.keepBoth}
                              onChange={(e) =>
                                change(
                                  row.id,
                                  {
                                    keepBoth: e.target.checked,
                                    reviewed: false,
                                  },
                                  false,
                                )
                              }
                            />
                            Mantener ambos en gasto {index + 1}
                          </label>
                        </div>
                      ) : null}
                      {needsAcknowledgement(row, sourceType) ? (
                        <label className="person">
                          <span>
                            He revisado datos, reparto y advertencias del gasto{" "}
                            {index + 1}; representa un gasto.
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`He revisado gasto ${index + 1}`}
                            checked={row.reviewed}
                            onChange={(e) =>
                              change(
                                row.id,
                                { reviewed: e.target.checked },
                                false,
                              )
                            }
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  {job?.results
                    .filter((result) => result.rowId === row.id)
                    .map((result) => (
                      <p key={result.rowId}>
                        {result.status === "persisted"
                          ? "Gasto guardado."
                          : `No guardada: ${result.code ?? "revisa esta fila"}.`}
                      </p>
                    ))}
                </article>
              ))}
            </fieldset>
            <button
              className="entry-add-expense"
              aria-label="Añadir otro gasto"
              disabled={locked || rows.length >= 200}
              onClick={addRow}
            >
              <span aria-hidden="true">+</span> Añadir otro gasto
            </button>
            <div className="notice">
              <strong>
                {selected.length}{" "}
                {selected.length === 1
                  ? "gasto para registrar"
                  : "gastos para registrar"}
              </strong>
              <p>
                PEN: {formatMoney(totals.PEN, "PEN")} · USD:{" "}
                {formatMoney(totals.USD, "USD")}
              </p>
            </div>
            <div className="actions">
              {job && job.state === "preview" ? (
                <button
                  disabled={busy || uncertain}
                  onClick={() => void openJob(job.id)}
                >
                  Descartar cambios locales y recargar borrador
                </button>
              ) : null}
              <button
                disabled={
                  locked ||
                  !rows.some((r) => r.description || r.amountText || r.spentOn)
                }
                onClick={() => void save()}
              >
                Guardar borrador privado
              </button>
              <button
                disabled={locked || !selected.length || invalid}
                onClick={() => void save(true)}
              >
                Revisar gastos
              </button>
              <button
                disabled={
                  busy ||
                  uncertain ||
                  job?.state === "persisted" ||
                  job?.state === "cancelled" ||
                  job?.state === "expired"
                }
                onClick={() => void cancel()}
              >
                {job ? "Cancelar registro" : "Descartar cambios"}
              </button>
            </div>
            {review && job ? (
              <section
                className="confirmation"
                aria-labelledby="confirm-import-title"
              >
                <h3 id="confirm-import-title">Confirma tus gastos</h3>
                <p>
                  Se guardarán {selected.length} gastos por{" "}
                  {formatMoney(totals.PEN, "PEN")} y{" "}
                  {formatMoney(totals.USD, "USD")}. El borrador por sí solo no
                  registra movimientos.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Confirmo registrar estos gastos revisados.
                </label>
                <button
                  disabled={!confirmed || busy || uncertain}
                  onClick={() => void confirm()}
                >
                  Confirmar gastos
                </button>
              </section>
            ) : null}
          </section>
          {!job || job.state === "preview" ? (
            <details
              className="entry-excel-secondary"
              id="prepare-data"
              open={excelOpen}
              onToggle={(event) => setExcelOpen(event.currentTarget.open)}
            >
              <summary>¿Prefieres usar Excel?</summary>
              <h2>Importar desde Excel o CSV</h2>
              <p>
                ¿Prefieres llenar tus gastos en Excel y subirlos? Descarga la
                plantilla.
              </p>
              <p>
                <a
                  href="/api/imports/template"
                  download="plantilla-gastos-cusco.xlsx"
                >
                  Descargar plantilla Excel
                </a>
              </p>
              <p>
                Completa la hoja Gastos y cárgala aquí. Revisarás el reparto
                antes de guardar. La plantilla incluye instrucciones.
              </p>
              {sourceType === "manual" &&
              rows.some((r) => r.description || r.spentOn || r.amountText) ? (
                <p className="notice">
                  Para cargar un archivo, termina este registro o descarta sus
                  cambios primero.
                </p>
              ) : null}
              <fieldset
                disabled={
                  locked ||
                  !!job ||
                  rows.some((r) => r.description || r.spentOn || r.amountText)
                }
              >
                <p>
                  CSV (hasta 15 MB) se procesa en este navegador. Excel (hasta 4
                  MB) se procesa en el servidor, sin ejecutar fórmulas ni
                  macros; se descarta el archivo original al terminar. Solo el
                  contenido revisable del borrador se guarda de forma privada.
                </p>
                <div className="filters">
                  <label htmlFor="import-separator">
                    Separador CSV
                    <select
                      id="import-separator"
                      value={separator}
                      onChange={(e) =>
                        setSeparator(e.target.value as CsvSeparator)
                      }
                    >
                      <option value=";">Punto y coma</option>
                      <option value=",">Coma</option>
                      <option value={"\t"}>Tabulación</option>
                    </select>
                  </label>
                  {(["description", "date", "amount", "currency"] as const).map(
                    (field) => (
                      <label key={field} htmlFor={`import-column-${field}`}>
                        Columna{" "}
                        {
                          {
                            description: "descripción",
                            date: "fecha",
                            amount: "importe",
                            currency: "moneda",
                          }[field]
                        }
                        <input
                          id={`import-column-${field}`}
                          value={headers[field]}
                          onChange={(e) =>
                            setHeaders((current) => ({
                              ...current,
                              [field]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ),
                  )}
                </div>
                <label htmlFor="import-file">
                  Archivo CSV o Excel
                  <input
                    id="import-file"
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void openFile(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                {sheets.length ? (
                  <div className="filters">
                    <label htmlFor="import-sheet">
                      Hoja Excel
                      <select
                        id="import-sheet"
                        value={sheetId}
                        onChange={(e) => setSheetId(e.target.value)}
                      >
                        {sheets.map((sheet) => (
                          <option key={sheet.id} value={sheet.id}>
                            {sheet.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      onClick={() => {
                        try {
                          const sheet = sheets.find((s) => s.id === sheetId);
                          if (sheet)
                            applyTable(sheet.table, "excel", sheet.name);
                        } catch (cause) {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "No se pudo interpretar la hoja.",
                          );
                        }
                      }}
                    >
                      Preparar hoja seleccionada
                    </button>
                  </div>
                ) : null}
                <label htmlFor="import-paste">
                  Pegar tabla con encabezados
                  <textarea
                    id="import-paste"
                    rows={5}
                    value={paste}
                    maxLength={1000000}
                    onChange={(e) => setPaste(e.target.value)}
                    placeholder={
                      "description\tdate\tamount\tcurrency\nCena\t2026-01-01\t100.00\tPEN"
                    }
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                <button
                  onClick={() => {
                    try {
                      applyTable(parseCsv(paste, "\t"), "csv");
                      setSheets([]);
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "No se pudo interpretar la tabla.",
                      );
                    }
                  }}
                >
                  Preparar datos pegados
                </button>
              </fieldset>
              <p className="hint">
                Fechas AAAA-MM-DD; importes decimales sin símbolo ni separador
                de miles; moneda explícita PEN o USD. Máximo 200 filas
                candidatas por lote. Las imágenes y la extracción con IA aún no
                están habilitadas.
              </p>
              {sourceNote ? (
                <p role="status">
                  {sourceNote} La evidencia temporal de cada fila se limita a
                  2.000 caracteres.
                </p>
              ) : null}
              {sourceWarnings.length ? (
                <ul>
                  {sourceWarnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}
          <details className="entry-drafts">
            <summary>Recuperar borradores</summary>
            <h2>Borradores y resultados privados</h2>
            <p>
              Los borradores caducan a los siete días. Guardar un borrador no
              registra gastos.
            </p>
            <div className="actions">
              <button disabled={busy || dirty || uncertain} onClick={reset}>
                Nuevo registro
              </button>
              <button
                disabled={busy || uncertain}
                onClick={() => void refreshJobs()}
              >
                Actualizar lista de borradores
              </button>
              {jobs.map((value) => (
                <button
                  key={value.id}
                  disabled={busy || dirty || uncertain}
                  onClick={() => void openJob(value.id)}
                >
                  Abrir {value.sourceType} ·{" "}
                  {value.state === "preview"
                    ? "borrador"
                    : value.state === "persisted"
                      ? "guardado"
                      : value.state === "cancelled"
                        ? "cancelado"
                        : "caducado"}{" "}
                  · {new Date(value.createdAt).toLocaleDateString("es-PE")}
                </button>
              ))}
            </div>
            {dirty ? (
              <p className="hint">
                Hay cambios sin guardar. Guarda el borrador o descártalo antes
                de cambiar de pantalla o abrir otro lote.
              </p>
            ) : null}
          </details>
        </>
      ) : null}
      <footer>CUSCO · REGISTRO DE GASTOS</footer>
    </main>
  );
}
