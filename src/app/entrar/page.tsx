"use client";
import Link from "next/link";
import PinLogin from "@/components/pin-login";
import { useEffect, useRef, useState } from "react";

async function exchange(params: URLSearchParams): Promise<string> {
  const token = params.get("token");
  if (!token || params.size !== 1) {
    return "El enlace no es válido. Pide al administrador tu enlace privado.";
  }
  try {
    const response = await fetch("/api/access/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      return response.status === 503
        ? "El acceso todavía no está disponible. Inténtalo más tarde."
        : "El enlace no es válido, expiró o fue revocado. Pide uno nuevo al administrador.";
    }
    window.location.replace("/gastos");
    return "Abriendo las cuentas del viaje…";
  } catch {
    return "No se pudo conectar. Abre de nuevo tu enlace privado para reintentar.";
  }
}

export default function Enter() {
  const started = useRef(false);
  const [status, setStatus] = useState("Comprobando tu enlace…");
  const [pinLogin, setPinLogin] = useState(false);
  useEffect(() => {
    function openAccess() {
      const fragment = window.location.hash;
      // Se limpia antes de cualquier llamada; no se guarda en localStorage ni telemetría.
      window.history.replaceState(null, "", "/entrar");
      if (!fragment || fragment === "#") {
        void Promise.resolve().then(() => setPinLogin(true));
        return;
      }
      void Promise.resolve().then(() => setPinLogin(false));
      const params = new URLSearchParams(fragment.slice(1));
      void exchange(params).then(setStatus);
    }
    window.addEventListener("hashchange", openAccess);
    if (!started.current) {
      started.current = true;
      openAccess();
    }
    return () => window.removeEventListener("hashchange", openAccess);
  }, []);
  if (pinLogin) return <PinLogin />;
  return (
    <main className="access-screen">
      <p className="eyebrow">CUSCO · ACCESO PRIVADO</p>
      <h1>Las cuentas del viaje.</h1>
      <p role="status">{status}</p>
      <Link href="/">Volver al inicio</Link>
    </main>
  );
}
