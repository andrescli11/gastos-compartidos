# Importaciones con IA

## 1. Objetivo y principio de control

Reducir el trabajo de transcribir gastos sin permitir que un modelo decida qué se guarda. Toda importación termina en una previsualización editable y requiere confirmación humana de la persona que aporta los datos.

## 2. Fuentes admitidas

- CSV.
- Excel sin ejecutar macros ni fórmulas.
- Capturas bancarias con cero, uno o varios movimientos.
- Fotografías de boletas o comprobantes.

No se admiten inicialmente PDF, archivos protegidos, contenido activo ni integraciones directas con bancos.

## 3. Máquina de estados

`uploaded → parsed → extracted → validated → preview → confirmed → persisted`

`failed`, `cancelled` y `expired` son estados explícitos. El estado se conserva también por página o fila para identificar éxitos parciales. Cada transición es idempotente, auditable y recuperable cuando corresponde.

## 4. Ingesta segura

1. Comprobar firma real, tipo, tamaño, páginas, filas y resolución.
2. Calcular huella del contenido y opciones normalizadas.
3. Guardar temporalmente en Storage privado. Una carga sin terminar expira a los 7 días; al confirmar o cancelar, el original temporal se elimina en un máximo de 24 horas.
4. Procesar en aislamiento y sin ejecutar macros, fórmulas, enlaces ni contenido activo.
5. Borrar el original al finalizar su periodo de retención y registrar el resultado del borrado.

En archivos tabulares se conservan coordenadas de hoja, fila y columna y el texto literal. Se permite elegir hoja, encabezado, separador, codificación y formatos cuando sean ambiguos. La previsualización informa hojas, filas, columnas o celdas omitidas y marca fórmulas que no tengan un valor almacenado. Si en el futuro se exporta CSV, se neutraliza la inyección de fórmulas.

Límites iniciales: 10 archivos por importación, 15 MB por archivo, 25 megapíxeles por imagen, 2.000 filas por libro, 200 candidatos por importación, 20 importaciones por participante al día y 2 trabajos de IA concurrentes por participante. Son configurables, pero un cambio exige pruebas de carga y coste.

## 5. Extracción

### Excel y CSV

El parser produce primero una tabla neutral determinística. La IA solo interpreta encabezados, formatos o fragmentos ambiguos necesarios; no recibe el archivo completo si no hace falta.

### Imágenes

Se usa OpenAI Responses API con capacidad visual y Structured Outputs mediante JSON Schema estricto. El modelo runtime es configurable por entorno y debe verificarse al desplegar; no se fija un nombre de modelo sin comprobar disponibilidad y capacidades.

Cada candidato incluye:

- Referencia localizable a la fuente.
- Fecha literal y fecha normalizada o `null`.
- Comercio y descripción.
- Importe literal y decimal normalizado o `null`.
- Moneda literal y `PEN`, `USD` o `null`.
- Tipo: gasto, devolución, transferencia o desconocido.
- Señales de confianza por campo y advertencias.
- Versión de prompt y esquema.

El esquema usa campos obligatorios, `null` para desconocidos y `additionalProperties: false`. El contenido del documento se trata siempre como datos, nunca como instrucciones.

## 6. Reglas específicas

- Un saldo, límite de crédito, subtotal o impuesto no es automáticamente un gasto.
- En una boleta, el candidato principal es el total pagado; totales incompatibles se bloquean para revisión.
- Abonos, devoluciones, transferencias y cargos pendientes se marcan, no se importan silenciosamente como gastos.
- No se adivina moneda, fecha, signo ni importe.
- No se convierte PEN a USD o viceversa durante la ingesta.
- Las capturas pueden producir varios candidatos y también cero candidatos.

## 7. Validación determinística

Independiente del modelo:

- JSON y esquema exactos.
- Límites de longitud y cantidad.
- Decimal válido, positivo y dentro de límites configurados.
- Moneda admitida.
- Fecha real; fuera del rango del viaje genera advertencia bloqueante hasta decisión explícita.
- Coherencia de signo, tipo de movimiento y totales.
- Campos obligatorios presentes antes de persistir.

La confianza declarada por el modelo no se considera probabilidad calibrada. Inicialmente todos los candidatos requieren revisión.

## 8. Previsualización

Mostrar evidencia, candidatos, exclusiones, campos editables, advertencias y posibles duplicados. Permitir seleccionar o descartar por fila y asignar beneficiarios. Antes de confirmar se muestran cantidad y subtotales separados de PEN y USD.

La confirmación persiste exactamente la versión revisada y enlaza cada gasto con la versión de preview confirmada. Un hash o versión optimista evita confirmar un preview modificado en paralelo. Los resultados se devuelven por fila; un éxito parcial conserva qué filas se guardaron y cuáles fallaron sin volver a importar las primeras.

## 9. Idempotencia y duplicados

