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
