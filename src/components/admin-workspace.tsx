"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  forgetPending,
  recoverPending,
  rememberPending,
  type PendingOperation,
} from "@/domain/pending-operation";
type AccessLink = {
  id: string;
  displayName: string;
  role: "admin" | "participant";
  version: number;
  revoked: boolean;
  expired: boolean;
  own: boolean;
};
type Command =
  | { operation: "rotate"; id: string; expectedVersion: number }
  | { operation: "revoke"; id: string };
type Snapshot = { links: AccessLink[]; csrfToken: string };
class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(options: RequestInit = {}): Promise<T> {
  const r = await fetch("/api/access/links", {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  const d = await r.json();
  if (!r.ok)
    throw new RequestError(
      r.status,
      d.error ?? "No se pudo completar la operación.",
    );
  return d;
}
export default function AdminWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [review, setReview] = useState<PendingOperation<Command> | null>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [ack, setAck] = useState(false),
    [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    void api<Snapshot>()
      .then(async (s) => ({
        s,
        p: await recoverPending<Command>(s.csrfToken, sessionStorage, "access"),
      }))
      .then(({ s, p }) => {
        if (active) {
          setSnapshot(s);
          setReview(p);
          setUncertain(!!p);
        }
      })
      .catch(() => {
        if (active)
          setError(
            "No se pudo abrir la administración. Se requiere un enlace administrativo activo.",
          );
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [review]);
  async function submit() {
    if (!snapshot || !review || busy || !ack) return;
    setBusy(true);
    setError("");
    let sent = false;
    try {
      await rememberPending(
        review,
        snapshot.csrfToken,
        sessionStorage,
        "access",
      );
      sent = true;
      const result = await api<{ url?: string }>({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": snapshot.csrfToken,
          "Idempotency-Key": review.key,
        },
        body: JSON.stringify(review.command),
      });
      try {
        forgetPending(sessionStorage, "access");
      } catch {}
      setReview(null);
      setUncertain(false);
      setAck(false);
      setUrl(result.url ?? "");
      try {
        setSnapshot(await api<Snapshot>());
      } catch {
        setError("La operación terminó. Recarga para actualizar la lista.");
      }
    } catch (e) {
      const definitive =
        e instanceof RequestError &&
        [400, 401, 403, 409].includes(e.status) &&
        !uncertain;
      if (!sent || definitive) {
        try {
          forgetPending(sessionStorage, "access");
        } catch {}
        setReview(null);
        setAck(false);
      } else setUncertain(true);
      setError(
        sent && !definitive
          ? "No se pudo confirmar el resultado. Reintenta la misma operación; no generes otra clave."
          : e instanceof Error
            ? e.message
            : "No se pudo completar la operación.",
      );
    } finally {
      setBusy(false);
    }
  }
  function prepare(link: AccessLink, operation: "rotate" | "revoke") {
    setUrl("");
    setError("");
    setAck(false);
    setReview({
      key: crypto.randomUUID(),
      command:
        operation === "rotate"
          ? { operation, id: link.id, expectedVersion: link.version }
          : { operation, id: link.id },
    });
  }
  return (
    <main>
      <header>
        <Link
          className="brand"
          href="/gastos"
          onNavigate={(e) => {
            if (review) e.preventDefault();
          }}
        >
          C / Cusco
        </Link>
      </header>
      <h1>Administrar accesos</h1>
      <p>
        Revocar invalida el enlace y sus sesiones. Renovar crea un enlace nuevo
        y deja inutilizable el anterior.
      </p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {!snapshot ? (
        <p>Abre tu enlace administrativo para gestionar accesos.</p>
      ) : (
        <>
          {url ? (
            <section className="notice">
              <h2>Nuevo enlace privado</h2>
              <p>
                Entrégalo únicamente a su titular. Se muestra después de
                renovar; no se publica en la lista.
              </p>
              <label htmlFor="private-access-url">Enlace privado</label>
              <input
                id="private-access-url"
                value={url}
                readOnly
                onFocus={(e) => e.target.select()}
              />
              <button onClick={() => setUrl("")}>Ocultar enlace</button>
            </section>
          ) : null}
          {review ? (
            <section className="notice" aria-labelledby="access-review">
              <h2 id="access-review">
                Confirmar{" "}
                {review.command.operation === "rotate"
                  ? "renovación"
                  : "revocación"}
              </h2>
              <p>
                {snapshot.links.find((l) => l.id === review.command.id)
                  ?.displayName ?? "Acceso seleccionado"}
              </p>
              {uncertain ? (
                <p>
                  Hay una operación pendiente de respuesta. Este reintento usa
                  la misma clave.
                </p>
              ) : null}
              <label className="person">
                <span>Confirmo que quiero invalidar el acceso anterior.</span>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  disabled={busy}
                />
              </label>
              <button onClick={() => void submit()} disabled={!ack || busy}>
                {busy
                  ? "Procesando…"
                  : uncertain
                    ? "Reintentar la misma operación"
                    : "Confirmar cambio de acceso"}
              </button>
              {!uncertain ? (
                <button
                  disabled={busy}
                  onClick={() => {
                    setReview(null);
                    setAck(false);
                  }}
                >
                  Cancelar
                </button>
              ) : null}
            </section>
          ) : null}
          <section aria-label="Enlaces del grupo">
            {snapshot.links.map((l) => (
              <article key={l.id} className="expense-card">
                <h2>{l.displayName}</h2>
                <p>
                  {l.role === "admin" ? "Administración" : "Participante"} ·{" "}
                  {l.revoked ? "Revocado" : l.expired ? "Expirado" : "Activo"}
                  {l.own ? " · Tu acceso actual" : ""}
                </p>
                {!l.own ? (
                  <div className="actions">
                    <button
                      disabled={!!review || busy}
                      onClick={() => prepare(l, "rotate")}
                    >
                      Renovar enlace
                    </button>
                    <button
                      disabled={!!review || busy || l.revoked}
                      onClick={() => prepare(l, "revoke")}
                    >
                      Revocar enlace
                    </button>
                  </div>
                ) : (
                  <p>
                    Para recuperar o renovar tu propio acceso administrativo,
                    utiliza el procedimiento seguro de recuperación.
                  </p>
                )}
              </article>
            ))}
          </section>
        </>
      )}
    </main>
  );
}
