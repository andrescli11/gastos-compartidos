# Desarrollo autónomo

## 1. Objetivo operativo

Completar el MVP con mínima supervisión del propietario. Los modelos pueden decidir detalles reversibles dentro del alcance y los límites de seguridad documentados. No pueden ampliar el producto, gastar sin límites, debilitar controles ni realizar cambios destructivos de producción.

## 2. Roles de modelos

- **Orquestador:** mantiene contexto, asigna trabajo, resuelve dependencias y verifica gates.
- **Arquitectura y seguridad:** modelo de razonamiento máximo, preferentemente `gpt-6-astra`, para diseño, permisos, dinero, amenazas y revisiones de alto riesgo.
- **Implementación:** modelo Codex de máxima capacidad, preferentemente `gpt-6.1-terra`, para cortes verticales, migraciones e integraciones.
- **Calidad y tareas mecánicas:** `gpt-6.1-sol` para pruebas, documentación, fixtures y verificaciones repetitivas; los casos financieros o de seguridad vuelven a un modelo de razonamiento máximo.
- **Revisión cruzada:** ningún agente aprueba exclusivamente su propio trabajo en cambios financieros, de autorización o de despliegue.

Los nombres son preferencias de ejecución, no dependencias del producto. Si cambia la disponibilidad, el orquestador elige la capacidad equivalente más fuerte.

## 3. Política de autonomía

El equipo autónomo puede, sin preguntar:

- Elegir estructura interna, nombres y componentes coherentes con los documentos.
- Añadir pruebas, validaciones, telemetría redactada y documentación.
- Corregir errores detectados por CI o revisiones.
- Crear previews y migraciones no destructivas en entornos de prueba.
- Ajustar UX reversible respetando requisitos y accesibilidad.

Debe detenerse y solicitar una decisión agrupada solo cuando:

- Falte una credencial o autorización externa que no pueda configurarse de forma segura.
- Exista un coste nuevo, compra, dominio o cambio de plan.
- Sea necesaria una migración destructiva o pérdida de datos.
- Dos requisitos de producto sean incompatibles.
- Se pretenda cambiar alcance, privacidad, política monetaria o permisos.
- Un gate crítico no pueda superarse sin aceptar un riesgo residual nuevo.

## 4. Flujo por corte vertical

1. Seleccionar una historia y criterios de aceptación del backlog.
2. Identificar invariantes, amenazas y casos límite.
3. Implementar dominio, persistencia, API y UI mínimos.
4. Añadir pruebas unitarias, integración y E2E proporcionadas al riesgo.
5. Ejecutar revisión independiente de producto, seguridad y calidad.
6. Corregir hasta que todos los gates estén verdes.
7. Crear preview y realizar smoke test.
8. Integrar automáticamente si no existen bloqueos.
9. Actualizar documentación y registro de decisiones.

## 5. Estrategia Git y despliegue

- Una rama o worktree por corte.
- Pull request pequeño con contexto, riesgo, pruebas y evidencias.
- CI obligatorio; sin merge forzado ni tests omitidos.
- Revisión automática independiente para autorización, dinero y migraciones.
- Merge automático cuando controles y revisiones pasan.
- Vercel genera preview por PR.
- `main` despliega producción solo después del gate de liberación correspondiente.

Hasta que la infraestructura externa esté configurada, se validará localmente y no se fingirá que un despliegue o credencial funciona.

## 6. Gates por fase

### Gate A — Fundaciones

- Proyecto reproducible, CI, validación de entorno y documentación vigente.
- Migraciones ejecutables desde base vacía.
- Secretos fuera del repositorio.

### Gate B — Dominio financiero

- Repartos, balances, conversión y liquidación superan propiedades e invariantes.
- Casos conocidos donde un algoritmo voraz no es mínimo están cubiertos.

### Gate C — Acceso y CRUD

- Matriz completa de autorización probada, incluido acceso directo hostil.
- Revocación de enlaces y sesiones verificada.

### Gate D — Ingesta

- Parsers, estados, idempotencia y preview funcionan sin IA real.
- Se permiten candidatos privados recuperables; ninguno se convierte en gasto financiero antes de confirmar.

### Gate E — IA

- Integración real funciona con schema estricto.
- Dataset dorado y umbrales de `04-ai-imports.md` superados en un informe versionado.
- Costes, límites, privacidad y fallos controlados.
- El agente de QA produce el informe y un agente independiente de seguridad/calidad lo aprueba. Si falta corpus, presupuesto o condición contractual de privacidad, la IA queda deshabilitada en producción sin bloquear el resto del MVP.

### Gate F — Liquidación y pagos

- Bloqueo de modo/tasa, confirmación bilateral y recalculo auditado verificados.

### Gate G — Producción

- Red, secretos e identidades observados como listos.
- Migración, backup, smoke test y rollback ensayados.
- Datos de demostración ausentes de producción.
- Enlaces reales generados y distribuidos por canal del administrador.

## 7. Registro de decisiones y evidencia

Cada PR documenta: problema, solución, alternativas, riesgos, pruebas ejecutadas y cambios de datos. Las decisiones permanentes se agregan a `docs/decisions.md`. Las evidencias no incluyen PII ni archivos reales.

## 8. Gestión de fallos

Si una tarea falla, el orquestador clasifica el bloqueo, intenta alternativas seguras y conserva trabajo válido. No repite solicitudes destructivas, no desactiva TLS, no evade la red y no solicita secretos en el chat. Agrupa todas las acciones que requieran intervención en una sola petición concreta.
