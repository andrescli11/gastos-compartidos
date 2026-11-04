# Pruebas y calidad

## 1. Pirámide de pruebas

### Unitarias

- Dinero, decimales y redondeo.
- Reparto igual y personalizado.
- Conversión USD→PEN.
- Balances y optimización de transferencias.
- Máquinas de estados de importaciones y pagos.
- Parsers, fechas, monedas, normalización y duplicados.
- Autorización como funciones de política.

### Propiedades

- Conservación de dinero.
- Suma cero por moneda.
- Idempotencia.
- Aplicar transferencias deja todos los saldos en cero.
- Permutar el orden de gastos no cambia el resultado.

### Integración

- BFF, base de datos y Storage.
- Transacciones, restricciones y concurrencia.
- Matriz de permisos positiva y negativa.
- Importación completa sin persistencia prematura.
- Reintentos, doble clic, timeout y fallos parciales.
- Resultado por fila, reinicio después de éxito parcial y confirmación concurrente contra un preview versionado.
- Duplicados dentro de la carga y contra gastos existentes, incluida la decisión “mantener ambos”.
- Pagos y bloqueo de configuración de liquidación.
- Carrera concurrente entre cambio de modo/tasa y confirmación del primer pago.
- Aislamiento de caché: sesiones anónimas, distintas o revocadas no reciben respuestas autenticadas previas.

### Contrato de IA

- JSON Schema estricto.
- Salidas inválidas, nulas o sobredimensionadas.
- 429, 5xx, timeout y reintentos controlados.
- Prompt injection dentro de documentos.
- Regresión sobre corpus dorado.

### E2E

- Entrada por enlace y sesión limpia.
- Crear, editar y eliminar gasto propio.
- Imposibilidad de modificar gasto ajeno.
- Registro masivo e importación revisada.
- Corregir, excluir y conservar candidatos; validar subtotales PEN/USD y errores accesibles en preview.
- Liquidación separada y consolidada.
- Registrar, confirmar, rechazar y anular pagos.
- Flujos móviles y de escritorio.

## 2. Accesibilidad

- Navegación completa con teclado.
- Foco visible y orden lógico.
- Etiquetas, nombres accesibles y mensajes de error asociados.
- Contraste suficiente y no depender solo del color.
- Tablas y diálogos utilizables con lector de pantalla.
- Pruebas automatizadas más revisión de recorridos críticos.

## 3. Seguridad y robustez

- IDOR y escalamiento de rol.
- CSRF y sesiones revocadas.
- Archivos maliciosos, fórmulas CSV y tipos falsos.
- Codificaciones, separadores y fechas regionales ambiguas; Excel protegido, corrupto, con fórmulas sin caché y hojas/celdas omitidas.
- PII y secretos ausentes de logs y errores.
- Colisiones de idempotencia.
- Carga concurrente, límites y presupuestos.

## 4. Rendimiento objetivo

La navegación y operaciones manuales deben sentirse inmediatas en móvil. La extracción puede ser asíncrona, con progreso y recuperación. Se medirán percentiles de latencia por etapa, tamaño de bundles y consultas; no se optimizará prematuramente más allá de límites definidos durante implementación.

## 5. Gates de CI

1. Formato y lint.
2. Typecheck estricto.
3. Pruebas unitarias y de propiedades.
4. Integración con base efímera.
5. Build reproducible.
6. E2E de recorrido feliz y permisos críticos.
7. Escaneo de secretos y dependencias.
8. Evaluación versionada de IA cuando cambian modelo, prompt, esquema o parser, usando los umbrales de `04-ai-imports.md`.
9. Pruebas de expiración, borrado verificable y ausencia de PII en logs, trazas, métricas y errores.

Ningún test se desactiva para integrar un cambio. Una prueba inestable se corrige o se aísla con una decisión documentada y plazo explícito.

## 6. Criterio de liberación

- Cero errores críticos o altos abiertos.
- Invariantes financieras verificadas.
- Autorización negativa cubierta.
- Corpus crítico sin regresiones.
- Preview funcional en móvil y escritorio.
- Migración, despliegue y rollback ensayados.
