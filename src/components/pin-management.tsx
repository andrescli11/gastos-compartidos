"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type PinUser = {
  id: string;
  displayName: string;
  role: "participant" | "admin";
  version: number;
  pinEnabled: boolean;
  hasPin: boolean;
  own: boolean;
};
type Snapshot = { users: PinUser[]; csrfToken: string };
type Command =
  | { operation: "set"; id: string; expectedVersion: number; pin: string }
  | { operation: "disable"; id: string; expectedVersion: number };
type Review = { command: Command; key: string; target: PinUser };
class PinRequestError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super("No se pudo completar el cambio de PIN.");
  }
}
async function request<T>(init?: RequestInit): Promise<T> {
  const response = await fetch("/api/access/pin/manage", {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new PinRequestError(
      response.status,
      typeof data.code === "string" ? data.code : undefined,
    );
  return data as T;
}
export default function PinManagement() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [pin, setPin] = useState("");
  // PINs exist only in this component's memory until the request is resolved.
  // They are never placed in browser storage or a persistent pending journal.
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [ownAcknowledged, setOwnAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const data = await request<Snapshot>();
      setSnapshot(data);
      setSelected((current) =>
        data.users.some((user) => user.id === current)
          ? current
          : (data.users[0]?.id ?? ""),
      );
    } catch (cause) {
      setSnapshot(null);
      setError(
        cause instanceof PinRequestError && cause.status === 403
          ? "Solo el administrador puede gestionar los PIN."
          : cause instanceof PinRequestError && cause.status === 401
            ? "La sesión terminó. Vuelve a entrar con tu acceso administrativo."
            : "No se pudo cargar la gestión de PIN. Recarga la página para reintentar.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);
  useEffect(() => {
    if (!review && !busy) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [review, busy]);
  const target = snapshot?.users.find((user) => user.id === selected);
  const locked = busy || !!review;
  function guardNavigation(event: { preventDefault(): void }) {
    if (review || busy) {
      event.preventDefault();
      setError("Termina la revisión o comprueba el resultado antes de salir.");
    }
  }
  function prepare(operation: Command["operation"], event?: FormEvent) {
    event?.preventDefault();
    if (!target || locked || (operation === "disable" && !target.pinEnabled))
      return;
    if (operation === "set" && !/^[0-9]{3}$/.test(pin)) {
      setError("Introduce exactamente tres dígitos, del 000 al 999.");
      return;
    }
    setError("");
    setMessage("");
    setOwnAcknowledged(false);
    const command: Command =
      operation === "set"
        ? { operation, id: target.id, expectedVersion: target.version, pin }
        : { operation, id: target.id, expectedVersion: target.version };
    setReview({ command, key: crypto.randomUUID(), target });
    setPin("");
  }
  async function submit() {
    if (!snapshot || !review || busy || (review.target.own && !ownAcknowledged))
      return;
    setBusy(true);
    setError("");
    const wasUncertain = uncertain;
    let sent = false,
      committed = false;
    try {
      sent = true;
      const result = await request<{ ok: true; ownSessionRevoked: boolean }>({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": snapshot.csrfToken,
          "Idempotency-Key": review.key,
        },
        body: JSON.stringify(review.command),
      });
      committed = true;
      setPin("");
      setReview(null);
      setUncertain(false);
      setOwnAcknowledged(false);
      if (result.ownSessionRevoked) {
        setSnapshot(null);
        window.location.replace("/");
        return;
      }
      setMessage(
        review.command.operation === "set"
          ? "PIN actualizado. Se cerraron las sesiones anteriores de ese acceso."
          : "PIN desactivado. Se cerraron las sesiones anteriores de ese acceso.",
      );
      setSnapshot(null);
      await load();
    } catch (cause) {
      if (
        cause instanceof PinRequestError &&
        [401, 403].includes(cause.status)
      ) {
        setPin("");
        setReview(null);
        setSnapshot(null);
        setUncertain(false);
        setError(
          cause.status === 403
            ? "Solo el administrador puede gestionar los PIN."
            : "La sesión terminó. Si cambiaste tu propio PIN, entra con el nuevo PIN o con tu enlace administrativo.",
        );
      } else if (
        cause instanceof PinRequestError &&
        cause.status === 409 &&
        cause.code === "STALE_VERSION"
      ) {
        setPin("");
        setReview(null);
        setUncertain(false);
        setOwnAcknowledged(false);
        setError(
          "El acceso cambió. Revisa sus datos actuales antes de preparar otro cambio.",
        );
        await load();
      } else if (
        !committed &&
        sent &&
        (wasUncertain ||
          !(cause instanceof PinRequestError) ||
          cause.status >= 500)
      ) {
        setUncertain(true);
        setError(
          "No se pudo comprobar el resultado. Reintenta la misma operación; no cambies el PIN mientras se comprueba.",
        );
      } else {
        setPin("");
        setReview(null);
        setUncertain(false);
        setError(
          cause instanceof PinRequestError && cause.status === 400
            ? "Revisa el usuario y el PIN de tres dígitos."
            : "No se pudo guardar el cambio de PIN.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header className="payment-header">
        <Link href="/administrar" onNavigate={guardNavigation}>
          ← Administración
        </Link>
        <h1>Gestionar PIN</h1>
      </header>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {loading ? (
        <p role="status">Cargando accesos…</p>
      ) : !snapshot ? (
        <p>
          <Link href="/">Volver al acceso</Link>
        </p>
      ) : (
        <>
          <p>
            Establece un PIN de tres dígitos para cada participante o
            administrador. Puedes cambiar un PIN, pero no consultar el anterior.
          </p>
          <p>
            Los enlaces privados actuales siguen disponibles durante la
            transición.
          </p>
          <form
            className="editor expense-fields"
            onSubmit={(event) => prepare("set", event)}
          >
            <fieldset disabled={locked}>
              <label htmlFor="pin-target">Usuario</label>
              <select
                id="pin-target"
                value={selected}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setPin("");
                  setError("");
                }}
              >
                {snapshot.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.displayName}
                    {user.role === "admin" ? " · Administrador" : ""}
                  </option>
                ))}
              </select>
              {target ? (
                <p>
                  {target.own ? "Tu acceso actual · " : ""}
                  {target.pinEnabled
                    ? "PIN activo"
                    : target.hasPin
                      ? "PIN desactivado"
                      : "PIN sin configurar"}
                </p>
              ) : null}
              <label htmlFor="new-access-pin">Nuevo PIN</label>
              <input
                id="new-access-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="[0-9]{3}"
                minLength={3}
                maxLength={3}
                required
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                aria-describedby="new-access-pin-help"
              />
              <p id="new-access-pin-help">
                Exactamente tres dígitos. Se conservan los ceros iniciales, por
                ejemplo 007.
              </p>
              <button disabled={!target}>Revisar PIN</button>
              <button
                type="button"
                disabled={!target?.pinEnabled}
                onClick={() => prepare("disable")}
              >
                Desactivar PIN
              </button>
            </fieldset>
          </form>
          {review ? (
            <section className="confirmation" aria-label="Revisión de PIN">
              <h2>
                {review.command.operation === "set"
                  ? "Confirmar nuevo PIN"
                  : "Confirmar desactivación de PIN"}
              </h2>
              <p>{review.target.displayName}</p>
              <p>
                {review.command.operation === "set"
                  ? "Se guardará el nuevo PIN y se cerrarán las sesiones anteriores de este acceso."
                  : "Se desactivará el acceso mediante PIN y se cerrarán sus sesiones. El enlace privado seguirá disponible."}
              </p>
              {review.target.own ? (
                <>
                  <p className="notice">
                    Este cambio cerrará tu sesión actual.{" "}
                    {review.command.operation === "set"
                      ? "Vuelve a entrar con tu nuevo PIN."
                      : "Necesitarás tu enlace administrativo para volver a entrar."}
                  </p>
                  <label className="person">
                    <span>Entiendo que este cambio cerrará mi sesión.</span>
                    <input
                      type="checkbox"
                      checked={ownAcknowledged}
                      disabled={busy}
                      onChange={(event) =>
                        setOwnAcknowledged(event.target.checked)
                      }
                    />
                  </label>
                </>
              ) : null}
              {uncertain ? (
                <p>
                  El cambio permanece únicamente en memoria mientras se
                  comprueba. Si la sesión terminó, entra de nuevo con el nuevo
                  PIN o con tu enlace administrativo.
                </p>
              ) : null}
              <button
                disabled={busy || (review.target.own && !ownAcknowledged)}
                onClick={() => void submit()}
              >
                {busy
                  ? "Guardando…"
                  : uncertain
                    ? "Reintentar la misma operación"
                    : review.command.operation === "set"
                      ? "Confirmar PIN"
                      : "Confirmar desactivación"}
              </button>
              {!uncertain ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setReview(null);
                    setPin("");
                    setOwnAcknowledged(false);
                  }}
                >
                  Cancelar
                </button>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