- Clave de idempotencia única por participante, viaje y tipo de comando, respaldada por una restricción única en base de datos.
- Misma clave y mismo hash de payload devuelve el mismo resultado; la misma clave con un payload distinto devuelve conflicto.
- La persistencia de la clave, el resultado global y la identidad de cada fila ocurre atómicamente con los gastos confirmados.
- Una fila es única dentro de la identidad del trabajo de importación y su referencia de origen. Una carga deliberadamente nueva obtiene otra identidad y no se bloquea solo por tener el mismo archivo.
- Comparación aproximada por fecha, importe, moneda y comercio normalizado para sugerir duplicados.
- Nunca eliminar, fusionar o rechazar automáticamente una coincidencia aproximada.
- Explicar por qué dos registros parecen duplicados y permitir “mantener ambos”.
- No comparar PEN y USD como si fueran equivalentes.

## 10. Privacidad

- Enviar al proveedor solo páginas, regiones o celdas necesarias.
- Enmascarar números de cuenta, tarjeta, DNI, correo y saldos cuando sea posible sin perder el gasto.
- Configurar controles del proveedor como `store: false` cuando estén disponibles, verificando por separado las políticas reales de retención.
- Nunca registrar imágenes, OCR completo ni datos bancarios en logs, trazas, métricas o respuestas de error.
- Mostrar aviso de procesamiento por tercero antes de la primera carga.

Los candidatos, OCR y previews temporales expiran junto con una importación sin terminar a los 7 días. Después de confirmar se conservan solo los datos normalizados revisados y referencias mínimas de auditoría. Las capturas bancarias no se retienen como adjuntos por defecto. Una boleta que el usuario decida adjuntar puede mantenerse hasta 30 días después del cierre administrativo del viaje. Borrado, cancelación y errores deben registrar un resultado verificable sin incluir contenido sensible.

Ante timeout, 429 o 5xx, reintentar solo fallos transitorios con backoff y un máximo de dos reintentos. Una salida inválida puede reintentarse una vez con el mismo contrato. Después, conservar el borrador, identificar páginas o filas afectadas y ofrecer reintento o entrada manual; nunca presentar un trabajo parcial como éxito completo.

## 11. Evaluación

Crear un corpus dorado autorizado o sintético con formatos reales, PEN/USD, fechas ambiguas, múltiples cargos, devoluciones, totales inconsistentes, imágenes difíciles, duplicados legítimos y contenido malicioso. Debe contener al menos 60 fuentes, con un mínimo de 15 capturas bancarias, 15 boletas, 15 hojas Excel/CSV y 15 casos adversariales o límite. Todo ejemplo real autorizado que entregue el grupo se incorpora. Desarrollo, validación y test se separan por documento, comercio y plantilla; el conjunto de test contiene al menos 20 fuentes nunca usadas para ajustar prompts.

Al menos 20 casos críticos se anotan por dos revisores independientes y se resuelven los desacuerdos. El informe versiona corpus, anotaciones, prompt, esquema, parser y modelo runtime.

Medir por tipo de fuente:

- Precisión y recall de transacciones detectadas.
- Exactitud de importe, moneda y fecha.
- Correspondencia candidato–origen.
- Falsos gastos y saldos importados.
- Correcciones y rechazos humanos.
- Calidad de detección de duplicados.
- Latencia y coste.

Umbrales de liberación por cada tipo de fuente habilitado:

- JSON válido conforme al esquema en al menos 99% de ejecuciones antes de reintento.
- Precisión de detección de transacciones ≥ 98% y recall ≥ 95%.
- Exactitud de importe y moneda ≥ 99%; exactitud de fecha ≥ 95% cuando la fuente la contiene.
- Cero saldos, límites, subtotales o texto malicioso aceptados como gasto sin advertencia bloqueante en el conjunto crítico.
- 100% de confirmaciones idempotentes y cero gastos persistidos sin confirmación.
- Ninguna regresión mayor a 1 punto porcentual frente a la versión activa.

Las señales de confianza se calibran por campo y tipo de fuente sobre validación independiente; se reportan cobertura y tasa de error de cada banda. Hasta tener suficientes datos, todas se muestran simplemente como “requiere revisión”.

No se declara precisión sin un corpus suficiente. Un cambio de modelo, prompt o esquema debe volver a ejecutar toda la evaluación y no puede degradar el conjunto crítico. El agente autónomo de QA genera el informe y un agente independiente de seguridad/calidad aprueba únicamente si los umbrales se cumplen. Si faltan corpus, presupuesto o condiciones de privacidad verificadas, la importación con IA queda deshabilitada en producción; el registro manual y parsing determinístico continúan disponibles.

La observabilidad agregada mide latencia y error por etapa, reintentos, coste/tokens, candidatos corregidos o descartados, duplicados sugeridos/confirmados y versión del pipeline. Usa IDs opacos y nunca contenido del gasto.
