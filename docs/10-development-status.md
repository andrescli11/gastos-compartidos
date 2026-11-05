# Estado de implementación — 2026-11-05

Rama `feat/foundations-money`. Código local en desarrollo; sin integración ni despliegue. No hay conexión real a Supabase y no se han confirmado gastos reales.

## Código preparado

- Next.js App Router y TypeScript estricto, estilos responsive y calculadora pública de prueba con participantes sintéticos.
- Dinero bigint, repartos iguales/personalizados, libros PEN/USD, conversión USD→PEN half-up y mayores restos, plan mínimo hasta 18 saldos y alternativa determinista explícita por encima del límite.
- Persistencia SQL fuente: viaje fijo, participantes, hashes de enlaces/sesiones, gastos, repartos, revisiones financieras, auditoría, idempotencia y cuotas persistentes.
- API SQL privada para crear, editar, anular y leer gastos. Autorización de sesión/pagador en la transacción, constraints diferidos y control optimista. Driver de servidor con TLS, consultas parametrizadas y `SET LOCAL ROLE cusco_bff` por llamada.
- Canje de enlaces, sesiones hasta 8h, contexto, logout y revocación administrativa, con cuotas y auditoría. SQL en `db/access.sql`.
- Rutas HTTP de acceso, sesión, gastos y resumen: cookies `__Host-` HttpOnly/Secure/SameSite, origen y CSRF, JSON acotado, errores sanitizados, cuotas IP/sesión/global y `private, no-store`. Sin configuración válida rechazan acceso.
- `/entrar`: elimina el fragmento del historial antes del canje. `/gastos`: revisión y confirmación explícita, creación, edición y anulación, filtros, detalle, balances y propuesta de devoluciones calculada en servidor.
- Recuperación de operación incierta dentro de la misma pestaña y sesión: diario AES-GCM en sessionStorage antes de confirmar la solicitud; clave de cifrado derivada del CSRF de sesión y no persistida. Al recargar se recupera el comando y la misma clave de idempotencia, sin reenviarlo automáticamente. Incertidumbre conservada ante 429/403 después de timeout/5xx; un rechazo inequívoco del primer intento limpia el diario para evitar quedar atrapado. Aviso de navegación y logout bloqueado mientras el resultado siga incierto. No sustituye borradores recuperables de servidor ni recuperación tras cerrar pestaña/expirar sesión.
- Duplicados aproximados por fecha, importe, moneda y descripción normalizada: advertencia y decisión explícita de conservar ambos. No se fusiona ni elimina automáticamente.
- Parser CSV estricto con evidencia literal/coordenadas, límites y advertencias. Asistente local para corregir y copiar UNA fila al registro manual, confirmar que representa un gasto y seleccionar reparto antes de guardar. No sube el archivo ni persiste candidatos automáticamente. NO es la importación CSV masiva: falta identidad/procedencia durable por fila, jobs, drafts privados de servidor y confirmación por lote.

## Comprobaciones ejecutadas

`npm run test:local` funciona sin descargar dependencias y agrupa:

- 1800 escenarios monetarios de conservación/positividad/libros separados.
- 560 planes contrastados con oráculo exhaustivo, límite 18 y alternativa 19, conversión y redondeo.
- Matriz de políticas de gastos/pagos.
- Contratos del adaptador SQL con ejecutor simulado, parametrización, precisión y errores sin datos sensibles.
- Handlers HTTP con dependencias simuladas: origen/CSRF, cookies, cuotas, límites JSON, revocación y resumen.
- CSV adversarial: comillas, multilinea, límites, monedas/fechas, fórmulas solo señalizadas y ausencia de escritura.
- Diario cifrado: recuperación de la misma clave, alteraciones rechazadas y separación entre sesiones.

Revisiones independientes estáticas de dominio, persistencia, acceso y CSV realizadas. Se corrigieron parser con salto de línea, privilegios efectivos del driver, campos de fuente, incertidumbre sticky y recuperación de clave.

## Preparado, pero NO ejecutado

- PostgreSQL: fixtures transaccionales, permisos/RLS, sesiones/revocación, idempotencia, constraints y pruebas de concurrencia. Workflow `database.yml` independiente de npm; runner `npm run test:db` solo para base efímera vacía.
- Playwright móvil/escritorio: calculadora, flujo con API simulada, confirmación obligatoria, timeout→429, recuperación tras recarga y limpieza de fragmento.
- Instalación reproducible, lockfile, formato, ESLint, typecheck, Vitest, build, audit de dependencias y smoke test real. Antes de producción, completar CSP con nonce en lugar de scripts inline permitidos y verificar cabeceras en navegador real.
- Supabase CLI/advisors y generación de migraciones. Los archivos `db/*.sql` son fuente; no se inventaron nombres de migración sin CLI.

## Bloqueo actual comprobado

El proxy del entorno no responde. La instalación npm y la consulta de documentación remota fallaron. El intento de red con permisos adicionales quedó bloqueado y fue interrumpido; no se repetirá sin corregir el entorno. No hay psql/servidor PostgreSQL ni Supabase CLI; el socket Docker no es accesible.

No se eludió proxy/TLS, no se imprimieron secretos y no se intentó conectar a producción. `init:local` creó `.env.local` ignorado por Git con secreto aleatorio privado, sin imprimirlo ni sobrescribir configuración. DATABASE_URL continúa sin configurar.

## Próximo paso y gates

Restaurar el entorno para instalar herramientas y ejecutar CI local/base efímera antes de seguir acumulando cambios financieros. Instrucciones y checkpoint agrupado en `11-integration-checkpoint.md`.

