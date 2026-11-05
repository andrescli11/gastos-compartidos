# Revisión y confirmación de importaciones: dominio local

`src/domain/import-workflow.ts` prepara comandos para un adaptador de persistencia futuro. NO escribe gastos ni acepta resultados del navegador como prueba de escritura.

## Contratos

- `createImport`: propietario y lista de participantes fijos, máximo 200 candidatos, origen por archivo/fila, originales separados de campos revisados. Ninguna fila seleccionada por defecto.
- `viewImport`: solo propietario o administrador; comprueba cancelación y caducidad. La identidad y el reloj son del servidor confiable, nunca valores autorizantes del cliente.
- `editImportItem`: versión optimista, pagador propio para participante, referencias válidas y edición sin alterar origen. Cualquier cambio invalida reconocimientos previos de la fila.
- `acknowledgeImportItem`: reconocimiento explícito de advertencias vigentes y decisión de conservar ambos ante duplicados.
- `confirmImport`: único punto de confirmación humana de una versión concreta. Valida descripción, fecha real, moneda explícita, dinero bigint y reparto exacto. Genera manifiesto con totales separados PEN/USD y versión confirmada. Todavía no marca filas como guardadas.
- `applyImportResults`: solo adaptador confiable, dentro de la transacción que escribe los gastos. Exige intento, manifiesto y versión coincidentes; un resultado por cada fila confirmada. Conserva éxitos y errores parciales. Un éxito nunca vuelve al siguiente lote.
- `cancelImport` y `expireImport`: cancelación sin trabajo financiero en curso y TTL de siete días. Purgan contenido temporal del modelo. El borrado físico de archivos es responsabilidad del adaptador/Storage.

Los recibos se comparan por campos canónicos: cambiar el orden de filas o propiedades JSON no duplica ni cambia resultados. Reutilizar el intento con resultados distintos produce conflicto.

## Privacidad

Tras guardar una fila se reemplazan sus originales por los campos normalizados del comando revisado y se eliminan advertencias/duplicados/reconocimientos temporales. Al terminar se eliminan descartados; cancelar o expirar purga candidatos y recibos del estado temporal. Los fallos pendientes conservan el trabajo revisable hasta el TTL.

Los archivos originales viven fuera de este módulo. La implementación real debe conservar sus referencias en una tabla privada de fuentes y ejecutar borrado verificable: máximo 24h después de confirmar/cancelar y siete días para importaciones sin terminar, según docs04. No afirmar que ese borrado está implementado por purgar objetos en memoria.

## Evidencia

```bash
npm run test:imports
```

Pruebas ejecutadas sin paquetes externos: permisos, versiones, ausencia de persistencia prematura, campos desconocidos, advertencias, duplicados, recibos, errores parciales, TTL, limpieza y replay con propiedades reordenadas. El recorrido de dominio CSV→revisión→confirmación→resultado parcial→reintento comprueba procedencia por fila, reparto exacto de céntimos y totales PEN/USD.

Revisión independiente favorable después de corregir retención de originales, canonicalización de recibos y confusión de fila física con número de registros CSV.

## Integración pendiente

- Guardar jobs/candidatos privados y manifests en PostgreSQL; los bigint cruzan JSON como strings.
- Generar IDs de fuente/ítem/job en servidor, verificar propiedad de archivos y conservar identidad estable por fila.
- Recalcular posibles duplicados contra el libro vigente y exigir nueva revisión si cambia una advertencia.
- Aplicar confirmación, gastos, identidad de filas y recibos de forma atómica, con restricciones únicas e idempotencia durable.
- Resolver carreras entre confirmar/expirar/cancelar y limpieza de archivos; timestamps y TTL siempre de servidor.
- Conectar UI de importación masiva y parsing Excel determinístico, Storage privado y pruebas reales.

El asistente CSV actual de la pantalla sigue copiando filas al registro manual. Este workflow todavía no lo convierte en importación masiva persistente. Gate D sigue pendiente.
