# Pagos y cierre: dominio validado localmente

> Registro de fases anteriores. Estado vigente y evidencia de liberación: [verificación actual](17-release-verification.md).

## Alcance implementado

`src/domain/payments.ts` implementa funciones puras sin dependencias externas ni escritura financiera. Reciben el libro vigente y una identidad que el futuro BFF debe resolver desde la sesión, nunca desde el payload del navegador.

- El emisor o administrador registra un pago pendiente; pagador financiero y actor quedan separados.
- Solo receptor o administrador confirma/rechaza. Confirmados se anulan únicamente por administrador con motivo privado obligatorio.
- Repetir una transición ya completada no duplica efecto ni auditoría. Un intento de cambiar importe/destinatario reutilizando el mismo ID produce conflicto.
- Solo confirmados afectan balances. Parciales permitidos. Al anular se restaura su efecto sobre saldos sin borrar el pago ni su confirmador original.
- PEN/USD separados o consolidación exacta a PEN con la tasa vigente. Historial de pagos USD anulados/rechazados se conserva al consolidar; nunca se reconvierte un pago histórico.
- La confirmación exige una elección administrativa explícita del modo, también si es separado. Se conserva el actor que eligió. Configuración bloqueada mientras exista un pendiente o confirmado. Pendientes se rechazan mediante receptor/admin; no se añadió una transición pendiente→anulado fuera de la máquina documentada.
- Tasas matemáticamente equivalentes no producen una modificación financiera, aunque se expresen con fracciones distintas.
- Versiones de libro y pago evitan aplicar decisiones preparadas sobre un estado obsoleto. La auditoría contiene IDs opacos, acción y versión, sin importes, nombres o motivos.

`payment-summary.ts` genera un contrato JSON sin bigint: totales originales por moneda, totales del libro de liquidación, saldos después de pagos, propuestas de transferencia, configuración bloqueada y estado de cuadre. El estado derivado de saldo cero no sustituye un cierre administrativo del viaje.

## Pagos que difieren del neto

Los requisitos permiten pagar por gasto o neto y no prohíben registrar transferencias reales que excedan el saldo neto. No se inventó una prohibición de sobrepago.

Antes de confirmar se recalculan saldos y se emiten advertencias si emisor/receptor ya no tienen deuda/crédito o si el importe los supera. Confirmar esos casos requiere reconocer la versión vigente revisada. La transferencia confirmada puede crear un saldo inverso, que permanece explicable. La UI y persistencia futuras deben mostrar esas advertencias y registrar la revisión dentro del comando autorizado.

## Evidencia

```bash
npm run test:payments
```

Ejecutado con Node 24 sin instalar paquetes. Cubre permisos negativos, parciales, duplicados/reintentos, anulación con motivo, conservación de dinero, cambios de gasto posteriores, tasas equivalentes, históricos de USD, conflictos de versión y 120 cierres completos generados separados/consolidados. Revisión independiente del dominio favorable.

La prueba de versión simula comandos concurrentes sobre un snapshot; NO demuestra aislamiento en PostgreSQL.

## Pendiente antes de habilitar

- Tabla/funciones SQL de pagos, estados/restricciones y auditoría con timestamps.
- Validar configuración, confirmación y bloqueo dentro de una sola transacción y con el mismo lock de viaje que mutaciones de gasto.
- Idempotencia durable por actor/clave/payload, no solo semántica de estados en memoria.
- BFF y UI con roles, revisión de advertencias, CSRF y cuotas; sustituir el resumen solo-de-gastos por el de pagos cuando existan pagos persistidos.
- Pruebas PostgreSQL de carrera de configuración/primera confirmación, doble confirmación y anulación; navegador y accesibilidad.

No se declara Gate F superado. No se añadió un endpoint capaz de registrar pagos antes de disponer de estos controles.

## Integración añadida después de publicar el primer snapshot

La persistencia, el repositorio, las rutas y `/pagos` ya tienen implementación fuente. El runner de PostgreSQL incluye `payments.sql`, sus fixtures y carreras de registro/confirmación/configuración/anulación. `test:api` incluye el adaptador de pagos, sus contratos y privacidad de motivos. Estas adiciones deben pasar CI real antes de considerar Gate F.

La confirmación SQL exige siempre la versión revisada del libro bloqueado. El BFF vuelve a leer/derivar el snapshot; las advertencias se muestran al receptor antes de confirmar. Reintentar una clave completada devuelve su resultado original, y la UI recarga el contexto actual tras éxito.
