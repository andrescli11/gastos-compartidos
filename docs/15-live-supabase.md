# Conexión con Supabase real

El propietario autorizó usar el proyecto existente sin crear otra base (2026-11-05).

## Aplicado

- Proyecto `app-gastos-compartidos`, ref `hajvwunpgqkmosbsuinu`, región us-east-1, PostgreSQL17. No había tablas en public/app_private/app_api.
- Migración `cusco_initial_expenses_access_payments`, versión remota `20261105150002`, aplicada con el conector Supabase. El archivo en supabase/migrations reproduce el SQL aplicado, sin inventar versión ni incluir credenciales. No volver a ejecutar sobre esta base.
- Un viaje fijo; cero participantes y cero movimientos reales agregados. No se ejecutó ninguna suite de fixtures contra esta base.
- Las13 tablas privadas tienen RLS. Anon/authenticated no tienen acceso a los esquemas privados de la app.
- Login runtime exclusivo, sin privilegios administrativos ni herencia automática; miembro de cusco_bff. Sin SELECT directo a gastos. La app usa SET LOCAL ROLE por transacción. Contraseña generada aleatoriamente, no versionada.
- Vercel: APP_URL canónica y RATE_LIMIT_SECRET configurados solo en production del proyecto existente. Las previews no reciben credenciales de la base real. El nombre histórico del proyecto incluye preview, pero su entorno activo Vercel es production.

## Pendiente

Host exacto Transaction pooler desde Connect, configurar DATABASE_URL como secreto de production, redesplegar y verificar el acceso real por HTTPS. Faltan nombres del grupo y provisionamiento de enlaces privados. No declarar funcionalidad persistente desplegada hasta esas comprobaciones.

## Advisors

Los avisos INFO de RLS sin políticas son deliberados: denegación directa y acceso por funciones SQL autorizadas, según db/README.md. Persisten avisos previos de ejecución pública en la función ajena a la app public.rls_auto_enable(); no se cambiaron objetos preexistentes. Revisar [remediación del advisor](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

## Revisión independiente

Revisión cruzada del esquema, grants y adaptador: sin bloqueos de permisos identificados. Se confirmó el usuario del pooler con sufijo de project-ref, TLS verificado y la necesidad de probar canje y lectura autenticada tras redesplegar.

## Recuperación

No borrar esquemas ni datos. Ante un fallo de runtime, corregir configuración o desplegar versión compatible. Cambios SQL posteriores se hacen como migraciones aditivas. La credencial runtime puede rotarse con ALTER ROLE y actualización segura de Vercel; nunca colocarla en Git ni en el chat.
