# Operación y recuperación

## Entorno y límites

Un único Supabase real contiene el viaje. El proyecto Vercel con nombre histórico
`gastos-compartidos-preview` usa el target `production` para esa base. Los targets
`preview` y `development` no reciben su conexión ni sus secretos. No habilitar
despliegues automáticos de código no revisado con acceso a datos reales.

La IA permanece deshabilitada hasta cumplir evaluación, privacidad y presupuesto.
No habilitar planes, PITR, compras ni add-ons de pago como parte de mantenimiento
ordinario. La disponibilidad de backups administrados depende del plan Supabase:
comprobarlo en el dashboard, sin asumir que existe PITR por tener una base activa.

## Antes de una publicación

1. Identificar commit, proyecto, target y URL canónica exactos.
2. Exigir Quality, Database y revisión independiente aprobados para el código.
3. Si hay migración, revisar el esquema remoto y aplicar solamente cambios
   compatibles/aditivos. Nunca ejecutar `scripts/test-db.sh` contra Supabase real.
4. Comprobar existencia de `DATABASE_URL`, `DATABASE_CA_CERT`, `RATE_LIMIT_SECRET`
   y `APP_URL` sin revelar sus valores. Mantener TLS y validación del hostname.
5. Confirmar que el backup que se usará para recuperación es descargable y que su
   restauración fue ensayada. Un comando de backup preparado no demuestra esto.
6. Publicar el commit revisado. Comprobar acceso privado en navegador y APIs,
   conservación de saldos y ausencia de caché compartida.

## Backup privado cifrado

`scripts/backup-private.sh` exporta los esquemas privados y sus funciones, incluido
historial financiero, con `pg_dump` en formato custom y cifra el stream mediante
`age`. No genera una copia en claro. El destino debe estar fuera del repositorio,
no existir todavía y pertenecer a un directorio privado. Nunca subirlo a Actions,
GitHub, logs, almacenamiento público o un artefacto de pruebas.

La copia de producción excluye datos de sesiones, cuotas y comandos de
importación temporales. Conserva jobs y referencias de filas guardadas para
trazabilidad, pero rechaza exportar mientras haya previews con filas o evidencia
no vacía. El operador debe terminar o cancelar esos borradores explícitamente;
el script nunca los borra para completar un backup. Así el backup financiero no
extiende la retención de fuentes y no recupera trabajo temporal pendiente.
Después de restaurar, las personas deben volver a entrar con su enlace; no se
recuperan sesiones antiguas.

Requisitos del operador:

- Cliente PostgreSQL compatible con el servidor y `age` instalados.
- Variables `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` proporcionadas
  por su gestor de secretos, nunca como argumentos ni en el chat.
- `PGSSLMODE=verify-full` y `PGSSLROOTCERT` con CA del proveedor.
- Una identidad de backup separada del runtime con permisos de lectura necesarios.
  El login runtime de la app no puede leer tablas directamente y no sirve para
  hacer un backup. No ampliar sus permisos para resolverlo.
- `CUSCO_BACKUP_RECIPIENT` con la clave **pública** de un destinatario age. Guardar
  la identidad privada correspondiente en el gestor de secretos del propietario,
  separada del backup. Perderla impide recuperar los datos.

Con ese entorno configurado de forma segura:

```bash
bash scripts/backup-private.sh /ruta/privada/fuera-del-repo/cusco.dump.age
```

Guardar fecha UTC, commit del código, versión de migración, hash SHA-256 del
archivo cifrado y resultado de la restauración. Esos metadatos no contienen datos
del viaje. Rotar/eliminar exportaciones según la política del propietario; no
conservar copias olvidadas de nombres, sesiones o fuentes temporales.

## Ensayo de restauración

`scripts/check-backup-restore.sh` está restringido a la instancia **ya existente**
de PostgreSQL temporal del workflow Database. Rechaza hosts remotos, otro nombre
de base y ausencia de los flags explícitos de CI. Hace dump, reemplaza los dos
esquemas dentro de esa misma instancia, restaura y compara el contenido financiero.
Nunca debe recibir secretos de producción ni ejecutarse contra Supabase real.

La exportación excluye ACL y propietarios. Después de restaurar, reinstalar solo
los grants revisados de cada API SQL; las tablas privadas conservan RLS y no se
otorga acceso de lectura al BFF. Repetir los contratos HTTP/autorización después
del ensayo para verificar que recuperar datos no abre accesos.

Para una recuperación real, detener escrituras y usar la cuenta administrativa
del operador. Desencriptar únicamente en almacenamiento temporal privado de la
máquina de recuperación; ejecutar `pg_restore --list` para validar el formato.
Restaurar primero en el entorno de recuperación autorizado, verificar integridad
y grants, y solo entonces decidir la recuperación de producción. No automatizar
`DROP` o reemplazos de datos reales. Si se necesita una restauración destructiva,
la autorización del propietario debe nombrar ese reemplazo y el punto temporal.

## Rollback de aplicación

1. Identificar la última publicación compatible y verificada en Vercel.
2. Inspeccionar sus metadatos y variables, sin promover previews con secretos
   diferentes ni asumir que una página inicial que responde prueba el backend.
3. Reasignar la publicación compatible en Vercel. Mantener el esquema aditivo;
   no ejecutar una migración inversa que borre gastos o historial.
