# Registro de decisiones

## ADR-001 — Un único viaje fijo

**Decisión:** el MVP contiene un viaje preconfigurado y una lista fija de participantes.

**Motivo:** resolver el cuadre real sin construir administración comercial.

## ADR-002 — Acceso por enlaces privados

**Decisión:** tokens aleatorios canjeados por sesiones; sin cuentas ni Supabase Auth.

**Consecuencia:** quien obtiene un enlace hereda sus permisos. Deben existir revocación, rotación y recuperación operativa del administrador.

## ADR-003 — BFF como límite de confianza

**Decisión:** el navegador llama a Next.js; el BFF autoriza y accede a Supabase/OpenAI.

**Motivo:** centralizar permisos y evitar credenciales administrativas en el cliente.

## ADR-004 — Propiedad basada en pagador

**Decisión:** un participante gestiona únicamente gastos cuyo pagador almacenado es él. Solo el administrador cambia el pagador.

## ADR-005 — Dos libros monetarios

**Decisión:** PEN y USD permanecen separados por defecto. La consolidación a PEN usa una tasa fija acordada, visible y bloqueada tras el primer pago confirmado.

## ADR-006 — Dinero exacto

**Decisión:** importes como enteros en unidad menor y aritmética exacta; nunca flotantes.

## ADR-007 — IA asistida

**Decisión:** la IA genera candidatos estructurados. Validación determinística y confirmación humana preceden cualquier efecto financiero.

## ADR-008 — Optimización verificable

**Decisión:** usar algoritmo exacto dentro de un límite explícito de participantes con saldo. Fuera del límite, etiquetar el resultado como optimizado, no mínimo probado.

## ADR-009 — Monolito modular administrado

**Decisión:** Next.js, Supabase y Vercel; no microservicios ni cola externa inicialmente.

## ADR-010 — Automatización con gates

**Decisión:** agentes especializados implementan y revisan; CI, seguridad, evaluación de IA y smoke tests condicionan integración y despliegue.

## ADR-011 — Previews aisladas de producción

**Decisión:** previews usan una rama o proyecto Supabase dedicado, con secretos, Storage y datos independientes. Si no existe, no se conectan a datos reales.

**Motivo:** el código de un pull request no debe poder leer o modificar producción.

## Plantilla para nuevas decisiones

### ADR-XXX — Título

**Contexto:**

**Decisión:**

**Alternativas:**

**Consecuencias y riesgos:**

## ADR-012 — Liquidación exacta mediante programación dinámica

**Contexto:** se requiere mínimo probado hasta 18 saldos no nulos y resultado determinista.

**Decisión:** maximizar cortes de suma cero mediante DP de subconjuntos O(n·2^n), con reconstrucción de grupos. Dentro de cada grupo se cancelan deudas por ID estable. Por encima de 18 se aplica cancelación determinista sin afirmar mínimo probado. Dinero y sumas usan bigint; las máscaras y cantidades de grupos usan índices enteros.

**Alternativas:** búsqueda recursiva con poda; voraz global (no garantiza mínimo).

**Consecuencias:** consumo exponencial acotado explícitamente. El cálculo deberá ejecutarse en servidor para datos reales. Pruebas contrastan grupos pequeños contra un oráculo de búsqueda exhaustiva independiente.

## ADR-013 — API PostgreSQL privada para gastos

**Contexto:** el BFF debe autorizar dentro de la misma transacción que modifica dinero, reparto e historial.

**Decisión:** tablas en `app_private`, funciones específicas en `app_api` sin acceso desde Data API, y login runtime con rol `cusco_bff` limitado a EXECUTE. Sesiones opacas verificadas en base. Mutaciones serializadas por fila del único viaje, versión optimista e idempotencia atómica. El JSON monetario usa strings para no perder precisión. El BFF accede mediante PostgreSQL con TLS y pool limitado; no requiere service_role.

**Alternativas:** CRUD REST con credencial administrativa; descartado por ampliar los permisos runtime y separar validación y escritura.

**Consecuencias:** requiere credencial de conexión PostgreSQL de mínimo privilegio y acceso al pooler. Funciones SECURITY DEFINER requieren revisión, search_path fijo y grants explícitos. La serialización limita rendimiento deliberadamente para el grupo fijo. SQL fuente pendiente de generación de migración y ejecución contra PostgreSQL antes de liberar.

## ADR-014 — Sesión opaca, límites persistentes y recuperación de confirmaciones

**Decisión:** canje de token de fragmento por sesión aleatoria HttpOnly/Secure/SameSite, solo hashes en PostgreSQL y comprobación por operación. CSRF derivado de la sesión, validación de origen exacto y cuotas persistentes en transacciones independientes previas al intento protegido. El IP se toma solo del header de infraestructura Vercel; en otros hosts se comparte un bucket conservador sin confiar en headers del cliente.

**Recuperación:** antes de enviar una confirmación se guarda un diario privado cifrado AES-GCM en sessionStorage, con clave derivada del CSRF que no se persiste. Se recupera la misma clave de idempotencia tras recarga en esa pestaña/sesión y se exige reintento explícito. Una respuesta de cuota/CSRF después de resultado incierto no demuestra que el intento original fallara. Cerrar pestaña o expirar/cambiar sesión no está cubierto por este mecanismo; drafts privados de servidor corresponden a ingesta posterior.

