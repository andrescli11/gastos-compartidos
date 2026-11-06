# Conexión con Supabase real

> Registro de fases anteriores. Estado vigente y evidencia de liberación: [verificación actual](17-release-verification.md).

El propietario autorizó usar el proyecto existente sin crear otra base (2026-11-05).

## Aplicado

- Proyecto `app-gastos-compartidos`, ref `hajvwunpgqkmosbsuinu`, región us-east-1, PostgreSQL17. No había tablas en public/app_private/app_api.
- Migración `cusco_initial_expenses_access_payments`, versión remota `20261105150002`, aplicada con el conector Supabase. El archivo en supabase/migrations reproduce el SQL aplicado, sin inventar versión ni incluir credenciales. No volver a ejecutar sobre esta base.
- Un viaje fijo; siete participantes reales facilitados por el propietario, siete enlaces personales y uno administrativo. Cero gastos y pagos agregados. No se ejecutó ninguna suite de fixtures contra esta base.
- Las13 tablas privadas tienen RLS. Anon/authenticated no tienen acceso a los esquemas privados de la app.
- Login runtime exclusivo, sin privilegios administrativos ni herencia automática; miembro de cusco_bff. Sin SELECT directo a gastos. La app usa SET LOCAL ROLE por transacción. Contraseña generada aleatoriamente, no versionada.
- Vercel: APP_URL canónica y RATE_LIMIT_SECRET configurados solo en production del proyecto existente. Las previews no reciben credenciales de la base real. El nombre histórico del proyecto incluye preview, pero su entorno activo Vercel es production.

## Conexión configurada

Host Transaction pooler confirmado por el propietario: aws-0-us-east-1.pooler.supabase.com:6543, base postgres. DATABASE_URL configurada como secreto solo de production con login de mínimo privilegio. Despliegue dpl_3P1cxi6trZ4sWuSJLcsYxpesgfFW READY en https://gastos-compartidos-preview.vercel.app, commit 2c8caa7c8edb128e50e81275ae722cabff0c8e7d. Verificado por HTTPS: rechazo anónimo401, canje200 con cookie Secure/HttpOnly, contexto administrativo con siete participantes y lecturas200 de gastos, pagos y resumen. Cliente Node reenvía cookie manualmente; no equivale a verificación de navegador real. No se crearon movimientos financieros para este smoke.

## Advisors

Los avisos INFO de RLS sin políticas son deliberados: denegación directa y acceso por funciones SQL autorizadas, según db/README.md. Persisten avisos previos de ejecución pública en la función ajena a la app public.rls_auto_enable(); no se cambiaron objetos preexistentes. Revisar [remediación del advisor](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

## Revisión independiente

Revisión cruzada del esquema, grants y adaptador: sin bloqueos de permisos identificados. Se confirmó el usuario del pooler con sufijo de project-ref, TLS verificado y la necesidad de probar canje y lectura autenticada tras redesplegar.

## Recuperación

No borrar esquemas ni datos. Ante un fallo de runtime, corregir configuración o desplegar versión compatible. Cambios SQL posteriores se hacen como migraciones aditivas. La credencial runtime puede rotarse con ALTER ROLE y actualización segura de Vercel; nunca colocarla en Git ni en el chat.

## Certificado del pooler

Node rechazó inicialmente la cadena con SELF_SIGNED_CERT_IN_CHAIN. Se añadió DATABASE_CA_CERT opcional en el adaptador, manteniendo rejectUnauthorized=true y validación de hostname. CA pública Supabase Root2021 descargada por HTTPS desde https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt . Huella SHA256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA. Con esa CA se verificó conexión pg, SET LOCAL ROLE y función autorizada dentro de una transacción revertida. Revisión independiente aprobó el cambio.

Quality y Database aprobados para 2c8caa7c8edb128e50e81275ae722cabff0c8e7d (runs42052169456 y42052169433). Los enlaces privados se entregan fuera del repositorio y no se publican en GitHub.

También se canjearon los siete enlaces personales por HTTPS y se verificó que cada sesión identifica al participante correcto y puede leer gastos. No se registraron datos financieros. Las sesiones de verificación se crearon de forma normal; las VM temporales de comprobación quedaron detenidas.