Gates A/C/D no superados; B tiene evidencia financiera local y revisión, pendiente suite integrada. E/IA deshabilitada. F/pagos y G/producción pendientes.

Quedan entrada masiva con confirmación atómica, importaciones persistentes CSV/Excel/archivos, evaluación IA, pagos y bloqueo de liquidación, administración de enlaces en UI, accesibilidad verificada y despliegue/rollback ensayado. No se declaran completas esas fases.

## Avance sin cambios de entorno: pagos

Se añadió dominio puro de pagos y resumen de cierre. Estados, permisos, parciales, anulación, bloqueo de configuración y reintentos semánticos están implementados y probados con Node sin dependencias. `npm run test:payments` pasa, incluidos 120 cierres completos separados/consolidados, y se integra en `test:domain`/`test:local`.

Revisión independiente favorable del núcleo. No hay aún SQL, BFF ni UI de pagos; los endpoints actuales siguen describiendo gastos sin pagos. Gate F no superado. Contratos, interpretación de pagos distintos del neto y pendientes en `12-offline-payment-domain.md`.

## Avance sin cambios de entorno: confirmación por lote

Se añadió dominio de revisión privada y confirmación de importaciones: propiedad, versiones, candidatos separados de gastos, manifiesto explícito, advertencias y duplicados reconocidos por revisión, resultados por fila, reintento sin repetir éxitos y expiración a siete días.

`npm run test:imports` ejecuta la máquina de estados y un recorrido CSV→revisión→confirmación→resultado parcial→reintento, sin escrituras reales. Revisión independiente favorable tras corregir limpieza terminal y comparación canónica de recibos. No hay nuevos servicios ni credenciales requeridas para estas pruebas.

La persistencia de jobs/ítems, transacción de confirmación, Storage/TTL físico y UI masiva siguen pendientes. `13-offline-import-workflow.md` detalla contratos y límites. Gate D no superado.

## Publicación GitHub e integración de pagos — 2026-11-05

- Primer avance publicado en `feat/foundations-money`, commit `1ae4d92f6ce0ba3e1a6786cb00cc0983329e8429`, PR de borrador #1. Main no se modificó.
- GitHub Actions ejecutó PostgreSQL 17: workflow Database del snapshot inicial APROBADO, incluidas persistencia, acceso y concurrencia de gastos. Evidencia: https://github.com/andrescli11/gastos-compartidos/actions/runs/41978816321 . Esta ejecución no incluye las adiciones posteriores de pagos.
- Quality inicial falló por ausencia de lockfile. Se prepara bootstrap restringido a la rama para resolver dependencias sin lifecycle scripts, fijar versiones, formatear fuentes ya tracked y publicar lockfile/normalización con permisos temporales mínimos. Después ejecuta los checks completos; no altera producción.
- Nuevo código de pagos integrado: `db/payments.sql`, fixtures SQL, contexto consistente, mutaciones autorizadas/idempotentes, lock del viaje, elección administrativa, configuración bloqueada, razones de anulación solo para admin; repositorio y rutas HTTP con importes strings y CSRF; pantalla `/pagos` con revisión, advertencias y recuperación cifrada separada.
- Contratos de API y namespace de recuperación probados localmente. Se añadieron pruebas PostgreSQL concurrentes de registro/reintento, confirmación frente a cambio de configuración, auditoría única y anulación repetida; se ejecutarán en CI con el nuevo snapshot.
- Un rechazo SQL de versión obsoleta se identifica como `STALE_VERSION`, distinto de un conflicto de clave/payload. Dado el contador monótono y el lookup de idempotencia previo, permite liberar una operación incierta y revisar sobre el libro actual. Conflictos genéricos y límites siguen conservando la incertidumbre.
- Conexiones de herramientas GitHub/Supabase/Vercel disponibles. Se encontró proyecto Supabase `app-gastos-compartidos`; inspección de public/app_private/app_api sin tablas. No se escribió en el proyecto ni se asumió que sea desarrollo. Vercel no devolvió proyectos Git enlazados en el equipo consultado; no se creó despliegue.

- Snapshot de pagos `368d97d8f87e22c274b1a82258c457db7f0619cc`: Database APROBADO con nuevas tablas, fixtures y concurrencia real de pagos. Evidencia: https://github.com/andrescli11/gastos-compartidos/actions/runs/41982659229 .
- Bootstrap resolvió/fijó dependencias y formateó código, pero la escritura desde Actions fue rechazada con403. Se reemplaza por exportación de artefacto de fuentes/lockfile con permisos solo lectura; el agente publicará el resultado usando la conexión GitHub autorizada. Los checks se ejecutan igualmente y conservan los fallos.
- El resumen de la pantalla de gastos ahora deriva del mismo libro con pagos confirmados y configuración vigente; evita seguir proponiendo deudas ya pagadas. Regresión API local aprobada.

## Actualización: integración validada en CI

El commit `2bf8e91d33b3342aa5c7b80f21066067808c7b6a` aprueba Quality y Database, incluido HTTP real contra Next/PostgreSQL desechable: sesiones, gasto idempotente, pago confirmado, saldo y revocación. Pagos tiene SQL, API e interfaz integrados. Ver [evidencia y límites](14-verification.md). Los bloqueos históricos de instalación/build en este documento se resolvieron mediante CI; persisten configuración externa, importación masiva y gates de producción. No hay despliegue ni cambios en la base Supabase.
