'use client';
import { useEffect, useRef, useState } from 'react';
export default function Enter(){
  const started=useRef(false);
  const [status,setStatus]=useState('Comprobando tu enlace…');
  useEffect(()=>{
    if(started.current)return;started.current=true;
    const fragment=window.location.hash;
    // Se limpia antes de cualquier llamada; no se guarda en localStorage ni telemetría.
    window.history.replaceState(null,'','/entrar');
    const params=new URLSearchParams(fragment.slice(1));
    const token=params.get('token');
    if(!token||params.size!==1){setStatus('El enlace no es válido. Pide al administrador tu enlace privado.');return;}
    void fetch('/api/access/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),credentials:'same-origin',cache:'no-store'})
      .then(async response=>{if(!response.ok){setStatus(response.status===503?'El acceso todavía no está disponible. Inténtalo más tarde.':'El enlace no es válido, expiró o fue revocado. Pide uno nuevo al administrador.');return;}window.location.replace('/gastos');})
      .catch(()=>setStatus('No se pudo conectar. Abre de nuevo tu enlace privado para reintentar.'));
  },[]);
  return <main className="access-screen"><p className="eyebrow">CUSCO · ACCESO PRIVADO</p><h1>Las cuentas del viaje.</h1><p role="status">{status}</p><a href="/">Volver al inicio</a></main>;
}
