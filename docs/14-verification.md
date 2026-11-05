# Verificación del recorrido de gastos y pagos

## Historia

Participante abre enlace privado → servidor canjea por cookie → consulta contexto → revisa y confirma un gasto → se registra pago externo → receptor confirma → el saldo se recalcula desde PostgreSQL.

## Evidencia disponible

- PostgreSQL17: migraciones fuente, constraints, permisos, sesiones/revocación y concurrencia de gastos/pagos aprobados en GitHub Actions.
- Snapshot `f7cd99aa59647e5ccc609675f5338228216aa4f9`: formato, lint, TypeScript, pruebas unitarias/locales y build aprobados. Run https://github.com/andrescli11/gastos-compartidos/actions/runs/42036885474 .
- Navegador en ese snapshot:20/22 escenarios aprobados. Los2 fallos son la misma aserción en escritorio/móvil que encontraba el alert del framework además del error de la app; selector afinado sin eliminar la comprobación del error.
- Se corrigieron patrones de carga React y etiquetas explícitas de selectores de pago, a partir de errores reales de lint/navegador.
- Dependencias fijadas y lockfile incorporado. Audit sin críticos/altos; quedan8 avisos moderados transitivos del tooling TypeScript/ESLint relacionados con minimatch. No se ejecutó `audit fix --force`, que proponía un downgrade incompatible del framework de lint.

## Verificación HTTP real aprobada

El workflow Database compila e inicia Next en la misma VM que la base efímera. `scripts/check-http-flow.mjs` crea exclusivamente fixtures parametrizados en `cusco_test`, con tokens aleatorios que permanecen en memoria, y comprueba:

- Rechazo anónimo, canje y atributos de cookie, contexto/CSRF.
- Origen incorrecto, CSRF ausente y pagador ajeno rechazados.
- Elección administrativa, gasto y reintento sin duplicar.
- Pago pendiente, confirmación del receptor y saldo actualizado a cero.
- Revocación e imposibilidad de volver a leer contenido privado.

Errores solo indican fase y código HTTP, sin cuerpos, cookies, tokens ni detalles de conexión. Guards exigen CI, base desechable, host loopback y nombre/origen exactos de prueba. SSL solo se omite en loopback con flags explícitos de test/GitHubActions; en destinos remotos se mantiene validación del certificado.

Snapshot `2bf8e91d33b3342aa5c7b80f21066067808c7b6a`: workflow [Database aprobado](https://github.com/andrescli11/gastos-compartidos/actions/runs/42039447134), incluida la prueba HTTP real. Workflow [Quality aprobado](https://github.com/andrescli11/gastos-compartidos/actions/runs/42039447216): formato, lint, TypeScript, pruebas, build, navegador y audit. Los dos fallos anteriores de selector quedan resueltos. El cliente Node reenvía cookies manualmente: comprueba atributos y validación BFF, pero no demuestra comportamiento de cookies en un navegador HTTPS real. Las pruebas Playwright actuales interceptan respuestas privadas; la prueba HTTPS contra infraestructura desplegada sigue siendo necesaria antes de producción.

## Separación de entornos

No se ejecutaron migraciones ni fixtures en el proyecto Supabase existente. La inspección disponible no establece que sea desarrollo. No se creó ni promovió un despliegue Vercel. Main permanece sin cambios y el trabajo está en PR de borrador.
