# Backlog de implementación

El orden minimiza retrabajo y permite validar el riesgo financiero y de autorización antes de integrar IA.

## Fase 0 — Fundaciones

### F0.1 Proyecto y calidad

- Inicializar Next.js/TypeScript y estilos.
- Configurar lint, formato, tipos, Vitest, Playwright y CI.
- Añadir validación de variables de entorno sin imprimir valores.

**Terminado cuando:** instalación y build son reproducibles; CI ejecuta checks básicos desde un clon limpio.

### F0.2 Supabase local y migraciones

- Configurar Supabase local.
- Crear esquema privado, restricciones, permisos y seeds sintéticos.
- Generar tipos.

**Terminado cuando:** una base vacía migra y se valida automáticamente; no hay acceso `anon` a tablas sensibles.

## Fase 1 — Dominio financiero

### F1.1 Dinero y reparto

- Tipos monetarios exactos.
- Reparto igual y personalizado.
- Propiedades de conservación.

### F1.2 Balances y liquidación

- Libros separados PEN/USD.
- Conversión fija opcional a PEN.
- Algoritmo exacto dentro del límite y fallback explícito.

**Terminado cuando:** invariantes y fixtures complejos pasan; aplicar la propuesta deja saldos cero.

## Fase 2 — Acceso y gastos manuales

### F2.1 Enlaces y sesiones

- Canje seguro, URL limpia, cookies, revocación y recuperación operativa del admin.

### F2.2 Lectura y CRUD autorizado

- Lista, filtros, detalle y resumen.
- Crear/editar/anular gasto propio.
- Gestión total para admin.
- Matriz de pruebas negativas.

### F2.3 Entrada masiva manual

- Tabla editable, pegado, validación por fila y confirmación idempotente.

**Terminado cuando:** un participante no puede modificar gastos ajenos aunque manipule solicitudes.

## Fase 3 — Pipeline de importación sin IA

### F3.1 Archivos y estados

- Storage privado, límites, TTL y máquina de estados.
- Carga segura y recuperación.

### F3.2 Excel/CSV

- Parser determinístico, selección de hoja/formato, mapeo y coordenadas.

### F3.3 Preview y duplicados

- Tabla editable, evidencia, errores, subtotales por moneda y confirmación transaccional.
- Huellas exactas y sugerencias aproximadas.

**Terminado cuando:** reintentos y doble clic no duplican; los borradores privados son recuperables y ningún candidato se convierte en gasto financiero antes de confirmar.

## Fase 4 — Extracción con IA

### F4.1 Contrato multimodal

- JSON Schema, prompts versionados, validación y mocks.
- Capturas con varias transacciones y fotos de boletas.

### F4.2 Privacidad, límites y telemetría

- Minimización/redacción, presupuesto, rate limits y logs seguros.

### F4.3 Evaluación

- Corpus dorado, runner reproducible y umbrales por fuente.

**Terminado cuando:** el conjunto crítico supera umbrales acordados y todos los candidatos siguen requiriendo confirmación.

## Fase 5 — Pagos y cierre

### F5.1 Configuración de liquidación

- Elegir modo y tasa; bloquear tras primer pago confirmado.

### F5.2 Pagos

- Registrar, confirmar, rechazar y anular.
- Pagos parciales e historial.

### F5.3 Vista final

- Explicación por gasto, balances, transferencias y estado de cierre.

**Terminado cuando:** el viaje puede alcanzar saldos cero y cada importe es trazable.

## Fase 6 — Hardening y producción

- Accesibilidad y responsive.
- Seguridad ofensiva y archivos hostiles.
- Rendimiento, costes y observabilidad.
- Migración, backup, rollback y smoke tests reales.
- Seed definitivo de participantes y generación de enlaces.

**Terminado cuando:** se supera Gate G de desarrollo autónomo.

## Dependencias del propietario

Se agruparán en un único checkpoint antes de producción:

- Lista y orden de participantes.
- Fechas del viaje.
- Muestras autorizadas o sintéticas para evaluación.
- Configuración de secretos, red e identidades descrita en `09-bootstrap-checklist.md`.
- Aceptación de costes y políticas aplicables de OpenAI, Supabase y Vercel.

El desarrollo local hasta la integración real puede avanzar sin esos datos usando fixtures sintéticos.