4. Verificar canje de enlace, cookie segura, consulta autenticada y rechazo
   anónimo/revocado por HTTPS. Los saldos deben coincidir con el estado previo.
5. Corregir hacia adelante. Si el contrato de la versión anterior no acepta el
   nuevo esquema, no hacer ese rollback: contener la operación y publicar la
   corrección compatible.

El ensayo de CI valida restauración financiera; no demuestra que se haya hecho
rollback de la publicación real. Registrar la evidencia concreta por despliegue,
sin introducir un rollback innecesario cuando personas estén usando la app.

## Limpieza de temporales

`db/maintenance.sql` añade `app_private.run_maintenance()`, ejecutable solamente
por la cuenta administrativa/scheduler. Borra cuotas caducadas y sesiones con
expiración o revocación de hace más de un día; registra únicamente cantidades y
timestamp. No borra enlaces, gastos, pagos, revisiones, auditoría ni idempotencia
financiera. Cuando existe `app_private.expire_imports()`, la llama para eliminar
evidencia y resultados temporales caducados según el contrato de importación.

Después de aplicar y revisar esa migración, programar una ejecución diaria con
el scheduler administrativo disponible. Si se usa `pg_cron`, verificar primero la
extensión y permisos del proyecto; el comando programado es:

```sql
select app_private.run_maintenance();
```

No otorgar ese EXECUTE a `cusco_bff`, `anon` ni `authenticated`. Revisar el último
`completed_at` de `maintenance_runs`: si supera 48 horas, corregir el scheduler.
Comprobar que no hay jobs con evidencia que exceda su TTL; los contadores son
evidencia de ejecución, no prueba suficiente de borrado de un bucket externo.

## Enlace perdido o filtrado

El administrador revoca el enlace afectado y genera uno nuevo por el canal
administrativo. Las sesiones anteriores se invalidan por la comprobación del
enlace/versión en cada operación. Nunca enviar enlaces privados en un PR o log.

Si se pierde el enlace administrativo, el operador con acceso al dashboard
Supabase crea un nuevo token criptográfico por el procedimiento seguro de
provisionamiento y persiste solamente SHA-256. Revoca el enlace anterior y entrega
el nuevo por el canal privado del propietario. No existe recuperación pública,
registro de cuentas ni un bypass con un parámetro de URL.

## Cabeceras y comprobaciones

La política CSP usa un nonce criptográfico nuevo por solicitud, propagado a los
scripts de Next. No permite scripts inline genéricos ni `unsafe-eval` en
producción. Los estilos inline permanecen permitidos para compatibilidad visual;
eso no concede ejecución de JavaScript. Se bloquean frames, objetos, handlers
inline y cambios de base URI. HSTS protege HTTPS; las respuestas privadas añaden
`private, no-store` también para cachés CDN.

La suite de navegador comprueba hidratación con nonce, nonce distinto entre
documentos, rechazo de un handler inline y caché privada de pantallas/API.
Las revisiones de incidentes conservan IDs opacos y códigos de error; nunca
cuerpos HTTP, cookies, tokens, nombres ni importes del viaje.

## Respaldo realizado antes de la ampliación de importaciones

Se generó una copia cifrada real con age, mediante cuenta de solo lectura con vencimiento de 30 minutos y límite de 2 conexiones, TLS verify-full y políticas SELECT exclusivamente para esa cuenta. Al terminar se eliminaron cuenta y políticas (verificado por catálogo). El respaldo se descifró a stream para validar el catálogo y se transfirió a una ubicación privada fuera de Git, con SHA-256 verificado: 2cbd278c51ddc74fa4ca22caadd383e0b44c30162fe6726e6c6b211f16ccdfcf. La identidad age se conserva en archivo separado, con permisos 600. No contiene originales de importación ni contraseñas de servidor.

Los dumps creados durante un acceso de backup efímero incluyen sus políticas RLS aunque se use --no-acl. Antes de restaurar, generar el TOC con pg_restore --list y pasarlo por scripts/filter-backup-toc.py, luego usar --use-list con ese resultado. El filtro elimina exclusivamente POLICY app_private.* cusco_backup_snapshot_read y conserva todas las otras entradas. La suite de restauración crea esas políticas, exporta, elimina su rol y restaura con el TOC filtrado. No recrear permisos amplios ni desactivar RLS para resolver una restauración fallida.

## Acceso por PIN

`PIN_SECRET` es una variable sensible exclusiva de production en Vercel. Debe conservarse con la recuperación de la configuración del servidor; nunca se incluye en Git, logs ni el archivo de PIN iniciales. Restaurar verificadores sin su secreto correspondiente requiere restablecer los PIN desde un enlace administrativo vigente. La exportación financiera cifrada puede conservar los verificadores, no PIN legibles.

Los accesos PIN usan tres dígitos sin límites de intentos ni bloqueo temporal, por decisión expresa del propietario (ADR026). Los ocho códigos iniciales se entregan fuera del repositorio; tras un cambio administrativo, ese archivo no refleja el PIN nuevo. Cambiar o desactivar el PIN propio cierra la sesión y exige volver a entrar. No renovar ni revocar el enlace administrativo de recuperación mientras se verifica el acceso inicial. Renovar enlaces privados requiere configurar el PIN del nuevo ID.
