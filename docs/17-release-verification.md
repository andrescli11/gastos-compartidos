# Verificación de liberación — 5 de noviembre de 2026

## Resultado

MVP operativo de gastos, importación determinística y pagos para el viaje fijo. Supabase real existente, siete participantes, fechas del 29/10/2026 al 02/11/2026. No se creó otro proyecto Supabase ni se insertaron movimientos financieros para comprobar producción.

La extracción de imágenes con IA queda deshabilitada por la excepción explícita de Gate E: no hay corpus aprobado, presupuesto ni condiciones de privacidad verificadas. No se presenta como función disponible.

## Evidencia del código

Commit de aplicación 8dac03abf9147a59221410d048ba9320c1947b79:

- [Quality aprobado](https://github.com/andrescli11/gastos-compartidos/actions/runs/42118054182): formato, lint, TypeScript, pruebas, build, navegador y audit sin críticos/altos. Persisten 8 avisos moderados transitivos del tooling TypeScript/ESLint documentados anteriormente; no se hizo downgrade forzado.
- [Database aprobado](https://github.com/andrescli11/gastos-compartidos/actions/runs/42118054183): SQL, autorización, idempotencia, concurrencia, importación parcial y TTL; backup/restore conserva datos y permisos, incluida denegación de EXECUTE público en funciones futuras.
- HTTP real Next→PostgreSQL aprobado.
- Navegador real→Next→PostgreSQL aprobado en escritorio/móvil: canje, URL limpia, revisión antes de gasto, pago y confirmación del receptor hasta saldo cero; administración; descarga de plantilla XLSX, llenado con ZIP/XML independiente, carga, borrador sin gasto y confirmación idempotente de una fila.
- Parsers hostiles ZIP/XML/CSV y plantilla verificados sin ejecutar fórmulas ni macros. La plantilla también pasó ZIP/CRC/XML con Python estándar.

## Producción real

Despliegue Vercel dpl_A3fJwUBX1cY2gLr9W78pqQUcuVKv READY, mismo commit, Node24 como CI. URL: https://gastos-compartidos-preview.vercel.app . El nombre histórico incluye preview; la base real y sus secretos se usan solo en production.

`check-live-readonly.mjs` pasó con Chromium en la URL HTTPS real, escritorio de 1280 px y móvil de 390 px: aislamiento anónimo, sesión con cookie segura, URL sin fragmento, gastos, pagos/resumen con suma de balances cero, importación, descarga/carga en memoria de plantilla, administración, CSP con nonce y logout de la sesión de verificación. No registró gastos, pagos ni borradores. No se guardaron trazas/capturas con datos privados.

Migraciones remotas generadas por Supabase y reproducidas en supabase/migrations:

- 20261105150002: esquema inicial.
- 20261105220620: importaciones, administración, mantenimiento y remediación de permisos; fechas autorizadas.
- 20261105220745: pg_cron, limpieza cada hora (minuto 17) y primera ejecución verificada.

Catálogo comprobado: RLS en todas las tablas privadas, sin SELECT directo del runtime, sin USAGE de anon en app_api. Advisors de seguridad sin WARN/ERROR; INFO de RLS sin políticas corresponde a denegación directa deliberada y funciones SQL autorizadas.

## Revisión y recuperación

Revisiones independientes de autorización/dinero, parser/archivos, UI, CSP y operaciones. Hallazgos corregidos antes de publicar: identidad de fila/origen, preservación de advertencias, precedencia JSON/alias SQL, permisos futuros y filtrado de políticas temporales del backup.

Respaldo real cifrado con age, descifrado/catálogo y SHA256 verificados, fuera de Git y descargable; identidad privada en archivo separado, con permisos 600. Cuenta de backup solo lectura, vencimiento de 30 minutos y 2 conexiones; cuenta y políticas retiradas y comprobadas. El filtro TOC elimina solo las políticas de esa cuenta al restaurar. La restauración completa se ensayó con datos sintéticos en la instancia CI existente; no se sobrescribió producción.

Rollback: volver a la versión previa de Vercel manteniendo las migraciones aditivas. El contrato previo de gastos/pagos sigue compatible. No usar DROP ni una restauración destructiva para revertir una publicación de interfaz. El workflow Database también compila el commit previo de producción 2c8caa7 y ejecuta su BFF contra el esquema migrado de la misma instancia efímera, sin crear otra base ni usar secretos reales. Ese ensayo cubre sesión, gasto idempotente, pago confirmado, saldo y revocación después de volver al código anterior.

## Gates

A/B/C/D/F superados con la evidencia anterior. Gate E deshabilitado conforme a su excepción. Gate G respaldado por configuración real verificada, migraciones aditivas, respaldo, restauración ensayada, smoke HTTPS/browser y accesos distribuidos por archivo privado del administrador. El simulador público no forma parte del libro financiero y no carga datos del grupo.

## Acceso por PIN — 10 de noviembre de 2026

El selector público incluye los siete participantes y el administrador, con PIN de tres dígitos y gestión exclusiva del administrador. La política sin límites de intentos ni bloqueo temporal es una decisión expresa del propietario, registrada en ADR026. Los enlaces privados siguen funcionando durante la transición.

- [Quality](https://github.com/andrescli11/gastos-compartidos/actions/runs/42729953732) aprobado: formato, lint, tipos, lógica, build y 116 pruebas de navegador móvil/escritorio. Incluye PIN con ceros iniciales, reintentos, sesión por rol, gestión y apertura de un enlace privado desde la pantalla de PIN.
- [Database](https://github.com/andrescli11/gastos-compartidos/actions/runs/42729953556) aprobado: permisos, revocación, carrera entre cambio de PIN e ingreso, idempotencia, respaldo/restauración, navegador→BFF→PostgreSQL y compatibilidad con la aplicación anterior. Revisiones independientes de backend, UI y corrección de hashchange sin bloqueos.
- Supabase CLI generó `20261110004008_basic_pin_access.sql` en CI. La migración aplicada por Supabase obtuvo la versión real `20261110004132`; el archivo versionado con ese nombre reproduce exactamente `db/pins.sql`.
- Se configuraron ocho verificadores, incluido uno administrativo, con ocho eventos de auditoría. Los códigos iniciales y `PIN_SECRET` permanecen fuera de Git. Catálogo verificado: sin SELECT directo de BFF/anon ni EXECUTE de anon sobre el verificador. No se escribieron gastos, repartos ni pagos para esta entrega.

La evidencia de integración y publicación está en [PR 13](https://github.com/andrescli11/gastos-compartidos/pull/13). La recuperación conserva el esquema aditivo y el secreto del servidor, según el runbook.