**Consecuencias:** cookies y APIs privadas no usan caché compartida; no se registra contenido ni tokens. Los límites globales/IP se confirman aun cuando el canje falle. Contadores caducados requieren limpieza operativa; sesiones y enlaces exigen herramientas administrativas seguras antes de producción. CSV local es transcripción asistida a registro manual, no pipeline de importación con trazabilidad durable.

## ADR-015 — Pagos externos y revisión del saldo vigente

**Contexto:** el producto permite liquidación por gasto o neta y registrar transferencias realizadas fuera de la aplicación. No especifica un tope de pago igual al saldo neto.

**Decisión:** conservar transferencias reales confirmadas, con advertencias y revisión explícita de la versión del libro cuando difieran del neto. No imponer una prohibición nueva de sobrepago. Confirmados alteran saldo; pendientes y rechazados no. Anulación administrativa conserva historial y motivo privado.

**Consecuencias:** una transferencia real puede producir un saldo inverso explicable. La confirmación requiere la versión vigente y futura transacción SQL con lock del viaje; una función pura no demuestra aislamiento de base de datos. Configuración/tasa permanecen bloqueadas con pagos pendientes o confirmados; pendientes se resuelven por rechazo conforme a la máquina de estados existente.

## ADR-016 — Verificación remota y bootstrap temporal en rama

**Contexto:** el terminal no puede descargar dependencias, pero GitHub Actions sí puede ejecutar PostgreSQL y herramientas de Node.

**Decisión:** publicar avances como PR de borrador y ejecutar comprobaciones en runners aislados. El bootstrap limitado al repositorio/rama de desarrollo genera el lockfile, fija dependencias y normaliza formato de archivos tracked; su token de escritura solo existe en el paso REST de commit, con comprobación de HEAD y sin force. No recibe secretos de aplicación ni escribe en main. Los checks siguen siendo obligatorios.

**Consecuencias:** el commit creado por GITHUB_TOKEN no dispara por sí mismo otra ejecución; bootstrap valida su snapshot y debe comprobarse el estado del commit exacto antes de integrar. La configuración remota de Vercel/Supabase se inspecciona por sus herramientas y no se asume que el proyecto vacío sea un entorno de pruebas.

## ADR-017 — Conflicto de versión distinguible de idempotencia

**Decisión:** el BFF expone `STALE_VERSION` solo para mensajes SQL conocidos de versión monótona del libro/gasto/pago. Permite descartar un comando incierto que ya no puede aplicarse por versión y revisar sobre datos actuales. Un conflicto de idempotencia genérico no demuestra ausencia de escritura y mantiene la clave/diario.

**Actualización ADR-016:** el token de Actions recibió403 al escribir el resultado. El bootstrap pasa a permisos de lectura y entrega un artefacto de fuentes normalizadas/lockfile, con exclusión de secretos. La publicación se realiza mediante la conexión GitHub autorizada, conservando revisión y lease del HEAD. No se pide ampliar permisos del repositorio ni se ocultan checks fallidos.

## ADR018 — Importación determinística sin retener originales

CSV se procesa en el navegador; Excel .xlsx se parsea en memoria en el BFF y se descarta inmediatamente. No se carga ningún original a Storage. Los borradores privados conservan solo evidencia de celdas acotada durante siete días; confirmar/cancelar elimina la evidencia. Esto reduce exposición y evita credenciales de Storage amplias. CSV admite15MB y Excel4MB para respetar el techo de petición de Vercel; archivos activos/macros/protegidos se rechazan. El lector OOXML conservador preserva literales decimales y usa límites ZIP/XML, en lugar de transformar importes con coma flotante. IA deshabilitada según GateE.

## ADR019 — Confirmación de lotes y procedencia

Una importación tiene versión privada, filas seleccionadas/revisadas y resultados por fila. SQL confirma exactamente la revisión almacenada, revalida sesión/pagador/duplicados y usa identidad estable trabajo+fila. Éxitos no se repiten; fallos se corrigen y reintentan. La procedencia mínima sobrevive al borrado de la evidencia temporal. El servidor recalcula advertencias de fechas y duplicados; el usuario reconoce cada fila y mantiene ambos explícitamente si corresponde.

## ADR020 — Seguridad y recuperación operativa

CSP con nonce por petición y render dinámico, caché privada en recorridos autenticados. Administración de accesos permite renovar/revocar con confirmación; la autorrotación administrativa se reserva al procedimiento de recuperación para no invalidar su propia operación antes de entregar el enlace. El backup financiero cifrado excluye sesiones/cuotas/comandos y se bloquea mientras existan borradores con evidencia temporal; no borra trabajo para poder exportar. Se ensaya restauración solo en la instancia efímera de CI existente, nunca sobre Supabase real.

## ADR021 — Permisos futuros del rol de migración

PostgreSQL concede EXECUTE a PUBLIC por defecto de forma global; un REVOKE por esquema no puede restar ese permiso global. La remediación y restauración revocan el default global de EXECUTE del rol de migración y conceden funciones de app_api explícitamente a cusco_bff. No modifica funciones existentes fuera de la app; una RPC nueva de ese propietario requiere grants explícitos. La prueba de restauración crea una función temporal y verifica que no es pública.
