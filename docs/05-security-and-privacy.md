# Seguridad y privacidad

## 1. Activos sensibles

- Enlaces y sesiones privadas.
- Gastos, balances y nombres de participantes.
- Capturas bancarias, boletas y datos extraídos.
- Claves de Supabase, OpenAI, GitHub y Vercel.
- Credenciales y configuración de base de datos.

## 2. Amenazas prioritarias

- Adivinar, filtrar o reutilizar un enlace privado.
- Un participante modificando gastos ajenos mediante llamadas directas.
- Acceso público accidental a Storage.
- Inyección de prompt desde documentos.
- Archivos hostiles, macros, fórmulas o descompresión excesiva.
- Duplicación de gastos o pagos por reintentos.
- Exposición de PII en logs, errores, previews o analítica.
- Uso de claves administrativas en el navegador.
- Abuso de endpoints de IA y costes inesperados.
- Migraciones o despliegues autónomos destructivos.

## 3. Controles

### Acceso

- Tokens aleatorios de 32 bytes, SHA-256 en base de datos, revocación y rotación.
- Intercambio inmediato por cookie segura y redirección a URL limpia.
- Protección contra CSRF en comandos mutables.
- Rate limits por sesión, IP y endpoint, con límites más estrictos para carga e IA.
- Autorización de servidor en cada operación y pruebas negativas sistemáticas.
- Tablas sensibles en esquema privado, sin acceso para roles públicos; RLS y políticas de Storage como segunda barrera.
- Funciones SQL de dominio con permisos mínimos, `search_path` fijado y autorización dentro de la transacción.

### Archivos

- Bucket privado sin URLs públicas.
- URLs firmadas breves después de verificar autorización.
- Validación por firma, límites de tamaño/páginas/píxeles y nombres generados por servidor.
- No ejecutar contenido activo.
- Retención mínima y borrado verificable.

### Aplicación

- Validación de entrada y salida en límites de confianza.
- Consultas parametrizadas y restricciones de base de datos.
- Cabeceras CSP, HSTS, `X-Content-Type-Options` y política de `Referrer` restrictiva.
- Toda página o respuesta autenticada usa `Cache-Control: private, no-store`; se deshabilita caché compartida de Next.js/Vercel para datos del viaje.
- Dependencias fijadas y escaneadas.
- Idempotencia en comandos financieros.
- Historial mínimo para cambios administrativos y pagos.

### IA

- Structured Outputs, límites de tokens/candidatos y timeout.
- Tratar todo texto del archivo como no confiable.
- Validación determinística posterior.
- Presupuesto y rate limit por participante.
- Ninguna escritura directa desde la salida del modelo.

## 4. Secretos

- Se almacenan en Codex Cloud, GitHub Actions, Supabase o Vercel según necesidad; nunca en Git.
- Variables públicas de Supabase no sustituyen autorización.
- La clave de servicio de Supabase solo existe en servidor y debe evitarse donde una credencial de menor privilegio sea suficiente.
- No imprimir variables de entorno ni leer archivos de secretos para inspeccionar valores.
- Rotar inmediatamente cualquier secreto filtrado y revocar sesiones relacionadas.

## 5. Privacidad y retención

- Recoger solo datos necesarios para cuadrar el viaje.
- Las capturas bancarias se consideran especialmente sensibles.
- Los originales de importación tienen TTL corto configurable; conservar únicamente comprobantes que el grupo necesite consultar.
- No enviar datos a analítica de terceros durante el MVP.
- Los logs usan identificadores opacos y métricas agregadas.
- El administrador puede solicitar borrado de un archivo fuente sin destruir la trazabilidad monetaria necesaria.

## 6. Gates de producción

- Matriz de autorización probada para todos los endpoints.
- Ningún bucket u objeto sensible es público.
- Escaneo de secretos y dependencias sin hallazgos críticos.
- Pruebas de prompt injection, archivos hostiles, CSRF, IDOR e idempotencia superadas.
- Límites de coste y carga activos.
- Rollback probado.
- Una sesión anónima o revocada nunca recupera desde caché contenido servido anteriormente a una sesión válida.
- Revisión manual única de la configuración de secretos, red y dominio antes del primer despliegue real.

## 7. Respuesta a incidentes

Revocar enlace o secreto → invalidar sesiones → contener endpoint afectado → preservar auditoría no sensible → corregir → rotar credenciales → verificar ausencia de exposición adicional → documentar el incidente y prevención.
