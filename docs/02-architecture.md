# Arquitectura

## 1. Stack

- Next.js con App Router y TypeScript.
- Tailwind CSS y componentes accesibles de shadcn/ui.
- Supabase PostgreSQL y Storage privado.
- Endpoints de servidor de Next.js como Backend for Frontend (BFF).
- OpenAI Responses API con visión y Structured Outputs para extracción.
- ExcelJS para lectura determinística de Excel y parser estricto de CSV.
- Zod para validar contratos de entrada y salidas de IA.
- Vitest y Playwright para pruebas.
- GitHub como fuente y Vercel para previews y producción.

## 2. Diagrama lógico

```text
Navegador
   │ HTTPS + enlace/token privado
   ▼
Next.js en Vercel (UI + BFF)
   ├── valida sesión derivada del token y autorización
   ├── aplica reglas de negocio e idempotencia
   ├── llama a OpenAI para extracción estructurada
   └── usa credenciales de servidor para Supabase
          ├── PostgreSQL
          └── Storage privado
```

El navegador no recibe credenciales administrativas ni accede directamente a tablas sensibles. Las lecturas y escrituras pasan por el BFF. RLS permanece habilitado como defensa adicional, no como sustituto de la autorización del servidor.

## 3. Identidad mediante enlaces

- Cada enlace contiene un token aleatorio criptográfico de 32 bytes.
- El formato recomendado es `/entrar#token=…`: el fragmento evita que el token viaje en la petición inicial o en logs. Una página mínima, sin terceros, lo canjea por `POST` y lo elimina del historial.
- El servidor intercambia el token por una cookie de sesión segura, `HttpOnly`, `Secure`, `SameSite=Lax` y con expiración limitada.
- En la base solo se guarda SHA-256 del token y metadatos de revocación; la entropía del token evita tratarlo como una contraseña humana. Nunca se guarda el original.
- El token no aparece en logs, telemetría, `Referer`, URLs de recursos ni llamadas a terceros.
- Tras el intercambio se redirige a una URL limpia.
- La sesión contiene el `participant_id`, rol y versión de autorización; cada operación vuelve a comprobar revocación y permisos.
- Regenerar un enlace revoca sesiones anteriores asociadas.

## 4. Contrato de autorización

| Acción                     | Participante                    | Administrador     |
| -------------------------- | ------------------------------- | ----------------- |
| Leer gastos y balances     | Todos                           | Todos             |
| Crear gasto                | Solo con sí mismo como pagador  | Cualquier pagador |
| Editar/eliminar gasto      | Solo si continúa siendo pagador | Cualquiera        |
| Cambiar pagador            | No                              | Sí                |
| Cargar/revisar importación | Propia                          | Cualquiera        |
| Registrar pago             | Si es emisor                    | Cualquiera        |
| Confirmar/rechazar pago    | Si es receptor                  | Sí                |
| Configurar liquidación     | No                              | Sí                |
| Revocar enlaces            | No                              | Sí                |

La API obtiene la identidad de la sesión; nunca confía en un `participant_id`, rol o `trip_id` enviado por el cliente para decidir permisos. En actualizaciones verifica tanto el registro existente como el propuesto, para impedir apropiarse de un gasto ajeno cambiando su pagador.

## 5. Componentes

### Interfaz

- Resumen y lista de gastos.
- Formularios individual y masivo.
- Flujo de importación y previsualización.
- Detalle del reparto.
- Balances, planes de liquidación y pagos.
- Herramientas administrativas mínimas.

### Dominio

Funciones puras y deterministas para dinero, repartos, balances, conversión y optimización de transferencias. No dependen de React, Supabase ni OpenAI.

### BFF

- Autenticación del enlace y sesiones.
- Autorización por acción.
- Validación de comandos.
- Operaciones transaccionales e idempotentes.
- Orquestación de importaciones.
- URLs firmadas de corta duración para archivos autorizados.

### Persistencia

Migraciones SQL versionadas. Tipos generados desde el esquema. Restricciones de base de datos refuerzan moneda, importes, unicidad, estados y relaciones. Las mutaciones financieras se ejecutan mediante funciones específicas que verifican sesión, viaje, rol y pagador dentro de la misma transacción que cambia datos y auditoría.

## 6. Importaciones

Las importaciones son trabajos persistentes con estados explícitos. Los archivos se validan antes de procesarse; Excel/CSV se parsean primero de forma determinística. La IA recibe únicamente regiones o celdas necesarias y devuelve datos que pasan validación independiente. La confirmación se ejecuta en una transacción y usa claves de idempotencia.

## 7. Despliegue

- Cada pull request genera una preview de Vercel.
- `main` despliega producción después de superar todos los gates.
- Las migraciones se prueban localmente contra una base efímera antes de aplicarse.
- Las migraciones de producción son versionadas, compatibles hacia atrás cuando sea posible y tienen procedimiento de recuperación.
- Los cambios de prompt, esquema de extracción o modelo runtime pasan nuevamente por evaluación.

## 8. Observabilidad

Registrar IDs opacos, estados, latencias, errores clasificados, versión de esquema/prompt/modelo y consumo agregado. No registrar tokens, imágenes, OCR completo, nombres, comercios, importes, números de cuenta ni contenido de documentos.

## 9. Decisiones deliberadas

- BFF en lugar de acceso administrativo desde el cliente.
- Enlaces privados en lugar de cuentas completas.
- Monolito modular en lugar de microservicios.
- Procesamiento asíncrono persistente para importaciones, sin introducir una cola externa inicialmente.
- Dos monedas explícitas, sin conversión durante la ingesta.
- Supabase y Vercel administrados para reducir operación manual.
