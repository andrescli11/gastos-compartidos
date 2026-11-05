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
