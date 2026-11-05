"use client";
import Link from "next/link";
import { useState } from "react";
import {
  calculateBalances,
  equalSplit,
  formatMoney,
  parseMoney,
  type Currency,
} from "@/domain/money";
import { planSettlement } from "@/domain/settlement";
const participants = [
  { id: "demo-01", name: "Participante 1" },
  { id: "demo-02", name: "Participante 2" },
  { id: "demo-03", name: "Participante 3" },
];
export default function Home() {
  const [payerId, setPayerId] = useState("demo-01");
  const [amount, setAmount] = useState("100.00");
  const [currency, setCurrency] = useState<Currency>("PEN");
  const [selected, setSelected] = useState(participants.map((p) => p.id));
  let error = "";
  let splits: ReturnType<typeof equalSplit> = [];
  try {
    splits = equalSplit(parseMoney(amount), selected);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Revisa el reparto.";
  }
  return (
    <main>
      <header>
        <Link href="/" className="brand">
          C / <span>Cusco</span>
        </Link>
        <Link className="badge" href="/gastos">
          Entrar a mis gastos
        </Link>
      </header>
      <section className="intro">
        <p className="eyebrow">CUENTAS CLARAS, BUENOS RECUERDOS</p>
        <h1>
          El viaje termina.
          <br />
          Las cuentas, también.
        </h1>
        <p>
          Reparte cada gasto al céntimo y revisa cuánto le corresponde a cada
          persona.
        </p>
      </section>
      <div className="notice">
        <strong>Vista de desarrollo</strong> · Participantes de ejemplo. Este
        cálculo no guarda gastos ni accede a datos del grupo.
      </div>
      <section className="workspace" aria-labelledby="draft-title">
        <div className="editor">
          <p className="eyebrow">01 / PREPARAR EL REPARTO</p>
          <h2 id="draft-title">Un gasto, bien repartido.</h2>
          <label htmlFor="amount">Importe total</label>
          <div className="amount-row">
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              maxLength={15}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "split-error" : undefined}
            />
            <select
              aria-label="Moneda"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
            >
              <option value="PEN">PEN · Soles</option>
              <option value="USD">USD · Dólares</option>
            </select>
          </div>
          <label htmlFor="payer">¿Quién pagó?</label>
          <select
            id="payer"
            className="payer-select"
            value={payerId}
            onChange={(e) => setPayerId(e.target.value)}
          >
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <fieldset>
            <legend>¿Entre quiénes se reparte?</legend>
            {participants.map((p) => (
              <label className="person" key={p.id}>
                <span>{p.name}</span>
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, p.id]
                        : selected.filter((id) => id !== p.id),
                    )
                  }
                />
              </label>
            ))}
          </fieldset>
        </div>
        <div className="preview">
          <p className="eyebrow">02 / REVISAR</p>
          <h2>A cada persona le toca</h2>
          <div aria-live="polite" aria-atomic="true">
            {error ? (
              <p id="split-error" className="error">
                {error}
              </p>
            ) : (
              <>
                <ul>
                  {splits.map((split) => (
                    <li key={split.participantId}>
                      <span>
                        {
                          participants.find((p) => p.id === split.participantId)
                            ?.name
                        }
                      </span>
                      <strong>
                        {formatMoney(split.amountMinor, currency)}
                      </strong>
                    </li>
                  ))}
                </ul>
                <div className="total">
                  <span>Total repartido</span>
                  <strong>{formatMoney(parseMoney(amount), currency)}</strong>
                </div>
                <p className="hint">
                  Los céntimos restantes se asignan por identificador de
                  participante, en orden estable. El reparto siempre suma el
                  total.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
      {!error ? (
        <section className="settlement" aria-labelledby="settlement-title">
          <p className="eyebrow">03 / VISTA PREVIA DE LIQUIDACIÓN</p>
          <h2 id="settlement-title">¿Quién le devuelve a quién?</h2>
          <ul>
            {planSettlement(
              calculateBalances([
                { payerId, currency, amountMinor: parseMoney(amount), splits },
              ])[currency],
              currency,
            ).transfers.map((t) => (
              <li key={t.senderId + t.receiverId}>
                <span>
                  {participants.find((p) => p.id === t.senderId)?.name} →{" "}
                  {participants.find((p) => p.id === t.receiverId)?.name}
                </span>
                <strong>{formatMoney(t.amountMinor, currency)}</strong>
              </li>
            ))}
          </ul>
          {splits.length === 1 && splits[0].participantId === payerId ? (
            <p>No hay transferencias: el pagador cubre su propia parte.</p>
          ) : (
            <p className="hint">
              Mínimo de transferencias probado para este borrador. Es una
              propuesta de devolución; no registra pagos.
            </p>
          )}
        </section>
      ) : null}
      <footer>
        CUSCO · PEN & USD <span>Un viaje. Un grupo. Todo en orden.</span>
      </footer>
    </main>
  );
}
