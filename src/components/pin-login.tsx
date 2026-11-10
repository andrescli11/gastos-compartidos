"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";

type LoginUser = {
  id: string;
  displayName: string;
  role: "admin" | "participant";
};
export default function PinLogin() {
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/access/pin/users", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!Array.isArray(data.users)) throw new Error();
        if (active) setUsers(data.users);
      })
      .catch(() => {
        if (active)
          setError(
            "No se pudieron cargar los usuarios. Recarga la página para intentarlo de nuevo.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !selected || !/^[0-9]{3}$/.test(pin)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id: selected, pin }),
      });
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Usuario o PIN incorrectos."
            : "No se pudo iniciar sesión. Inténtalo de nuevo.",
        );
        return;
      }
      window.location.replace("/");
    } catch {
      setError("No se pudo conectar. Inténtalo de nuevo.");
    } finally {
      setPin("");
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }
  return (
    <main className="pin-login-page">
      <div className="pin-login-logo" aria-hidden="true">
        Logo
      </div>
      <h1>Adiós Yacolino</h1>
      <section className="pin-login-card" aria-labelledby="pin-login-title">
        <h2 id="pin-login-title">Ingresa a las cuentas del viaje</h2>
        {loading ? <p role="status">Cargando usuarios…</p> : null}
        {error ? (
          <p role="alert" id="pin-login-error" className="error">
            {error}
          </p>
        ) : null}
        {!loading && !error && !users.length ? (
          <p>
            El administrador todavía no ha configurado los PIN. Puedes seguir
            entrando con tu enlace privado.
          </p>
        ) : null}
        <form onSubmit={submit}>
          <fieldset disabled={loading || busy || !users.length}>
            <label htmlFor="pin-user">Usuario</label>
            <select
              id="pin-user"
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setPin("");
                setError("");
              }}
              autoComplete="username"
              required
            >
              <option value="">Selecciona tu usuario</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
            <label htmlFor="login-pin">PIN de acceso</label>
            <input
              ref={inputRef}
              id="login-pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              pattern="[0-9]{3}"
              minLength={3}
              maxLength={3}
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              aria-describedby={
                error ? "pin-login-help pin-login-error" : "pin-login-help"
              }
              required
            />
            <p id="pin-login-help" className="hint">
              Introduce tu PIN de 3 dígitos.
            </p>
            <button
              type="submit"
              disabled={busy || !selected || !/^[0-9]{3}$/.test(pin)}
            >
              {busy ? "Ingresando…" : "Ingresar"}
            </button>
          </fieldset>
        </form>
      </section>
    </main>
  );
}
