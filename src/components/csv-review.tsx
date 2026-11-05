"use client";
import { useState } from "react";
import {
  csvCandidates,
  parseCsv,
  CsvError,
  CSV_LIMITS,
  type CsvCandidate,
  type CsvHeaderMap,
  type CsvPreview,
  type CsvSeparator,
} from "@/domain/csv";
import { parseMoney, type Currency } from "@/domain/money";
export type ReviewedCsvRow = {
  description: string;
  date: string;
  amount: string;
  currency: Currency;
};
const labels = {
  REQUIRES_REVIEW: "Requiere revisión",
  MISSING_DESCRIPTION: "Falta descripción",
  INVALID_DATE: "Fecha inválida o ambigua",
  INVALID_AMOUNT: "Importe inválido",
  UNKNOWN_CURRENCY: "Moneda desconocida",
  FORMULA_LIKE_CONTENT:
    "Contiene texto parecido a una fórmula; no se ha ejecutado",
  OUTSIDE_TRIP_DATES: "Fuera de las fechas del viaje",
};
function ReviewRow({
  candidate,
  onUse,
}: {
  candidate: CsvCandidate;
  onUse: (value: ReviewedCsvRow) => void;
}) {
  const initial =
    candidate.amountMinor === null
      ? ""
      : `${BigInt(candidate.amountMinor) / 100n}.${(BigInt(candidate.amountMinor) % 100n).toString().padStart(2, "0")}`;
  const [description, setDescription] = useState(candidate.description ?? ""),
    [date, setDate] = useState(candidate.date ?? ""),
    [amount, setAmount] = useState(initial),
    [currency, setCurrency] = useState(candidate.currency ?? ""),
    [checked, setChecked] = useState(false);
  let validAmount = false;
  try {
    parseMoney(amount);
    validAmount = true;
  } catch {}
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= "2000-01-01" &&
    date <= "2100-12-31" &&
    Number.isFinite(Date.parse(date + "T00:00:00Z")) &&
    new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date;
  return (
    <article className="expense-card">
      <h3>Fila {candidate.sourceRow}</h3>
      <details>
        <summary>Ver texto de origen</summary>
        <dl>
          {Object.entries(candidate.fields).map(([field, cell]) => (
            <div key={field}>
              <dt>
                {field} · fila {cell.row}, columna {cell.columnIndex}
              </dt>
              <dd className="literal">{cell.literal}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p>{candidate.warnings.map((w) => labels[w]).join(" · ")}</p>
      <div className="filters">
        <label>
          Descripción fila {candidate.sourceRow}
          <input
            value={description}
            maxLength={240}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          Fecha fila {candidate.sourceRow}
          <input
            type="date"
            min="2000-01-01"
            max="2100-12-31"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          Importe fila {candidate.sourceRow}
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Moneda fila {candidate.sourceRow}
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="">Seleccionar</option>
            <option>PEN</option>
            <option>USD</option>
          </select>
        </label>
      </div>
      <label className="person">
        <span>
          He revisado la evidencia y confirmo que esta fila representa un gasto.
        </span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
      </label>
      <button
        disabled={
          !checked ||
          !description.trim() ||
          !validDate ||
          !validAmount ||
          !["PEN", "USD"].includes(currency)
        }
        onClick={() =>
          onUse({
            description: description.trim(),
            date,
            amount,
            currency: currency as Currency,
          })
        }
      >
        Llevar fila {candidate.sourceRow} al formulario
      </button>
      <p className="hint">
        No guarda el gasto. Revisa pagador y beneficiarios en el formulario
        antes de confirmar.
      </p>
    </article>
  );
}
export default function CsvReview({
  onUse,
  disabled,
}: {
  onUse: (row: ReviewedCsvRow) => void;
  disabled: boolean;
}) {
  const [separator, setSeparator] = useState<CsvSeparator>(";"),
    [preview, setPreview] = useState<CsvPreview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  const [headers, setHeaders] = useState<CsvHeaderMap>({
    description: "description",
    date: "date",
    amount: "amount",
    currency: "currency",
  });
  async function load(file: File) {
    setError("");
    setPreview(null);
    setLoading(true);
    try {
      if (file.size > CSV_LIMITS.bytes) throw new CsvError("FILE_TOO_LARGE");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      setPreview(csvCandidates(parseCsv(text, separator), headers));
      setRevision((n) => n + 1);
    } catch (e) {
      setError(
        e instanceof CsvError
          ? `${e.message} (${e.code}${e.row ? `, fila ${e.row}` : ""})`
          : "No se pudo leer el archivo como CSV UTF-8.",
      );
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="settlement" aria-labelledby="csv-title">
      <h2 id="csv-title">Transcribir desde CSV</h2>
      <p>
        Este asistente copia una fila al registro manual; todavía no es una
        importación masiva con trazabilidad del archivo. El archivo se procesa
        en este navegador. No se sube ni se guarda automáticamente. Selecciona
        el separador y los nombres exactos de las columnas antes de abrirlo.
      </p>
      <fieldset disabled={loading || disabled}>
        <div className="filters">
          <label>
            Separador
            <select
              value={separator}
              onChange={(e) => setSeparator(e.target.value as CsvSeparator)}
            >
              <option value=";">Punto y coma</option>
              <option value=",">Coma</option>
              <option value={"\t"}>Tabulación</option>
            </select>
          </label>
          {(["description", "date", "amount", "currency"] as const).map(
            (field) => (
              <label key={field}>
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
        <label>
          Archivo CSV UTF-8
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void load(file);
              e.target.value = "";
            }}
          />
        </label>
      </fieldset>
      <p role="status">{loading ? "Leyendo CSV…" : error}</p>
      {preview ? (
        <div key={revision}>
          <p>
            {preview.candidates.length} candidatos ·{" "}
            {preview.omittedEmptyRows.length} filas vacías omitidas.{" "}
            {preview.omittedColumns.length
              ? `Columnas no utilizadas: ${preview.omittedColumns.join(", ")}.`
              : ""}
          </p>
          {preview.omittedEmptyRows.length ? (
            <p className="hint">
              Filas vacías: {preview.omittedEmptyRows.join(", ")}.
            </p>
          ) : null}
          <fieldset disabled={disabled || loading}>
            {preview.candidates.map((c) => (
              <ReviewRow key={c.sourceRow} candidate={c} onUse={onUse} />
            ))}
          </fieldset>
          <button onClick={() => setPreview(null)}>Descartar candidatos</button>
        </div>
      ) : null}
    </section>
  );
}
