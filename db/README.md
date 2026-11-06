# Persistencia de gastos

## Estado

Los esquemas y funciones se ejecutaron y verificaron en PostgreSQL17 de CI y se aplicaron al Supabase real autorizado. Las migraciones en supabase/migrations reproducen las versiones remotas. Incluyen gastos, acceso, pagos, importaciones y mantenimiento. Ver [evidencia de liberación](../docs/17-release-verification.md).

No volver a aplicar los archivos fuente completos a la base existente. Los cambios siguientes requieren migraciones compatibles/aditivas, revisión y CI. app_private y app_api permanecen fuera del acceso público; el runtime usa solamente funciones autorizadas.

## Contrato y límite de confianza

- `app_private`: viaje fijo, participantes, hashes de enlaces y sesiones, gastos, partes, revisiones, auditoría e idempotencia. RLS activo, sin grants públicos y sin acceso directo del BFF.
- `app_api`: funciones autorizadas con `search_path` vacío y EXECUTE solo para `cusco_bff`. La identidad se deriva del hash de sesión, nunca de un rol o participante enviado en el comando.
- `cusco_bff`: rol NOLOGIN y sin privilegios administrativos; el operador provisionará un login dedicado miembro de este rol mediante el canal seguro de credenciales. No otorgar acceso directo a tablas ni membresía de roles de administración. La cuenta que aplica el esquema es distinta de la cuenta runtime.
- Las funciones SECURITY DEFINER se mantienen en esquema no expuesto y son propiedad de la cuenta de migración. El bypass de RLS del propietario es deliberado y queda limitado por validación de sesión y pagador dentro de la función. No hay política `auth.uid()` porque no se usa Supabase Auth.
- `DATABASE_URL`: conexión PostgreSQL del login BFF (pooler en producción). `src/server/database.ts` limita el pool y exige TLS con validación de certificado fuera de tests locales. No usa claves service_role ni expone configuración al cliente. Cada consulta reserva una conexión, inicia transacción, asume `SET LOCAL ROLE cusco_bff` y confirma o revierte antes de liberarla. Una membresía incorrecta falla sin elevar permisos.
- `src/server/expense-repository.ts`: consultas parametrizadas, entrada y salida validadas e importes JSON como cadenas decimales de céntimos. Los errores no conservan mensaje, detail, consulta ni cause del driver.

El código HTTP y de pantalla ya llama a esta API mediante sesión, CSRF y cuotas. La integración PostgreSQL, el navegador y el despliegue se verificaron; ver el informe de liberación. No existe fallback de persistencia pública. Un diario cifrado en sessionStorage recupera confirmaciones inciertas dentro de la misma pestaña/sesión; no contiene una copia en claro del token o gasto.

## Comandos

`app_api.mutate_expense(session_hash, idempotency_key, command)` acepta:

- `create`: payerId, description, spentOn (YYYY-MM-DD), amountMinor (string), currency y splits.
- `update`: los mismos campos más id y expectedVersion (número entero).
- `void`: id y expectedVersion. Conserva gasto, partes y revisiones.

Cada parte tiene participantId y amountMinor como string. Las partes deben ser únicas, positivas y sumar exactamente el gasto. El pagador y los beneficiarios deben estar activos. Un participante no cambia el pagador ni modifica un gasto ajeno. El administrador sí puede reasignar.

La identidad de idempotencia es enlace + ámbito + UUID; payload diferente con la misma clave genera conflicto. Se conserva el JSON canónico revisado y el resultado en tablas privadas, sin huella de cálculo externa confiada al cliente. Un reintento revalida sesión antes de devolver el resultado anterior. Rotar el enlace crea una nueva identidad operativa y revoca las sesiones anteriores.

El bloqueo de la fila del único viaje serializa las mutaciones: decisión deliberada para un grupo pequeño. La versión optimista detecta ediciones obsoletas. Las restricciones diferidas vuelven a comprobar suma y existencia de partes al commit, incluidos cambios SQL administrativos.

Cada revisión guarda el estado financiero privado. La auditoría solo contiene IDs opacos, acción y versión. Historial, idempotencia, incremento de versión de libro y cambios de gasto se confirman o revierten juntos.

## Pruebas

Sin dependencias externas:

```bash
npm run test:persistence
```

Con PostgreSQL 17 y Node 24, usando exclusivamente una base efímera **vacía**, configurar la conexión mediante PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE en el entorno seguro y ejecutar:

```bash
CUSCO_DB_TEST_DISPOSABLE=yes npm run test:db
```

El script requiere confirmación técnica explícita de base desechable y falla si el esquema ya existe. No elimina bases ni esquemas. Nunca usar credenciales de producción. El workflow `database.yml` provisiona su propia instancia aislada y no necesita secretos de la organización.

`tests/persistence.sql` ejecuta fixtures sintéticos dentro de una transacción que termina en rollback: CRUD, acceso propio/ajeno, reasignación administrativa, permisos directos, sesión inválida/expirada/revocada, rotación, reintento, claves conflictivas, versiones, sumas, beneficiarios duplicados y escritura de historial.

`check-db-concurrency.mjs` crea fixtures sintéticos permanentes solo en esa base efímera; prueba dos reintentos simultáneos y dos ediciones competidoras. Se destruye la instancia de CI al terminar. No imprime SQL ni errores del driver.

Las suites PostgreSQL, advisors, canje, revocación y recorridos BFF/UI se ejecutaron. Pagos e importaciones determinísticas ya están integrados. Los originales de importación no se retienen en Storage, según ADR018.

## Despliegue y recuperación

Este archivo no se ejecuta en el arranque de la app ni automáticamente contra producción. Las versiones remotas aplicadas están reproducidas en supabase/migrations. Producción requiere los gates y revisión de configuración descritos en `docs/07-autonomous-development.md`.

El primer esquema es aditivo. Ante fallo durante su transacción, PostgreSQL revierte sus cambios. Tras datos reales, recuperar con una migración correctiva compatible o backup verificado; no usar DROP/rollback destructivo. Volver a la versión anterior de la app solo si su contrato sigue siendo compatible con el esquema desplegado.

## Acceso y cuotas

`access.sql` añade canje, contexto, logout, revocación y cuotas; `tests/access.sql` cubre sus contratos. Las cuotas se consumen en llamadas separadas que confirman antes del intento protegido, para que un fallo de autenticación no revierta el límite. Limpiar contadores expirados periódicamente en una tarea administrativa; no se otorgan permisos de purga al BFF. Documentación actualizada del conjunto en `docs/10-development-status.md`.
